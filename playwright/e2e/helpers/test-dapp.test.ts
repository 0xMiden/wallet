import type { BrowserContext, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DappCellRunner,
  deadlineIn,
  HarnessFault,
  infraAborted,
  InfrastructureFault,
  type Deadline
} from './dapp-cells';
import {
  advanceChain,
  callDapp,
  ChainUnavailable,
  expectNoPrompt,
  openTestDapp,
  popupBlock,
  type DappHandle
} from './test-dapp';
import { DAPP_ORIGINS } from './test-dapp-server';
import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';

jest.mock('@playwright/test', () => ({ expect: jest.fn() }));
jest.mock('./test-dapp-server', () => ({
  ...jest.requireActual('./test-dapp-server'),
  installTestDapp: jest.fn(async () => undefined)
}));

// What page.evaluate rejects with when the page throws: Playwright carries the page error's stack, which opens with
// the error's name.
const pageError = (name: string, message: string): Error =>
  new Error(`page.evaluate: ${name}: ${message}\n    at call (http://localhost:4810/test-dapp.js:1:1)`);
const nodeError = () => pageError('ChainUnavailableError', 'syncChain: TypeError: Failed to fetch');

interface Call {
  command: string;
  input: Record<string, unknown>;
}

// Answers each call with the next of `answers` (an Error rejects, a function runs), then with `rest`.
function dappAnswering(
  answers: unknown[],
  rest: (call: Call) => Promise<unknown> = async () => undefined
): { dapp: DappHandle; calls: Call[] } {
  const calls: Call[] = [];
  const evaluate = jest.fn(async (_script: unknown, call: Call) => {
    calls.push(call);
    if (answers.length === 0) return rest(call);
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  });
  const dapp: DappHandle = {
    page: { evaluate } as unknown as Page,
    label: 'one',
    origin: DAPP_ORIGINS.one,
    context: { on: jest.fn(), off: jest.fn(), pages: () => [] } as unknown as BrowserContext
  };
  return { dapp, calls };
}

const contextFor = (deadline: Deadline) => ({ deadline, evidence: {}, softFail: jest.fn() });

// Every command a repeat cannot change the answer of, with an input of its shape.
const REPEATABLE: Record<string, (dapp: DappHandle, deadline: Deadline) => Promise<unknown>> = {
  chainNote: (dapp, deadline) => callDapp(dapp, 'chainNote', { noteId: '0x01' }, deadline),
  chainNullifier: (dapp, deadline) => callDapp(dapp, 'chainNullifier', { nullifierHex: '0x02' }, deadline),
  chainAccount: (dapp, deadline) => callDapp(dapp, 'chainAccount', { accountId: '0x03' }, deadline),
  syncHeight: (dapp, deadline) => callDapp(dapp, 'syncHeight', {}, deadline),
  init: (dapp, deadline) =>
    callDapp(dapp, 'init', { rpcUrl: 'https://rpc.testnet.miden.io', storeName: 'test-dapp-unit' }, deadline),
  buildCustom: (dapp, deadline) => callDapp(dapp, 'buildCustom', { shape: 'p2id', outputs: [] }, deadline),
  makeNoteFile: (dapp, deadline) =>
    callDapp(dapp, 'makeNoteFile', { noteBytesB64: 'AA==', format: 'withProof' }, deadline)
};
const ASKED_ONCE: Record<string, (dapp: DappHandle, deadline: Deadline) => Promise<unknown>> = {
  waitForHeight: (dapp, deadline) => callDapp(dapp, 'waitForHeight', { target: 12, timeoutMs: 1_000 }, deadline),
  submitCustom: (dapp, deadline) =>
    callDapp(dapp, 'submitCustom', { requestId: 'r1', recipientAddress: '', importNotes: false }, deadline)
};

describe('callDapp', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it.each(Object.entries(REPEATABLE))(
    'asks %s again after the node failed it, until it answers',
    async (name, call) => {
      const { dapp, calls } = dappAnswering([nodeError(), nodeError(), { answered: name }]);
      const result = call(dapp, deadlineIn(60_000, 'W1'));
      await jest.advanceTimersByTimeAsync(4_000);
      await expect(result).resolves.toEqual({ answered: name });
      expect(calls.map(entry => entry.command)).toEqual([name, name, name]);
    }
  );

  it.each(Object.entries(REPEATABLE))("never asks %s again after the page's own fault", async (_name, call) => {
    const { dapp, calls } = dappAnswering([pageError('HarnessCheckError', 'init has not run')]);
    await expect(call(dapp, deadlineIn(60_000, 'W1'))).rejects.toBeInstanceOf(HarnessFault);
    expect(calls).toHaveLength(1);
  });

  it.each(Object.entries(ASKED_ONCE))('asks %s only once after the node failed it', async (_name, call) => {
    const { dapp, calls } = dappAnswering([nodeError()]);
    await expect(call(dapp, deadlineIn(60_000, 'W1'))).rejects.toBeInstanceOf(ChainUnavailable);
    expect(calls).toHaveLength(1);
  });

  it('asks a read compared with an earlier one only once, and still names the node', async () => {
    const { dapp, calls } = dappAnswering([nodeError()]);
    const read = callDapp(dapp, 'syncHeight', {}, deadlineIn(60_000, 'W1'), { once: true });
    await expect(read).rejects.toBeInstanceOf(ChainUnavailable);
    expect(calls).toHaveLength(1);
  });

  it('reports a node failing every read to the deadline as a cell-scoped fault, with its last error', async () => {
    const failures = Array.from({ length: 10 }, (_, i) =>
      pageError('ChainUnavailableError', `getAccountDetails: attempt ${i + 1} refused`)
    );
    const { dapp, calls } = dappAnswering(failures);
    const read = callDapp(dapp, 'chainAccount', { accountId: '0x02' }, deadlineIn(7_000, 'W1')).catch(
      (error: unknown) => error
    );
    await jest.advanceTimersByTimeAsync(7_000);
    const error = await read;
    expect(error).toBeInstanceOf(ChainUnavailable);
    expect(error).toBeInstanceOf(InfrastructureFault);
    expect(error).toMatchObject({ abortsLeg: false, message: expect.stringContaining('attempt 4 refused') });
    expect(error).toMatchObject({ message: expect.stringContaining('4 attempts') });
    expect(calls).toHaveLength(4);
  });

  it('reports the node with the attempt count when the deadline cuts an attempt after a node failure', async () => {
    const { dapp, calls } = dappAnswering([nodeError(), () => new Promise(() => undefined)]);
    const read = callDapp(dapp, 'chainNote', { noteId: '0x01' }, deadlineIn(10_000, 'W1')).catch(
      (error: unknown) => error
    );
    await jest.advanceTimersByTimeAsync(10_000);
    const error = await read;
    expect(error).toBeInstanceOf(ChainUnavailable);
    expect(error).toMatchObject({ message: expect.stringContaining('syncChain: TypeError: Failed to fetch') });
    expect(error).toMatchObject({ message: expect.stringContaining('after 2 attempts') });
    expect(calls).toHaveLength(2);
  });

  it('stops asking when the time left would not cover the interval and an attempt as long as the last', async () => {
    const slowFailure = () =>
      new Promise((_, reject) => {
        setTimeout(() => reject(nodeError()), 3_000);
      });
    const { dapp, calls } = dappAnswering([], slowFailure);
    const read = callDapp(dapp, 'chainAccount', { accountId: '0x02' }, deadlineIn(10_000, 'W1')).catch(
      (error: unknown) => error
    );
    await jest.advanceTimersByTimeAsync(11_000);
    const error = await read;
    expect(error).toBeInstanceOf(ChainUnavailable);
    expect(error).toMatchObject({ message: expect.stringMatching(/\(after 2 attempts\)$/) });
    expect(calls).toHaveLength(2);
  });
});

describe('expectNoPrompt', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('asks the first height again but the second only once, and names the node when that one fails', async () => {
    const { dapp, calls } = dappAnswering([nodeError(), { height: 10 }, nodeError()], async () => {
      throw nodeError();
    });
    const refusal = { ok: false, error: { name: 'WalletNotConnectedError', message: 'refused' } };
    const checked = expectNoPrompt(dapp, async () => refusal, contextFor(deadlineIn(60_000, 'R1')), {
      refusal: true
    }).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(await checked).toBeInstanceOf(ChainUnavailable);
    expect(calls.map(entry => entry.command)).toEqual(['syncHeight', 'syncHeight', 'syncHeight']);
  });
});

describe('the height wait the driver hands the page', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('ends a margin before the cell deadline', async () => {
    const { dapp, calls } = dappAnswering([{ height: 10 }, { height: 11, reachedAtMs: 0 }]);
    await popupBlock(dapp, contextFor(deadlineIn(60_000, 'W1')));
    expect(calls[1]).toEqual({ command: 'waitForHeight', input: { target: 11, timeoutMs: 55_000 } });
  });

  it('is never below 1 ms', async () => {
    const { dapp, calls } = dappAnswering([{ height: 10 }, { height: 11, reachedAtMs: 0 }]);
    await popupBlock(dapp, contextFor(deadlineIn(3_000, 'W1')));
    expect(calls[1]).toEqual({ command: 'waitForHeight', input: { target: 11, timeoutMs: 1 } });
  });

  it('ends a cell whose page syncs keep failing as blocked by infrastructure, not a new failure', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-dapp-'));
    // The page's waitForHeight: every sync fails, and its last lap and sync land after its own timeout.
    const { dapp } = dappAnswering([], async call => {
      await new Promise(resolve => setTimeout(resolve, Number(call.input.timeoutMs) + 2_000));
      throw pageError('ChainUnavailableError', 'chain stuck at 10, wanted 12; last sync failed: syncChain: Failed');
    });
    const runner = new DappCellRunner<string>({
      part: 'core',
      axis: 'offchain',
      journey: 'W',
      testTitle: 'dApp test - offchain account',
      outDir: dir,
      declared: ['W1'],
      registry: { bugsFor: () => [] },
      hooks: { quiesce: async () => undefined, restore: async () => undefined },
      budgets: { write: 30_000 }
    });
    const wallet = {} as unknown as GuardianAwareWalletPage;
    const record = runner.run({
      id: 'W1',
      budget: 'write',
      run: async ctx => void (await advanceChain(wallet, dapp, 12, ctx))
    });
    await jest.advanceTimersByTimeAsync(30_000);
    const done = await record;
    expect([done.verdict, done.error]).toEqual(['blocked-infra', expect.stringContaining('last sync failed')]);
    expect(infraAborted(dir)).toBeNull();
  });
});

describe('openTestDapp', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const initAnswer = { syncHeight: 7, feeFaucetIdHex: '0x0f', sdkVersion: '0.17.3', adapterVersion: '0.17.0' };
  const contextServing = (dapp: DappHandle): BrowserContext => {
    const page = Object.assign(dapp.page, {
      goto: jest.fn(async () => null),
      waitForFunction: jest.fn(async () => undefined)
    });
    return { newPage: jest.fn(async () => page) } as unknown as BrowserContext;
  };
  const init = { rpcUrl: 'https://rpc.testnet.miden.io', storeName: 'test-dapp-unit' };

  it("asks the node again for the dApp's setup init", async () => {
    const { dapp, calls } = dappAnswering([nodeError(), initAnswer]);
    const opened = openTestDapp(contextServing(dapp), 'one', init);
    await jest.advanceTimersByTimeAsync(2_000);
    await expect(opened).resolves.toMatchObject({ label: 'one', origin: DAPP_ORIGINS.one });
    expect(calls.map(entry => entry.command)).toEqual(['init', 'init']);
  });

  it('gives up on a setup init the node keeps failing once the setup deadline runs out', async () => {
    const { dapp } = dappAnswering([], async () => {
      throw nodeError();
    });
    const opened = openTestDapp(contextServing(dapp), 'one', init).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(120_000);
    const error = await opened;
    expect(error).toBeInstanceOf(ChainUnavailable);
    expect(error).toMatchObject({ message: expect.stringContaining('attempts)') });
  });
});
