/**
 * @jest-environment node
 */
import { IDBFactory } from 'fake-indexeddb';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CellDeadlineExceeded,
  DappCellRunner,
  deadlineIn,
  HarnessFault,
  judgeCell,
  type CellContext,
  type Deadline
} from './dapp-cells';
import { callOn, ChainUnavailable } from './dapp-channel';
import { registryOf } from './dapp-known-bugs';
import type { MobileCellState, MobileJourney } from './dapp-mobile-journey';
import { readRows, waitForQueueDrained, type MobileWallet } from './dapp-mobile-wallet';
import {
  captureMobileBaseline,
  expectMobileWriteToTheEnd,
  expectNoNewMobileRows,
  ownRowsBesides,
  pairNotes,
  stableVault,
  timed,
  type MobileBaseline,
  type MobileSide
} from './dapp-mobile-writes';
import { TxStatus, type TransactionRowSnapshot } from './history';
import { getEnvironmentConfig } from '../config/environments';
import type { OutputNoteView } from '../test-dapp/protocol';

jest.mock('@playwright/test', () => {
  const jestExpect = expect;
  return { expect: (value: unknown) => jestExpect(value) };
});

describe('rows a write did not account for', () => {
  const rows = [
    { id: 'base', type: 'send', accountId: 'mtst1a' },
    { id: 'mine', type: 'send', accountId: 'mtst1a' },
    { id: 'stranger', type: 'consume', accountId: 'mtst1a', secondaryAccountId: 'mtst1stranger' },
    { id: 'from-b', type: 'consume', accountId: 'mtst1a', secondaryAccountId: 'mtst1b' },
    { id: 'other-account', type: 'send', accountId: 'mtst1other' }
  ];

  it("leaves out the baseline, the write itself, a stranger's consume and another account", () => {
    const left = ownRowsBesides('mtst1a', ['mtst1a', 'mtst1b'], { rowIds: ['base'], capturedAtSec: 0 }, ['mine'], rows);
    expect(left.map(row => row.id)).toEqual(['from-b']);
  });
});

describe('pairing output notes', () => {
  const note = (noteId: string, noteType: 'public' | 'private'): OutputNoteView => ({
    noteId,
    noteType,
    bytesB64: '',
    isSameSdkNote: true,
    script: 'p2id'
  });

  it('pairs a dApp-built note by id and a wallet-built one by type', () => {
    const pairs = pairNotes(
      [{ noteType: 'public' }, { noteId: '0xAB', noteType: 'private' }],
      [note('0xcd', 'public'), note('0xab', 'private')]
    );
    expect(pairs.map(([expected, actual]) => [expected.noteId ?? 'by type', actual.noteId])).toEqual([
      ['0xAB', '0xab'],
      ['by type', '0xcd']
    ]);
  });

  it('refuses an expected note no output matches', () => {
    expect(() => pairNotes([{ noteId: '0x01', noteType: 'public' }], [note('0x02', 'public')])).toThrow(
      'no output note left to pair'
    );
  });
});

describe('step durations', () => {
  it('records how long each step took, a failed one too, and keeps the steps before it', async () => {
    const ctx: CellContext = { deadline: deadlineIn(10_000, 'cell'), evidence: {}, softFail: () => undefined };
    await timed(ctx, 'first', async () => 1);
    await expect(
      timed(ctx, 'second', async () => {
        throw new Error('the step failed');
      })
    ).rejects.toThrow('the step failed');
    expect(Object.keys(ctx.evidence.stepDurationsMs ?? {})).toEqual(['first', 'second']);
    expect(Object.values(ctx.evidence.stepDurationsMs ?? {}).every(ms => ms >= 0)).toBe(true);
  });
});

describe('mobile write read boundaries', () => {
  const hash = `0x${'a'.repeat(64)}`;
  const completed: TransactionRowSnapshot = {
    id: 'write',
    accountId: 'mtst1a',
    status: TxStatus.Completed,
    transactionId: hash,
    feeAmount: '0'
  };
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-writes-'));
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function walletWithRows(rows: readonly TransactionRowSnapshot[] | null = [completed]) {
    const indexedDB = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('TridentMain', 1);
      request.onupgradeneeded = () => {
        if (rows !== null) {
          const table = request.result.createObjectStore('transactions', { keyPath: 'id' });
          for (const row of rows) table.put(row);
        }
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
    });
    const state = {
      currentAccount: { publicKey: 'mtst1a' },
      balances: {
        mtst1a: [
          { tokenId: 'tst', balance: 100, metadata: { symbol: 'TST', decimals: 0 } },
          { tokenId: 'native', balance: 100, metadata: { symbol: 'MIDEN', decimals: 0 } }
        ]
      },
      assetsMetadata: {},
      balancesLastFetched: { mtst1a: 0 },
      fetchBalances: async () => {
        state.balancesLastFetched.mtst1a += 1;
      },
      updateCurrentAccount: async (account: string) => {
        state.currentAccount = { publicKey: account };
      }
    };
    const win = { __TEST_STORE__: { getState: () => state } };
    const observer = { onRead: (_js: string): void => undefined };
    const evalJs = jest.fn(async (_js: string): Promise<void> => undefined);
    const unused = async (): Promise<never> => {
      throw new Error('unused wallet action');
    };
    const wallet: MobileWallet = {
      evalJs: async <T>(js: string): Promise<T> => {
        await evalJs(js);
        observer.onRead(js);
        // eslint-disable-next-line no-new-func
        return new Function('window', 'indexedDB', js)(win, indexedDB);
      },
      click: unused,
      waitFor: unused,
      screenshot: unused,
      navigateTo: unused,
      delay: unused,
      createNewWallet: unused,
      createGuardianWallet: unused,
      claimAllNotes: unused,
      getGuardianAuthInfo: unused
    };
    return { wallet, evalJs, state, observer };
  }

  async function fixture(rows: readonly TransactionRowSnapshot[] | null = [completed]) {
    const device = await walletWithRows(rows);
    const channel = {
      label: 'A/one',
      send: async (command: string): Promise<unknown> => {
        if (command === 'waitForTransaction') return { ok: true, value: { txHash: hash, outputNotes: [] } };
        if (command === 'chainAccount') return { found: true, commitmentHex: 'new' };
        throw new Error(`unexpected command ${command}`);
      }
    };
    const dapp = { label: 'A/one', wallet: device.wallet, channel, origin: 'https://example.test' };
    const runner = new DappCellRunner<Partial<MobileCellState>>({
      surface: 'ios',
      part: 'unit',
      axis: 'offchain',
      journey: 'PL',
      testTitle: 'write reads',
      outDir: directory,
      declared: [],
      registry: registryOf([]),
      hooks: { quiesce: async () => undefined, restore: async () => undefined }
    });
    const unused = async (): Promise<never> => {
      throw new Error('unused journey action');
    };
    const j: MobileJourney = {
      surface: 'ios',
      axis: {
        label: 'offchain',
        walletType: 'off-chain',
        create: unused,
        settle: async () => undefined,
        connectKeyMembership: unused,
        expected: { guardianInfo: () => null, connectKeyMembership: '', builder: 'plain' }
      },
      walletA: device.wallet,
      walletB: device.wallet,
      env: getEnvironmentConfig(),
      network: 'testnet',
      runner,
      server: {
        port: 0,
        urlFor: () => '',
        events: () => [],
        waitForEvent: unused,
        send: unused,
        stop: async () => undefined
      },
      dapp,
      dappB: dapp,
      cliFaucetId: 'cli',
      tokenFaucetId: 'tst',
      native: { tokenId: 'native', symbol: 'MIDEN', decimals: 0, baseFee: 0 },
      addressB: 'mtst1b',
      held: { w4: { noteId: '', amount: 0n }, r7: { noteId: '', amount: 0n } },
      produced: { noteId: '', bytesB64: '', nullifierHex: '', amount: 0n },
      providerAtBoot: true,
      memo: new Map(),
      outputNoteIds: new Set(),
      senders: () => ['mtst1a', 'mtst1b'],
      account: async () => 'mtst1a',
      call: (command, input, deadline, options) => callOn(channel, command, input, deadline, options)
    };
    const side: MobileSide = { j, wallet: device.wallet, account: 'mtst1a', accountIdHex: '0xaaa', dapp };
    const baseline: MobileBaseline = {
      rowIds: [],
      capturedAtSec: 0,
      vault: { tst: 100n, native: 100n },
      commitmentHex: 'old'
    };
    return { ...device, side, baseline };
  }

  it('allows an existing fresh empty transaction store', async () => {
    const { side } = await fixture([]);
    await expect(expectNoNewMobileRows(side, { rowIds: [], capturedAtSec: 0 })).resolves.toBeUndefined();
  });

  it('retains known output ids when the transaction view stalls before its receipt', async () => {
    const { side, baseline } = await fixture();
    side.dapp.channel.send = async () => new Promise(() => undefined);
    jest.useFakeTimers();
    const outcome = expectMobileWriteToTheEnd(
      side,
      baseline,
      { txId: 'write', outputNotes: [{ noteId: '0xABC', noteType: 'public', toB: 5n }], consumedNullifiers: [] },
      {},
      { deadline: deadlineIn(100, 'X1'), evidence: {}, softFail: () => undefined }
    ).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(100);
    await expect(outcome).resolves.toBeInstanceOf(CellDeadlineExceeded);
    expect([...side.j.outputNoteIds]).toEqual(['abc']);
  });

  it('remembers the actual id of a wallet-built output for later pending accounting', async () => {
    const { side, baseline } = await fixture();
    const send = side.dapp.channel.send;
    side.dapp.channel.send = async (command, input, timeout) => {
      if (command === 'waitForTransaction')
        return {
          ok: true,
          value: {
            txHash: hash,
            outputNotes: [{ noteId: '0xABC', noteType: 'public', bytesB64: '', isSameSdkNote: true, script: 'p2id' }]
          }
        };
      if (command === 'chainNote')
        return { found: true, senderHex: '0xaaa', noteType: 'public', blockNum: 1, attachmentWordsHex: [] };
      return send(command, input, timeout);
    };
    jest.useFakeTimers();
    const outcome = expectMobileWriteToTheEnd(
      side,
      baseline,
      { txId: 'write', outputNotes: [{ noteType: 'public', attachmentWordsHex: [] }], consumedNullifiers: [] },
      {},
      { deadline: deadlineIn(10_000, 'W1'), evidence: {}, softFail: () => undefined }
    );
    await jest.advanceTimersByTimeAsync(9_000);
    await expect(outcome).resolves.toMatchObject({ txHash: hash });
    expect([...side.j.outputNoteIds]).toEqual(['abc']);
  });

  it('rejects a missing transaction store through the no-new-rows assertion', async () => {
    const { side } = await fixture(null);
    await expect(expectNoNewMobileRows(side, { rowIds: [], capturedAtSec: 0 })).rejects.toThrow(
      'transaction store is missing'
    );
  });

  it('rejects a valid empty read when a baseline row disappeared', async () => {
    const { side } = await fixture([]);
    await expect(expectNoNewMobileRows(side, { rowIds: ['baseline'], capturedAtSec: 0 })).rejects.toThrow();
  });

  it('never drains a missing transaction store as though it were empty', async () => {
    const { wallet } = await fixture(null);
    jest.useFakeTimers();
    const outcome = waitForQueueDrained(() => readRows(wallet), 2_000).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(5_000);
    await expect(outcome).resolves.toEqual(
      expect.objectContaining({ message: expect.stringContaining('transaction store is missing') })
    );
  });

  it('keeps a node failure as ChainUnavailable when a bounded baseline chain read reaches the deadline', async () => {
    const { side } = await fixture();
    const send = jest.fn(side.dapp.channel.send);
    let attempts = 0;
    side.dapp.channel.send = async (command, input, timeoutMs) => {
      if (command === 'chainAccount') {
        attempts += 1;
        if (attempts === 1) throw new ChainUnavailable('the node failed the baseline account read');
        return new Promise(() => undefined);
      }
      return send(command, input, timeoutMs);
    };
    const input = { txId: 'write' };
    await side.dapp.channel.send('waitForTransaction', input, 4_000);
    expect(send).toHaveBeenCalledWith('waitForTransaction', input, 4_000);
    jest.useFakeTimers();
    const ctx: CellContext = {
      deadline: deadlineIn(12_000, 'baseline chain read'),
      evidence: {},
      softFail: () => undefined
    };
    const outcome = captureMobileBaseline(side, ['tst'], ctx).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(12_000);
    await expect(outcome).resolves.toBeInstanceOf(ChainUnavailable);
    await expect(outcome).resolves.toHaveProperty('message', expect.stringContaining('deadline cut the last'));
    expect(attempts).toBe(2);
  });

  it('expires during baseline account selection without issuing another device command', async () => {
    const { side, state, evalJs } = await fixture();
    state.currentAccount.publicKey = 'mtst1other';
    let finish = (): void => undefined;
    const selected = new Promise<void>(resolve => {
      finish = resolve;
    });
    jest.spyOn(state, 'updateCurrentAccount').mockImplementation(async () => selected);
    jest.useFakeTimers();
    const ctx: CellContext = { deadline: deadlineIn(100, 'baseline'), evidence: {}, softFail: () => undefined };
    const outcome = captureMobileBaseline(side, ['tst'], ctx).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(100);
    await expect(outcome).resolves.toBeInstanceOf(CellDeadlineExceeded);
    const reads = evalJs.mock.calls.length;
    finish();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(evalJs).toHaveBeenCalledTimes(reads);
    expect(evalJs.mock.calls.some(([js]) => js.includes('__dapp_rows'))).toBe(false);
  });

  it('rejects the final four-second wait with one second left and performs no later read', async () => {
    const { side, baseline, observer } = await fixture();
    jest.useFakeTimers();
    const evidence: CellContext['evidence'] = {};
    const deadline: Deadline = {
      label: 'write',
      remainingMs: () => (evidence.stepDurationsMs?.vault === undefined ? 60_000 : 1_000),
      race: (work, what) => deadlineIn(deadline.remainingMs(), 'write').race(work, what)
    };
    const ctx: CellContext = { deadline, evidence, softFail: () => undefined };
    const afterVault: string[] = [];
    observer.onRead = js => {
      if (evidence.stepDurationsMs?.vault !== undefined) afterVault.push(js);
    };
    const outcome = expectMobileWriteToTheEnd(
      side,
      baseline,
      { txId: 'write', outputNotes: [], consumedNullifiers: [] },
      {},
      ctx
    ).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(10_000);
    await expect(outcome).resolves.toBeInstanceOf(CellDeadlineExceeded);
    expect(evidence.stepDurationsMs?.nothingElse).toBe(1_000);
    expect(afterVault).toEqual([]);
  });

  it.each([
    'Remote debugger is not connected',
    "Remote debugger error with code '-32601': Method not found",
    'CDP Runtime.evaluate: Invalid parameters',
    'WebSocket is not open: readyState 3 (CLOSED)'
  ])('judges the evaluate transport failure %s as a harness fault through the assertion', async message => {
    const { side, evalJs } = await fixture([]);
    jest.useFakeTimers();
    evalJs.mockRejectedValue(new Error(message));
    const outcome = expectNoNewMobileRows(side, { rowIds: [], capturedAtSec: 0 }).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(3_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(HarnessFault);
    expect(
      judgeCell({
        surface: 'ios',
        cellId: 'R1',
        axis: 'offchain',
        hardError: error,
        softFailures: [],
        evidence: {},
        registry: registryOf([])
      }).verdict
    ).toBe('harness-fault');
  });

  it('keeps an evaluate timeout as its original plain failure', async () => {
    const { wallet, evalJs } = await fixture();
    const timeout = new Error('eval: CDP call did not return within 30000ms (WebView/RWI wedged)');
    evalJs.mockRejectedValue(timeout);
    const ctx: CellContext = { deadline: deadlineIn(60_000, 'vault'), evidence: {}, softFail: () => undefined };
    await expect(stableVault(wallet, ['tst'], ctx)).rejects.toBe(timeout);
  });

  it('judges a successful read with the wrong balance as fail-new', async () => {
    const { side, baseline } = await fixture();
    jest.useFakeTimers();
    const ctx: CellContext = { deadline: deadlineIn(10_000, 'write'), evidence: {}, softFail: () => undefined };
    const outcome = expectMobileWriteToTheEnd(
      side,
      baseline,
      { txId: 'write', outputNotes: [], consumedNullifiers: [] },
      { tst: -1n },
      ctx
    ).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(20_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(HarnessFault);
    expect(error).toEqual(expect.objectContaining({ message: expect.stringContaining('the vault at') }));
    expect(
      judgeCell({
        surface: 'ios',
        cellId: 'W1',
        axis: 'offchain',
        hardError: error,
        softFailures: [],
        evidence: ctx.evidence,
        registry: registryOf([])
      }).verdict
    ).toBe('fail-new');
  });
});
