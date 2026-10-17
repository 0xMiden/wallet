/**
 * @jest-environment node
 */
import { test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DappCellRunner, deadlineIn, HarnessFault, type CellContext } from './dapp-cells';
import {
  MOBILE_COMMAND_CEILING_MS,
  startCommandServer,
  type CommandServer,
  type CommandResult,
  type DeviceKey
} from './dapp-command-server';
import { mobileOffchainAxis } from './dapp-mobile-axis';
import { iosDevice } from './dapp-mobile-device';
import {
  AUTO_DECLINE_MS,
  coverageOf,
  HOLD_MARGIN_MS,
  holdLeftMs,
  MOBILE_CELL_BUDGET_MS,
  MOBILE_PROVIDER_TIMEOUT_MS,
  MOBILE_QUIESCE_BUDGET_MS,
  sheetBlock,
  startMobileJourney,
  type MobileSession
} from './dapp-mobile-journey';
import { answerSheet } from './dapp-mobile-sheet';
import { accountRows, foregroundOrigin, nativeAsset, type MobileWallet } from './dapp-mobile-wallet';
import { nodeHeight, waitForNodeHeight } from './dapp-node-calls';
import { MidenCli } from './miden-cli';
import { publicFaucetAccountId } from './public-faucet';
import type { DappLabel } from './test-dapp-server';
import { getEnvironmentConfig } from '../config/environments';
import { CLIRunner } from '../harness/cli-runner';
import { TestStepRunner } from '../harness/test-step';
import { TimelineRecorder } from '../harness/timeline-recorder';
import type { ConnectedView } from '../test-dapp/protocol';

jest.mock('@playwright/test', () => ({
  expect: Object.assign(jest.fn(), { any: jest.fn() }),
  test: { info: () => ({ title: 'mobile journey unit', testId: 'mobile-journey-unit' }) }
}));
jest.mock('./dapp-cells', () => ({
  ...jest.requireActual<typeof import('./dapp-cells')>('./dapp-cells'),
  infraAborted: () => null,
  DappCellRunner: jest.fn(() => ({ recordCoverage: jest.fn(), setupFailed: jest.fn() }))
}));
jest.mock('./dapp-command-server', () => ({
  ...jest.requireActual<typeof import('./dapp-command-server')>('./dapp-command-server'),
  startCommandServer: jest.fn()
}));
jest.mock('./dapp-mobile-wallet', () => ({
  ...jest.requireActual<typeof import('./dapp-mobile-wallet')>('./dapp-mobile-wallet'),
  accountRows: jest.fn(),
  foregroundOrigin: jest.fn(),
  nativeAsset: jest.fn(),
  openDappUrl: jest.fn(),
  pendingTransfers: jest.fn(async () => 0),
  readRows: jest.fn(async () => []),
  removeDappSession: jest.fn(),
  selectAccountIfNeeded: jest.fn(),
  waitForQueueDrained: jest.fn(async () => undefined)
}));
jest.mock('./dapp-mobile-sheet', () => ({
  ...jest.requireActual<typeof import('./dapp-mobile-sheet')>('./dapp-mobile-sheet'),
  answerSheet: jest.fn(),
  denyOpenSheet: jest.fn()
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

  it('labels an unknown answer and a missing one as other, saying what came', () => {
    expect(coverageOf(event({ path: 'something', detail: 'x' }))).toEqual({ presentationPath: 'other', detail: 'x' });
    expect(coverageOf(null)).toEqual({ presentationPath: 'other', detail: 'no presentation answer within 35000 ms' });
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
    expect(jest.mocked(nodeHeight)).toHaveBeenCalledWith(RPC);
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

describe('the quiesce connect permission', () => {
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

  beforeEach(() => {
    jest.clearAllMocks();
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
    await timeline.close();
    fs.rmSync(directory, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  async function prepare(wanted: MobileSession, returned: string) {
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
            value = [{ url: 'https://rpc.testnet.miden.io/tip', headers: [], status: 200 }];
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
      surface: 'ios',
      axis: mobileOffchainAxis,
      walletA: wallet('mtst1a'),
      walletB: wallet('mtst1b'),
      midenCli: new MidenCli({ binaryPath: 'unused', workDir: directory, env, cliRunner: new CLIRunner(timeline) }),
      envConfig: env,
      steps: new TestStepRunner(timeline, directory),
      testInfo: test.info(),
      device: iosDevice([])
    });
    const options = jest.mocked(DappCellRunner).mock.calls[0]?.[0];
    if (options === undefined) throw new Error('no runner hooks registered');
    return {
      journey,
      quiesce: () =>
        options.hooks.quiesce(
          { id: 'S1', budget: 'read', state: { session: wanted }, run: async () => undefined },
          deadlineIn(20_000, 'quiesce')
        )
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
});
