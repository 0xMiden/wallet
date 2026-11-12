import type { SwapConfig } from 'lib/remote-config/schema';
import type { SwapPairs, SwapPairsToken } from 'lib/remote-config/swap-pairs';

import type { SwapToken } from '../tokens';

/**
 * Four of the tokens the testnet solver lists (`GET /v2/pairs`), for the suites that need a registry
 * without loading a bridge config: install them with `_setSwapTokensForTest(TEST_SWAP_TOKENS)`, or
 * give a stand-in snapshot the solver's answer through `TEST_SWAP_PAIRS`. The registry entries carry
 * the bech32 address of each faucet, as the wallet's does once the SDK has converted the solver's hex
 * (without the routing suffix the SDK appends, which the shared SDK stand-ins do not model).
 */
export const TEST_SWAP_TOKEN_DECIMALS = 8;

export const TEST_TOKEN_IMIDEN: SwapToken = {
  symbol: 'IMIDEN',
  faucetId: 'mtst1ap6sq54y4ugv65g5rafvpmp2mg79kmry',
  decimals: TEST_SWAP_TOKEN_DECIMALS
};
export const TEST_TOKEN_IETH: SwapToken = {
  symbol: 'IETH',
  faucetId: 'mtst1ar3nfx83zanxz5ftttzdakrwcuw5fcz0',
  decimals: TEST_SWAP_TOKEN_DECIMALS,
  priceSymbol: 'ETH'
};
export const TEST_TOKEN_IUSDT: SwapToken = {
  symbol: 'IUSDT',
  faucetId: 'mtst1aqy5dx8uf0znr5fkmvyxduufqg33953u',
  decimals: TEST_SWAP_TOKEN_DECIMALS
};
export const TEST_TOKEN_IBTC: SwapToken = {
  symbol: 'IBTC',
  faucetId: 'mtst1azhcg3xy5lqfzy2xv6km5fw96qqklx5k',
  decimals: TEST_SWAP_TOKEN_DECIMALS,
  priceSymbol: 'BTC'
};

/** In the solver's order. */
export const TEST_SWAP_TOKENS: SwapToken[] = [TEST_TOKEN_IMIDEN, TEST_TOKEN_IETH, TEST_TOKEN_IUSDT, TEST_TOKEN_IBTC];

/** The document's swap section as `TEST_BRIDGE_CONFIG` (lib/epoch/testing/bridge-config) carries it. */
export const TEST_SWAP_SECTION: SwapConfig = { etaUrl: 'https://quotes.test' };

/** A registry token as the solver lists it, with `faucetId` in the spelling the caller gives. */
export const testSwapPairsToken = (token: SwapToken, faucetId: string = token.faucetId): SwapPairsToken => ({
  faucetId,
  ticker: token.symbol,
  decimals: token.decimals,
  ...(token.priceSymbol === undefined ? {} : { binanceAsset: token.priceSymbol })
});

/**
 * The solver's answer as `TEST_BRIDGE_CONFIG_SNAPSHOT` carries it: each faucet spelled as the registry
 * entries above spell it, not in the solver's hex, so a suite whose SDK stand-in parses no id still
 * matches a fixture token against the listed one. The first pair is the one the swap form opens on.
 * A parser test uses `TEST_SWAP_PAIRS_RESPONSE`.
 */
export const TEST_SWAP_PAIRS: SwapPairs = {
  tokens: TEST_SWAP_TOKENS.map(token => testSwapPairsToken(token)),
  pairs: [
    { faucetIds: [TEST_TOKEN_IMIDEN.faucetId, TEST_TOKEN_IETH.faucetId] },
    { faucetIds: [TEST_TOKEN_IETH.faucetId, TEST_TOKEN_IUSDT.faucetId] },
    { faucetIds: [TEST_TOKEN_IBTC.faucetId, TEST_TOKEN_IUSDT.faucetId] }
  ]
};

/** The same tokens and pairs as the solver answers them: each faucet in hex, each priced asset as the solver names it. */
export const TEST_SWAP_PAIRS_RESPONSE = {
  tokens: [
    { faucetId: '0x750052a4af10cd51141f52c0ec2ada', ticker: 'IMIDEN', decimals: 8, binanceAsset: 'SOL' },
    { faucetId: '0xe33498f1176661512b5ac4ded86ec7', ticker: 'IETH', decimals: 8, binanceAsset: 'ETH' },
    { faucetId: '0x094698fc4bc531d136db0866f38902', ticker: 'IUSDT', decimals: 8, binanceAsset: 'USDT' },
    { faucetId: '0xaf8444c4a7c091114666adba25c5d0', ticker: 'IBTC', decimals: 8, binanceAsset: 'BTC' }
  ],
  pairs: [
    {
      name: 'IMIDEN-IETH',
      binanceSymbol: 'SOLETH',
      faucetIds: ['0x750052a4af10cd51141f52c0ec2ada', '0xe33498f1176661512b5ac4ded86ec7']
    },
    {
      name: 'IETH-IUSDT',
      binanceSymbol: 'ETHUSDT',
      faucetIds: ['0xe33498f1176661512b5ac4ded86ec7', '0x094698fc4bc531d136db0866f38902']
    },
    {
      name: 'IBTC-IUSDT',
      binanceSymbol: 'BTCUSDT',
      faucetIds: ['0xaf8444c4a7c091114666adba25c5d0', '0x094698fc4bc531d136db0866f38902']
    }
  ]
};
