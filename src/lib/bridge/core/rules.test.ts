import { assetKey, sameAsset } from './assets';
import { deriveTransferAction, isValidAmount, routeSwitchChangesAsset, validateTransferAmount } from './rules';
import { testRoute } from '../testing/fixtures';

it.each(['1', '0.0001', '1.000000000000000000'])('accepts positive amounts %s', amount => {
  expect(isValidAmount(amount)).toBe(true);
});
it.each(['', '   ', '0', '0.0', '-1', 'abc', '1.2.3', '1e999', 'NaN', 'Infinity'])(
  'rejects %s before a prompt',
  amount => {
    expect(isValidAmount(amount)).toBe(false);
  }
);
it('identifies assets by network and contract/faucet, not symbol or provider', () => {
  const route = testRoute();
  const token = {
    network: 'sepolia',
    kind: 'erc20',
    symbol: 'USDC',
    decimals: 6,
    address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
  } satisfies typeof route.source;
  expect(sameAsset(token, { ...token, address: token.address.toUpperCase() })).toBe(true);
  expect(assetKey(token)).toBe('sepolia:erc20:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
  expect(routeSwitchChangesAsset(route, { ...route, source: token })).toBe(true);
  expect(routeSwitchChangesAsset(route, { ...route, provider: 'epoch' })).toBe(false);
  expect(sameAsset(token, { ...token, network: 'base' })).toBe(false);
  expect(sameAsset(token, { ...token, address: `0x${'1'.repeat(40)}` })).toBe(false);
});
it.each([
  ['0.123456780000000000', true],
  ['0.000000001', false],
  ['0.000000000000000001', false],
  ['1.0000000000000000000', false],
  ['01', false],
  ['1e1', false],
  ['92233720347.07292160', true],
  ['92233720347.07292161', false]
])('checks source and destination precision without rounding %s', (amount, allowed) => {
  const route = testRoute();
  let accepted = true;
  try {
    validateTransferAmount(route, String(amount));
  } catch {
    accepted = false;
  }
  expect(accepted).toBe(allowed);
});
it('keeps withdrawal source precision separate from EVM destination precision', () => {
  expect(() => validateTransferAmount(testRoute('send'), '0.12345678')).not.toThrow();
  expect(() => validateTransferAmount(testRoute('send'), '0.123456789')).toThrow();
});
it('orders actual transfer prerequisites before review', () => {
  const base = {
    sourceConnected: true,
    destinationConnected: true,
    amount: '1',
    insufficientBalance: false,
    quoteLoading: false,
    isSubmitting: false
  };
  expect(deriveTransferAction(base)).toBe('review');
  expect(deriveTransferAction({ ...base, isSubmitting: true })).toBe('submitting');
  expect(deriveTransferAction({ ...base, amount: '0' })).toBe('enter-amount');
  expect(deriveTransferAction({ ...base, sourceConnected: false })).toBe('connect-source');
  expect(deriveTransferAction({ ...base, destinationConnected: false })).toBe('connect-destination');
  expect(deriveTransferAction({ ...base, insufficientBalance: true })).toBe('insufficient');
  expect(deriveTransferAction({ ...base, quoteLoading: true })).toBe('quote-loading');
});
