import type { Page } from '@playwright/test';

import {
  vaultBalanceOfCurrentAccount,
  vaultReadingOfCurrentAccount,
  waitForVaultBalanceOfCurrentAccount,
  type VaultReading
} from './balance-truth';
import {
  captureBaseline,
  expectCancelledWhileQueued,
  expectNoNewRows,
  expectVaultUnchanged,
  expectWritesToTheEnd,
  unlessAThirdPartyMovedARead,
  vaultSyncedAfter,
  type Baseline,
  type WriteSide
} from './dapp-assertions';
import type { DappAxis } from './dapp-axis';
import { deadlineIn, InfrastructureFault, type CellContext, type Deadline } from './dapp-cells';
import type { NonCurrentRead } from './dapp-gates';
import { readTransactionRow, readTransactionRows, USER_CANCELLED_REASON, type TransactionRowSnapshot } from './history';
import { callDapp, ChainUnavailable, type DappHandle } from './test-dapp';
import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';

// Playwright's expect takes a message as its second argument, which Jest's refuses (guardian-axis-coverage.test.ts).
// refusal() builds its matchers from Playwright's expect, so the asymmetric ones come along.
jest.mock('@playwright/test', () => {
  const jestExpect = (globalThis as typeof globalThis & { expect: typeof expect }).expect;
  return {
    expect: Object.assign((actual: unknown) => jestExpect(actual), {
      objectContaining: jestExpect.objectContaining,
      stringMatching: jestExpect.stringMatching
    })
  };
});
jest.mock('./balance-truth', () => ({
  vaultBalanceOfCurrentAccount: jest.fn(),
  vaultReadingOfCurrentAccount: jest.fn(),
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
  rowIds: ['funding'],
  capturedAtSec: 1_000
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
    nativeFaucetId: NATIVE,
    journeySenders: () => [ACCOUNT, 'mtst1qaccountb', 'mtst1clifaucet', 'mtst1publicfaucet']
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
const assertSend = (side: WriteSide, from: Baseline = baseline) =>
  expectWritesToTheEnd(
    side,
    from,
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

  // callDapp races each attempt against the same deadline and names the node only after its own race lost, so its
  // failure settles just after the deadline; a second race on that deadline would report CellDeadlineExceeded instead.
  it.each(['chainNote', 'chainNullifier', 'chainAccount'])(
    'reports the node, not the deadline, when the deadline cuts %s after a node failure',
    async failing => {
      jest.useFakeTimers();
      try {
        walletShows(after, [row('funding'), written]);
        const answer = jest.mocked(callDapp).getMockImplementation()!;
        jest.mocked(callDapp).mockImplementation(((dapp: DappHandle, command: string, ...rest: unknown[]) => {
          if (command === 'chainNullifier' && command !== failing) return Promise.resolve({ committedAt: 9 });
          if (command !== failing) return (answer as (...args: unknown[]) => unknown)(dapp, command, ...rest);
          return new Promise((_, reject) => {
            setTimeout(() => reject(new ChainUnavailable(`${command}: node down (after 2 attempts)`)), 5_001);
          });
        }) as unknown as typeof callDapp);
        const settled = expectWritesToTheEnd(
          sideOf().side,
          baseline,
          [{ txId: TX, outputNotes: [{ noteType: 'public' }], consumedNullifiers: ['0xnullifier'] }],
          { [TOKEN]: -AMOUNT },
          { deadline: deadlineIn(5_000, 'W1'), evidence: {}, softFail: () => undefined }
        ).catch((error: unknown) => error);
        await jest.advanceTimersByTimeAsync(5_001);
        expect(await settled).toBeInstanceOf(ChainUnavailable);
      } finally {
        jest.useRealTimers();
      }
    }
  );
});

describe('a note from outside the journey', () => {
  const STRANGER = 'mtst1qstranger_qr7qqq9wr6w';
  const GIFT = 1_000_000n;
  const after = { [TOKEN]: 10_000n - AMOUNT, [NATIVE]: 1_000n - FEE };
  // The wallet's auto-consume of a native note a stranger sent the account: GIFT in, its own fee out.
  const movedByGift = { ...after, [NATIVE]: after[NATIVE] + GIFT - 7n };
  const gift = (id: string, extra: Partial<TransactionRowSnapshot> = {}) =>
    row(id, {
      type: 'consume',
      secondaryAccountId: STRANGER,
      noteIds: [`0x${'ee'.repeat(32)}`],
      amount: String(GIFT),
      faucetId: NATIVE,
      completedAt: baseline.capturedAtSec + 5,
      ...extra
    });
  const failureOf = (work: Promise<unknown>) =>
    work.then(
      () => undefined,
      (error: unknown) => error
    );

  it('leaves a consume of it out of the rows the account ran besides the writes', async () => {
    walletShows(after, [row('funding'), written, gift('gift')]);
    await expect(assertSend(sideOf().side)).resolves.toHaveLength(1);
  });

  it("still counts a consume of a journey sender's note as a row besides the writes", async () => {
    walletShows(after, [row('funding'), written, gift('again', { secondaryAccountId: 'mtst1clifaucet' })]);
    await expect(assertSend(sideOf().side)).rejects.toThrow(/again/);
  });

  it('records a vault it moved after the baseline as infrastructure for this cell, naming the row and sender', async () => {
    walletShows(movedByGift, [row('funding'), written, gift('gift')]);
    const error = await failureOf(assertSend(sideOf().side));
    expect(error).toBeInstanceOf(InfrastructureFault);
    expect(error).toMatchObject({ abortsLeg: false, message: expect.stringContaining(`gift consumed`) });
    expect(error).toMatchObject({ message: expect.stringContaining(STRANGER) });
  });

  it('records the same when the exact balance wait ran out on the moved vault', async () => {
    walletShows(movedByGift, [row('funding'), written, gift('gift')]);
    const timedOut = new Error('vault balance of 0xnative never read 990');
    jest.mocked(waitForVaultBalanceOfCurrentAccount).mockRejectedValueOnce(timedOut);
    const error = await failureOf(assertSend(sideOf().side));
    expect(error).toBeInstanceOf(InfrastructureFault);
    expect(error).toMatchObject({ cause: timedOut });
  });

  it('counts a consume of it that was still running when the baseline was read', async () => {
    walletShows(movedByGift, [row('funding'), gift('gift', { status: 1, completedAt: undefined }), written]);
    const error = await failureOf(assertSend(sideOf().side, { ...baseline, rowIds: ['funding', 'gift'] }));
    expect(error).toBeInstanceOf(InfrastructureFault);
  });

  it("keeps a vault failure the wallet's when the consume finished before the baseline was read", async () => {
    walletShows(movedByGift, [row('funding'), gift('gift', { completedAt: baseline.capturedAtSec - 5 }), written]);
    const error = await failureOf(assertSend(sideOf().side, { ...baseline, rowIds: ['funding', 'gift'] }));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(InfrastructureFault);
  });

  it("keeps a vault failure the wallet's when the account also ran a row of its own", async () => {
    walletShows(movedByGift, [
      row('funding'),
      written,
      gift('gift'),
      row('tx-again', { transactionId: `0x${'ef'.repeat(32)}` })
    ]);
    const error = await failureOf(assertSend(sideOf().side));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(InfrastructureFault);
  });

  it("is left out of a refusal's new rows, and any other new row still fails it", async () => {
    jest.mocked(readTransactionRows).mockResolvedValue([row('funding'), gift('gift')]);
    await expect(expectNoNewRows(sideOf().side, baseline)).resolves.toBeUndefined();
    jest.mocked(readTransactionRows).mockResolvedValue([row('funding'), gift('gift'), row('refused-ran')]);
    await expect(expectNoNewRows(sideOf().side, baseline)).rejects.toThrow(/refused-ran/);
  });

  it("makes an unchanged-vault check infrastructure, unless a row of the account's own ran beside it", async () => {
    const failed = row(TX, { status: 3 });
    walletShows({ ...baseline.vault, [NATIVE]: baseline.vault[NATIVE]! + GIFT - 7n }, [
      row('funding'),
      failed,
      gift('gift')
    ]);
    expect(await failureOf(expectVaultUnchanged(sideOf().side, baseline, ctx(), [TX]))).toBeInstanceOf(
      InfrastructureFault
    );
    const own = await failureOf(expectVaultUnchanged(sideOf().side, baseline, ctx(), []));
    expect(own).toBeInstanceOf(Error);
    expect(own).not.toBeInstanceOf(InfrastructureFault);
  });

  describe('beside a row the user cancelled (R4)', () => {
    const cancelled = row(TX, { status: 3, error: USER_CANCELLED_REASON });
    const cancelRefused = { ok: false, error: { name: 'WalletTransactionError', message: USER_CANCELLED_REASON } };
    const waitAnswers = (answer: unknown) =>
      jest.mocked(callDapp).mockImplementation((async () => answer) as unknown as typeof callDapp);
    const assertCancel = () => expectCancelledWhileQueued(sideOf().side, baseline, TX, ctx());

    it('passes a cancel the dApp was told of that moved nothing', async () => {
      walletShows(baseline.vault, [row('funding'), cancelled]);
      waitAnswers(cancelRefused);
      await expect(assertCancel()).resolves.toBeUndefined();
    });

    it("records a vault a stranger's note moved as infrastructure, the cancelled row being the cell's own", async () => {
      walletShows({ ...baseline.vault, [NATIVE]: baseline.vault[NATIVE]! + GIFT - 7n }, [
        row('funding'),
        cancelled,
        gift('gift')
      ]);
      waitAnswers(cancelRefused);
      const error = await failureOf(assertCancel());
      expect(error).toBeInstanceOf(InfrastructureFault);
      expect(error).toMatchObject({ abortsLeg: false, message: expect.stringContaining(STRANGER) });
    });

    it("keeps a cancelled row that debited the wallet's when no third party moved the vault", async () => {
      walletShows({ ...baseline.vault, [TOKEN]: baseline.vault[TOKEN]! - AMOUNT }, [row('funding'), cancelled]);
      waitAnswers(cancelRefused);
      const error = await failureOf(assertCancel());
      expect(error).not.toBeInstanceOf(InfrastructureFault);
      // The vault check's failure, not the wait's: its diff names the debited faucet.
      expect(error).toMatchObject({ message: expect.stringContaining(TOKEN) });
    });

    it('fails a cancel whose wait the dApp saw answered without the cancel', async () => {
      walletShows(baseline.vault, [row('funding'), cancelled]);
      waitAnswers({ ok: true, value: { txHash: TX_HASH } });
      await expect(assertCancel()).rejects.toThrow(/toEqual/);
    });
  });

  describe('completed before a baseline stamp the store had not caught up with', () => {
    const NOW_MS = 1_791_650_000_500;
    const STAMP_SEC = Math.floor(NOW_MS / 1000);
    const ABSENT = '0xabsent';
    const stale = { [TOKEN]: '10000', [NATIVE]: '1000' };
    const withGift = { ...stale, [NATIVE]: String(1_000n + GIFT - 7n) };
    // A second before the stamp, so the window leaves it out: only the baseline's vault can hold it.
    const consumed = gift('gift', { completedAt: STAMP_SEC - 1 });
    const settled = async <T>(work: Promise<T>): Promise<T> => {
      const outcome = work.then(
        value => ({ value }),
        (error: unknown) => ({ error })
      );
      await jest.advanceTimersByTimeAsync(61_000);
      const done = await outcome;
      if ('error' in done) throw done.error;
      return done.value;
    };

    beforeEach(() => jest.useFakeTimers({ now: NOW_MS }));
    afterEach(() => jest.useRealTimers());

    /**
     * The page after the consume: each forced sync publishes the account's vault with the gift, stamped after it was
     * asked for, and the store takes the last vault its account published one read later (its poll lags the sync).
     */
    function pageAfterTheConsume(published: VaultReading['sync']) {
      let store: Record<string, string> = stale;
      let sync = published;
      let polled = false;
      const triggerSync = jest.fn(async () => {
        sync = { account: ACCOUNT, syncedAtMs: Date.now() + 1, vault: withGift };
        polled = false;
      });
      jest.mocked(vaultReadingOfCurrentAccount).mockImplementation(async () => {
        if (polled && sync?.account === ACCOUNT) store = sync.vault;
        polled = true;
        return { storeAccount: ACCOUNT, store, sync };
      });
      jest
        .mocked(vaultBalanceOfCurrentAccount)
        .mockImplementation(async (_page, faucetId) => BigInt(store[faucetId] ?? '0'));
      jest.mocked(readTransactionRows).mockResolvedValue([row('funding'), consumed]);
      jest.mocked(callDapp).mockImplementation((async () => ({
        found: true,
        commitmentHex: '0xold',
        lastBlockNum: 8
      })) as unknown as typeof callDapp);
      const { side } = sideOf();
      const wallet = { page: side.wallet.page, triggerSync } as unknown as GuardianAwareWalletPage;
      return { side: { ...side, wallet }, triggerSync };
    }

    it("is in the baseline's vault, so the write's exact checks pass", async () => {
      const { side } = pageAfterTheConsume({ account: ACCOUNT, syncedAtMs: (STAMP_SEC - 10) * 1000, vault: stale });
      const captured = await settled(captureBaseline(side, [TOKEN, ABSENT], ctx()));
      expect(captured).toEqual({
        vault: { [TOKEN]: 10_000n, [ABSENT]: 0n, [NATIVE]: 1_000n + GIFT - 7n },
        commitmentHex: '0xold',
        rowIds: ['funding', 'gift'],
        capturedAtSec: STAMP_SEC
      });
      walletShows({ [TOKEN]: 10_000n - AMOUNT, [NATIVE]: 1_000n + GIFT - 7n - FEE }, [
        row('funding'),
        consumed,
        written
      ]);
      await expect(settled(assertSend(side, captured))).resolves.toHaveLength(1);
    });

    it('waits for the store to take a sync it has not polled yet', async () => {
      const { side } = pageAfterTheConsume({ account: ACCOUNT, syncedAtMs: NOW_MS - 100, vault: withGift });
      expect((await settled(captureBaseline(side, [TOKEN], ctx()))).vault).toEqual({
        [TOKEN]: 10_000n,
        [NATIVE]: 1_000n + GIFT - 7n
      });
    });

    it("takes no other account's sync for the store's, whatever vault it published", async () => {
      const { side, triggerSync } = pageAfterTheConsume({
        account: 'mtst1qaccountb',
        syncedAtMs: NOW_MS - 100,
        vault: stale
      });
      await expect(settled(vaultSyncedAfter(side.wallet, side.dapp, STAMP_SEC * 1000, ctx()))).resolves.toEqual(
        withGift
      );
      expect(triggerSync).toHaveBeenCalled();
    });

    describe('when the wallet publishes no sync after the stamp', () => {
      const commands = () => jest.mocked(callDapp).mock.calls.map(call => call[1]);
      const nodeDown = async (command: string) => {
        throw new ChainUnavailable(`dApp one ${command}: ChainUnavailableError: syncChain: Error: status 429`);
      };
      /** Every forced sync republishes the stale stamp, as the service worker does while the node fails its syncs. */
      function stuckSide(
        node: (command: string, deadline: Deadline) => Promise<unknown>,
        triggerSync: () => Promise<void> = async () => undefined
      ): WriteSide {
        jest.mocked(vaultReadingOfCurrentAccount).mockResolvedValue({
          storeAccount: ACCOUNT,
          store: stale,
          sync: { account: ACCOUNT, syncedAtMs: (STAMP_SEC - 10) * 1000, vault: stale }
        });
        jest
          .mocked(callDapp)
          .mockClear()
          .mockImplementation((async (_dapp: DappHandle, command: string, _input: unknown, deadline: Deadline) =>
            node(command, deadline)) as unknown as typeof callDapp);
        const { side } = sideOf();
        return { ...side, wallet: { page: side.wallet.page, triggerSync } as unknown as GuardianAwareWalletPage };
      }

      it("is blocked by infrastructure when the dApp's node fails too", async () => {
        await expect(settled(captureBaseline(stuckSide(nodeDown), [TOKEN], ctx()))).rejects.toBeInstanceOf(
          ChainUnavailable
        );
        expect(commands()).toEqual(['syncHeight']);
      });

      it("stays the wallet's failure when the dApp's node answers, asked with time left for it", async () => {
        const left: number[] = [];
        const side = stuckSide(async (_command, deadline) => {
          left.push(deadline.remainingMs());
          return { height: 9 };
        });
        const error = await settled(failureOf(captureBaseline(side, [TOKEN], ctx())));
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(InfrastructureFault);
        expect(String(error)).toMatch(/the store holding a wallet sync after the baseline stamp/);
        expect(commands()).toEqual(['syncHeight']);
        expect(left[0]).toBeGreaterThanOrEqual(10_000);
      });

      it("is blocked by infrastructure when the wallet's forced sync never settles and the node fails", async () => {
        const side = stuckSide(nodeDown, () => new Promise<void>(() => undefined));
        await expect(settled(captureBaseline(side, [TOKEN], ctx()))).rejects.toBeInstanceOf(ChainUnavailable);
      });

      it('passes any other failure of the wait on unchanged, without asking the node', async () => {
        const side = stuckSide(async () => ({ height: 9 }));
        jest.mocked(vaultReadingOfCurrentAccount).mockRejectedValue(new Error('store read failed'));
        await expect(settled(captureBaseline(side, [TOKEN], ctx()))).rejects.toThrow(/^store read failed$/);
        expect(commands()).toEqual([]);
      });
    });
  });

  describe('beside a read served after its popup (M4-reads)', () => {
    const own = { [TOKEN]: '10000', [NATIVE]: '1000' };
    const otherOwn = { [TOKEN]: '100', [NATIVE]: '500' };
    const movedOwn = { ...own, [NATIVE]: String(1_000n + GIFT - 7n) };
    const read = (served: Record<string, string> | null, prompted = true): NonCurrentRead => ({
      prompted,
      result: { ok: true },
      served,
      own
    });
    const judge = (answered: NonCurrentRead, rows: TransactionRowSnapshot[], since: Baseline = baseline) => {
      jest.mocked(readTransactionRows).mockResolvedValue(rows);
      return failureOf(unlessAThirdPartyMovedARead(sideOf().side, since, answered, otherOwn));
    };

    it("records the account's own vault moved by it after the capture as infrastructure, naming the row and sender", async () => {
      const error = await judge(read(movedOwn), [row('funding'), gift('gift')]);
      expect(error).toBeInstanceOf(InfrastructureFault);
      expect(error).toMatchObject({ abortsLeg: false, message: expect.stringContaining('gift consumed') });
      expect(error).toMatchObject({ message: expect.stringContaining(STRANGER) });
    });

    it('counts a consume of it that was still running when the vaults were captured', async () => {
      const running = gift('gift', { status: 1, completedAt: undefined });
      const error = await judge(read(movedOwn), [row('funding'), running], {
        ...baseline,
        rowIds: ['funding', 'gift']
      });
      expect(error).toBeInstanceOf(InfrastructureFault);
    });

    it("leaves the read to K9's rule when the consume finished before the capture or moved the other account", async () => {
      const before = gift('gift', { completedAt: baseline.capturedAtSec - 5 });
      expect(await judge(read(movedOwn), [row('funding'), before], { ...baseline, rowIds: ['funding', 'gift'] })).toBe(
        undefined
      );
      expect(await judge(read(movedOwn), [row('funding'), gift('gift', { accountId: 'mtst1qaccountb' })])).toBe(
        undefined
      );
    });

    it("keeps a leak the wallet's: the other account's vault served, whatever moved", async () => {
      expect(await judge(read(otherOwn), [row('funding'), gift('gift')])).toBe(undefined);
    });

    it("keeps the read the wallet's when the account ran a row of its own", async () => {
      expect(await judge(read(movedOwn), [row('funding'), gift('gift'), row('tx-read')])).toBe(undefined);
    });

    it("leaves a consume of a journey sender's note to K9's rule, even one running at the capture", async () => {
      const grant = gift('grant', { secondaryAccountId: 'mtst1publicfaucet', status: 1, completedAt: undefined });
      expect(await judge(read(movedOwn), [row('funding'), grant], { ...baseline, rowIds: ['funding', 'grant'] })).toBe(
        undefined
      );
    });

    it('leaves a read with no popup, one that served nothing and one served its own vault as they are', async () => {
      const rows = [row('funding'), gift('gift')];
      expect(await judge(read(movedOwn, false), rows)).toBe(undefined);
      expect(await judge(read(null), rows)).toBe(undefined);
      expect(await judge(read(own), rows)).toBe(undefined);
    });
  });
});
