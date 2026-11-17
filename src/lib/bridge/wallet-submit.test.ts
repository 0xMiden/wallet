import { accounts, now, referenceSnapshot, testRoute } from './testing/fixtures';
import { reviewedErc20Transfer } from './testing/operation-fixtures';
import { submitReviewedBridge, walletBridgeBalanceCap } from './wallet-submit';

const mockState = {
  balances: { [accounts.midenAccount]: [] },
  balancesLoading: { [accounts.midenAccount]: false },
  balanceReadFailed: { [accounts.midenAccount]: false },
  tokenPricesStatus: 'ready',
  tokenPrices: { ETH: { price: 10, observedAt: now, change24h: 0, percentageChange24h: 0 } }
};
jest.mock('lib/store', () => ({ getIntercom: jest.fn(), useWalletStore: { getState: () => mockState } }));
jest.mock('lib/miden/activity', () => ({
  requestSWTransactionProcessing: jest.fn(),
  startBackgroundTransactionProcessing: jest.fn()
}));
jest.mock('lib/miden/back/miden-client-proxy', () => ({ midenClientProxy: {} }));
jest.mock('lib/miden/sdk/miden-client', () => ({ withWasmClientLock: async (fn: () => unknown) => fn() }));
jest.mock('lib/miden/guardian/account', () => ({ resolveGuardianEndpoint: jest.fn() }));
jest.mock('lib/remote-config/runtime', () => ({ getBridgeConfigSnapshot: () => referenceSnapshot('testnet') }));

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(now);
  mockState.balancesLoading[accounts.midenAccount] = false;
  mockState.balanceReadFailed[accounts.midenAccount] = false;
  mockState.tokenPricesStatus = 'ready';
  mockState.tokenPrices.ETH.observedAt = now;
});
afterEach(() => jest.restoreAllMocks());

it('uses actual current wallet snapshots and the original USDC-at-par cap, including enabled and exceeded deposits', () => {
  const route = reviewedErc20Transfer('agglayer').route;
  expect(walletBridgeBalanceCap(route, '1.000000', accounts.midenAccount).status).toBe('allowed');
  expect(walletBridgeBalanceCap(route, '1232.462001', accounts.midenAccount).status).toBe('exceeded');
  expect(walletBridgeBalanceCap(route, '1', 'missing-account').status).toBe('unavailable');
});

it.each(['loading', 'failed', 'prices'])('does not authorize a capped receive from a %s snapshot', kind => {
  if (kind === 'loading') mockState.balancesLoading[accounts.midenAccount] = true;
  if (kind === 'failed') mockState.balanceReadFailed[accounts.midenAccount] = true;
  if (kind === 'prices') mockState.tokenPricesStatus = 'error';
  expect(walletBridgeBalanceCap(testRoute(), '1', accounts.midenAccount).status).toBe('unavailable');
});

it('never substitutes a stale or nominal market price and never imposes an inbound cap on a native withdrawal', () => {
  expect(walletBridgeBalanceCap(testRoute(), '1', accounts.midenAccount).status).toBe('allowed');
  mockState.tokenPrices.ETH.observedAt = now - 86400000;
  expect(walletBridgeBalanceCap(testRoute(), '1', accounts.midenAccount).status).toBe('unavailable');
  expect(walletBridgeBalanceCap(testRoute('send'), '1', accounts.midenAccount).status).toBe('allowed');
});

it('a revoked live review cannot reach an external wallet before admission', async () => {
  const review = reviewedErc20Transfer('agglayer');
  const wallet = jest.fn();
  const result = await submitReviewedBridge(review, {
    getContext: () => {
      throw new Error('Review invalidated');
    },
    getEvmWallet: wallet,
    onOperation: jest.fn(),
    signTransaction: async () => new Uint8Array(),
    guardianProvider: {
      getAccounts: async () => [],
      getPublicKeyForCommitment: async () => '',
      signWord: async () => ''
    }
  });
  expect(result).toEqual({ kind: 'rejected' });
  expect(wallet).not.toHaveBeenCalled();
});
