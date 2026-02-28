import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  TransactionMessage,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  createInitializePermanentDelegateInstruction,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  createMintToInstruction,
  createInitializeTransferHookInstruction,
  createInitializeInterestBearingMintInstruction,
  createInitializeNonTransferableMintInstruction,
  createEnableRequiredMemoTransfersInstruction,
  createEnableCpiGuardInstruction,
  createReallocateInstruction,
  getMintLen,
  ExtensionType,
} from '@solana/spl-token';
import { Program, AnchorProvider, BN } from '@coral-xyz/anchor';
import { Umi } from '@metaplex-foundation/umi';
import { createSignerFromKeypair, percentAmount, createGenericFile } from '@metaplex-foundation/umi';
import { createV1, TokenStandard } from '@metaplex-foundation/mpl-token-metadata';
import { toWeb3JsInstruction } from '@metaplex-foundation/umi-web3js-adapters';
import { TRANSFER_HOOK_PROGRAM_ID, TREASURY_ADDRESS } from './constants';
import type { TokenMetadata, TokenExtensions, TransferHookConfig, CreateTokenResult } from './types';
import transferHookIdl from '../idl/transfer_hook.json';

/**
 * Create a Token-2022 token with optional extensions and Metaplex metadata.
 *
 * This mirrors the full TokenCreator flow from the frontend:
 *   Tx1: CreateAccount → Extension inits → InitializeMint → CreateATA → MintTo → Reallocate → Enable account extensions → InitializeRegistry
 *   Tx2: Metaplex createV1 metadata
 *
 * @param connection  - Solana RPC connection
 * @param payer       - Wallet public key (fee payer & mint authority)
 * @param walletSign  - `wallet.signTransaction` function
 * @param umi         - Configured Umi instance (with identity set to the wallet, uploader configured)
 * @param metadata    - Token name, symbol, description, decimals, supply, image
 * @param extensions  - Optional Token-2022 extensions to enable
 * @param hookConfig  - Optional Transfer Hook configuration (trading hours, limits, NFT gate)
 * @returns CreateTokenResult with mint address, ATA, and tx signatures
 */
export async function createToken(
  connection: Connection,
  payer: PublicKey,
  walletSign: (tx: VersionedTransaction) => Promise<VersionedTransaction>,
  umi: Umi,
  metadata: TokenMetadata,
  extensions: TokenExtensions = {},
  hookConfig: TransferHookConfig = {}
): Promise<CreateTokenResult> {
  // ── Extension conflict logic ───────────────────────────────
  const isTransferHookDisabled = !!extensions.nonTransferable || !!extensions.cpiGuard;
  const isTransferFeeDisabled = !!extensions.nonTransferable;
  const isPermanentDelegateDisabled = !!extensions.nonTransferable;

  // ══ Step 1: Upload Image & Metadata to Irys ══════════════
  const genericFile = createGenericFile(metadata.image, metadata.imageFileName, {
    contentType: metadata.imageContentType,
  });
  const [imageUri] = await umi.uploader.upload([genericFile]);

  const metadataUri = await umi.uploader.uploadJson({
    name: metadata.name,
    symbol: metadata.symbol,
    description: metadata.description,
    image: imageUri,
    properties: {
      files: [{ type: metadata.imageContentType, uri: imageUri }],
    },
  });

  // ══ Step 2: Build Token-2022 Mint Transaction ═════════════
  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;

  // Build extension type list
  const extensionTypes: ExtensionType[] = [];
  if (!isTransferHookDisabled) extensionTypes.push(ExtensionType.TransferHook);
  if (extensions.permanentDelegation && !isPermanentDelegateDisabled)
    extensionTypes.push(ExtensionType.PermanentDelegate);
  if (extensions.transferFee && !isTransferFeeDisabled)
    extensionTypes.push(ExtensionType.TransferFeeConfig);
  if (extensions.interestBearing) extensionTypes.push(ExtensionType.InterestBearingConfig);
  if (extensions.nonTransferable) extensionTypes.push(ExtensionType.NonTransferable);

  const mintLen = getMintLen(extensionTypes);
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

  const transaction = new Transaction();

  // 1. Create Account
  transaction.add(
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: mint,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    })
  );

  // 2. Extension inits BEFORE InitializeMint
  if (extensions.nonTransferable) {
    transaction.add(
      createInitializeNonTransferableMintInstruction(mint, TOKEN_2022_PROGRAM_ID)
    );
  }

  if (extensions.permanentDelegation && !isPermanentDelegateDisabled) {
    transaction.add(
      createInitializePermanentDelegateInstruction(mint, payer, TOKEN_2022_PROGRAM_ID)
    );
  }

  if (extensions.transferFee && !isTransferFeeDisabled) {
    transaction.add(
      createInitializeTransferFeeConfigInstruction(
        mint,
        payer,
        payer,
        extensions.transferFee.feeBasisPoints,
        extensions.transferFee.maxFee,
        TOKEN_2022_PROGRAM_ID
      )
    );
  }

  if (extensions.interestBearing) {
    transaction.add(
      createInitializeInterestBearingMintInstruction(
        mint,
        payer,
        extensions.interestBearing.rate,
        TOKEN_2022_PROGRAM_ID
      )
    );
  }

  // Transfer Hook init (only if not disabled)
  if (!isTransferHookDisabled) {
    transaction.add(
      createInitializeTransferHookInstruction(
        mint,
        payer,
        TRANSFER_HOOK_PROGRAM_ID,
        TOKEN_2022_PROGRAM_ID
      )
    );
  }

  // 3. Initialize Mint
  transaction.add(
    createInitializeMintInstruction(
      mint,
      metadata.decimals,
      payer,
      payer,
      TOKEN_2022_PROGRAM_ID
    )
  );

  // 4. Create ATA
  const ata = getAssociatedTokenAddressSync(mint, payer, false, TOKEN_2022_PROGRAM_ID);
  transaction.add(
    createAssociatedTokenAccountInstruction(payer, ata, payer, mint, TOKEN_2022_PROGRAM_ID)
  );

  // 5. Mint Initial Supply
  const supplyUnits = BigInt(metadata.supply * 10 ** metadata.decimals);
  transaction.add(
    createMintToInstruction(mint, ata, payer, supplyUnits, [], TOKEN_2022_PROGRAM_ID)
  );

  // 5b. Post-mint ATA-level extensions (MemoTransfer, CPI Guard)
  const accountExtensionTypes: ExtensionType[] = [];
  if (extensions.memoTransfer) accountExtensionTypes.push(ExtensionType.MemoTransfer);
  if (extensions.cpiGuard) accountExtensionTypes.push(ExtensionType.CpiGuard);

  if (accountExtensionTypes.length > 0) {
    transaction.add(
      createReallocateInstruction(ata, payer, accountExtensionTypes, payer, [], TOKEN_2022_PROGRAM_ID)
    );
  }

  if (extensions.memoTransfer) {
    transaction.add(
      createEnableRequiredMemoTransfersInstruction(ata, payer, [], TOKEN_2022_PROGRAM_ID)
    );
  }

  if (extensions.cpiGuard) {
    transaction.add(
      createEnableCpiGuardInstruction(ata, payer, [], TOKEN_2022_PROGRAM_ID)
    );
  }

  // 6. Initialize Transfer Hook Registry (only if hook is enabled)
  if (!isTransferHookDisabled) {
    const provider = new AnchorProvider(
      connection,
      { publicKey: payer, signTransaction: walletSign, signAllTransactions: async (txs: any) => txs } as any,
      { commitment: 'confirmed' }
    );
    const program = new Program(transferHookIdl as any, provider);

    const [config] = PublicKey.findProgramAddressSync(
      [Buffer.from('config'), mint.toBuffer()],
      TRANSFER_HOOK_PROGRAM_ID
    );
    const [extraAccountMetaList] = PublicKey.findProgramAddressSync(
      [Buffer.from('extra-account-metas'), mint.toBuffer()],
      TRANSFER_HOOK_PROGRAM_ID
    );

    const openMinute = hookConfig.tradingHours ? hookConfig.tradingHours.openMinuteUTC : null;
    const closeMinute = hookConfig.tradingHours ? hookConfig.tradingHours.closeMinuteUTC : null;
    const maxTransferAmt = hookConfig.transferLimits
      ? new BN(hookConfig.transferLimits.max * 10 ** metadata.decimals)
      : new BN('18446744073709551615'); // u64::MAX
    const minTransferAmt = hookConfig.transferLimits
      ? new BN(hookConfig.transferLimits.min * 10 ** metadata.decimals)
      : new BN(0);
    const nftMint = hookConfig.nftMintAddress || PublicKey.default;

    const initRegistryIx = await program.methods
      .initializeRegistry(openMinute, closeMinute, maxTransferAmt, minTransferAmt, nftMint)
      .accounts({
        payer,
        treasury: TREASURY_ADDRESS,
        mint,
        config,
        extraAccountMetaList,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    transaction.add(initRegistryIx);
  }

  // ══ Step 3: Build Metaplex Metadata Tx ════════════════════
  const umiMintKeypair = umi.eddsa.createKeypairFromSecretKey(mintKeypair.secretKey);
  const umiMintSigner = createSignerFromKeypair(umi, umiMintKeypair);

  const metaTxBuilder = createV1(umi, {
    mint: umiMintSigner,
    authority: umi.identity,
    payer: umi.identity,
    updateAuthority: umi.identity,
    name: metadata.name,
    symbol: metadata.symbol,
    uri: metadataUri,
    sellerFeeBasisPoints: percentAmount(0),
    tokenStandard: TokenStandard.Fungible,
    isMutable: true,
  });

  // ══ Step 4: Sign & Send Tx1 (Mint + Extensions + Hook) ════
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

  const messageV0 = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: transaction.instructions,
  }).compileToV0Message();

  const versionedTx = new VersionedTransaction(messageV0);
  versionedTx.sign([mintKeypair]);

  // Simulate first
  const simResult = await connection.simulateTransaction(versionedTx);
  if (simResult.value.err) {
    throw new Error(
      `Mint simulation failed: ${JSON.stringify(simResult.value.err)}\nLogs:\n${simResult.value.logs?.join('\n')}`
    );
  }

  const signedTx = await walletSign(versionedTx);
  const mintTxSig = await connection.sendRawTransaction(signedTx.serialize(), { skipPreflight: true });
  await connection.confirmTransaction(
    { signature: mintTxSig, blockhash, lastValidBlockHeight },
    'confirmed'
  );

  // ══ Step 5: Send Tx2 (Metaplex Metadata) ══════════════════
  const metadataTx = new Transaction();
  const metaIxs = metaTxBuilder.getInstructions();
  for (const ix of metaIxs) {
    metadataTx.add(toWeb3JsInstruction(ix));
  }

  const { blockhash: bh2, lastValidBlockHeight: lvbh2 } = await connection.getLatestBlockhash('confirmed');
  const msgV0Meta = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: bh2,
    instructions: metadataTx.instructions,
  }).compileToV0Message();

  const versionedMetaTx = new VersionedTransaction(msgV0Meta);
  versionedMetaTx.sign([mintKeypair]);

  const simResult2 = await connection.simulateTransaction(versionedMetaTx);
  if (simResult2.value.err) {
    throw new Error(
      `Metadata simulation failed: ${JSON.stringify(simResult2.value.err)}\nLogs:\n${simResult2.value.logs?.join('\n')}`
    );
  }

  const signedMetaTx = await walletSign(versionedMetaTx);
  const metaTxSig = await connection.sendRawTransaction(signedMetaTx.serialize(), {
    skipPreflight: true,
  });
  await connection.confirmTransaction(
    { signature: metaTxSig, blockhash: bh2, lastValidBlockHeight: lvbh2 },
    'confirmed'
  );

  return {
    mint,
    ata,
    mintTxSignature: mintTxSig,
    metadataTxSignature: metaTxSig,
  };
}
