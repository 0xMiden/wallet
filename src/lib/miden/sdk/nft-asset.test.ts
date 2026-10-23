import { describeNft, nftKey, toNft } from './nft-asset';

jest.mock('./helpers', () => ({
  getBech32AddressFromAccountId: (id: { __faucet: string }) => `bech32:${id.__faucet}`
}));

const word = (hex: string) => ({ toHex: () => hex });
const nft = (faucet: string, hex: string) =>
  ({ faucetId: () => ({ __faucet: faucet }), intoWord: () => word(hex) }) as any;

// Same head and tail, different middle: what the short id on a sheet cannot tell apart.
const WORD_ONE = `0x${'ab'.repeat(5)}${'11'.repeat(22)}${'cd'.repeat(3)}`;
const WORD_TWO = `0x${'ab'.repeat(5)}${'22'.repeat(22)}${'cd'.repeat(3)}`;

describe('nft-asset', () => {
  it('shortens the value word to its head and tail beside the bech32 faucet', () => {
    expect(toNft(nft('f1', WORD_ONE))).toEqual({ faucetId: 'bech32:f1', assetId: '0xabababab…cdcdcd' });
  });

  it('gives two NFTs that share a short id different keys, because the key spans the whole word', () => {
    const one = nft('f1', WORD_ONE);
    const two = nft('f1', WORD_TWO);

    expect(toNft(one).assetId).toBe(toNft(two).assetId);
    expect(nftKey(one)).not.toBe(nftKey(two));
  });

  it('keys the same faucet and word identically, and the same word on another faucet differently', () => {
    expect(nftKey(nft('f1', WORD_ONE))).toBe(nftKey(nft('f1', WORD_ONE)));
    expect(nftKey(nft('f1', WORD_ONE))).not.toBe(nftKey(nft('f2', WORD_ONE)));
  });

  it('describes an NFT for a text sheet with its faucet label', () => {
    expect(describeNft({ faucetId: 'f1', assetId: '0xaa…bb' }, id => `<${id}>`)).toBe('NFT 0xaa…bb from faucet <f1>');
  });
});
