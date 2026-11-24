/**
 * @jest-environment node
 */
import { test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CellDeadlineExceeded,
  DappCellRunner,
  deadlineIn,
  HarnessFault,
  InfrastructureFault,
  judgeCell,
  type CellContext,
  type Deadline,
  type JourneyRecord,
  type PendingNoteSnapshot
} from './dapp-cells';
import { ChainUnavailable, type DappChannel } from './dapp-channel';
import {
  MOBILE_COMMAND_CEILING_MS,
  startCommandServer,
  type CommandServer,
  type CommandResult,
  type DeviceKey
} from './dapp-command-server';
import { registryOf } from './dapp-known-bugs';
import { mobileOffchainAxis } from './dapp-mobile-axis';
import { androidDevice, iosDevice, type MobileDevice, type NativeKeyboardControls } from './dapp-mobile-device';
import { runNativeKeyboardJourney } from './dapp-mobile-keyboard';
import {
  AUTO_DECLINE_MS,
  coverageOf,
  guardNodeCalls,
  HOLD_MARGIN_MS,
  holdLeftMs,
  MOBILE_CELL_BUDGET_MS,
  MOBILE_PROVIDER_TIMEOUT_MS,
  MOBILE_QUIESCE_BUDGET_MS,
  sheetBlock,
  startMobileJourney,
  type MobileSession,
  type MobileSlot
} from './dapp-mobile-journey';
import { answerSheet, denyOpenSheet } from './dapp-mobile-sheet';
import {
  accountAddressAfterCreate,
  accountRows,
  createAccount,
  foregroundOrigin,
  nativeAsset,
  pendingNotes,
  readRows,
  removeDappSession,
  selectAccountIfNeeded,
  vaultOf,
  type MobileWallet
} from './dapp-mobile-wallet';
import { expectMobileWriteToTheEnd } from './dapp-mobile-writes';
import { nodeHeight, waitForNodeHeight, type FetchLogEntry } from './dapp-node-calls';
import { TxStatus } from './history';
import { MidenCli } from './miden-cli';
import { publicFaucetAccountId } from './public-faucet';
import type { DappLabel } from './test-dapp-server';
import { getEnvironmentConfig } from '../config/environments';
import { CLIRunner } from '../harness/cli-runner';
import { TestStepRunner } from '../harness/test-step';
import { TimelineRecorder } from '../harness/timeline-recorder';
import type { ConnectedView } from '../test-dapp/protocol';

jest.mock('@playwright/test', () => {
  const jestExpect = expect;
  return {
    expect: Object.assign((value: unknown) => jestExpect(value), { any: jestExpect.any }),
    test: { info: () => ({ title: 'mobile journey unit', testId: 'mobile-journey-unit' }) }
  };
});
jest.mock('./dapp-cells', () => ({
  ...jest.requireActual<typeof import('./dapp-cells')>('./dapp-cells'),
  infraAborted: () => null,
  DappCellRunner: jest.fn(() => ({ recordCoverage: jest.fn(), setupFailed: jest.fn() }))
}));
jest.mock('./dapp-command-server', () => ({
  ...jest.requireActual<typeof import('./dapp-command-server')>('./dapp-command-server'),
  startCommandServer: jest.fn()
}));
jest.mock('./dapp-mobile-keyboard', () => ({ runNativeKeyboardJourney: jest.fn(async () => undefined) }));
jest.mock('./dapp-mobile-wallet', () => ({
  ...jest.requireActual<typeof import('./dapp-mobile-wallet')>('./dapp-mobile-wallet'),
  accountRows: jest.fn(),
  createAccount: jest.fn(),
  foregroundOrigin: jest.fn(),
  nativeAsset: jest.fn(),
  openDappUrl: jest.fn(),
  pendingNotes: jest.fn(async () => []),
  readRows: jest.fn(async () => []),
  vaultOf: jest.fn(),
  removeDappSession: jest.fn(async () => undefined),
  selectAccountIfNeeded: jest.fn(async () => undefined),
  waitForQueueDrained: jest.fn(async () => undefined)
}));
jest.mock('./dapp-mobile-sheet', () => ({
  ...jest.requireActual<typeof import('./dapp-mobile-sheet')>('./dapp-mobile-sheet'),
  answerSheet: jest.fn(),
  denyOpenSheet: jest.fn(async () => undefined)
}));
jest.mock('./public-faucet', () => ({
  ...jest.requireActual<typeof import('./public-faucet')>('./public-faucet'),
  publicFaucetAccountId: jest.fn()
}));
jest.mock('./dapp-node-calls', () => ({
  ...jest.requireActual('./dapp-node-calls'),
  nodeHeight: jest.fn(),
  waitForNodeHeight: jest.fn()
}));

const source = (file: string): string => fs.readFileSync(path.resolve(__dirname, '../../..', file), 'utf8');

/** The host clock, captured before any test installs fake timers. */
const REAL_DATE_NOW = Date.now;

describe('pending note provenance reads', () => {
  const readPending = jest.requireActual<typeof import('./dapp-mobile-wallet')>('./dapp-mobile-wallet').pendingNotes;
  const key = 'claimable_notes:v1:https://rpc.testnet.miden.io|testnet:mtst1b';

  function page() {
    const state = { currentAccount: { publicKey: 'mtst1b' } };
    const cache = { notes: [{ id: '0xf00d', senderAddress: 'mtst1foreign', faucetId: 'tst', amount: '174200' }] };
    const get = jest.fn(async (_input: { key: string }) => ({ value: JSON.stringify(cache.notes) }));
    const win = {
      __TEST_STORE__: { getState: () => state },
      Capacitor: { Plugins: { Preferences: { get } } }
    };
    const listed = { ids: ['0xf00d'], loading: false };
    const document = {
      querySelectorAll: () => listed.ids.map(id => ({ getAttribute: () => id })),
      querySelector: (selector: string) => (selector === '[role="progressbar"]' && listed.loading ? {} : null)
    };
    const unused = async (): Promise<never> => {
      throw new Error('unused pending-list action');
    };
    const wallet: MobileWallet = {
      evalJs: async <T>(js: string): Promise<T> => {
        // eslint-disable-next-line no-new-func
        return new Function('window', 'document', 'location', js)(win, document, { hash: '#/history?filter=pending' });
      },
      navigateTo: jest.fn(async () => undefined),
      click: unused,
      waitFor: unused,
      screenshot: unused,
      delay: unused,
      createNewWallet: unused,
      createGuardianWallet: unused,
      claimAllNotes: unused,
      getGuardianAuthInfo: unused
    };
    return { wallet, state, cache, listed, get };
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: 0 });
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('reads full base-unit provenance by visible note id from the exact account and network cache', async () => {
    const { wallet, cache, get } = page();
    cache.notes.unshift({ id: '0xother', senderAddress: 'mtst1a', faucetId: 'xbx', amount: '99' });
    const pending = readPending(wallet, 'mtst1b', 'https://rpc.testnet.miden.io', 'testnet', 10_000);
    await jest.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toEqual([
      { noteId: '0xf00d', sender: 'mtst1foreign', faucet: 'tst', amount: '174200' }
    ]);
    expect(get.mock.calls.every(([input]) => input.key === key)).toBe(true);
    expect(get.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('waits for provenance to be persisted rather than treating a visible unaccounted row as foreign', async () => {
    const { wallet, cache } = page();
    const notes = cache.notes;
    cache.notes = [];
    setTimeout(() => {
      cache.notes = notes;
    }, 1_500);
    const pending = readPending(wallet, 'mtst1b', 'https://rpc.testnet.miden.io', 'testnet', 10_000);
    await jest.advanceTimersByTimeAsync(8_000);
    await expect(pending).resolves.toEqual([
      { noteId: '0xf00d', sender: 'mtst1foreign', faucet: 'tst', amount: '174200' }
    ]);
  });

  it('waits for loading to end before accepting two empty Pending-list reads', async () => {
    const { wallet, listed, get } = page();
    listed.ids = [];
    listed.loading = true;
    let settled = false;
    const pending = readPending(wallet, 'mtst1b', 'https://rpc.testnet.miden.io', 'testnet', 10_000).then(notes => {
      settled = true;
      return notes;
    });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    listed.loading = false;
    await jest.advanceTimersByTimeAsync(7_000);
    await expect(pending).resolves.toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });

  it('fails within the cell bound when a row never acquires readable provenance', async () => {
    const { wallet, cache } = page();
    cache.notes = [];
    const pending = readPending(
      wallet,
      'mtst1b',
      'https://rpc.testnet.miden.io',
      'testnet',
      10_000,
      deadlineIn(700, 'R5')
    ).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(700);
    await expect(pending).resolves.toBeInstanceOf(CellDeadlineExceeded);
  });

  it('rejects an account change while the persisted snapshot is in flight', async () => {
    const { wallet, state, get } = page();
    get.mockImplementation(async () => {
      state.currentAccount.publicKey = 'mtst1other';
      return { value: '[]' };
    });
    const pending = readPending(wallet, 'mtst1b', 'https://rpc.testnet.miden.io', 'testnet', 10_000).catch(
      (error: unknown) => error
    );
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual(
      expect.objectContaining({ message: expect.stringContaining('Pending account changed') })
    );
  });
});

describe('mobile budgets', () => {
  it('reads the provider timeout the injected script enforces', () => {
    const timeout = /reject\(new Error\('Request timeout'\)\);\s*\}\s*\},\s*(\d+)\);/.exec(
      source('src/lib/dapp-browser/injection-script.ts')
    )?.[1];
    expect(Number(timeout)).toBe(MOBILE_PROVIDER_TIMEOUT_MS);
  });

  it('keeps every cell, the quiesce and one command under 280 s, ahead of that timeout', () => {
    const limit = MOBILE_PROVIDER_TIMEOUT_MS - 20_000;
    const budgets = { ...MOBILE_CELL_BUDGET_MS, quiesce: MOBILE_QUIESCE_BUDGET_MS, command: MOBILE_COMMAND_CEILING_MS };
    expect(Object.entries(budgets).filter(([, ms]) => ms > limit)).toEqual([]);
  });

  it("reads the wallet's 120 s auto-decline, and gives R7 room to wait it out", () => {
    const after = /const AUTODECLINE_AFTER = ([\d_]+);/
      .exec(source('src/lib/miden/back/dapp.ts'))?.[1]
      ?.replace(/_/g, '');
    expect(Number(after)).toBe(AUTO_DECLINE_MS);
    expect(MOBILE_CELL_BUDGET_MS.long).toBeGreaterThanOrEqual(AUTO_DECLINE_MS + 40_000);
  });

  it('ends a held sheet the hold margin before the auto-decline, counted from the request', () => {
    expect(holdLeftMs(1_000, 1_000)).toBe(AUTO_DECLINE_MS - HOLD_MARGIN_MS);
    expect(holdLeftMs(1_000, 1_000 + AUTO_DECLINE_MS - HOLD_MARGIN_MS)).toBe(0);
    expect(HOLD_MARGIN_MS).toBeGreaterThanOrEqual(10_000);
  });
});

describe('the leg coverage label', () => {
  const event = (data: Record<string, unknown>) => ({
    key: 'A/one',
    kind: 'presentation',
    at: 1,
    receivedAt: 2,
    visibility: 'visible',
    data
  });

  it.each([
    ['gated', 'ready() resolved'],
    ['fallback', 'Native presentation is unsupported in this WebView'],
    ['absent', 'window.bread.presentation.ready is not a function']
  ])('keeps a %s answer as the page reported it', (presentationPath, detail) => {
    expect(coverageOf(event({ path: presentationPath, detail }))).toEqual({ presentationPath, detail });
  });

  it('labels an observed unknown answer as other, saying what came', () => {
    expect(coverageOf(event({ path: 'something', detail: 'x' }))).toEqual({ presentationPath: 'other', detail: 'x' });
  });

  it('leaves coverage unset when the presentation event never arrived', () => {
    expect(coverageOf(null)).toBeUndefined();
  });
});

describe('the held sheet block', () => {
  const RPC = 'https://rpc.testnet.miden.io';
  const context = (): CellContext => ({
    deadline: deadlineIn(200_000, 'cell'),
    evidence: {},
    softFail: () => undefined
  });
  const sentAgo = (ms: number) => {
    const now = Date.now();
    return { origin: null, messages: [], approveEnabled: true, sentAt: now - ms, seenAt: now };
  };

  it('waits for the block after the tip within the hold margin counted from the request, not from the sight', async () => {
    jest.mocked(nodeHeight).mockReset().mockResolvedValue(100);
    const next = jest.mocked(waitForNodeHeight).mockReset().mockResolvedValue(101);
    await sheetBlock(RPC, sentAgo(30_000), context());
    expect(jest.mocked(nodeHeight)).toHaveBeenCalledWith(RPC, expect.any(Number));
    const [url, target, budget] = next.mock.calls[0] ?? [];
    expect([url, target]).toEqual([RPC, 101]);
    // 120 s less the 10 s margin less the 30 s since the request: about 80 s, where a count from the sight gives 110.
    expect(budget).toBeLessThanOrEqual(AUTO_DECLINE_MS - HOLD_MARGIN_MS - 30_000);
    expect(budget).toBeGreaterThan(AUTO_DECLINE_MS - HOLD_MARGIN_MS - 31_000);
  });

  it('fails as a harness fault when the hold margin ran out before the block', async () => {
    jest.mocked(nodeHeight).mockReset().mockResolvedValue(100);
    jest.mocked(waitForNodeHeight).mockReset();
    await expect(sheetBlock(RPC, sentAgo(AUTO_DECLINE_MS), context())).rejects.toBeInstanceOf(HarnessFault);
    expect(jest.mocked(waitForNodeHeight)).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let release: ((value: T) => void) | undefined;
  let fail: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return {
    promise,
    resolve: (value: T) => {
      if (release === undefined) throw new Error('deferred promise has no resolver');
      release(value);
    },
    reject: (reason: unknown) => {
      if (fail === undefined) throw new Error('deferred promise has no rejecter');
      fail(reason);
    }
  };
}

describe('the sheet block cutoff', () => {
  const rpc = 'https://rpc.testnet.miden.io';
  const sheet = () => ({
    origin: null,
    messages: [],
    approveEnabled: true,
    sentAt: Date.now() - AUTO_DECLINE_MS + HOLD_MARGIN_MS + 20,
    seenAt: Date.now()
  });
  const context = (ms = 200_000): CellContext => ({
    deadline: deadlineIn(ms, 'cell'),
    evidence: {},
    softFail: () => undefined
  });

  beforeEach(() => {
    jest.useFakeTimers();
    jest.mocked(nodeHeight).mockReset().mockResolvedValue(100);
    jest.mocked(waitForNodeHeight).mockReset().mockResolvedValue(101);
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('rejects a stalled initial tip query at the shared cutoff', async () => {
    jest.mocked(nodeHeight).mockReturnValue(new Promise(() => undefined));
    const outcome = jest.fn();
    void sheetBlock(rpc, sheet(), context()).then(outcome, outcome);
    await jest.advanceTimersByTimeAsync(20);
    expect(outcome).toHaveBeenCalledWith(expect.any(ChainUnavailable));
    expect(
      judgeCell({
        surface: 'ios',
        cellId: 'X1',
        axis: 'offchain',
        hardError: outcome.mock.calls[0]?.[0],
        softFailures: [],
        evidence: {},
        registry: registryOf([])
      }).verdict
    ).toBe('blocked-infra');
    expect(waitForNodeHeight).not.toHaveBeenCalled();
  });

  it('rejects a stalled target query at the shared cutoff', async () => {
    jest.mocked(nodeHeight).mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(100), 10)));
    jest.mocked(waitForNodeHeight).mockReturnValue(new Promise(() => undefined));
    const outcome = jest.fn();
    void sheetBlock(rpc, sheet(), context()).then(outcome, outcome);
    await jest.advanceTimersByTimeAsync(20);
    expect(waitForNodeHeight).toHaveBeenCalledWith(rpc, 101, 10);
    expect(outcome).toHaveBeenCalledWith(expect.any(ChainUnavailable));
    expect(
      judgeCell({
        surface: 'ios',
        cellId: 'X1',
        axis: 'offchain',
        hardError: outcome.mock.calls[0]?.[0],
        softFailures: [],
        evidence: {},
        registry: registryOf([])
      }).verdict
    ).toBe('blocked-infra');
  });

  it('rejects a target returned after the cutoff even before its timer can fire', async () => {
    const target = deferred<number>();
    jest.mocked(waitForNodeHeight).mockReturnValue(target.promise);
    const held = sheet();
    const pending = sheetBlock(rpc, held, context());
    const outcome = pending.then(
      () => null,
      error => error
    );
    await jest.advanceTimersByTimeAsync(0);
    jest.setSystemTime(held.sentAt + AUTO_DECLINE_MS - HOLD_MARGIN_MS + 1);
    target.resolve(101);
    await expect(outcome).resolves.toBeInstanceOf(ChainUnavailable);
  });

  it('uses the cell deadline when it precedes the sheet hold cutoff', async () => {
    jest.mocked(waitForNodeHeight).mockReturnValue(new Promise(() => undefined));
    const outcome = jest.fn();
    void sheetBlock(rpc, sheet(), context(5)).then(outcome, outcome);
    await jest.advanceTimersByTimeAsync(5);
    expect(waitForNodeHeight).toHaveBeenCalledWith(rpc, 101, 5);
    expect(outcome).toHaveBeenCalledWith(expect.any(ChainUnavailable));
  });
});

describe('mobile journey hooks and setup', () => {
  const origin = 'http://localhost:4545';
  const connected = (permission: string, address = 'mtst1a'): ConnectedView => ({
    address,
    addressCanonical: address,
    accountIdHex: '0xaaa',
    publicKeyHex: '0x123',
    privateDataPermission: permission,
    allowedPrivateData: permission === 'AUTO' ? 3 : null,
    builder: 'plain'
  });
  const wallet = (address: string): MobileWallet => ({
    createNewWallet: jest.fn(async () => ({ address, seedPhrase: [] })),
    createGuardianWallet: jest.fn(async () => ({ address, seedPhrase: [] })),
    claimAllNotes: jest.fn(),
    getGuardianAuthInfo: jest.fn(),
    evalJs: async <T>(): Promise<T> => {
      throw new Error('unexpected webview read');
    },
    click: jest.fn(),
    waitFor: jest.fn(),
    screenshot: jest.fn(),
    navigateTo: jest.fn(),
    delay: jest.fn()
  });
  let directory: string;
  let timeline: TimelineRecorder;
  let fetchLog: FetchLogEntry[];
  let device: MobileDevice & NativeKeyboardControls;
  const nodeCall = (status: number, options: Partial<FetchLogEntry> = {}): FetchLogEntry => ({
    url: 'https://rpc.testnet.miden.io/tip',
    method: 'POST',
    headers: [],
    at: 1,
    status,
    error: null,
    ms: 1,
    completedAt: 2,
    bodyDigest: 'a'.repeat(64),
    ...options
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(pendingNotes).mockReset().mockResolvedValue([]);
    jest.mocked(selectAccountIfNeeded).mockReset().mockResolvedValue(undefined);
    device = iosDevice([]);
    fetchLog = [nodeCall(200)];
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-journey-'));
    timeline = new TimelineRecorder(directory);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.mocked(accountRows).mockResolvedValue({
      account: 'mtst1a',
      displayFaucetId: null,
      rows: [{ tokenId: 'tst', symbol: 'TST', decimals: 8, balance: 1_000 }]
    });
    jest.mocked(nativeAsset).mockResolvedValue({ tokenId: 'native', symbol: 'MIDEN', decimals: 8, baseFee: 1 });
    jest.mocked(foregroundOrigin).mockResolvedValue(origin);
    jest.mocked(publicFaucetAccountId).mockResolvedValue('public-faucet');
    jest.mocked(answerSheet).mockImplementation(async (_host, start) => ({
      result: await start(),
      sheet: { origin, messages: [], approveEnabled: true, sentAt: Date.now(), seenAt: Date.now() },
      answeredAt: Date.now()
    }));
    jest.spyOn(MidenCli.prototype, 'init').mockResolvedValue(undefined);
    jest.spyOn(MidenCli.prototype, 'createFaucet').mockResolvedValue('cli-faucet');
    jest.spyOn(MidenCli.prototype, 'mint').mockResolvedValue({ txId: 'mint', noteId: 'held' });
    jest.spyOn(MidenCli.prototype, 'sync').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    jest.clearAllTimers();
    jest.useRealTimers();
    await timeline.close();
    fs.rmSync(directory, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  async function prepare(wanted: MobileSession = 'upon-request', returned = 'UPON_REQUEST') {
    const server: CommandServer = {
      port: 4545,
      urlFor: device => `${origin}/?device=${device}`,
      events: () => [],
      waitForEvent: async (what, predicate) => {
        const [key = '', kind = ''] = what.split(' ');
        const event = {
          key,
          kind,
          at: 1,
          receivedAt: 2,
          visibility: 'visible',
          data: { origin, isSecureContext: true, atBoot: true, path: 'gated', detail: 'ready() resolved' }
        };
        if (!predicate(event)) throw new Error(`unexpected event wait: ${what}`);
        return event;
      },
      send: jest.fn(async (device: DeviceKey, _dapp: DappLabel, command: string): Promise<CommandResult> => {
        let value: unknown;
        switch (command) {
          case '__fetchLog':
            value = fetchLog;
            break;
          case 'connect':
            value = {
              ok: true,
              value: connected(device === 'B' ? 'UPON_REQUEST' : returned, device === 'B' ? 'mtst1b' : 'mtst1a')
            };
            break;
          case 'session':
            value = {
              adapterConnected: false,
              adapterAddress: null,
              providerAddress: null,
              connected: null,
              events: []
            };
            break;
          case 'buildCustom':
            value = { requestId: 'producer', outputNoteIds: ['0xabc'] };
            break;
          case 'submitCustom':
            value = { ok: true, value: { txId: 'producer-tx' } };
            break;
          case 'waitForTransaction':
            value = { ok: true, value: { outputNotes: [{ noteId: '0xabc', bytesB64: 'note-bytes' }] } };
            break;
          case 'chainNote':
            value = { found: true };
            break;
          case 'noteFacts':
            value = { nullifierHex: '0xdef' };
            break;
          case 'init':
          case 'raw':
          case 'disconnect':
            value = {};
            break;
          default:
            throw new Error(`unexpected page command: ${command}`);
        }
        return { status: 'ok', value, enqueuedAt: 1, deliveredAt: 2, receivedAt: 3 };
      }),
      stop: jest.fn()
    };
    jest.mocked(startCommandServer).mockResolvedValue(server);
    const env = getEnvironmentConfig();
    const journey = await startMobileJourney({
      surface: device.surface,
      axis: mobileOffchainAxis,
      walletA: wallet('mtst1a'),
      walletB: wallet('mtst1b'),
      midenCli: new MidenCli({ binaryPath: 'unused', workDir: directory, env, cliRunner: new CLIRunner(timeline) }),
      envConfig: env,
      steps: new TestStepRunner(timeline, directory),
      testInfo: test.info(),
      device
    });
    const options = jest.mocked(DappCellRunner).mock.calls[0]?.[0];
    if (options === undefined) throw new Error('no runner hooks registered');
    return {
      journey,
      quiesce: (deadline: Deadline = deadlineIn(20_000, 'quiesce'), account: MobileSlot = 'primary') =>
        options.hooks.quiesce(
          { id: 'S1', budget: 'read', state: { session: wanted, account }, run: async () => undefined },
          deadline
        ),
      hooks: options.hooks,
      restore: () => options.hooks.restore({ id: 'R7-send', budget: 'long', run: async () => undefined })
    };
  }

  it.each<{ wanted: MobileSession; returned: string }>([
    { wanted: 'auto', returned: 'AUTO' },
    { wanted: 'upon-request', returned: 'UPON_REQUEST' }
  ])('accepts $returned for $wanted and remembers the account id', async ({ wanted, returned }) => {
    const { journey, quiesce } = await prepare(wanted, returned);
    await expect(quiesce()).resolves.toBeUndefined();
    expect(journey.memo.get('accountIdHex:mtst1a')).toBe('0xaaa');
    expect(jest.mocked(answerSheet).mock.calls.at(-1)?.[2]).toEqual({
      decision: 'approve',
      tickStandingAccess: wanted === 'auto'
    });
  });

  it('invokes the native keyboard check for the opened mobile dApp', async () => {
    const { journey } = await prepare();

    expect(runNativeKeyboardJourney).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'ios', device, page: journey.server, wallet: journey.walletA })
    );
  });

  it.each<{ wanted: MobileSession; returned: string; expected: string }>([
    { wanted: 'auto', returned: 'UPON_REQUEST', expected: 'AUTO' },
    { wanted: 'upon-request', returned: 'AUTO', expected: 'UPON_REQUEST' }
  ])('rejects $returned for $wanted as a harness fault naming both values', async ({ wanted, returned, expected }) => {
    const { journey, quiesce } = await prepare(wanted, returned);
    await expect(quiesce()).rejects.toEqual(
      expect.objectContaining({
        name: 'HarnessFault',
        message: `quiesce connect returned privateDataPermission ${returned}, expected ${expected}`
      })
    );
    expect(journey.memo.size).toBe(0);
  });

  it('classifies a created account and a stale list after createAccount', () => {
    const before = ['mtst1old'];
    const stale = [{ publicKey: 'mtst1old' }];
    expect(accountAddressAfterCreate(before, [{ publicKey: 'mtst1old' }, { publicKey: 'mtst1new' }], 'synced')).toEqual(
      { address: 'mtst1new' }
    );
    expect(accountAddressAfterCreate(before, stale, 'pending')).toBe('wait');
    expect(accountAddressAfterCreate(before, stale, 'synced')).toBe('missing');
    expect(source('playwright/e2e/helpers/wallet-page.ts')).toContain('account list has not landed');
    expect(source('playwright/e2e/helpers/dapp-mobile-wallet.ts')).toContain('account list has not landed');
  });

  it('does not select an account after creation outlives the quiesce deadline', async () => {
    const { quiesce, restore } = await prepare();
    const created = deferred<string>();
    jest.mocked(createAccount).mockReturnValue(created.promise);
    jest.useFakeTimers();
    const pending = quiesce(deadlineIn(20, 'quiesce'), 'second');
    const outcome = pending.then(
      () => null,
      error => error
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(createAccount).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(20);
    await expect(outcome).resolves.toBeInstanceOf(CellDeadlineExceeded);
    await restore();
    jest.mocked(selectAccountIfNeeded).mockClear();
    created.resolve('mtst1second');
    await jest.advanceTimersByTimeAsync(0);
    expect(selectAccountIfNeeded).not.toHaveBeenCalled();
  });

  it('stops selection commands at the quiesce deadline before cleanup and the next account change', async () => {
    const { journey, quiesce, restore } = await prepare();
    const updates: Array<{ address: string; at: number }> = [];
    const state = {
      currentAccount: { publicKey: 'mtst1other' },
      updateCurrentAccount: async (address: string): Promise<void> => {
        updates.push({ address, at: Date.now() });
      }
    };
    const win = { __TEST_STORE__: { getState: () => state } };
    journey.walletA.evalJs = async <T>(js: string): Promise<T> => {
      // eslint-disable-next-line no-new-func
      return new Function('window', js)(win);
    };
    const { selectAccountIfNeeded: select } =
      jest.requireActual<typeof import('./dapp-mobile-wallet')>('./dapp-mobile-wallet');
    jest.mocked(selectAccountIfNeeded).mockImplementation(select);
    jest.useFakeTimers({ now: 0 });
    const deadline = deadlineIn(700, 'short quiesce');
    const outcome = quiesce(deadline).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(700);
    await expect(outcome).resolves.toBeInstanceOf(CellDeadlineExceeded);
    const atExpiry = updates.length;
    expect(updates.at(0)).toEqual({ address: 'mtst1a', at: 0 });
    expect(updates.every(update => update.address === 'mtst1a' && update.at < 700)).toBe(true);
    state.currentAccount.publicKey = 'mtst1a';
    await restore();
    state.currentAccount.publicKey = 'mtst1other';
    await jest.advanceTimersByTimeAsync(30_000);
    expect(updates).toHaveLength(atExpiry);
  });

  async function pendingRecipientClaim(quiesceMs: number) {
    const { DappCellRunner: ActualRunner } = jest.requireActual<typeof import('./dapp-cells')>('./dapp-cells');
    jest.mocked(DappCellRunner).mockImplementationOnce(
      options =>
        new ActualRunner({
          ...options,
          outDir: path.join(directory, 'claim-records'),
          declared: ['W1', 'W4', 'X1'],
          registry: registryOf([]),
          budgets: { write: 5_000 },
          quiesceBudgetMs: quiesceMs,
          // Read the clock per call: the fake timers start after construction, and a captured host Date.now would
          // shorten the nested join deadline by the real milliseconds that pass.
          now: () => Date.now()
        })
    );
    const { journey } = await prepare();
    const runner = journey.runner;
    const raw = deferred<void>();
    const claim = jest.mocked(journey.walletB.claimAllNotes);
    claim.mockClear();
    claim.mockReturnValueOnce(raw.promise).mockResolvedValue(undefined);
    jest.mocked(pendingNotes).mockClear();
    const hash = `0x${'a'.repeat(64)}`;
    jest
      .mocked(readRows)
      .mockResolvedValue([
        { id: 'write', accountId: 'mtst1a', status: TxStatus.Completed, transactionId: hash, feeAmount: '0' }
      ]);
    jest.mocked(vaultOf).mockResolvedValue({ tst: 100n, native: 100n });
    const send = jest.mocked(journey.server.send).getMockImplementation();
    if (send === undefined) throw new Error('no command transport');
    jest.mocked(journey.server.send).mockImplementation(async (device, dapp, command, input, timeoutMs) => {
      let value: unknown;
      switch (command) {
        case 'waitForTransaction':
          value = {
            ok: true,
            value: {
              txHash: hash,
              outputNotes: [{ noteId: '0xabc', noteType: 'public', bytesB64: '', isSameSdkNote: true, script: 'p2id' }]
            }
          };
          break;
        case 'chainNote':
          value = { found: true, senderHex: '0xaaa', noteType: 'public', blockNum: 1 };
          break;
        case 'chainAccount':
          value = { found: true, commitmentHex: 'new' };
          break;
        default:
          return send(device, dapp, command, input, timeoutMs);
      }
      return { status: 'ok', value, enqueuedAt: 1, deliveredAt: 2, receivedAt: 3 };
    });
    jest.useFakeTimers();
    const first = runner.run({
      id: 'W1',
      budget: 'write',
      run: async ctx => {
        await expectMobileWriteToTheEnd(
          { j: journey, wallet: journey.walletA, dapp: journey.dapp, account: 'mtst1a', accountIdHex: '0xaaa' },
          { rowIds: [], capturedAtSec: 0, vault: { tst: 100n, native: 100n }, commitmentHex: 'old' },
          { txId: 'write', outputNotes: [{ noteType: 'public', toB: 1n }], consumedNullifiers: [] },
          {},
          ctx
        );
      }
    });
    await jest.advanceTimersByTimeAsync(5_000);
    expect((await first).verdict).toBe('fail-new');
    expect(journey.recipientClaim).toEqual({ cellId: 'W1', promise: raw.promise });
    return { journey, runner, raw, claim };
  }

  async function completedX1() {
    const { DappCellRunner: ActualRunner } = jest.requireActual<typeof import('./dapp-cells')>('./dapp-cells');
    jest.mocked(DappCellRunner).mockImplementationOnce(
      options =>
        new ActualRunner({
          ...options,
          outDir: path.join(directory, 'pending-records'),
          declared: ['X1', 'R5', 'R7-send'],
          registry: registryOf([])
        })
    );
    const { journey } = await prepare();
    const hash = `0x${'a'.repeat(64)}`;
    jest
      .mocked(readRows)
      .mockResolvedValue([
        { id: 'x1', accountId: 'mtst1a', status: TxStatus.Completed, transactionId: hash, feeAmount: '0' }
      ]);
    let received = 100n;
    jest
      .mocked(vaultOf)
      .mockImplementation(
        async (wallet): Promise<Record<string, bigint>> =>
          wallet === journey.walletB ? { tst: received } : { tst: 95n, native: 100n }
      );
    const claim = jest.mocked(journey.walletB.claimAllNotes);
    claim.mockClear();
    claim.mockImplementation(async () => {
      received += 5n;
    });
    const send = jest.mocked(journey.server.send).getMockImplementation();
    if (send === undefined) throw new Error('no command transport');
    jest.mocked(journey.server.send).mockImplementation(async (device, dapp, command, input, timeoutMs) => {
      let value: unknown;
      switch (command) {
        case 'waitForTransaction':
          value = {
            ok: true,
            value: {
              txHash: hash,
              outputNotes: [{ noteId: '0x111', noteType: 'public', bytesB64: '', isSameSdkNote: true, script: 'p2id' }]
            }
          };
          break;
        case 'chainNote':
          value = { found: true, senderHex: '0xaaa', noteType: 'public', blockNum: 1 };
          break;
        case 'chainAccount':
          value = { found: true, commitmentHex: 'new' };
          break;
        default:
          return send(device, dapp, command, input, timeoutMs);
      }
      return { status: 'ok', value, enqueuedAt: 1, deliveredAt: 2, receivedAt: 3 };
    });
    jest.useFakeTimers();
    const written = journey.runner.run({
      id: 'X1',
      budget: 'write',
      run: async ctx => {
        await expectMobileWriteToTheEnd(
          { j: journey, wallet: journey.walletA, dapp: journey.dapp, account: 'mtst1a', accountIdHex: '0xaaa' },
          { rowIds: [], capturedAtSec: 0, vault: { tst: 100n, native: 100n }, commitmentHex: 'old' },
          { txId: 'x1', outputNotes: [{ noteId: '0x111', noteType: 'public', toB: 5n }], consumedNullifiers: [] },
          { tst: -5n },
          ctx
        );
      }
    });
    await jest.advanceTimersByTimeAsync(5_000);
    expect((await written).verdict).toBe('pass');
    expect(received).toBe(105n);
    expect(journey.outputNoteIds).toContain('111');
    expect(claim).toHaveBeenCalledTimes(1);
    return { journey, claim };
  }

  const foreignNote: PendingNoteSnapshot = {
    noteId: '0xf00d',
    sender: 'mtst1stranger',
    faucet: 'xbx',
    amount: '174200'
  };

  it.each([
    { name: 'a foreign XBX note', notes: [foreignNote] },
    { name: 'a same-faucet foreign sender', notes: [{ ...foreignNote, faucet: 'tst', amount: '5' }] },
    { name: 'no foreign note', notes: [] }
  ])('continues from a passed X1 through R5 with $name and records provenance without claiming', async ({ notes }) => {
    const { journey, claim } = await completedX1();
    jest.mocked(pendingNotes).mockResolvedValue(notes);
    const run = jest.fn(async () => undefined);
    expect((await journey.runner.run({ id: 'R5', budget: 'read', run })).verdict).toBe('pass');
    expect((await journey.runner.run({ id: 'R7-send', budget: 'read', run })).verdict).toBe('pass');
    expect(run).toHaveBeenCalledTimes(2);
    expect(claim).toHaveBeenCalledTimes(1);
    const record: JourneyRecord = JSON.parse(fs.readFileSync(journey.runner.file, 'utf8'));
    expect(record.foreignPendingNotes ?? []).toEqual(
      notes.length === 0
        ? []
        : [
            { beforeCellId: 'R5', notes },
            { beforeCellId: 'R7-send', notes }
          ]
    );
  });

  it.each([
    { name: 'still-pending output', note: { ...foreignNote, noteId: '0x111' } },
    { name: 'still-pending output', note: { ...foreignNote, noteId: '0xABC' } },
    { name: 'still-pending output', note: { ...foreignNote, noteId: 'held' } },
    { name: 'unaccounted journey output', note: { ...foreignNote, noteId: '0x222', sender: 'mtst1a_suffix' } },
    { name: 'unaccounted journey output', note: { ...foreignNote, noteId: '0x222', sender: 'mtst1b' } },
    { name: 'unaccounted journey output', note: { ...foreignNote, noteId: '0x222', sender: 'cli-faucet' } },
    { name: 'unaccounted journey output', note: { ...foreignNote, noteId: '0x222', sender: 'tst' } },
    { name: 'unaccounted journey output', note: { ...foreignNote, noteId: '0x222', sender: 'public-faucet' } },
    { name: 'unaccounted journey output', note: { ...foreignNote, noteId: '0x222', sender: '' } }
  ])('blocks a $name after X1, even alongside a foreign note', async ({ name, note }) => {
    const { journey, claim } = await completedX1();
    jest.mocked(pendingNotes).mockResolvedValue([foreignNote, note]);
    const run = jest.fn(async () => undefined);
    const next = await journey.runner.run({ id: 'R5', budget: 'read', run });
    expect(next.verdict).toBe('blocked-state');
    expect(next.error).toContain(name);
    expect(next.error).toContain(note.noteId);
    expect((await journey.runner.run({ id: 'R7-send', budget: 'read', run })).verdict).toBe('blocked-state');
    expect(run).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalledTimes(1);
    const record: JourneyRecord = JSON.parse(fs.readFileSync(journey.runner.file, 'utf8'));
    expect(record.foreignPendingNotes).toEqual([{ beforeCellId: 'R5', notes: [foreignNote] }]);
  });

  it('joins an expired cell raw claim before reading B in the next quiesce', async () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { journey, runner, raw, claim } = await pendingRecipientClaim(20_000);
    const next = runner.run({ id: 'W4', budget: 'read', run: async () => undefined });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(pendingNotes).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalledTimes(1);
    raw.resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect((await next).verdict).toBe('pass');
    expect(pendingNotes).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(journey.recipientClaim).toBeUndefined();
    const written: JourneyRecord = JSON.parse(fs.readFileSync(runner.file, 'utf8'));
    expect(written.cells.some(cell => cell.evidence?.recipientClaimError !== undefined)).toBe(false);
    expect(warning).not.toHaveBeenCalled();
  });

  it('records a rejected prior claim against its originating cell without changing the next verdict', async () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { journey, runner, raw } = await pendingRecipientClaim(20_000);
    const next = runner.run({ id: 'W4', budget: 'read', run: async () => undefined });
    await jest.advanceTimersByTimeAsync(1_000);
    raw.reject(new Error('recipient claim failed after the cell expired'));
    await jest.advanceTimersByTimeAsync(0);
    expect((await next).verdict).toBe('pass');
    expect(journey.recipientClaim).toBeUndefined();
    const written: JourneyRecord = JSON.parse(fs.readFileSync(runner.file, 'utf8'));
    const origin = written.cells.find(cell => cell.id === 'W1');
    expect(origin?.verdict).toBe('fail-new');
    expect(origin?.evidence?.recipientClaimError).toBe('Error: recipient claim failed after the cell expired');
    expect(origin?.error).toContain(
      'late recipient claim from W1: Error: recipient claim failed after the cell expired'
    );
    expect(origin?.error).toContain('outlived the cell budget');
    expect(written.cells.find(cell => cell.id === 'W4')).toEqual(expect.objectContaining({ verdict: 'pass' }));
    expect(written.cells.find(cell => cell.id === 'W4')?.evidence?.recipientClaimError).toBeUndefined();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('W1: Error: recipient claim failed after the cell expired')
    );
  });

  it('blocks the leg when the raw claim cannot join within the next quiesce budget', async () => {
    const { journey, runner, raw, claim } = await pendingRecipientClaim(20_000);
    // Real milliseconds pass while the quiesce starts; the join budget must still follow the fake clock alone.
    let pending = journey.recipientClaim;
    Object.defineProperty(journey, 'recipientClaim', {
      configurable: true,
      get: () => {
        const until = REAL_DATE_NOW() + 5;
        while (REAL_DATE_NOW() < until) {
          // spin on the host clock
        }
        return pending;
      },
      set: value => {
        pending = value;
      }
    });
    const run = jest.fn(async () => undefined);
    let finished = false;
    const next = runner.run({ id: 'W4', budget: 'read', run }).then(record => {
      finished = true;
      return record;
    });
    await jest.advanceTimersByTimeAsync(18_999);
    expect(finished).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(finished).toBe(true);
    const record = await next;
    expect(record.verdict).toBe('blocked-state');
    expect(record.error).toContain("wallet B's previous claim");
    expect((await runner.run({ id: 'X1', budget: 'read', run })).verdict).toBe('blocked-state');
    expect(run).not.toHaveBeenCalled();
    expect(pendingNotes).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(journey.recipientClaim).toEqual({ cellId: 'W1', promise: raw.promise });
  });

  it('attempts disconnect, revocation and primary selection after denial rejects', async () => {
    const { journey, restore } = await prepare();
    const disconnect = jest.spyOn(journey, 'call');
    jest.mocked(denyOpenSheet).mockRejectedValueOnce(new Error('denial failed'));
    await expect(restore()).rejects.toThrow('denial failed');
    expect(disconnect).toHaveBeenCalledWith('disconnect', {}, expect.anything());
    expect(removeDappSession).toHaveBeenCalledWith(journey.walletA, origin);
    expect(selectAccountIfNeeded).toHaveBeenCalledWith(journey.walletA, 'mtst1a', expect.anything());
  });

  it('attempts revocation and primary selection after disconnect rejects and preserves every error', async () => {
    const { journey, restore } = await prepare();
    jest.spyOn(journey, 'call').mockRejectedValueOnce(new Error('disconnect failed'));
    jest.mocked(removeDappSession).mockRejectedValueOnce(new Error('revocation failed'));
    await expect(restore()).rejects.toMatchObject({
      message: expect.stringContaining('disconnect failed'),
      errors: [
        expect.objectContaining({ message: expect.stringContaining('disconnect failed') }),
        expect.objectContaining({ message: expect.stringContaining('revocation failed') })
      ]
    });
    expect(removeDappSession).toHaveBeenCalledWith(journey.walletA, origin);
    expect(selectAccountIfNeeded).toHaveBeenCalledWith(journey.walletA, 'mtst1a', expect.anything());
  });

  it('attempts revocation and primary selection after disconnect times out', async () => {
    const { journey, restore } = await prepare();
    jest.spyOn(journey, 'call').mockReturnValueOnce(new Promise(() => undefined));
    jest.useFakeTimers();
    const outcome = restore().then(
      () => null,
      error => error
    );
    await jest.advanceTimersByTimeAsync(30_000);
    await expect(outcome).resolves.toMatchObject({ message: expect.stringContaining('disconnect') });
    expect(removeDappSession).toHaveBeenCalledWith(journey.walletA, origin);
    expect(selectAccountIfNeeded).toHaveBeenCalledWith(journey.walletA, 'mtst1a', expect.anything());
  });

  it.each([
    {
      name: 'infrastructure',
      denial: undefined,
      disconnect: new InfrastructureFault('operator unavailable', { abortsLeg: false }),
      revocation: new Error('revocation failed'),
      verdict: 'blocked-infra',
      failedSteps: ['disconnect', 'revocation']
    },
    {
      name: 'harness',
      denial: new HarnessFault('sheet bridge failed'),
      disconnect: undefined,
      revocation: undefined,
      verdict: 'harness-fault',
      failedSteps: ['sheet denial']
    }
  ])(
    'preserves $name classification in a cell record after every restore attempt',
    async ({ denial, disconnect, revocation, verdict, failedSteps }) => {
      const { journey, restore } = await prepare();
      const call = jest.spyOn(journey, 'call');
      if (denial !== undefined) jest.mocked(denyOpenSheet).mockRejectedValueOnce(denial);
      if (disconnect !== undefined) call.mockRejectedValueOnce(disconnect);
      if (revocation !== undefined) jest.mocked(removeDappSession).mockRejectedValueOnce(revocation);
      const { DappCellRunner: ActualRunner } = jest.requireActual<typeof import('./dapp-cells')>('./dapp-cells');
      const runner = new ActualRunner({
        surface: 'ios',
        part: 'unit',
        axis: 'offchain',
        journey: 'PL',
        testTitle: 'restore classification',
        outDir: path.join(directory, 'restore-records'),
        declared: ['R7-send'],
        registry: registryOf([]),
        hooks: { quiesce: async () => undefined, restore: async () => undefined }
      });
      const record = await runner.run({ id: 'R7-send', budget: 'read', run: restore });
      expect(record.verdict).toBe(verdict);
      for (const step of failedSteps) expect(record.error).toContain(step);
      expect(denyOpenSheet).toHaveBeenCalledTimes(1);
      expect(call).toHaveBeenCalledWith('disconnect', {}, expect.anything());
      expect(removeDappSession).toHaveBeenCalledWith(journey.walletA, origin);
      expect(selectAccountIfNeeded).toHaveBeenCalledWith(journey.walletA, 'mtst1a', expect.anything());
    }
  );

  it.each([
    { setupMs: 2_000, waitMs: 500, expectedMs: 500 },
    { setupMs: 100, waitMs: 500, expectedMs: 100 },
    { setupMs: 60_000, waitMs: 60_000, expectedMs: 30_000 }
  ])('bounds a pending-only log by $expectedMs ms and names the call', async ({ setupMs, waitMs, expectedMs }) => {
    jest.useFakeTimers({ now: 0 });
    const now = jest.fn(() => Date.now());
    const channel: DappChannel = {
      label: 'A/one',
      send: jest.fn(async () => [nodeCall(0, { status: null, completedAt: null, ms: null })])
    };
    let settled = false;
    const outcome = guardNodeCalls(channel, getEnvironmentConfig().rpcUrl, deadlineIn(setupMs, 'setup', now), {
      pendingWaitMs: waitMs,
      now
    }).then(
      () => {
        settled = true;
        return null;
      },
      error => {
        settled = true;
        return error;
      }
    );
    await jest.advanceTimersByTimeAsync(expectedMs - 1);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toMatchObject({
      name: 'ChainUnavailable',
      message: expect.stringContaining('POST https://rpc.testnet.miden.io/tip still pending')
    });
    await expect(outcome).resolves.toBeInstanceOf(InfrastructureFault);
    const reads = jest.mocked(channel.send).mock.calls.length;
    await jest.advanceTimersByTimeAsync(1_000);
    expect(channel.send).toHaveBeenCalledTimes(reads);
    expect(now).toHaveBeenCalled();
  });

  it.each([
    { setupMs: 2_000, completedAt: 100, pollAt: 250 },
    { setupMs: 100, completedAt: 25, pollAt: 50 }
  ])(
    'accepts a pending entry that completes within a $setupMs ms setup budget',
    async ({ setupMs, completedAt, pollAt }) => {
      jest.useFakeTimers({ now: 0 });
      const send = jest.fn(async () => [
        Date.now() >= completedAt
          ? nodeCall(200, { completedAt, ms: completedAt - 1 })
          : nodeCall(0, { status: null, completedAt: null, ms: null })
      ]);
      const outcome = guardNodeCalls(
        { label: 'A/one', send },
        getEnvironmentConfig().rpcUrl,
        deadlineIn(setupMs, 'setup'),
        {
          pendingWaitMs: 1_000,
          now: Date.now
        }
      );
      await jest.advanceTimersByTimeAsync(pollAt);
      await expect(outcome).resolves.toBeUndefined();
      expect(send).toHaveBeenCalledTimes(2);
    }
  );

  it('recovers a pending call that fails and then retries after that failure completes', async () => {
    jest.useFakeTimers({ now: 0 });
    const failed = nodeCall(503, { completedAt: 100, ms: 99 });
    const retry = nodeCall(0, { at: 150, status: null, completedAt: null, ms: null });
    const send = jest
      .fn()
      .mockResolvedValueOnce([nodeCall(0, { status: null, completedAt: null, ms: null })])
      .mockResolvedValueOnce([failed, retry])
      .mockResolvedValue([failed, { ...retry, status: 200, completedAt: 300, ms: 150 }]);
    const outcome = guardNodeCalls(
      { label: 'A/one', send },
      getEnvironmentConfig().rpcUrl,
      deadlineIn(2_000, 'setup'),
      {
        pendingWaitMs: 1_000,
        now: Date.now
      }
    );
    await jest.advanceTimersByTimeAsync(500);
    await expect(outcome).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('keeps a pending call that completes with an unrecovered failure as infrastructure', async () => {
    jest.useFakeTimers({ now: 0 });
    const send = jest
      .fn()
      .mockResolvedValueOnce([nodeCall(0, { status: null, completedAt: null, ms: null })])
      .mockResolvedValue([nodeCall(503, { completedAt: 100, ms: 99 })]);
    const outcome = guardNodeCalls(
      { label: 'A/one', send },
      getEnvironmentConfig().rpcUrl,
      deadlineIn(2_000, 'setup'),
      {
        pendingWaitMs: 1_000,
        now: Date.now
      }
    ).catch(error => error);
    await jest.advanceTimersByTimeAsync(250);
    await expect(outcome).resolves.toBeInstanceOf(ChainUnavailable);
  });

  it('bounds a stalled fetch-log refresh and reports the last known pending call', async () => {
    jest.useFakeTimers({ now: 0 });
    const send = jest
      .fn()
      .mockResolvedValueOnce([nodeCall(0, { status: null, completedAt: null, ms: null })])
      .mockReturnValue(new Promise(() => undefined));
    const outcome = guardNodeCalls(
      { label: 'A/one', send },
      getEnvironmentConfig().rpcUrl,
      deadlineIn(2_000, 'setup'),
      {
        pendingWaitMs: 500,
        now: Date.now
      }
    ).catch(error => error);
    await jest.advanceTimersByTimeAsync(500);
    await expect(outcome).resolves.toMatchObject({
      name: 'ChainUnavailable',
      message: expect.stringContaining('POST https://rpc.testnet.miden.io/tip still pending')
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith('__fetchLog', {}, 250);
  });

  it('waits for a pending node call to complete before setup passes', async () => {
    jest.useFakeTimers({ now: 0 });
    fetchLog = [nodeCall(0, { status: null, completedAt: null, ms: null })];
    let settled = false;
    const outcome = prepare().then(result => {
      settled = true;
      return result;
    });
    await jest.advanceTimersByTimeAsync(249);
    expect(settled).toBe(false);
    fetchLog = [nodeCall(200, { completedAt: 200, ms: 199 })];
    await jest.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toHaveProperty('journey');
  });

  it('does not recover from an overlapping request that completed earlier', async () => {
    fetchLog = [
      nodeCall(503, { at: 0, completedAt: 100, ms: 100 }),
      nodeCall(200, { at: 10, completedAt: 20, ms: 10 })
    ];
    await expect(prepare()).rejects.toBeInstanceOf(ChainUnavailable);
  });

  it('does not recover from an overlapping success that started before the failure', async () => {
    fetchLog = [
      nodeCall(200, { at: 0, completedAt: 120, ms: 120 }),
      nodeCall(503, { at: 10, completedAt: 100, ms: 90 })
    ];
    await expect(prepare()).rejects.toBeInstanceOf(ChainUnavailable);
  });

  it('does not recover from a success with a different body on the same endpoint', async () => {
    fetchLog = [nodeCall(503), nodeCall(200, { at: 3, completedAt: 4, bodyDigest: 'b'.repeat(64) })];
    await expect(prepare()).rejects.toBeInstanceOf(ChainUnavailable);
  });

  it('keeps a failure after a success of the same call unrecovered', async () => {
    fetchLog = [nodeCall(200), nodeCall(503, { at: 3, completedAt: 4 })];
    await expect(prepare()).rejects.toBeInstanceOf(ChainUnavailable);
  });

  it('does not infer recovery when a request has no body digest', async () => {
    fetchLog = [nodeCall(503, { bodyDigest: null }), nodeCall(200, { at: 3, completedAt: 4 })];
    await expect(prepare()).rejects.toBeInstanceOf(ChainUnavailable);
  });

  it('accepts a node 503 followed by a successful retry of the same call', async () => {
    fetchLog = [nodeCall(503), nodeCall(200, { at: 3, completedAt: 4 })];
    await expect(prepare()).resolves.toHaveProperty('journey');
  });

  it('accepts a failed node fetch followed by a successful retry', async () => {
    fetchLog = [nodeCall(0, { status: null, error: 'connection reset' }), nodeCall(200, { at: 3, completedAt: 4 })];
    await expect(prepare()).resolves.toHaveProperty('journey');
  });

  it('classifies an unrecovered failed node fetch as infrastructure', async () => {
    fetchLog = [nodeCall(0, { status: null, error: 'Failed to fetch' })];
    await expect(prepare()).rejects.toBeInstanceOf(ChainUnavailable);
  });

  it('classifies an unrecovered node failure as infrastructure', async () => {
    fetchLog = [nodeCall(503)];
    await expect(prepare()).rejects.toBeInstanceOf(ChainUnavailable);
  });

  it('does not let a different successful call recover a node failure', async () => {
    fetchLog = [nodeCall(503), nodeCall(200, { at: 3, completedAt: 4, url: 'https://rpc.testnet.miden.io/other' })];
    await expect(prepare()).rejects.toBeInstanceOf(ChainUnavailable);
  });

  it('accepts a completed 200 node call with a newly allowed SDK header', async () => {
    fetchLog = [nodeCall(200, { headers: [['x-sdk-trace', 'value']] })];
    await expect(prepare()).resolves.toHaveProperty('journey');
  });

  it('keeps a disallowed header as a harness fault even after a successful retry', async () => {
    fetchLog = [nodeCall(503, { headers: [['x-bad-header', 'value']] }), nodeCall(200, { at: 3, completedAt: 4 })];
    await expect(prepare()).rejects.toBeInstanceOf(HarnessFault);
  });

  it.each([nodeCall(400), nodeCall(0, { status: null, error: 'CORS preflight rejected' })])(
    'keeps malformed requests and CORS failures as harness faults: %j',
    async call => {
      fetchLog = [call];
      await expect(prepare()).rejects.toBeInstanceOf(HarnessFault);
    }
  );

  it('classifies rejected forwarding as infrastructure and keeps its reason', async () => {
    const reason = new Error('adb connection lost');
    device = androidDevice(['device'], async () => {
      throw reason;
    });
    await expect(prepare()).rejects.toMatchObject({
      name: 'InfrastructureFault',
      message: expect.stringContaining('adb connection lost'),
      cause: reason
    });
  });

  it('keeps a verified but missing forwarding mapping as a harness fault', async () => {
    device = androidDevice(['device'], async () => '');
    await expect(prepare()).rejects.toBeInstanceOf(HarnessFault);
  });
});
