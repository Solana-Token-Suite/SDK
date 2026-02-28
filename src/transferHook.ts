import {
  Connection,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  getMint,
  getTransferHook,
  getTransferFeeConfig,
  getPermanentDelegate,
  getInterestBearingMintConfigState,
} from '@solana/spl-token';
import { Program, AnchorProvider, BN } from '@coral-xyz/anchor';
import { TRANSFER_HOOK_PROGRAM_ID } from './constants';
import {
  deriveHookConfigPDA,
  deriveWhitelistMarkerPDA,
  sendInstructions,
} from './utils';
import type {
  HookConfigState,
  HookFlags,
  EditConfigParams,
  MintExtensions,
} from './types';
import transferHookIdl from '../idl/transfer_hook.json';

// ── Helper to build Anchor provider/program ──────────────────
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
  return new Program(transferHookIdl as any, provider);
}

// ── Detect Extensions on a Token-2022 Mint ───────────────────

/**
 * Detect which Token-2022 extensions are enabled on a mint.
 */
export async function detectExtensions(
  connection: Connection,
  mintAddress: PublicKey
): Promise<MintExtensions> {
  const mintInfo = await getMint(connection, mintAddress, 'confirmed', TOKEN_2022_PROGRAM_ID);
  const decimals = mintInfo.decimals;

  const ext: MintExtensions = {
    hasTransferHook: false,
    hasTransferFee: false,
    hasPermanentDelegate: false,
    hasInterestBearing: false,
  };

  try {
    const hookData = getTransferHook(mintInfo);
    if (hookData && hookData.programId.toBase58() !== PublicKey.default.toBase58()) {
      ext.hasTransferHook = true;
      ext.transferHookProgramId = hookData.programId.toBase58();
    }
  } catch { /* not present */ }

  try {
    const tfConfig = getTransferFeeConfig(mintInfo);
    if (tfConfig) {
      ext.hasTransferFee = true;
      ext.transferFeeBps = tfConfig.newerTransferFee.transferFeeBasisPoints;
      const maxFeeRaw = tfConfig.newerTransferFee.maximumFee;
      ext.maxFee = (Number(maxFeeRaw) / 10 ** decimals).toString();
      ext.withheldOnMint = (Number(tfConfig.withheldAmount) / 10 ** decimals).toString();
      ext.withdrawAuthority = tfConfig.withdrawWithheldAuthority.toBase58();
    }
  } catch { /* not present */ }

  try {
    const pdData = getPermanentDelegate(mintInfo);
    if (pdData && pdData.delegate.toBase58() !== PublicKey.default.toBase58()) {
      ext.hasPermanentDelegate = true;
      ext.permanentDelegate = pdData.delegate.toBase58();
    }
  } catch { /* not present */ }

  try {
    const ibConfig = getInterestBearingMintConfigState(mintInfo);
    if (ibConfig) {
      ext.hasInterestBearing = true;
      ext.currentRate = ibConfig.currentRate;
      ext.rateAuthority = ibConfig.rateAuthority.toBase58();
    }
  } catch { /* not present */ }

  return ext;
}

// ── Fetch Hook Config ────────────────────────────────────────

/**
 * Fetch the on-chain transfer hook config for a given mint.
 * Returns null if config is not initialized.
 */
export async function fetchHookConfig(
  connection: Connection,
  payer: PublicKey,
  walletSign: (tx: VersionedTransaction) => Promise<VersionedTransaction>,
  mintAddress: PublicKey
): Promise<HookConfigState | null> {
  const program = getProgram(connection, payer, walletSign);
  const [configPda] = deriveHookConfigPDA(mintAddress);

  try {
    const data = await (program.account as any).configAccount.fetch(configPda);
    return {
      owner: data.owner,
      mint: data.mint,
      nftMintAddress: data.nftMintAddress,
      whitelistEnabled: data.whitelistEnabled,
      tradingTimeEnabled: data.tradingTimeEnabled,
      maxTransferEnabled: data.maxTransferEnabled,
      nftGated: data.nftGated,
      openMinute: data.openMinute ?? null,
      closeMinute: data.closeMinute ?? null,
      maxTransferAmount: BigInt(data.maxTransferAmount.toString()),
      minTransferAmount: BigInt(data.minTransferAmount.toString()),
    };
  } catch {
    return null;
  }
}

// ── Update Flags ─────────────────────────────────────────────

/**
 * Update the policy flags (whitelist, trading time, max transfer, NFT gate)
 * on the on-chain transfer hook config.
 */
export async function updateFlags(
  connection: Connection,
  payer: PublicKey,
  walletSign: (tx: VersionedTransaction) => Promise<VersionedTransaction>,
  mintAddress: PublicKey,
  flags: HookFlags
): Promise<string> {
  const program = getProgram(connection, payer, walletSign);
  const [configPda] = deriveHookConfigPDA(mintAddress);

  return program.methods
    .updateFlags(
      flags.whitelistEnabled,
      flags.tradingTimeEnabled,
      flags.maxTransferEnabled,
      flags.nftGated
    )
    .accounts({
      owner: payer,
      config: configPda,
      mint: mintAddress,
    })
    .rpc();
}

// ── Edit Config ──────────────────────────────────────────────

/**
 * Edit the on-chain config values (trading hours, transfer limits, NFT mint).
 * Only non-null fields are updated.
 */
export async function editConfig(
  connection: Connection,
  payer: PublicKey,
  walletSign: (tx: VersionedTransaction) => Promise<VersionedTransaction>,
  mintAddress: PublicKey,
  params: EditConfigParams
): Promise<string> {
  const program = getProgram(connection, payer, walletSign);
  const [configPda] = deriveHookConfigPDA(mintAddress);

  const openMinute = params.openMinute !== undefined ? params.openMinute : null;
  const closeMinute = params.closeMinute !== undefined ? params.closeMinute : null;
  const maxAmount = params.maxTransferAmount !== undefined && params.maxTransferAmount !== null
    ? new BN(params.maxTransferAmount.toString())
    : null;
  const minAmount = params.minTransferAmount !== undefined && params.minTransferAmount !== null
    ? new BN(params.minTransferAmount.toString())
    : null;
  const nftMint = params.nftMintAddress !== undefined ? params.nftMintAddress : null;

  return program.methods
    .editConfig(openMinute, closeMinute, maxAmount, minAmount, nftMint)
    .accounts({
      owner: payer,
      config: configPda,
      mint: mintAddress,
    })
    .rpc();
}

// ── Whitelist Management ─────────────────────────────────────

/**
 * Add an address to the whitelist for a given mint.
 */
export async function addToWhitelist(
  connection: Connection,
  payer: PublicKey,
  walletSign: (tx: VersionedTransaction) => Promise<VersionedTransaction>,
  mintAddress: PublicKey,
  userAddress: PublicKey
): Promise<string> {
  const program = getProgram(connection, payer, walletSign);
  const [configPda] = deriveHookConfigPDA(mintAddress);
  const [whitelistMarker] = deriveWhitelistMarkerPDA(mintAddress, userAddress);

  return program.methods
    .addToWhitelist()
    .accounts({
      payer,
      owner: payer,
      config: configPda,
      mint: mintAddress,
      userPubkey: userAddress,
      whitelistMarker,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

/**
 * Remove an address from the whitelist for a given mint.
 */
export async function removeFromWhitelist(
  connection: Connection,
  payer: PublicKey,
  walletSign: (tx: VersionedTransaction) => Promise<VersionedTransaction>,
  mintAddress: PublicKey,
  userAddress: PublicKey
): Promise<string> {
  const program = getProgram(connection, payer, walletSign);
  const [configPda] = deriveHookConfigPDA(mintAddress);
  const [whitelistMarker] = deriveWhitelistMarkerPDA(mintAddress, userAddress);

  return program.methods
    .removeFromWhitelist()
    .accounts({
      payer,
      owner: payer,
      config: configPda,
      mint: mintAddress,
      userPubkey: userAddress,
      whitelistMarker,
    })
    .rpc();
}
