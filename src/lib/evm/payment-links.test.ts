import { evmPaymentLinks, evmPaymentLinksOf, trustCoinOfEvmChain, trustPaymentLink } from './payment-links';

const TO = '0x7a3f09d1000000000000000000000000c91e2b4a';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ZERO = '0x0000000000000000000000000000000000000000';

describe('trustCoinOfEvmChain', () => {
  it.each([
    [1, 60],
    [8453, 8453],
    [42161, 10042221],
    [10, 10000070],
    [11155111, undefined]
  ])('maps chain %i to Trust coin %p', (chainId, coin) => {
    expect(trustCoinOfEvmChain(chainId)).toBe(coin);
  });
});

describe('trustPaymentLink', () => {
  it('adds a memo only when one is given', () => {
    expect(trustPaymentLink('c60', TO, '1').url).toBe(`trust://send?asset=c60&address=${TO}&amount=1`);
    expect(trustPaymentLink('c60', TO, '1', 'm 1').url).toBe(`trust://send?asset=c60&address=${TO}&amount=1&memo=m+1`);
  });
});

describe('evmPaymentLinksOf', () => {
  it('gives the Trust link alone for a memo', () => {
    const links = evmPaymentLinksOf({
      chainId: 1,
      trustCoin: 60,
      token: undefined,
      to: TO,
      units: '1',
      amount: '1',
      memo: 'x'
    });
    expect(links.map(link => link.wallet)).toEqual(['trust']);
  });
});

describe('evmPaymentLinks', () => {
  it('builds Trust, MetaMask and Rainbow links for a token in exact base units', () => {
    expect(evmPaymentLinks({ chainId: 8453, token: USDC, to: TO, amountBaseUnits: 123_456_789n, decimals: 6 })).toEqual(
      [
        { wallet: 'trust', url: `trust://send?asset=c8453_t${USDC}&address=${TO}&amount=123.456789` },
        { wallet: 'metamask', url: `metamask://send/${USDC}@8453/transfer?address=${TO}&uint256=123456789` },
        { wallet: 'rainbow', url: `ethereum:${USDC}@8453/transfer?address=${TO}&uint256=123456789` }
      ]
    );
  });

  it.each<[`0x${string}` | null]>([[null], [ZERO]])('builds native coin links in wei for token %p', token => {
    expect(evmPaymentLinks({ chainId: 1, token, to: TO, amountBaseUnits: 100000000000000001n, decimals: 18 })).toEqual([
      { wallet: 'trust', url: `trust://send?asset=c60&address=${TO}&amount=0.100000000000000001` },
      { wallet: 'metamask', url: `metamask://send/${TO}@1?value=100000000000000001` },
      { wallet: 'rainbow', url: `ethereum:${TO}@1?value=100000000000000001` }
    ]);
  });

  it.each<[string, Parameters<typeof evmPaymentLinks>[0]]>([
    ['a chain with no mapping', { chainId: 11155111, token: USDC, to: TO, amountBaseUnits: 1n, decimals: 6 }],
    ['a bad recipient', { chainId: 1, token: USDC, to: '0x12', amountBaseUnits: 1n, decimals: 6 }],
    ['a bad token', { chainId: 1, token: '0x12', to: TO, amountBaseUnits: 1n, decimals: 6 }],
    ['a zero amount', { chainId: 1, token: USDC, to: TO, amountBaseUnits: 0n, decimals: 6 }],
    ['negative decimals', { chainId: 1, token: USDC, to: TO, amountBaseUnits: 1n, decimals: -1 }],
    ['fractional decimals', { chainId: 1, token: USDC, to: TO, amountBaseUnits: 1n, decimals: 1.5 }],
    ['too many decimals', { chainId: 1, token: USDC, to: TO, amountBaseUnits: 1n, decimals: 39 }]
  ])('gives no link for %s', (_name, input) => {
    expect(evmPaymentLinks(input)).toEqual([]);
  });
});
