import type { Page } from '@playwright/test';

import { vaultBalanceOfCurrentAccount } from './balance-truth';
import { expectWritesToTheEnd, type Baseline, type WriteSide } from './dapp-assertions';
import type { DappAxis } from './dapp-axis';
import { deadlineIn, type CellContext } from './dapp-cells';
import { readTransactionRow, readTransactionRows, type TransactionRowSnapshot } from './history';
import { callDapp, type DappHandle } from './test-dapp';
import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';

// Playwright's expect takes a message as its second argument, which Jest's refuses (guardian-axis-coverage.test.ts).
jest.mock('@playwright/test', () => {
  const jestExpect = (globalThis as typeof globalThis & { expect: typeof expect }).expect;
  return { expect: (actual: unknown) => jestExpect(actual) };
});
jest.mock('./balance-truth', () => ({
  vaultBalanceOfCurrentAccount: jest.fn(),
  waitForVaultBalanceOfCurrentAccount: jest.fn(async () => undefined)
}));
jest.mock('./history', () => ({
  ...jest.requireActual('./history'),
  readTransactionRow: jest.fn(),
  readTransactionRows: jest.fn()
}));
jest.mock('./test-dapp', () => ({
  ...jest.requireActual('./test-dapp'),
  callDapp: jest.fn(),
  ensureUnlocked: jest.fn(async () => undefined),
  selectAccountIfNeeded: jest.fn(async () => undefined)
}));

const ACCOUNT = 'mtst1qaccounta_qruqqypuyph';
const TOKEN = '0xtoken';
const NATIVE = '0xnative';
const TX = 'tx-1';
const TX_HASH = `0x${'ab'.repeat(32)}`;
const NOTE = `0x${'cd'.repeat(32)}`;
const FEE = 10n;
const AMOUNT = 500n;
const baseline: Baseline = {
  vault: { [TOKEN]: 10_000n, [NATIVE]: 1_000n },
  commitmentHex: '0xold',
  rowIds: ['funding']
};
const row = (id: string, extra: Partial<TransactionRowSnapshot> = {}): TransactionRowSnapshot => ({
  id,
  type: 'send',
  accountId: ACCOUNT,
  status: 2,
  ...extra
});
const written = row(TX, { transactionId: TX_HASH, feeAmount: String(FEE) });

function sideOf(): { side: WriteSide; syncs: () => number } {
  const triggerSync = jest.fn(async () => undefined);
  const axis = {
    settle: async () => undefined,
    guardianCommitment: async () => 'not-applicable',
    expected: { guardianCommitment: () => 'not-applicable' }
  } as unknown as DappAxis;
  const side: WriteSide = {
    wallet: { page: {} as unknown as Page, triggerSync } as unknown as GuardianAwareWalletPage,
    dapp: { label: 'one' } as unknown as DappHandle,
    axis,
    account: ACCOUNT,
    accountIdHex: '0xaccount',
    nativeFaucetId: NATIVE
  };
  return { side, syncs: () => triggerSync.mock.calls.length };
}

/** The wallet as it stands after the write: `vault` is what every balance read returns, `rows` its history. */
function walletShows(vault: Record<string, bigint>, rows: TransactionRowSnapshot[]): void {
  jest.mocked(vaultBalanceOfCurrentAccount).mockImplementation(async (_page, faucetId) => vault[faucetId] ?? 0n);
  jest.mocked(readTransactionRows).mockResolvedValue(rows);
  jest.mocked(readTransactionRow).mockImplementation(async (_page, id) => rows.find(entry => entry.id === id) ?? null);
  jest.mocked(callDapp).mockImplementation((async (_dapp: DappHandle, command: string) => {
    if (command === 'waitForTransaction') {
      return {
        ok: true,
        value: {
          txHash: TX_HASH,
          outputNotes: [{ noteId: NOTE, noteType: 'public', bytesB64: '', isSameSdkNote: true }]
        }
      };
    }
    if (command === 'chainNote') return { found: true, blockNum: 9, senderHex: '0xaccount', noteType: 'public' };
    if (command === 'chainAccount') return { found: true, commitmentHex: '0xnew', lastBlockNum: 9 };
    throw new Error(`unexpected command ${command}`);
  }) as unknown as typeof callDapp);
}

const ctx = (): CellContext => ({ deadline: deadlineIn(60_000, 'W1'), evidence: {}, softFail: () => undefined });
const assertSend = (side: WriteSide) =>
  expectWritesToTheEnd(
    side,
    baseline,
    [{ txId: TX, outputNotes: [{ noteType: 'public' }], consumedNullifiers: [] }],
    { [TOKEN]: -AMOUNT },
    ctx()
  );

describe('expectWritesToTheEnd', () => {
  const after = { [TOKEN]: 10_000n - AMOUNT, [NATIVE]: 1_000n - FEE };

  it("passes a write that is the only thing the account ran, whatever another account's rows say", async () => {
    walletShows(after, [row('funding'), written, row('tx-other', { accountId: 'mtst1qaccountb' })]);
    const { side, syncs } = sideOf();
    await expect(assertSend(side)).resolves.toHaveLength(1);
    expect(syncs()).toBe(2);
  });

  it('fails a write the wallet ran twice as two rows', async () => {
    walletShows(after, [row('funding'), written, row('tx-again', { transactionId: `0x${'ef'.repeat(32)}` })]);
    await expect(assertSend(sideOf().side)).rejects.toThrow(/tx-again/);
  });

  it('fails a write whose second debit lands after the exact balance wait', async () => {
    walletShows({ [TOKEN]: 10_000n - 2n * AMOUNT, [NATIVE]: 1_000n - 2n * FEE }, [row('funding'), written]);
    await expect(assertSend(sideOf().side)).rejects.toThrow();
  });
});
