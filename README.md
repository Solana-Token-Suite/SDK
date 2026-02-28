# Solana Token Suite SDK

A comprehensive TypeScript SDK that mirrors all functionality from the Solana Token Suite frontend — create Token-2022 tokens with extensions, manage transfer hooks, launch ICOs, and mint NFTs.

All tokens use the **shared Transfer Hook program** (`AjNBZRCm6jsPjPRiZ3hbAitg9KEgCYqKmGm675Fpi6XU`) and **ICO program** (`3YXfnw8Lk1PsuwbyRxSjHHVwxxDLiDH1BHohgbZcW4zb`) deployed on Solana.

## Installation

```bash
npm install @solana-token-suite/sdk
```

## Quick Start

### 1. Create a Token-2022 Token with Extensions

```typescript
import { Connection, PublicKey } from '@solana/web3.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { irysUploader } from '@metaplex-foundation/umi-uploader-irys';
import { walletAdapterIdentity } from '@metaplex-foundation/umi-signer-wallet-adapters';
import { createToken, istTimeToUtcMinute } from '@solana-token-suite/sdk';
import fs from 'fs';

const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

// Set up Umi (with your wallet adapter)
const umi = createUmi('https://api.devnet.solana.com')
  .use(irysUploader())
  .use(walletAdapterIdentity(wallet));

const image = fs.readFileSync('./token-logo.png');

const result = await createToken(
  connection,
  wallet.publicKey,
  wallet.signTransaction,
  umi,
  {
    name: 'My Token',
    symbol: 'MTK',
    description: 'A powerful Token-2022 token',
    decimals: 9,
    supply: 1_000_000,
    image: new Uint8Array(image),
    imageFileName: 'token-logo.png',
    imageContentType: 'image/png',
  },
  // Optional extensions
  {
    transferFee: { feeBasisPoints: 50, maxFee: 5000n },        // 0.5% fee
    permanentDelegation: true,                                  // burn/clawback
    interestBearing: { rate: 500 },                            // 5% interest
    memoTransfer: true,                                        // require memo
    // nonTransferable: true,                                  // soul-bound (disables hook & fee)
    // cpiGuard: true,                                         // CPI protection (disables hook)
  },
  // Optional Transfer Hook config
  {
    tradingHours: {
      openMinuteUTC: istTimeToUtcMinute('09:00'),   // 9 AM IST → UTC
      closeMinuteUTC: istTimeToUtcMinute('17:00'),  // 5 PM IST → UTC
    },
    transferLimits: { min: 1, max: 100_000 },
    // nftMintAddress: new PublicKey('...'),         // NFT-gated
  }
);

console.log('Mint:', result.mint.toBase58());
console.log('ATA:', result.ata.toBase58());
console.log('Tx1:', result.mintTxSignature);
console.log('Tx2:', result.metadataTxSignature);
```

### 2. Manage Transfer Hook Policies

```typescript
import {
  fetchHookConfig,
  updateFlags,
  editConfig,
  addToWhitelist,
  removeFromWhitelist,
  detectExtensions,
} from '@solana-token-suite/sdk';

const mint = new PublicKey('YOUR_TOKEN_MINT');

// Detect extensions on a mint
const extensions = await detectExtensions(connection, mint);
console.log('Has Transfer Hook:', extensions.hasTransferHook);
console.log('Has Transfer Fee:', extensions.hasTransferFee);

// Fetch current hook config
const config = await fetchHookConfig(connection, wallet.publicKey, wallet.signTransaction, mint);
console.log('Trading Hours:', config?.tradingTimeEnabled);
console.log('Whitelist:', config?.whitelistEnabled);

// Update policy flags
await updateFlags(connection, wallet.publicKey, wallet.signTransaction, mint, {
  whitelistEnabled: true,
  tradingTimeEnabled: true,
  maxTransferEnabled: true,
  nftGated: false,
});

// Edit config values (only non-null fields are updated)
await editConfig(connection, wallet.publicKey, wallet.signTransaction, mint, {
  openMinute: 180,   // 3:00 AM UTC
  closeMinute: 720,  // 12:00 PM UTC
  maxTransferAmount: 1_000_000_000_000n, // in base units
  minTransferAmount: 1_000_000_000n,
});

// Whitelist management
await addToWhitelist(connection, wallet.publicKey, wallet.signTransaction, mint,
  new PublicKey('USER_TO_WHITELIST')
);

await removeFromWhitelist(connection, wallet.publicKey, wallet.signTransaction, mint,
  new PublicKey('USER_TO_REMOVE')
);
```

### 3. Token-2022 Extension Management

```typescript
import {
  harvestTransferFees,
  delegateBurn,
  delegateTransfer,
  updateInterestRate,
} from '@solana-token-suite/sdk';

const mint = new PublicKey('YOUR_TOKEN_MINT');

// Harvest transfer fees from all holders → your wallet
const sig = await harvestTransferFees(connection, wallet.publicKey, wallet.signTransaction, mint);

// Permanent Delegate: burn tokens from any holder
await delegateBurn(
  connection, wallet.publicKey, wallet.signTransaction,
  mint,
  new PublicKey('HOLDER_WALLET'),
  100,  // amount (human-readable)
  9     // decimals
);

// Permanent Delegate: clawback (transfer from any holder to another)
await delegateTransfer(
  connection, wallet.publicKey, wallet.signTransaction,
  mint,
  new PublicKey('SOURCE_WALLET'),
  new PublicKey('DEST_WALLET'),
  50,   // amount
  9     // decimals
);

// Update interest rate (basis points)
await updateInterestRate(connection, wallet.publicKey, wallet.signTransaction, mint, 750); // 7.5%
```

### 4. Launch & Buy ICO

```typescript
import { launchICO, buyToken, fetchICOConfig } from '@solana-token-suite/sdk';

const mint = new PublicKey('YOUR_TOKEN_MINT');

// Launch an ICO
const launchSig = await launchICO(connection, wallet.publicKey, wallet.signTransaction, {
  mint,
  softCapSol: 10,
  hardCapSol: 100,
  startTime: Math.floor(Date.now() / 1000),
  endTime: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
  amount: 500_000,
  pricePerTokenSol: 0.001,
});

// Buy tokens from an ICO
const buySig = await buyToken(connection, wallet.publicKey, wallet.signTransaction, {
  mint,
  amount: 1000,
});

// Fetch ICO state
const icoConfig = await fetchICOConfig(connection, wallet.publicKey, wallet.signTransaction, mint);
console.log('Total Raised:', icoConfig?.totalRaised);
console.log('Price:', icoConfig?.pricePerToken);
```

### 5. Mint an NFT

```typescript
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { irysUploader } from '@metaplex-foundation/umi-uploader-irys';
import { walletAdapterIdentity } from '@metaplex-foundation/umi-signer-wallet-adapters';
import { mintNFT } from '@solana-token-suite/sdk';

const umi = createUmi('https://api.devnet.solana.com')
  .use(irysUploader())
  .use(walletAdapterIdentity(wallet));

const image = fs.readFileSync('./nft-artwork.png');

const result = await mintNFT(umi, {
  name: 'My Epic NFT',
  symbol: 'EPIC',
  description: 'A legendary NFT on Solana',
  royalties: 5, // 5% creator royalties
  image: new Uint8Array(image),
  imageFileName: 'nft-artwork.png',
  imageContentType: 'image/png',
  attributes: [
    { trait_type: 'Rarity', value: 'Legendary' },
    { trait_type: 'Power', value: '9001' },
  ],
});

console.log('NFT Mint:', result.mint);
console.log('Tx:', result.signature);
```

## Utility Functions

```typescript
import {
  // Time conversion helpers
  istTimeToUtcMinute,     // "09:00" IST → UTC minute-of-day
  utcMinuteToIstTime,     // UTC minute → "HH:MM" IST string
  utcMinuteToUtcTime,     // UTC minute → "HH:MM" UTC string

  // PDA derivation
  deriveHookConfigPDA,          // Transfer Hook config PDA
  deriveExtraAccountMetaListPDA, // Extra account meta list PDA
  deriveWhitelistMarkerPDA,     // Whitelist marker PDA
  deriveICOConfigPDA,           // ICO global config PDA
  deriveICOConfigAccountPDA,    // ICO per-mint config PDA
  deriveICOVaultAccountPDA,     // ICO vault PDA
  deriveMetadataPDA,            // Metaplex metadata PDA

  // Transaction helpers
  buildVersionedTransaction,           // Build a VersionedTransaction
  sendAndConfirmVersionedTransaction,  // Send and confirm
  sendInstructions,                    // Build + sign + send instructions

  // Transfer Hook
  resolveTransferHookAccounts,  // Resolve extra accounts for hook-aware transfers
} from '@solana-token-suite/sdk';
```

## Extension Conflict Rules

| Extension          | Disables                                          |
| ------------------ | ------------------------------------------------- |
| **NonTransferable** | TransferHook, TransferFee, PermanentDelegate     |
| **CPI Guard**       | TransferHook                                     |

These conflicts are automatically enforced during token creation.

## Programs

| Program         | Address                                        |
| --------------- | ---------------------------------------------- |
| Transfer Hook   | `AjNBZRCm6jsPjPRiZ3hbAitg9KEgCYqKmGm675Fpi6XU` |
| ICO             | `3YXfnw8Lk1PsuwbyRxSjHHVwxxDLiDH1BHohgbZcW4zb` |
| Treasury        | `HtGXcunbPUU54wMa9ZiXdMXvv1b5ppT7DeFLJWdtH7Lr` |

## License

MIT
