import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
  Signer,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  getMint,
  getTransferHook,
  createTransferCheckedInstruction,
  addExtraAccountMetasForExecute,
} from '@solana/spl-token';
import { TRANSFER_HOOK_PROGRAM_ID, ICO_PROGRAM_ID, METADATA_PROGRAM_ID } from './constants';

// ── IST ↔ UTC Time Helpers ───────────────────────────────────

const IST_OFFSET = 330; // IST = UTC + 5h30m in minutes

/**
 * Convert UTC minute-of-day to IST time string "HH:MM"
 */
export function utcMinuteToIstTime(utcMin: number): string {
  let istMin = utcMin + IST_OFFSET;
  if (istMin >= 1440) istMin -= 1440;
  const h = Math.floor(istMin / 60);
  const m = istMin % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

/**
 * Convert UTC minute-of-day to UTC time string "HH:MM"
 */
export function utcMinuteToUtcTime(utcMin: number): string {
  const h = Math.floor(utcMin / 60);
  const m = utcMin % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

/**
 * Convert IST time string "HH:MM" to UTC minute-of-day (u16)
 */
export function istTimeToUtcMinute(istTime: string): number {
  const [h, m] = istTime.split(':').map(Number);
  let utcMin = h * 60 + m - IST_OFFSET;
  if (utcMin < 0) utcMin += 1440;
  return utcMin;
}

// ── PDA Derivation ───────────────────────────────────────────

/** Derive the transfer hook config PDA for a mint */
export function deriveHookConfigPDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('config'), mint.toBuffer()],
    TRANSFER_HOOK_PROGRAM_ID
  );
}

/** Derive the extra-account-metas PDA for a mint */
export function deriveExtraAccountMetaListPDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('extra-account-metas'), mint.toBuffer()],
    TRANSFER_HOOK_PROGRAM_ID
  );
}

/** Derive the whitelist marker PDA for a user on a given mint */
export function deriveWhitelistMarkerPDA(
  mint: PublicKey,
  user: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('whitelist'), mint.toBuffer(), user.toBuffer()],
    TRANSFER_HOOK_PROGRAM_ID
  );
}

/** Derive the ICO global config PDA */
export function deriveICOConfigPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('config')],
    ICO_PROGRAM_ID
  );
}

/** Derive the ICO config account PDA for a mint */
export function deriveICOConfigAccountPDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('ico_config_account'), mint.toBuffer()],
    ICO_PROGRAM_ID
  );
}

/** Derive the ICO vault account PDA for a mint */
export function deriveICOVaultAccountPDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('ico_vault_account'), mint.toBuffer()],
    ICO_PROGRAM_ID
  );
}

/** Derive the Metaplex metadata PDA for a mint */
export function deriveMetadataPDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID
  );
}

// ── Transaction Helpers ──────────────────────────────────────

/**
 * Build a VersionedTransaction from instructions, sign with provided signers,
 * then have the wallet sign. Returns raw signed tx ready to send.
 */
export async function buildVersionedTransaction(
  connection: Connection,
  payer: PublicKey,
  instructions: TransactionInstruction[],
  signers: Signer[] = []
): Promise<VersionedTransaction> {
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const messageV0 = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(messageV0);
  if (signers.length > 0) {
    tx.sign(signers);
  }
  return tx;
}

/**
 * Send and confirm a VersionedTransaction.
 */
export async function sendAndConfirmVersionedTransaction(
  connection: Connection,
  tx: VersionedTransaction,
  skipPreflight = false
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  return sig;
}

/**
 * Build, wallet-sign, and send a set of instructions.
 * `walletSign` should be `wallet.signTransaction`.
 */
export async function sendInstructions(
  connection: Connection,
  payer: PublicKey,
  instructions: TransactionInstruction[],
  walletSign: (tx: VersionedTransaction) => Promise<VersionedTransaction>,
  signers: Signer[] = [],
  skipPreflight = false
): Promise<string> {
  const tx = await buildVersionedTransaction(connection, payer, instructions, signers);
  const signed = await walletSign(tx);
  return sendAndConfirmVersionedTransaction(connection, signed, skipPreflight);
}

// ── Transfer Hook Account Resolution ─────────────────────────

/**
 * Resolves the extra accounts needed by a Transfer Hook for a given transfer.
 * Creates a mock transferChecked instruction, resolves extra accounts via
 * addExtraAccountMetasForExecute, then returns only the extra accounts beyond
 * the standard 4 transfer_checked keys (source, mint, dest, authority).
 */
export async function resolveTransferHookAccounts(
  connection: Connection,
  mint: PublicKey,
  source: PublicKey,
  destination: PublicKey,
  authority: PublicKey,
  amount: bigint,
  decimals: number
): Promise<{ pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[]> {
  try {
    const mintState = await getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
    const hookInfo = getTransferHook(mintState);
    if (!hookInfo) return [];

    const mockIx = createTransferCheckedInstruction(
      source,
      mint,
      destination,
      authority,
      amount,
      decimals,
      [],
      TOKEN_2022_PROGRAM_ID
    );

    await addExtraAccountMetasForExecute(
      connection,
      mockIx,
      hookInfo.programId,
      source,
      mint,
      destination,
      authority,
      amount,
      'confirmed'
    );

    // transferChecked has 4 standard keys: source, mint, dest, authority
    // Everything after index 4 is the transfer hook's extra accounts
    return mockIx.keys.slice(4);
  } catch {
    return [];
  }
}
