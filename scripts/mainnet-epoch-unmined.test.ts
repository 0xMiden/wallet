/** @jest-environment node */
import { readFileSync } from 'node:fs';
import {
  mainnetEpochNextAction,
  parseMainnetEpochCheckpoint,
  type MainnetEpochCheckpoint
} from '../playwright/e2e/helpers/mainnet-epoch-checkpoint';
import { closeEpochUnminedDeposit, type EpochUnminedLive } from '../playwright/e2e/helpers/mainnet-epoch-unmined';
import { epochUnminedDepositFixture } from './helpers/mainnet-epoch-fixture';

const hash = `0x${'a'.repeat(64)}`;
const approveHash = `0x${'b'.repeat(64)}`;
const depositHash = `0x${'c'.repeat(64)}`;
const unmined = epochUnminedDepositFixture;

const approvals = (state: MainnetEpochCheckpoint) => ({
  transactions: [state.transactions![0]!],
  paidEvmFees: '1000'
});
const live = (over: Partial<EpochUnminedLive> = {}): EpochUnminedLive => ({
  depositTransaction: undefined,
  depositReceipt: undefined,
  latestNonce: 1,
  pendingNonce: 1,
  tokenBalance: 3_000_000n + 999_981n,
  nativeBalance: 10_000_000_000_000_000n - 1000n,
  nativeVault: 20_000_000n - 1_010_000n - 14n,
  reverseStatus: [],
  ...over
});

it('closes a deposit that never mined as not executed with zero fee and exact attributed balances', () => {
  const state = unmined();
  expect(closeEpochUnminedDeposit(state, approvals(state), live())).toBe(true);
  expect(state.phase).toBe('cancelled');
  expect(state.unminedDeposit).toEqual({ hash: depositHash, nonce: 1 });
  expect(state.transactions?.map(tx => tx.feeWei)).toEqual(['1000', '0']);
  expect(state.paidEvmFees).toBe('1000');
  expect(state.after).toEqual({
    native: String(20_000_000n - 1_010_000n - 14n),
    evmToken: '3999981',
    evmNative: String(10_000_000_000_000_000n - 1000n)
  });
  expect(BigInt(state.realizedCostUsdMicros!)).toBeLessThanOrEqual(BigInt(state.lossBudgetUsdMicros));
  expect(state.lossBudgetUsdMicros).toBe(unmined().lossBudgetUsdMicros);
  expect(parseMainnetEpochCheckpoint(JSON.parse(JSON.stringify(state)))).toEqual(state);
  expect(mainnetEpochNextAction(state)).toBe('prepare');
});

it.each<[string, Partial<EpochUnminedLive>]>([
  ['the deposit transaction is known', { depositTransaction: { hash: depositHash } }],
  ['the deposit has a receipt', { depositReceipt: { status: 'success' } }],
  ['the latest nonce moved past the deposit', { latestNonce: 2 }],
  ['the latest nonce is below the deposit', { latestNonce: 0 }],
  ['a transaction is pending at the deposit nonce', { pendingNonce: 2 }],
  ['the token balance differs', { tokenBalance: 3_999_980n }],
  ['the token balance already paid out', { tokenBalance: 3_000_000n }],
  ['the native balance differs', { nativeBalance: 10_000_000_000_000_000n - 1001n }],
  ['the Miden balance differs', { nativeVault: 20_000_000n - 1_010_000n }],
  ['the provider reports the reverse filled', { reverseStatus: [{ chainId: 999, status: 'success' }] }],
  ['the provider reports a return note', { reverseStatus: [{ chainId: 999, status: 'pending', midenNoteId: hash }] }],
  ['the provider status is unreadable', { reverseStatus: null }]
])('falls back to fail-closed when %s', (_name, over) => {
  const state = unmined();
  const before = JSON.stringify(state);
  expect(closeEpochUnminedDeposit(state, approvals(state), live(over))).toBe(false);
  expect(JSON.stringify(state)).toBe(before);
});

it('falls back to fail-closed when the journal is not an approval followed by the missing deposit', () => {
  const noDeposit = unmined();
  noDeposit.transactions = [{ kind: 'approve', nonce: 0, hash: approveHash, feeWei: '1000' }];
  const before = JSON.stringify(noDeposit);
  expect(closeEpochUnminedDeposit(noDeposit, approvals(noDeposit), live())).toBe(false);
  expect(JSON.stringify(noDeposit)).toBe(before);
  const fees = unmined();
  expect(closeEpochUnminedDeposit(fees, { ...approvals(fees), paidEvmFees: '999' }, live())).toBe(false);
  expect(fees.phase).toBe('recovery-required');
});

describe('checkpoint schema', () => {
  const closed = () => {
    const state = unmined();
    closeEpochUnminedDeposit(state, approvals(state), live());
    return JSON.parse(JSON.stringify(state)) as Record<string, unknown> & MainnetEpochCheckpoint;
  };
  it('rejects an unmined marker outside the closed phase, with a fee, or with unattributed balances', () => {
    expect(() => parseMainnetEpochCheckpoint({ ...closed(), phase: 'complete' })).toThrow();
    expect(() => parseMainnetEpochCheckpoint({ ...closed(), phase: 'recovery-required' })).toThrow();
    const fee = closed();
    fee.transactions![1]!.feeWei = '1';
    expect(() => parseMainnetEpochCheckpoint(fee)).toThrow();
    const other = closed();
    other.unminedDeposit = { hash: approveHash, nonce: 1 };
    expect(() => parseMainnetEpochCheckpoint(other)).toThrow();
    const after = closed();
    after.after = { ...after.after!, evmToken: '1' };
    expect(() => parseMainnetEpochCheckpoint(after)).toThrow();
    const claimed = closed();
    claimed.returnMidenTxId = hash;
    expect(() => parseMainnetEpochCheckpoint(claimed)).toThrow();
  });
});

it('keeps every signing and submission primitive out of the recovery and unmined paths', () => {
  const forbidden =
    /sendRawTransaction|sendTransaction|signTransaction|writeContract|privateKeyToAccount|createEpochEvmSender|solveIntent|runEpochReverse|armMainnet|releaseMainnet/;
  const unminedSource = readFileSync('playwright/e2e/helpers/mainnet-epoch-unmined.ts', 'utf8');
  const runtime = readFileSync('playwright/e2e/helpers/mainnet-epoch-runtime.ts', 'utf8');
  const start = runtime.indexOf('export async function recoverEpochReturn');
  const end = runtime.indexOf('/** Refund-only', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  expect(runtime.slice(start, end)).toContain('closeEpochUnminedDeposit');
  expect(unminedSource).not.toMatch(forbidden);
  expect(runtime.slice(start, end)).not.toMatch(forbidden);
});
