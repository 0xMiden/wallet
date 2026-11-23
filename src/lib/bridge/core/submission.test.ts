import { bindTransferQuote, type QuoteValidity } from './quote';
import { assertReviewedBridge, type BridgeReviewContext, type ReviewedTransfer } from './review';
import { verifyBridgeSubmission } from './submission';
import { accounts, native, now, testRoute } from '../testing/fixtures';

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
function cctpReview(validity: QuoteValidity): ReviewedTransfer {
  const route = testRoute();
  const usdc = route.recovery.config.supportedEvmChains.sepolia?.bridges.usdcx?.tokens.USDC;
  if (!usdc) throw new Error('Missing Circle fixture');
  route.id = 'test:cctp:receive';
  route.provider = 'xreserve';
  route.source = { kind: 'erc20', network: 'sepolia', symbol: 'USDC', decimals: 6, address: usdc.contractAddress };
  route.destination = {
    kind: 'miden',
    network: 'miden-testnet',
    symbol: 'USDCx',
    decimals: 6,
    faucetId: native.faucetId
  };
  route.recovery.nativeAsset = { ...native };
  const amount = '1.000001';
  return {
    route,
    amount,
    accounts: { ...accounts },
    quote: bindTransferQuote(
      { route, amount, ...accounts },
      {
        kind: 'cctp',
        received: amount,
        validity,
        authorization: { signedQuote: '0x1234', feeTotalAmount: 1n, expiresAt: now / 1000 + 1 }
      }
    )
  };
}

it.each([{ kind: 'provider' }, { kind: 'time', expiresAt: now + 60_000 }] satisfies QuoteValidity[])(
  'requires a new review if CCTP authorization expires during cap verification with $kind outer validity',
  async validity => {
    const review = cctpReview(validity);
    expect(() => assertReviewedBridge(review, structuredClone(review), now)).not.toThrow();
    let clock = now;
    let release: () => void = () => {
      throw new Error('No cap read');
    };
    const pending = new Promise<void>(resolve => {
      release = resolve;
    });
    const verifyBalanceCap = jest.fn(() => pending);
    const submission = verifyBridgeSubmission(review, {
      readCurrent: async () => structuredClone(review),
      verifyBalanceCap,
      now: () => clock
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(verifyBalanceCap).toHaveBeenCalledWith(review.route, review.amount, accounts.midenAccount);
    clock = now + 1000;
    release();
    await expect(submission).rejects.toThrow('Bridge quote requires a new review');
  }
);

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

function circleSendReview(): ReviewedTransfer {
  const incoming = cctpReview({ kind: 'provider' });
  const route = {
    ...incoming.route,
    id: 'circle:send:native-fee',
    mode: 'send',
    source: incoming.route.destination,
    destination: incoming.route.source
  } satisfies ReviewedTransfer['route'];
  return {
    route,
    amount: '6',
    accounts: { ...accounts },
    networkFeeBudget: { faucetId: native.faucetId, maxAmount: '300', scope: 'a'.repeat(64) },
    quote: bindTransferQuote(
      { route, amount: '6', ...accounts },
      {
        kind: 'withdrawal',
        received: '5.9',
        fee: '0.1',
        validity: { kind: 'provider' }
      }
    )
  };
}

it('accepts the same displayed measured native cap after ordinary JSON transport, including measured zero', () => {
  const review = circleSendReview();
  expect(() => assertReviewedBridge(review, JSON.parse(JSON.stringify(review)), now)).not.toThrow();
  if (!review.networkFeeBudget) throw new Error('Missing fee fixture');
  review.networkFeeBudget.maxAmount = '0';
  expect(() => assertReviewedBridge(review, structuredClone(review), now)).not.toThrow();
});

it.each(['missing', 'empty faucet', 'negative', 'fractional', 'leading zeros', 'invalid source'])(
  'requires a real canonical native budget, not %s, for a Circle send',
  kind => {
    const review = circleSendReview();
    if (!review.networkFeeBudget) throw new Error('Missing fee fixture');
    if (kind === 'missing') Reflect.deleteProperty(review, 'networkFeeBudget');
    if (kind === 'empty faucet') review.networkFeeBudget.faucetId = '';
    if (kind === 'negative') review.networkFeeBudget.maxAmount = '-1';
    if (kind === 'fractional') review.networkFeeBudget.maxAmount = '0.1';
    if (kind === 'leading zeros') review.networkFeeBudget.maxAmount = '0300';
    if (kind === 'invalid source') review.networkFeeBudget.scope = 'raw-source-placeholder';
    expect(() => assertReviewedBridge(review, structuredClone(review), now)).toThrow();
  }
);

it.each(['maxAmount', 'faucetId', 'scope'])(
  'requires renewed explicit Circle review when the live native fee %s changes',
  field => {
    const review = circleSendReview();
    const current = structuredClone(review);
    if (!current.networkFeeBudget) throw new Error('Missing fee fixture');
    Reflect.set(current.networkFeeBudget, field, field === 'maxAmount' ? '301' : 'b'.repeat(64));
    expect(() => assertReviewedBridge(review, current, now)).toThrow();
  }
);
