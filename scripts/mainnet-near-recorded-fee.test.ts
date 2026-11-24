/** @jest-environment node */
import { verifyRecordedNearFee } from '../playwright/e2e/helpers/mainnet-near-recorded-fee';

const scope = {
  account: `0x${'1'.repeat(30)}`,
  note: `0x${'2'.repeat(64)}`,
  faucet: `0x${'3'.repeat(30)}`,
  budget: 420n,
  vaultDebit: 133n
};
const evidence = { account: scope.account, notes: [scope.note], fees: [{ faucet: scope.faucet, amount: 133n }] };

it('accepts an exact recorded fee corroborated by the vault debit', () => {
  expect(verifyRecordedNearFee(scope, evidence)).toBe(133n);
});

it.each([
  { account: scope.faucet },
  { notes: [] },
  { notes: [scope.note, scope.note] },
  { fees: [] },
  { fees: [...evidence.fees, ...evidence.fees] },
  { fees: [{ faucet: scope.account, amount: 133n }] },
  { fees: [{ faucet: scope.faucet, amount: 134n }] }
])('rejects mismatched or ambiguous recorded evidence %#', patch => {
  expect(() => verifyRecordedNearFee(scope, { ...evidence, ...patch })).toThrow();
});

it('rejects an exact fee above the checkpoint budget', () => {
  expect(() => verifyRecordedNearFee({ ...scope, budget: 132n }, evidence)).toThrow();
});
