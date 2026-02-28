import {
  Connection,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createHarvestWithheldTokensToMintInstruction,
  createWithdrawWithheldTokensFromMintInstruction,
  createBurnCheckedInstruction,
  createTransferCheckedWithTransferHookInstruction,
  createUpdateRateInterestBearingMintInstruction,
  createAssociatedTokenAccountInstruction,
  unpackAccount,
  getTransferFeeAmount,
} from '@solana/spl-token';
import { sendInstructions } from './utils';

// ── Harvest Transfer Fees ────────────────────────────────────

/**
 * Harvest withheld transfer fees from all token accounts into the mint,
 * then withdraw from mint to the owner's ATA.
 *
 * @returns Transaction signature
 */
export async function harvestTransferFees(
  connection: Connection,
  payer: PublicKey,
  walletSign: (tx: VersionedTransaction) => Promise<VersionedTransaction>,
  mintAddress: PublicKey
): Promise<string> {
  const instructions = [];

  // Find all token accounts with withheld fees
  const accounts = await connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: mintAddress.toBase58() } }],
  });

  const sourcesWithFees: PublicKey[] = [];
  for (const { pubkey, account } of accounts) {
    try {
      const tokenAccount = unpackAccount(pubkey, account, TOKEN_2022_PROGRAM_ID);
      const feeAmount = getTransferFeeAmount(tokenAccount);
      if (feeAmount && feeAmount.withheldAmount > 0n) {
        sourcesWithFees.push(pubkey);
      }
    } catch {
      /* skip invalid accounts */
    }
  }

  // Harvest from token accounts to mint (batch in groups of 20)
  if (sourcesWithFees.length > 0) {
    for (let i = 0; i < sourcesWithFees.length; i += 20) {
      const batch = sourcesWithFees.slice(i, i + 20);
      instructions.push(
        createHarvestWithheldTokensToMintInstruction(mintAddress, batch, TOKEN_2022_PROGRAM_ID)
      );
    }
  }

  // Withdraw accumulated fees from mint to owner's ATA
  const ownerAta = getAssociatedTokenAddressSync(mintAddress, payer, false, TOKEN_2022_PROGRAM_ID);
  const ownerAtaInfo = await connection.getAccountInfo(ownerAta);
  if (!ownerAtaInfo) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        payer, ownerAta, payer, mintAddress, TOKEN_2022_PROGRAM_ID
      )
    );
  }

  instructions.push(
    createWithdrawWithheldTokensFromMintInstruction(
      mintAddress, ownerAta, payer, [], TOKEN_2022_PROGRAM_ID
    )
  );

  return sendInstructions(connection, payer, instructions, walletSign);
}

// ── Permanent Delegate: Burn ─────────────────────────────────

/**
 * Burn tokens from any holder's account using permanent delegate authority.
 *
 * @param targetWallet  - The wallet whose tokens to burn
 * @param amount        - Human-readable amount (e.g. 100.5)
 * @param decimals      - Token decimals
 */
export async function delegateBurn(
  connection: Connection,
  payer: PublicKey,
  walletSign: (tx: VersionedTransaction) => Promise<VersionedTransaction>,
  mintAddress: PublicKey,
  targetWallet: PublicKey,
  amount: number,
  decimals: number
): Promise<string> {
  const targetAta = getAssociatedTokenAddressSync(
    mintAddress, targetWallet, false, TOKEN_2022_PROGRAM_ID
  );
  const amountRaw = BigInt(Math.floor(amount * 10 ** decimals));

  const ix = createBurnCheckedInstruction(
    targetAta, mintAddress, payer, amountRaw, decimals, [], TOKEN_2022_PROGRAM_ID
  );

  return sendInstructions(connection, payer, [ix], walletSign);
}

// ── Permanent Delegate: Transfer (Clawback) ──────────────────

/**
 * Transfer tokens from any holder's account to another using permanent delegate authority.
 * Supports transfer hook-aware transfers.
 *
 * @param sourceWallet  - Source wallet to clawback from
 * @param destWallet    - Destination wallet
 * @param amount        - Human-readable amount
 * @param decimals      - Token decimals
 */
export async function delegateTransfer(
  connection: Connection,
  payer: PublicKey,
  walletSign: (tx: VersionedTransaction) => Promise<VersionedTransaction>,
  mintAddress: PublicKey,
  sourceWallet: PublicKey,
  destWallet: PublicKey,
  amount: number,
  decimals: number
): Promise<string> {
  const sourceAta = getAssociatedTokenAddressSync(
    mintAddress, sourceWallet, false, TOKEN_2022_PROGRAM_ID
  );
  const destAta = getAssociatedTokenAddressSync(
    mintAddress, destWallet, false, TOKEN_2022_PROGRAM_ID
  );
  const amountRaw = BigInt(Math.floor(amount * 10 ** decimals));

  const instructions = [];

  // Ensure dest ATA exists
  const destAtaInfo = await connection.getAccountInfo(destAta);
  if (!destAtaInfo) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        payer, destAta, destWallet, mintAddress, TOKEN_2022_PROGRAM_ID
      )
    );
  }

  // Transfer hook-aware checked transfer using permanent delegate authority
  const transferIx = await createTransferCheckedWithTransferHookInstruction(
    connection,
    sourceAta,
    mintAddress,
    destAta,
    payer,
    amountRaw,
    decimals,
    [],
    'confirmed',
    TOKEN_2022_PROGRAM_ID
  );
  instructions.push(transferIx);

  return sendInstructions(connection, payer, instructions, walletSign);
}

// ── Interest Rate Update ─────────────────────────────────────

/**
 * Update the interest rate on an interest-bearing Token-2022 mint.
 *
 * @param rate - New rate in basis points (e.g. 500 = 5%)
 */
export async function updateInterestRate(
  connection: Connection,
  payer: PublicKey,
  walletSign: (tx: VersionedTransaction) => Promise<VersionedTransaction>,
  mintAddress: PublicKey,
  rate: number
): Promise<string> {
  const ix = createUpdateRateInterestBearingMintInstruction(
    mintAddress, payer, rate, [], TOKEN_2022_PROGRAM_ID
  );

  return sendInstructions(connection, payer, [ix], walletSign);
}
