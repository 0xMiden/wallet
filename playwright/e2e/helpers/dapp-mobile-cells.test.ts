/**
 * @jest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DappCellRunner, deadlineIn, type CellContext } from './dapp-cells';
import { callOn } from './dapp-channel';
import { registryOf } from './dapp-known-bugs';
import { cellIdsFor } from './dapp-matrix';
import { mobileOffchainAxis } from './dapp-mobile-axis';
import { mobileCells } from './dapp-mobile-cells';
import type { MobileCellState, MobileJourney } from './dapp-mobile-journey';
import { answerSheet, expectNoSheet } from './dapp-mobile-sheet';
import type { MobileWallet } from './dapp-mobile-wallet';
import { captureRowWindow, expectNoNewMobileRows } from './dapp-mobile-writes';
import pinned from './dapp-pinned.json';
import { getEnvironmentConfig } from '../config/environments';
import type { ConnectedView, DappError, Outcome, SessionView } from '../test-dapp/protocol';

jest.mock('@playwright/test', () => {
  const jestExpect = expect;
  return {
    expect: Object.assign((actual: unknown) => jestExpect(actual), {
      objectContaining: jestExpect.objectContaining,
      stringMatching: jestExpect.stringMatching,
      any: jestExpect.any
    })
  };
});

jest.mock('./dapp-mobile-sheet', () => ({ answerSheet: jest.fn(), expectNoSheet: jest.fn() }));
jest.mock('./dapp-mobile-writes', () => ({
  ...jest.requireActual<typeof import('./dapp-mobile-writes')>('./dapp-mobile-writes'),
  captureRowWindow: jest.fn(),
  expectNoNewMobileRows: jest.fn()
}));

const source = (file: string): string => fs.readFileSync(path.resolve(__dirname, '../../..', file), 'utf8');

describe('the mobile slim set', () => {
  // Building the cells reads only the network; every other journey field is read when a cell runs.
  const cells = mobileCells({ network: 'testnet' } as unknown as MobileJourney);

  it.each(['offchain', 'guardian'] as const)('implements exactly the in-app browser cells on the %s axis', axis => {
    expect(Object.keys(cells).sort()).toEqual([...cellIdsFor('PL', axis)].sort());
  });

  it('waits out the auto-decline on the long budget and gives every write the write budget', () => {
    const budgetOf = (ids: string[]) => ids.map(id => [id, cells[id]?.budget]);
    expect(budgetOf(['R7-connect', 'R7-send', 'R7-consume', 'R7-custom'])).toEqual([
      ['R7-connect', 'long'],
      ['R7-send', 'long'],
      ['R7-consume', 'long'],
      ['R7-custom', 'long']
    ]);
    expect(budgetOf(['M1', 'W1', 'W4', 'X1', 'R5'])).toEqual([
      ['M1', 'write'],
      ['W1', 'write'],
      ['W4', 'write'],
      ['X1', 'write'],
      ['R5', 'write']
    ]);
  });

  it('starts every connect claim with no session, and the Auto claims with an Auto one', () => {
    const sessionOf = (ids: string[]) => ids.map(id => [id, cells[id]?.state?.session]);
    expect(sessionOf(['S1', 'S2', 'S3', 'R7-connect'])).toEqual([
      ['S1', 'none'],
      ['S2', 'none'],
      ['S3', 'none'],
      ['R7-connect', 'none']
    ]);
    expect(sessionOf(['S11', 'W4'])).toEqual([
      ['S11', 'auto'],
      ['W4', 'auto']
    ]);
  });
});

describe('the pinned sheet text', () => {
  const dapp = source('src/lib/miden/back/dapp.ts');
  const start = dapp.indexOf('async function formatSimulatedCustomEffects');
  const end = dapp.indexOf('function consentReason');
  const formatter = dapp.slice(start, end);

  it('reads the formatter the approval sheet shows', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it.each(Object.entries(pinned.sheet))('finds the pinned %s text in the wallet formatter', (_key, text) => {
    expect(formatter).toContain(text);
  });

  it('lists the declared preview before the simulated effects on the mobile sheet, so the cells read the effects last', () => {
    expect(dapp).toContain('transactionMessages: [...declaredMessages, ...simulatedEffects.messages]');
  });
});

const refusalCases = [
  { id: 'S3', name: 'WalletConnectionError', causeName: 'NotGrantedMidenWalletError', message: 'NOT_GRANTED' },
  { id: 'S6', name: 'NotGrantedMidenWalletError', message: 'NOT_GRANTED' },
  { id: 'R1-send', name: 'WalletTransactionError', causeName: 'NotGrantedMidenWalletError', message: 'NOT_GRANTED' },
  { id: 'R1-custom', name: 'WalletTransactionError', causeName: 'NotGrantedMidenWalletError', message: 'NOT_GRANTED' },
  { id: 'R3-noteType', name: 'InvalidParamsMidenWalletError', message: 'INVALID_PARAMS: Error: noteType is required' },
  {
    id: 'R3-customPayload',
    name: 'InvalidParamsMidenWalletError',
    message: 'INVALID_PARAMS: Error: INVALID_PARAMS: Invalid CustomTransaction payload'
  },
  { id: 'R3-customUndecodable', name: 'InvalidParamsMidenWalletError', message: 'INVALID_PARAMS: deserialize failed' },
  { id: 'R7-connect', name: 'WalletConnectionError', causeName: 'NotGrantedMidenWalletError', message: 'NOT_GRANTED' },
  { id: 'R7-send', name: 'WalletTransactionError', causeName: 'NotGrantedMidenWalletError', message: 'NOT_GRANTED' },
  { id: 'R7-consume', name: 'WalletTransactionError', causeName: 'NotGrantedMidenWalletError', message: 'NOT_GRANTED' },
  { id: 'R7-custom', name: 'WalletTransactionError', causeName: 'NotGrantedMidenWalletError', message: 'NOT_GRANTED' }
];

describe('mobile refusal parity without hiding the later claims', () => {
  const directories: string[] = [];
  afterEach(() => {
    jest.resetAllMocks();
    for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function fixture(
    id: string,
    error: DappError,
    options: { answeredAt?: number; providerAfterDeny?: string; outcome?: Outcome<unknown> } = {}
  ) {
    const unused = async (): Promise<never> => {
      throw new Error('unused fixture action');
    };
    const wallet: MobileWallet = {
      evalJs: unused,
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
    const connected: ConnectedView = {
      address: 'mtst1a',
      addressCanonical: 'mtst1a',
      accountIdHex: '0xaaaa',
      publicKeyHex: '0x1111',
      privateDataPermission: 'UPON_REQUEST',
      allowedPrivateData: null,
      builder: 'plain'
    };
    let sessionReads = 0;
    const send = jest.fn(async (command: string): Promise<unknown> => {
      if (command === 'session') {
        sessionReads++;
        const session: SessionView = {
          adapterAddress: connected.address,
          adapterConnected: true,
          connected,
          providerAddress: id === 'S3' ? (options.providerAfterDeny ?? null) : connected.address,
          events: sessionReads > 1 ? [{ at: 1, source: 'adapter', event: 'disconnect', address: null }] : []
        };
        return session;
      }
      if (command === 'disconnect') return { adapterAddress: null };
      if (command === 'connect' && id === 'S6') return { ok: true, value: connected };
      if (command === 'buildCustom') return { requestId: 'request' };
      return options.outcome ?? { ok: false, error };
    });
    const channel = { label: 'A/one', send };
    const dapp = { label: 'A/one', origin: 'https://example.test', channel, wallet };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-cells-'));
    directories.push(dir);
    const runner = new DappCellRunner<Partial<MobileCellState>>({
      surface: 'ios',
      part: 'unit',
      axis: 'offchain',
      journey: 'PL',
      testTitle: 'mobile cells',
      outDir: dir,
      declared: [id],
      registry: registryOf([]),
      hooks: { quiesce: async () => undefined, restore: async () => undefined }
    });
    const j: MobileJourney = {
      surface: 'ios',
      axis: mobileOffchainAxis,
      walletA: wallet,
      walletB: wallet,
      env: getEnvironmentConfig(),
      network: 'testnet',
      runner,
      server: { port: 0, urlFor: () => '', events: () => [], waitForEvent: unused, send: unused, stop: unused },
      dapp,
      dappB: dapp,
      cliFaucetId: 'cli',
      tokenFaucetId: 'tst',
      native: { tokenId: 'native', symbol: 'MIDEN', decimals: 0, baseFee: 0 },
      addressB: 'mtst1b',
      held: { w4: { noteId: 'w4', amount: 0n }, r7: { noteId: 'r7', amount: 0n } },
      produced: { noteId: '', bytesB64: '', nullifierHex: '', amount: 0n },
      providerAtBoot: false,
      memo: new Map(),
      senders: () => ['mtst1a', 'mtst1b'],
      account: async () => 'mtst1a',
      call: (command, input, deadline, callOptions) => callOn(channel, command, input, deadline, callOptions)
    };
    const softFail = jest.fn();
    const ctx: CellContext = { deadline: deadlineIn(10_000, id), evidence: {}, softFail };
    jest.mocked(answerSheet).mockImplementation(async (_host, start) => ({
      result: await start(),
      sheet: { origin: dapp.origin, messages: [], approveEnabled: true, sentAt: 0, seenAt: 500 },
      answeredAt: options.answeredAt ?? 120_000
    }));
    jest.mocked(expectNoSheet).mockImplementation(async (_host, start) => start());
    jest.mocked(captureRowWindow).mockResolvedValue({ rowIds: [], capturedAtSec: 0 });
    jest.mocked(expectNoNewMobileRows).mockResolvedValue(undefined);
    const run = async () => {
      const cell = mobileCells(j)[id];
      if (cell === undefined) throw new Error(`missing cell ${id}`);
      await cell.run(ctx);
    };
    return { run, ctx, softFail, send, j };
  }

  it.each(refusalCases)('records the plain Error in $id and reaches its remaining claims', async entry => {
    const error = {
      name: entry.causeName === undefined ? 'Error' : entry.name,
      message: entry.message,
      ...(entry.causeName === undefined ? {} : { causeName: 'Error' })
    };
    const f = fixture(entry.id, error);
    await f.run();
    expect(f.ctx.evidence.dappError).toEqual(error);
    expect(f.softFail).toHaveBeenCalledTimes(1);
    expect(f.softFail).toHaveBeenCalledWith('refusal-class', expect.any(String));
    const rowChecks = entry.id === 'S3' || entry.id === 'S6' ? 0 : 1;
    expect(expectNoNewMobileRows).toHaveBeenCalledTimes(rowChecks);
  });

  it.each(refusalCases)('accepts extension-parity classes in $id with no soft failure', async entry => {
    const { id, ...error } = entry;
    const f = fixture(id, error);
    await f.run();
    expect(f.softFail).not.toHaveBeenCalled();
  });

  it.each([
    { ok: true, value: {} },
    { ok: false, error: { name: 'Error', message: 'a different refusal' } }
  ] satisfies Outcome<unknown>[])('keeps a successful or wrong-message answer hard: %j', async outcome => {
    const f = fixture('R1-send', { name: 'Error', message: 'NOT_GRANTED' }, { outcome });
    await expect(f.run()).rejects.toThrow();
    expect(f.softFail).not.toHaveBeenCalled();
    expect(expectNoNewMobileRows).not.toHaveBeenCalled();
  });

  it('keeps a new-row regression hard after recording a class difference', async () => {
    const f = fixture('R1-send', { name: 'WalletTransactionError', causeName: 'Error', message: 'NOT_GRANTED' });
    jest.mocked(expectNoNewMobileRows).mockRejectedValue(new Error('a refused request added a row'));
    await expect(f.run()).rejects.toThrow('a refused request added a row');
    expect(f.softFail).toHaveBeenCalledWith('refusal-class', expect.any(String));
  });

  it('still rejects a connected provider after S3 denies the connection', async () => {
    const f = fixture(
      'S3',
      { name: 'WalletConnectionError', causeName: 'Error', message: 'NOT_GRANTED' },
      { providerAfterDeny: 'mtst1a' }
    );
    await expect(f.run()).rejects.toThrow();
    expect(f.softFail).toHaveBeenCalledWith('refusal-class', expect.any(String));
  });

  it('requires the reconnect sheet after S6 refuses the stale provider request', async () => {
    const f = fixture('S6', { name: 'Error', message: 'NOT_GRANTED' });
    jest.mocked(answerSheet).mockRejectedValue(new Error('the reconnect did not prompt'));
    await expect(f.run()).rejects.toThrow('the reconnect did not prompt');
    expect(f.softFail).toHaveBeenCalledWith('refusal-class', expect.any(String));
  });

  it.each([118_999, 140_501])('keeps an out-of-window R7 decline hard at %i ms', async answeredAt => {
    const f = fixture(
      'R7-send',
      { name: 'WalletTransactionError', causeName: 'Error', message: 'NOT_GRANTED' },
      { answeredAt }
    );
    await expect(f.run()).rejects.toThrow();
    expect(f.ctx.evidence.stepDurationsMs).toEqual({
      declineFromRequest: answeredAt,
      declineFromSheet: answeredAt - 500
    });
    expect(f.softFail).toHaveBeenCalledWith('refusal-class', expect.any(String));
  });

  it.each([119_000, 140_500])('records both R7 clocks and accepts the boundary at %i ms', async answeredAt => {
    const f = fixture(
      'R7-send',
      { name: 'WalletTransactionError', causeName: 'Error', message: 'NOT_GRANTED' },
      { answeredAt }
    );
    await f.run();
    expect(f.ctx.evidence.stepDurationsMs).toEqual({
      declineFromRequest: answeredAt,
      declineFromSheet: answeredAt - 500
    });
    expect(expectNoNewMobileRows).toHaveBeenCalledTimes(1);
  });
});
