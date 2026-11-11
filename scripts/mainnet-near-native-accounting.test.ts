/** @jest-environment node */
import { assertOneClickMidenBalances } from '../playwright/e2e/helpers/mainnet-one-click-plan';
import { realizedMainnetLoopLoss } from '../playwright/e2e/helpers/mainnet-loop-budget';

function nativeLeg() {
  return {
    principal: { identity: 'miden:native', before: 20_000_000n, after: 19_897_000n },
    native: { identity: 'miden:native', before: 20_000_000n, after: 19_897_000n },
    sent: 5_000_000n,
    received: 4_900_000n,
    paidFees: 3_000n
  };
}

it('reconciles recycled native principal and actual fee receipts in the same vault asset', () => {
  expect(() => assertOneClickMidenBalances(nativeLeg())).not.toThrow();
});
it('keeps separate-principal routes valid without charging the fee asset twice', () => {
  const leg = nativeLeg();
  leg.principal = { identity: 'miden:token', before: 5_000_000n, after: 4_900_000n };
  leg.native = { identity: 'miden:native', before: 100_000n, after: 97_000n };
  expect(() => assertOneClickMidenBalances(leg)).not.toThrow();
});
it('checks each native forward and return leg without mistaking principal for a fee', () => {
  const forward = nativeLeg();
  forward.received = 0n;
  forward.principal.after = forward.native.after = 14_997_000n;
  expect(() => assertOneClickMidenBalances(forward)).not.toThrow();
  const reverse = nativeLeg();
  reverse.sent = 0n;
  reverse.principal.before = reverse.native.before = 14_997_000n;
  reverse.principal.after = reverse.native.after = 19_894_000n;
  expect(() => assertOneClickMidenBalances(reverse)).not.toThrow();
});
it('values the native loss exactly once after reconciliation', () => {
  const leg = nativeLeg();
  assertOneClickMidenBalances(leg);
  expect(realizedMainnetLoopLoss([leg.principal, leg.native].map(sample => ({
    ...sample, decimals: 6, usdMicros: 1_000_000n
  })))).toBe(103_000n);
});
it('rejects an unrelated credit even if the balance still fits the dollar ceiling', () => {
  const leg = nativeLeg();
  leg.principal.after += 1n;
  leg.native.after += 1n;
  expect(() => assertOneClickMidenBalances(leg)).toThrow();
});
it('rejects unrelated fee-asset spending on a separate-principal route', () => {
  const leg = nativeLeg();
  leg.principal = { identity: 'miden:token', before: 5_000_000n, after: 4_900_000n };
  leg.native = { identity: 'miden:native', before: 100_000n, after: 96_999n };
  expect(() => assertOneClickMidenBalances(leg)).toThrow();
});
it.each(['before', 'after'] as const)('rejects conflicting %s snapshots of the same asset', field => {
  const leg = nativeLeg();
  leg.native[field] += 1n;
  expect(() => assertOneClickMidenBalances(leg)).toThrow();
});
it('rejects negative fees instead of treating a credit as permission to spend', () => {
  const leg = nativeLeg();
  leg.paidFees = -1n;
  expect(() => assertOneClickMidenBalances(leg)).toThrow();
});
it('requires pre-existing principal and fee funds rather than offsetting an unfunded spend with future proceeds', () => {
  const leg = nativeLeg();
  leg.sent = 20_000_001n;
  leg.received = 19_900_001n;
  expect(() => assertOneClickMidenBalances(leg)).toThrow();
});
