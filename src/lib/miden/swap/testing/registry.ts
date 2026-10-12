import type { SwapConfig, SwapTokenConfig } from 'lib/remote-config/schema';

import type { SwapToken } from '../tokens';

/**
 * The testnet document's swap tokens (0xMiden/wallet-config testnet.json version 3), for the suites
 * that need a registry without loading a bridge config: install them with
 * `_setSwapTokensForTest(TEST_SWAP_TOKENS)`, or name their faucets in a stand-in document through
 * `TEST_SWAP_TOKEN_CONFIG`. The registry entries carry the bech32 address of each faucet, as the
 * wallet's does once the SDK has converted the document's hex (without the routing suffix the SDK
 * appends, which the shared SDK stand-ins do not model).
 */
export const TEST_SWAP_TOKEN_DECIMALS = 8;

export const TEST_TOKEN_IMIDEN: SwapToken = {
  symbol: 'IMIDEN',
  faucetId: 'mtst1ap6sq54y4ugv65g5rafvpmp2mg79kmry',
  decimals: TEST_SWAP_TOKEN_DECIMALS,
  logoSymbol: 'MIDEN'
};
export const TEST_TOKEN_IETH: SwapToken = {
  symbol: 'IETH',
  faucetId: 'mtst1ar3nfx83zanxz5ftttzdakrwcuw5fcz0',
  decimals: TEST_SWAP_TOKEN_DECIMALS,
  logoSymbol: 'ETH',
  priceSymbol: 'ETH'
};
export const TEST_TOKEN_IUSDT: SwapToken = {
  symbol: 'IUSDT',
  faucetId: 'mtst1aqy5dx8uf0znr5fkmvyxduufqg33953u',
  decimals: TEST_SWAP_TOKEN_DECIMALS,
  logoSymbol: 'USDC'
};
export const TEST_TOKEN_IBTC: SwapToken = {
  symbol: 'IBTC',
  faucetId: 'mtst1azhcg3xy5lqfzy2xv6km5fw96qqklx5k',
  decimals: TEST_SWAP_TOKEN_DECIMALS,
  logoSymbol: 'BTC',
  priceSymbol: 'BTC'
};

/** In the document's order: the first two are the default pair. */
export const TEST_SWAP_TOKENS: SwapToken[] = [TEST_TOKEN_IMIDEN, TEST_TOKEN_IETH, TEST_TOKEN_IUSDT, TEST_TOKEN_IBTC];

/**
 * The document's swap section as `TEST_BRIDGE_CONFIG` (lib/epoch/testing/bridge-config) carries it: each
 * faucet spelled as the registry entries above spell it, not in the document's hex, so a suite whose SDK
 * stand-in parses no id still matches a fixture token against the configured one. A parser test uses
 * `TEST_SWAP_TOKEN_CONFIG`.
 */
export const TEST_SWAP_SECTION: SwapConfig = {
  tokens: [
    { symbol: 'IMIDEN', faucetId: TEST_TOKEN_IMIDEN.faucetId, decimals: 8, logo: 'MIDEN' },
    { symbol: 'IETH', faucetId: TEST_TOKEN_IETH.faucetId, decimals: 8, logo: 'ETH', priceSymbol: 'ETH' },
    { symbol: 'IUSDT', faucetId: TEST_TOKEN_IUSDT.faucetId, decimals: 8, logo: 'USDC' },
    { symbol: 'IBTC', faucetId: TEST_TOKEN_IBTC.faucetId, decimals: 8, logo: 'BTC', priceSymbol: 'BTC' }
  ]
};

/** The same tokens as the document lists them, each faucet in hex. */
export const TEST_SWAP_TOKEN_CONFIG: SwapTokenConfig[] = [
  { symbol: 'IMIDEN', faucetId: '0x750052a4af10cd51141f52c0ec2ada', decimals: 8, logo: 'MIDEN' },
  { symbol: 'IETH', faucetId: '0xe33498f1176661512b5ac4ded86ec7', decimals: 8, logo: 'ETH', priceSymbol: 'ETH' },
  { symbol: 'IUSDT', faucetId: '0x094698fc4bc531d136db0866f38902', decimals: 8, logo: 'USDC' },
  { symbol: 'IBTC', faucetId: '0xaf8444c4a7c091114666adba25c5d0', decimals: 8, logo: 'BTC', priceSymbol: 'BTC' }
];
