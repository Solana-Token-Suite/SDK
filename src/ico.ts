import {
  Connection,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from '@solana/spl-token';
import { Program, AnchorProvider, BN } from '@coral-xyz/anchor';
import { ICO_PROGRAM_ID } from './constants';
import { deriveICOConfigPDA, deriveICOConfigAccountPDA, deriveICOVaultAccountPDA, resolveTransferHookAccounts } from './utils';
import type { LaunchICOParams, BuyTokenParams, ICOConfigState } from './types';
import icoIdl from '../idl/ico.json';

// ── Helper ───────────────────────────────────────────────────
function getProgram(
  connection: Connection,
  payer: PublicKey,
  walletSign: (tx: VersionedTransaction) => Promise<VersionedTransaction>
) {
  const provider = new AnchorProvider(
    connection,
    { publicKey: payer, signTransaction: walletSign, signAllTransactions: async (txs: any) => txs } as any,
    { commitment: 'confirmed' }
  );
  return new Program(icoIdl as any, provider);
}

/** Determine if a mint is Token-2022 or regular SPL Token */
async function getTokenProgram(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  const mintInfo = await connection.getAccountInfo(mint);
  if (mintInfo?.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    return TOKEN_2022_PROGRAM_ID;
  }
  return TOKEN_PROGRAM_ID;
}

// ── Launch ICO ───────────────────────────────────────────────

/**
 * Launch an ICO for a token. Deposits tokens into the ICO vault PDA.
 * Supports both Token-2022 and regular SPL Token mints.
 * Automatically resolves transfer hook extra accounts for Token-2022 tokens.
 *
 * @param connection  - Solana RPC connection
 * @param payer       - Wallet public key (creator)
 * @param walletSign  - wallet.signTransaction
 * @param params      - ICO launch parameters
 * @returns Transaction signature
 */
export async function launchICO(
  connection: Connection,
  payer: PublicKey,
  walletSign: (tx: VersionedTransaction) => Promise<VersionedTransaction>,
  params: LaunchICOParams
): Promise<string> {
  const program = getProgram(connection, payer, walletSign);
  const { mint } = params;

  const [config] = deriveICOConfigPDA();
  const [icoConfigAccount] = deriveICOConfigAccountPDA(mint);
  const [icoVaultAccount] = deriveICOVaultAccountPDA(mint);

  const tokenProgram = await getTokenProgram(connection, mint);
  const vaultAta = getAssociatedTokenAddressSync(mint, icoVaultAccount, true, tokenProgram);
  const creatorAta = getAssociatedTokenAddressSync(mint, payer, false, tokenProgram);

  const startTime = params.startTime ?? Math.floor(Date.now() / 1000);
  const endTime = params.endTime ?? startTime + 30 * 24 * 60 * 60;

  // Resolve extra accounts for Transfer Hook (if Token-2022)
  const extraAccounts = tokenProgram.equals(TOKEN_2022_PROGRAM_ID)
    ? await resolveTransferHookAccounts(
        connection,
        mint,
        creatorAta,
        vaultAta,
        payer,
        BigInt(new BN(params.amount * 1e9).toString()),
        9
      )
    : [];

  // Ensure creator ATA exists
  const preIxs = await (async () => {
    try {
      await getAccount(connection, creatorAta, 'confirmed', tokenProgram);
      return [];
    } catch {
      return [
        createAssociatedTokenAccountInstruction(payer, creatorAta, payer, mint, tokenProgram),
      ];
    }
  })();

  return program.methods
    .initializeIco(
      new BN(params.softCapSol * 1e9),
      new BN(params.hardCapSol * 1e9),
      new BN(startTime),
      new BN(endTime),
      new BN(params.amount * 1e9),
      new BN(params.pricePerTokenSol * 1e9)
    )
    .accounts({
      creator: payer,
      mint,
      config,
      icoConfigAccount,
      icoVaultAccount,
      vaultAta,
      creatorAta,
      tokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(extraAccounts)
    .preInstructions(preIxs)
    .rpc();
}

// ── Buy Tokens from ICO ──────────────────────────────────────

/**
 * Purchase tokens from an active ICO.
 * Supports both Token-2022 and regular SPL Token mints.
 * Automatically resolves transfer hook extra accounts for Token-2022 tokens.
 *
 * @param connection  - Solana RPC connection
 * @param payer       - Wallet public key (buyer)
 * @param walletSign  - wallet.signTransaction
 * @param params      - Buy parameters (mint, amount)
 * @returns Transaction signature
 */
export async function buyToken(
  connection: Connection,
  payer: PublicKey,
  walletSign: (tx: VersionedTransaction) => Promise<VersionedTransaction>,
  params: BuyTokenParams
): Promise<string> {
  const program = getProgram(connection, payer, walletSign);
  const { mint } = params;

  const [config] = deriveICOConfigPDA();
  const [icoConfigAccount] = deriveICOConfigAccountPDA(mint);
  const [icoVaultAccount] = deriveICOVaultAccountPDA(mint);

  const tokenProgram = await getTokenProgram(connection, mint);
  const vaultAta = getAssociatedTokenAddressSync(mint, icoVaultAccount, true, tokenProgram);
  const buyerAta = getAssociatedTokenAddressSync(mint, payer, false, tokenProgram);

  // Fetch ICO data to get creator
  const icoData = await (program.account as any).icoConfigAccount.fetch(icoConfigAccount);

  // Resolve extra accounts for Transfer Hook (vault -> buyer transfer)
  const extraAccounts = tokenProgram.equals(TOKEN_2022_PROGRAM_ID)
    ? await resolveTransferHookAccounts(
        connection,
        mint,
        vaultAta,
        buyerAta,
        icoVaultAccount,
        BigInt(new BN(params.amount * 1e9).toString()),
        9
      )
    : [];

  // Ensure buyer ATA exists
  const preIxs = await (async () => {
    try {
      await getAccount(connection, buyerAta, 'confirmed', tokenProgram);
      return [];
    } catch {
      return [
        createAssociatedTokenAccountInstruction(payer, buyerAta, payer, mint, tokenProgram),
      ];
    }
  })();

  return program.methods
    .purchaseToken(new BN(params.amount * 1e9))
    .accounts({
      buyer: payer,
      mint,
      config,
      creator: icoData.creator,
      icoConfigAccount,
      icoVaultAccount,
      vaultAta,
      buyerAta,
      tokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(extraAccounts)
    .preInstructions(preIxs)
    .rpc();
}

// ── Fetch ICO Config ─────────────────────────────────────────

/**
 * Fetch the on-chain ICO config for a given mint.
 * Returns null if no ICO is configured.
 */
export async function fetchICOConfig(
  connection: Connection,
  payer: PublicKey,
  walletSign: (tx: VersionedTransaction) => Promise<VersionedTransaction>,
  mint: PublicKey
): Promise<ICOConfigState | null> {
  const program = getProgram(connection, payer, walletSign);
  const [icoConfigAccount] = deriveICOConfigAccountPDA(mint);

  try {
    const data = await (program.account as any).icoConfigAccount.fetch(icoConfigAccount);
    return {
      creator: data.creator,
      mint: data.mint,
      softCap: BigInt(data.softCap.toString()),
      hardCap: BigInt(data.hardCap.toString()),
      startTime: data.startTime.toNumber(),
      endTime: data.endTime.toNumber(),
      tokenVault: data.tokenVault,
      totalRaised: BigInt(data.totalRaised.toString()),
      pricePerToken: BigInt(data.pricePerToken.toString()),
    };
  } catch {
    return null;
  }
}
