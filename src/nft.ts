import { Umi } from '@metaplex-foundation/umi';
import { createGenericFile, generateSigner, percentAmount } from '@metaplex-foundation/umi';
import { createNft } from '@metaplex-foundation/mpl-token-metadata';
import base58 from 'bs58';
import type { MintNFTParams, MintNFTResult } from './types';

/**
 * Mint a Metaplex standard NFT on Solana.
 *
 * Uploads image + metadata to Irys, then mints the NFT via Umi.
 *
 * @param umi    - Configured Umi instance (identity set, uploader configured for Irys)
 * @param params - NFT metadata & image
 * @returns MintNFTResult with mint address and tx signature
 */
export async function mintNFT(umi: Umi, params: MintNFTParams): Promise<MintNFTResult> {
  // Upload image
  const genericFile = createGenericFile(params.image, params.imageFileName, {
    contentType: params.imageContentType,
  });
  const [imageUri] = await umi.uploader.upload([genericFile]);

  // Upload metadata JSON
  const metadataUri = await umi.uploader.uploadJson({
    name: params.name,
    symbol: params.symbol,
    description: params.description,
    image: imageUri,
    properties: {
      files: [{ type: params.imageContentType, uri: imageUri }],
    },
    attributes: params.attributes || [],
  });

  // Mint NFT
  const mint = generateSigner(umi);
  const tx = createNft(umi, {
    mint,
    name: params.name,
    symbol: params.symbol,
    uri: metadataUri,
    sellerFeeBasisPoints: percentAmount(params.royalties),
  });

  const result = await tx.sendAndConfirm(umi);
  const signature = base58.encode(result.signature);

  return {
    mint: mint.publicKey.toString(),
    signature,
  };
}
