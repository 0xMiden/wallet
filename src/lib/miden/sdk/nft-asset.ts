import type { NonFungibleAsset } from '@miden-sdk/miden-sdk/lazy';

import { truncateHash } from 'utils/string';

import { getBech32AddressFromAccountId } from './helpers';

/**
 * A non-fungible asset by what the user can recognise: its issuing faucet and a short form of its value word.
 *
 * No name: an NFT faucet's name is not readable through SDK 0.17, so the faucet address and the id are the whole
 * identity on an approval sheet. Spending limits never see these (amount-only, decided on #1600).
 */
export interface NftAsset {
  faucetId: string;
  assetId: string;
}

/** The faucet in the cache's bech32 spelling, and the head and tail of the asset's value word. */
export function toNft(asset: NonFungibleAsset): NftAsset {
  return {
    faucetId: getBech32AddressFromAccountId(asset.faucetId()),
    assetId: truncateHash(asset.intoWord().toHex(), 10, 6)
  };
}

/**
 * What makes two NFTs the same one: the faucet and the COMPLETE value word. The short asset id on a sheet drops the
 * middle of the word, so two distinct NFTs can share it and must never be matched by it.
 */
export function nftKey(asset: NonFungibleAsset): string {
  return `${getBech32AddressFromAccountId(asset.faucetId())}|${asset.intoWord().toHex()}`;
}

/** What an approval row says for one NFT, shared by every plain-text sheet. */
export function describeNft(nft: NftAsset, truncateFaucet: (faucetId: string) => string): string {
  return `NFT ${nft.assetId} from faucet ${truncateFaucet(nft.faucetId)}`;
}
