import { PublicKey } from '@solana/web3.js';

// ── Token Creation ───────────────────────────────────────────

/** Token basic metadata */
export interface TokenMetadata {
  name: string;
  symbol: string;
  description: string;
  /** Number of decimal places (0-9) */
  decimals: number;
  /** Initial supply in human-readable units (before decimals) */
  supply: number;
  /** Image buffer */
  image: Uint8Array;
  /** Image filename */
  imageFileName: string;
  /** Image MIME type e.g. 'image/png' */
  imageContentType: string;
}

/** Extension configuration for token creation */
export interface TokenExtensions {
  /** Enable permanent delegate (your wallet can burn/clawback any holder's tokens) */
  permanentDelegation?: boolean;
  /** Enable transfer fees collected on every transfer */
  transferFee?: {
    /** Fee in basis points (e.g. 50 = 0.5%) */
    feeBasisPoints: number;
    /** Maximum fee in token base units */
    maxFee: bigint;
  };
  /** Enable interest-bearing config */
  interestBearing?: {
    /** Rate in basis points (e.g. 500 = 5%) */
    rate: number;
  };
  /** Enable required memo transfers on the creator's ATA */
  memoTransfer?: boolean;
  /** Make token non-transferable (soul-bound). Disables TransferHook, TransferFee, PermanentDelegate */
  nonTransferable?: boolean;
  /** Enable CPI guard on creator's ATA. Disables TransferHook */
  cpiGuard?: boolean;
}

/** Transfer Hook configuration (used during registry initialization) */
export interface TransferHookConfig {
  /** Enable trading hours restriction */
  tradingHours?: {
    /** Opening time as UTC minute-of-day (0-1439) */
    openMinuteUTC: number;
    /** Closing time as UTC minute-of-day (0-1439) */
    closeMinuteUTC: number;
  };
  /** Enable transfer amount limits */
  transferLimits?: {
    /** Minimum transfer in human-readable units */
    min: number;
    /** Maximum transfer in human-readable units */
    max: number;
  };
  /** NFT mint address for NFT-gated transfers (holders must own this NFT) */
  nftMintAddress?: PublicKey;
}

/** Result from token creation */
export interface CreateTokenResult {
  /** The mint public key */
  mint: PublicKey;
  /** The creator's associated token account */
  ata: PublicKey;
  /** Signature of the mint transaction (Tx1) */
  mintTxSignature: string;
  /** Signature of the metadata transaction (Tx2) */
  metadataTxSignature: string;
}

// ── Transfer Hook Management ─────────────────────────────────

/** On-chain config account state */
export interface HookConfigState {
  owner: PublicKey;
  mint: PublicKey;
  nftMintAddress: PublicKey;
  whitelistEnabled: boolean;
  tradingTimeEnabled: boolean;
  maxTransferEnabled: boolean;
  nftGated: boolean;
  openMinute: number | null;
  closeMinute: number | null;
  maxTransferAmount: bigint;
  minTransferAmount: bigint;
}

/** Flags to enable/disable hook policies */
export interface HookFlags {
  whitelistEnabled: boolean;
  tradingTimeEnabled: boolean;
  maxTransferEnabled: boolean;
  nftGated: boolean;
}

/** Parameters to edit the on-chain config */
export interface EditConfigParams {
  /** UTC minute-of-day for open time, null to skip */
  openMinute?: number | null;
  /** UTC minute-of-day for close time, null to skip */
  closeMinute?: number | null;
  /** Max transfer amount in base units, null to skip */
  maxTransferAmount?: bigint | null;
  /** Min transfer amount in base units, null to skip */
  minTransferAmount?: bigint | null;
  /** NFT mint address, null to skip */
  nftMintAddress?: PublicKey | null;
}

// ── Token-2022 Extension Detection ──────────────────────────

/** Detected extensions on a mint */
export interface MintExtensions {
  hasTransferHook: boolean;
  transferHookProgramId?: string;
  hasTransferFee: boolean;
  transferFeeBps?: number;
  maxFee?: string;
  withheldOnMint?: string;
  withdrawAuthority?: string;
  hasPermanentDelegate: boolean;
  permanentDelegate?: string;
  hasInterestBearing: boolean;
  currentRate?: number;
  rateAuthority?: string;
}

// ── ICO ──────────────────────────────────────────────────────

/** Parameters to launch an ICO */
export interface LaunchICOParams {
  /** Token mint address */
  mint: PublicKey;
  /** Soft cap in SOL (lamports = value * 1e9) */
  softCapSol: number;
  /** Hard cap in SOL */
  hardCapSol: number;
  /** Start time as Unix timestamp (seconds). Default: now */
  startTime?: number;
  /** End time as Unix timestamp (seconds). Default: now + 30 days */
  endTime?: number;
  /** Amount of tokens to sell (human-readable units) */
  amount: number;
  /** Price per token in SOL */
  pricePerTokenSol: number;
}

/** Parameters to purchase tokens from an ICO */
export interface BuyTokenParams {
  /** Token mint address */
  mint: PublicKey;
  /** Amount of tokens to buy (human-readable units) */
  amount: number;
}

/** On-chain ICO config state */
export interface ICOConfigState {
  creator: PublicKey;
  mint: PublicKey;
  softCap: bigint;
  hardCap: bigint;
  startTime: number;
  endTime: number;
  tokenVault: PublicKey;
  totalRaised: bigint;
  pricePerToken: bigint;
}

// ── NFT ──────────────────────────────────────────────────────

/** Parameters to mint an NFT */
export interface MintNFTParams {
  name: string;
  symbol: string;
  description: string;
  /** Royalty percentage (e.g. 5 for 5%) */
  royalties: number;
  /** Image buffer */
  image: Uint8Array;
  /** Image filename */
  imageFileName: string;
  /** Image MIME type */
  imageContentType: string;
  /** Optional additional attributes */
  attributes?: Array<{ trait_type: string; value: string }>;
}

/** Result from NFT minting */
export interface MintNFTResult {
  /** The NFT mint public key */
  mint: string;
  /** Transaction signature */
  signature: string;
}
