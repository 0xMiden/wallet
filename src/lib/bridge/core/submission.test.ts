import { assertReviewedBridge, type BridgeReviewContext, type ReviewedTransfer } from './review';
import { verifyBridgeSubmission } from './submission';
import { accounts, now, testRoute } from '../testing/fixtures';

function setup(): ReviewedTransfer {
  const route = testRoute();
  return {
    route,
    amount: '1.00000000',
    accounts: { ...accounts },
    quote: {
      kind: 'agglayer',
      received: '1',
      validity: { kind: 'time', expiresAt: now + 60_000 },
      request: { routeId: route.id, recovery: structuredClone(route.recovery), amount: '1.00000000', ...accounts }
    }
  };
}
it('accepts an unchanged exact review across JSON transport and key ordering', () => {
  const review = setup();
  const current: BridgeReviewContext = structuredClone(review);
  current.accounts.evmAddress = current.accounts.evmAddress.toUpperCase();
  expect(() => assertReviewedBridge(review, current, now)).not.toThrow();
});
it.each([
  'amount',
  'miden',
  'evm',
  'route',
  'asset',
  'precision',
  'config',
  'scope',
  'disabled',
  'expiry',
  'quote-request',
  'missing-quote'
])('requires another review when %s changes', change => {
  const review = setup();
  const current: BridgeReviewContext = structuredClone(review);
  if (change === 'amount') current.amount = '1';
  if (change === 'miden') current.accounts.midenAccount = `0x${'2'.repeat(30)}`;
  if (change === 'evm') current.accounts.evmAddress = `0x${'2'.repeat(40)}`;
  if (change === 'route') current.route.id = 'other';
  if (change === 'asset') current.route.source.network = 'ethereum';
  if (change === 'precision') current.route.destination.decimals = 6;
  if (change === 'config') current.route.recovery.config.version++;
  if (change === 'scope')
    current.route.recovery.nativeAsset = {
      faucetId: `0x${'2'.repeat(30)}`,
      symbol: 'USDCx',
      decimals: 6,
      scope: 'other-rpc',
      revision: 2
    };
  if (change === 'disabled') current.route.disabled = true;
  if (change === 'expiry' && review.quote) review.quote.validity = { kind: 'time', expiresAt: now };
  if (change === 'quote-request' && review.quote) review.quote.request.amount = '2';
  if (change === 'missing-quote') delete review.quote;
  expect(() => assertReviewedBridge(review, current, now)).toThrow();
});
it('reads current terms again after asynchronous cap verification, before returning submission permission', async () => {
  const review = setup();
  let current: BridgeReviewContext = structuredClone(review);
  let release: () => void = () => {
    throw new Error('No cap check');
  };
  const pending = new Promise<void>(resolve => {
    release = resolve;
  });
  const verifyBalanceCap = jest.fn(() => pending);
  const verification = verifyBridgeSubmission(review, {
    readCurrent: async () => current,
    verifyBalanceCap,
    now: () => now
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(verifyBalanceCap).toHaveBeenCalledWith(review.route, review.amount, accounts.midenAccount);
  current = { ...current, amount: '2' };
  release();
  await expect(verification).rejects.toThrow();
});
it('refuses missing cap verification, cap rejection and a quote expiring while valuation is pending', async () => {
  const review = setup();
  await expect(verifyBridgeSubmission(review, { readCurrent: async () => review, now: () => now })).rejects.toThrow();
  await expect(
    verifyBridgeSubmission(review, {
      readCurrent: async () => review,
      verifyBalanceCap: async () => {
        throw new Error('exceeded');
      },
      now: () => now
    })
  ).rejects.toThrow('exceeded');
  let clock = now;
  await expect(
    verifyBridgeSubmission(review, {
      readCurrent: async () => review,
      verifyBalanceCap: async () => {
        clock += 60_001;
      },
      now: () => clock
    })
  ).rejects.toThrow();
});
it('does not impose the inbound balance cap on withdrawals', async () => {
  const review = setup();
  review.route = testRoute('send');
  if (!review.quote) throw new Error('Missing quote fixture');
  review.quote.request.routeId = review.route.id;
  review.quote.request.recovery = structuredClone(review.route.recovery);
  const verifyBalanceCap = jest.fn(async () => {
    throw new Error('must not run');
  });
  await expect(
    verifyBridgeSubmission(review, { readCurrent: async () => review, verifyBalanceCap, now: () => now })
  ).resolves.toBeUndefined();
  expect(verifyBalanceCap).not.toHaveBeenCalled();
});

it('does not invalidate equivalent JSON key order or observation timestamps, but does bind quote accounts and provider', () => {
  const review = setup();
  const current: BridgeReviewContext = structuredClone(review);
  current.route.recovery = {
    derived: current.route.recovery.derived,
    config: current.route.recovery.config,
    network: current.route.recovery.network
  };
  current.route.recovery.derived.derivedAt++;
  expect(() => assertReviewedBridge(review, current, now)).not.toThrow();
  if (!review.quote) throw new Error('Missing quote fixture');
  review.quote.request.evmAddress = `0x${'2'.repeat(40)}`;
  expect(() => assertReviewedBridge(review, current, now)).toThrow();
  review.quote.request.evmAddress = accounts.evmAddress;
  review.quote.kind = 'epoch';
  expect(() => assertReviewedBridge(review, current, now)).toThrow();
});

it('refuses an otherwise matching review when the captured current start direction is off', () => {
  const review = setup();
  review.route.recovery.config.features.bridgeIn = false;
  if (!review.quote) throw new Error('Missing quote fixture');
  review.quote.request.recovery = structuredClone(review.route.recovery);
  expect(() => assertReviewedBridge(review, structuredClone(review), now)).toThrow();
});
