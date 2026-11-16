import { bridgeFeeCharging, walletBridgeProvider } from './provider';
import { bindTransferQuote, isQuoteReviewable, quoteAmounts } from './quote';
import { accounts, now, testRoute } from '../testing/fixtures';

it('retains exact request terms and provider output, including deducted fees', () => {
  const route = { ...testRoute('send'), provider: 'epoch' } satisfies ReturnType<typeof testRoute>;
  const quote = bindTransferQuote(
    { route, amount: '1.00000000', ...accounts },
    {
      kind: 'epoch',
      received: '0.999999999999999999',
      validity: { kind: 'time', expiresAt: now + 1 }
    }
  );
  expect(quote.request).toEqual({ routeId: route.id, amount: '1.00000000', ...accounts, recovery: route.recovery });
  expect(quoteAmounts(route, quote)).toEqual({ received: '0.999999999999999999', sourceTotal: '1.00000000' });
  expect(quote.request.recovery).not.toBe(route.recovery);
});
it('adds a forwarding fee to the source without subtracting it from the payout', () => {
  const asset = {
    network: 'sepolia',
    kind: 'erc20',
    address: `0x${'1'.repeat(40)}`,
    decimals: 6,
    symbol: 'USDC'
  } satisfies ReturnType<typeof testRoute>['source'];
  const route = {
    ...testRoute(),
    provider: 'xreserve',
    source: asset,
    destination: {
      kind: 'miden',
      network: 'miden-testnet',
      faucetId: `0x${'1'.repeat(30)}`,
      symbol: 'USDCx',
      decimals: 6
    }
  } satisfies ReturnType<typeof testRoute>;
  const quote = bindTransferQuote(
    { route, amount: '1.000001', ...accounts },
    {
      kind: 'cctp',
      received: '1.000001',
      fee: '0.250001',
      validity: { kind: 'provider' },
      authorization: { feeTotalAmount: 250001n, signedQuote: '0x1234' }
    }
  );
  expect(quoteAmounts(route, quote)).toEqual({ received: '1.000001', sourceTotal: '1.250002', fee: '0.250001' });
  expect(isQuoteReviewable(quote, now)).toBe(true);
});
it('does not add a deducted Circle fee to the amount being burned', () => {
  const route = { ...testRoute('send'), provider: 'xreserve' } satisfies ReturnType<typeof testRoute>;
  const quote = bindTransferQuote(
    { route, amount: '2', ...accounts },
    {
      kind: 'withdrawal',
      received: '1.9836',
      fee: '0.0164',
      validity: { kind: 'time', expiresAt: now + 1 }
    }
  );
  expect(quoteAmounts(route, quote)).toEqual({ received: '1.9836', sourceTotal: '2', fee: '0.0164' });
});
it('rejects missing, expired, invalid or nonpositive quote output without inventing an estimate', () => {
  expect(isQuoteReviewable(undefined, now)).toBe(false);
  expect(isQuoteReviewable({ kind: 'epoch', received: '1', validity: { kind: 'time', expiresAt: now } }, now)).toBe(
    false
  );
  expect(isQuoteReviewable({ kind: 'epoch', received: '0', validity: { kind: 'provider' } }, now)).toBe(false);
  expect(isQuoteReviewable({ kind: 'epoch', received: '1', validity: { kind: 'time', expiresAt: NaN } }, now)).toBe(
    false
  );
  expect(() =>
    bindTransferQuote(
      { route: testRoute(), amount: '1', ...accounts },
      {
        kind: 'agglayer',
        received: 'NaN',
        validity: { kind: 'time', expiresAt: now + 1 }
      }
    )
  ).toThrow();
});

it('derives an additional CCTP fee from its authorization and refuses contradictory display terms', () => {
  const route = {
    ...testRoute(),
    provider: 'xreserve',
    source: {
      kind: 'erc20',
      network: 'sepolia',
      symbol: 'USDC',
      decimals: 6,
      address: `0x${'1'.repeat(40)}`
    }
  } satisfies ReturnType<typeof testRoute>;
  const quote = bindTransferQuote(
    { route, amount: '1.000001', ...accounts },
    {
      kind: 'cctp',
      received: '1.000001',
      validity: { kind: 'provider' },
      authorization: { signedQuote: '0x1234', feeTotalAmount: 250001n }
    }
  );
  expect(quoteAmounts(route, quote)).toEqual({ received: '1.000001', sourceTotal: '1.250002', fee: '0.250001' });
  expect(() => quoteAmounts(route, { ...quote, fee: '0' })).toThrow();
});

it('maps portal protocol names only at the wallet boundary and retains direct-deposit fees', () => {
  expect(walletBridgeProvider('xreserve')).toBe('usdcx');
  expect(walletBridgeProvider('epoch')).toBe('epoch');
  expect(walletBridgeProvider('agglayer')).toBe('agglayer');
  expect(bridgeFeeCharging(testRoute())).toBe('none');
  const route = {
    ...testRoute(),
    provider: 'xreserve',
    source: {
      kind: 'erc20',
      network: 'arc-testnet',
      symbol: 'USDC',
      decimals: 6,
      address: `0x${'1'.repeat(40)}`
    }
  } satisfies ReturnType<typeof testRoute>;
  expect(bridgeFeeCharging(route)).toBe('none');
  const quote = bindTransferQuote(
    { route, amount: '1', ...accounts },
    {
      kind: 'arc-deposit',
      received: '1',
      validity: { kind: 'time', expiresAt: now + 1 }
    }
  );
  expect(quoteAmounts(route, quote)).toEqual({ sourceTotal: '1', received: '1' });
  expect(() => quoteAmounts(route, { ...quote, fee: '-1' })).toThrow();
});
