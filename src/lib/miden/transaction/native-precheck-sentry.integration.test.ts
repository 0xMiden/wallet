import { createInstance } from 'i18next';

import * as Repo from 'lib/miden/repo';
import { isCrashReportingEnabledAsync, isTelemetryEnabledAsync } from 'lib/settings/helpers';
import { bridgeReceiveLibraryError } from 'lib/telemetry/bridge-receive-failure';
import { stopCrashReporting } from 'lib/telemetry/crash';
import {
  assertNativeSessionChain,
  NativeSessionChainNotApprovedError,
  prepareNativeSessionChain,
  type ReownPlugin,
  type ReownState
} from 'lib/walletconnect/native';
import { nativeSigningErrorMessage } from 'lib/walletconnect/signing-error';

import { updateBridgedReceivePhase } from './complete';
import { ITransaction, ITransactionStatus } from '../db/types';

const mockStateListeners: Array<(state: ReownState) => void> = [];
const mockRemoveListener = jest.fn(async () => undefined);

jest.mock('@capacitor/core', () => {
  const actual = jest.requireActual<typeof import('@capacitor/core')>('@capacitor/core');
  const nativePrecheckIO = {
    getState: jest.fn(),
    request: jest.fn(),
    sendTransaction: jest.fn(),
    addListener: jest.fn(async (_name: string, listener: (state: ReownState) => void) => {
      mockStateListeners.push(listener);
      return { remove: mockRemoveListener };
    })
  };
  return {
    ...actual,
    nativePrecheckIO,
    registerPlugin: (name: string) => (name === 'Reown' ? nativePrecheckIO : actual.registerPlugin(name))
  };
});
jest.mock('lib/platform', () => ({
  ...jest.requireActual<typeof import('lib/platform')>('lib/platform'),
  isMobile: () => true,
  isIOS: () => true,
  isAndroid: () => false
}));
jest.mock('lib/settings/helpers', () => ({
  ...jest.requireActual<typeof import('lib/settings/helpers')>('lib/settings/helpers'),
  isCrashReportingEnabledAsync: jest.fn(),
  isTelemetryEnabledAsync: jest.fn()
}));
jest.mock('lib/telemetry/report-operation', () => ({ reportOperation: jest.fn() }));
jest.mock('lib/walletconnect/config', () => {
  const actual = jest.requireActual<typeof import('lib/walletconnect/testing/chains')>(
    'lib/walletconnect/testing/chains'
  );
  return actual.walletConnectConfigMock([actual.NO_PUBLIC_RPC_CHAIN]);
});

type NativeIO = Pick<ReownPlugin, 'getState' | 'request' | 'sendTransaction' | 'addListener'>;
const nativeIO = jest.requireMock<{ nativePrecheckIO: NativeIO }>('@capacitor/core').nativePrecheckIO;

const APPROVED = 11155111;
const TARGET = 5042002;
const NO_PUBLIC_RPC = 990001;
const UNKNOWN_CHAIN = 990003;
const PRIVATE_TOPIC = 'precheck-private-topic-7850bcf19a2e';
const PRIVATE_ACCOUNT = `0x${'c7'.repeat(20)}`;
const PRIVATE_AMOUNT = '9173.245801';
const PRIVATE_URL = 'https://precheck-private.example.invalid/rpc?projectId=5e3bdcf1174a';
const PRIVATE_TEXT = `precheck confidential ${PRIVATE_TOPIC} ${PRIVATE_ACCOUNT} ${PRIVATE_AMOUNT} ${PRIVATE_URL}`;
const POISON = [
  PRIVATE_TOPIC,
  PRIVATE_ACCOUNT,
  'c7c7c7',
  PRIVATE_AMOUNT,
  PRIVATE_URL,
  '5e3bdcf1174a',
  'Arc Testnet',
  'No Public RPC',
  'precheck confidential',
  'eip155:',
  '11155111',
  '5042002',
  '990001',
  '990003'
];
const i18n = createInstance();

interface CapturedRequest {
  url: string;
  headers: string;
  body: string;
}

const captured: CapturedRequest[] = [];
let originalFetch: PropertyDescriptor | undefined;
let originalDsn: string | undefined;
let nextRow = 0;

function bodyText(body: unknown): string {
  if (typeof body === 'string') return body;
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
  return body === undefined || body === null ? '' : JSON.stringify(body);
}

function headerText(headers: unknown): string {
  if (headers instanceof Headers) return [...headers.entries()].map(([key, value]) => `${key}: ${value}`).join('\n');
  return headers === undefined ? '' : JSON.stringify(headers);
}

// Sentry retains its first fetch reference; replacing it per case can hide a real envelope from assertions.
const fetchStub = async (input: unknown, init?: { headers?: unknown; body?: unknown }) => {
  captured.push({ url: String(input), headers: headerText(init?.headers), body: bodyText(init?.body) });
  return { status: 200, headers: new Headers() };
};

function session(chainIds?: number[]): ReownState {
  const state: ReownState = {
    configured: true,
    connected: true,
    topic: PRIVATE_TOPIC,
    address: PRIVATE_ACCOUNT,
    accounts: [PRIVATE_ACCOUNT],
    chainId: APPROVED,
    chainIds,
    walletName: PRIVATE_TEXT
  };
  Object.freeze(state.accounts);
  if (state.chainIds !== undefined) Object.freeze(state.chainIds);
  return Object.freeze(state);
}

function prepare(chainId: number, evidence: Record<string, unknown>): Promise<void> {
  // The future optional carrier is empty here; today's producer ignores it and the real wire assertion goes red.
  return Reflect.apply(prepareNativeSessionChain, undefined, [chainId, evidence]);
}

async function outcome(pending: Promise<void>): Promise<{ resolved: boolean; error?: unknown }> {
  try {
    await pending;
    return { resolved: true };
  } catch (error) {
    return { resolved: false, error };
  }
}

async function flushWire(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 5));
}

async function emitFailure(
  cause: unknown,
  evidence: Record<string, unknown>,
  library = 'none',
  genericCategory: 'unknown' | 'rpc' = 'unknown'
): Promise<string> {
  expect(bridgeReceiveLibraryError(cause)).toBe(library);
  const id = `private-precheck-row-${++nextRow}`;
  const row: ITransaction = {
    id,
    type: 'bridged-receive',
    accountId: PRIVATE_ACCOUNT,
    status: ITransactionStatus.Completed,
    initiatedAt: 1000,
    displayIcon: 'DEFAULT',
    extraInputs: { phase: 'submitting', provider: 'usdcx' }
  };
  await Repo.transactions.put(row);
  const error = nativeSigningErrorMessage(cause, i18n.t, value =>
    value instanceof Error ? value.message : 'Unknown error'
  );
  expect(typeof error).toBe('string');
  const source = { step: 'precheck_session_chain', cause, nativePrecheck: evidence };
  const before = captured.length;
  await updateBridgedReceivePhase(id, 'failed', { error, failure: { ...source, step: 'precheck_session_chain' } });
  await flushWire();

  expect(captured).toHaveLength(before + 1);
  const sent = captured.slice(before);
  expect(sent[0]?.body).toContain('WalletTransactionFailure');
  const wire = sent.map(entry => `${entry.url}\n${entry.headers}\n${entry.body}`).join('\n');
  const genericIdentity = genericCategory === 'rpc' ? 'rpc' : 'unknown; thrown string';
  expect(wire).toContain(`point bridge_receive_settlement; ${genericIdentity}; via usdcx`);
  expect(wire).toContain(`failed at precheck_session_chain; evm error ${library}`);
  for (const poison of [...POISON, id]) expect(wire).not.toContain(poison);
  const saved = await Repo.transactions.get(id);
  expect(saved?.extraInputs).toMatchObject({ phase: 'failed', provider: 'usdcx' });
  expect(saved).not.toHaveProperty('failure');
  expect(saved?.extraInputs).not.toHaveProperty('nativePrecheck');
  expect(saved?.extraInputs).not.toHaveProperty('cause');
  expect(nativeIO.sendTransaction).not.toHaveBeenCalled();
  return wire;
}

function expectFacts(wire: string, reason: string, recovery: string, recoveryError = 'none'): void {
  expect(wire).toContain(`native precheck ${reason}`);
  expect(wire).toContain(`chain recovery ${recovery}`);
  expect(wire).toContain(`recovery error ${recoveryError}`);
}

function expectGuard(result: { resolved: boolean; error?: unknown }): void {
  expect(result.resolved).toBe(false);
  expect(result.error).toBeInstanceOf(NativeSessionChainNotApprovedError);
}

beforeAll(async () => {
  originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  originalDsn = process.env.SENTRY_DSN;
  Object.defineProperty(globalThis, 'fetch', { value: fetchStub, configurable: true, writable: true });
  await i18n.init({
    lng: 'en',
    resources: { en: { translation: { evmChainNotApproved: 'Reconnect the wallet for {{network}}.' } } }
  });
});

afterAll(() => {
  if (originalFetch === undefined) Reflect.deleteProperty(globalThis, 'fetch');
  else Object.defineProperty(globalThis, 'fetch', originalFetch);
  if (originalDsn === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = originalDsn;
});

beforeEach(async () => {
  jest.clearAllMocks();
  captured.length = 0;
  mockStateListeners.length = 0;
  process.env.SENTRY_DSN = 'https://publickey@o0.ingest.de.sentry.io/1';
  jest.mocked(isCrashReportingEnabledAsync).mockResolvedValue(true);
  jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(false);
  jest.mocked(nativeIO.getState).mockReset().mockResolvedValue(session([APPROVED]));
  jest.mocked(nativeIO.request).mockReset().mockResolvedValue({ result: null });
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  await Repo.transactions.clear();
});

afterEach(async () => {
  jest.useRealTimers();
  stopCrashReporting();
  await flushWire();
  jest.restoreAllMocks();
});

it('reports a missing native session without a recovery request or a send', async () => {
  const evidence: Record<string, unknown> = {};
  jest
    .mocked(nativeIO.getState)
    .mockResolvedValue(Object.freeze({ configured: true, connected: false, accounts: [] }));
  const result = await outcome(prepare(TARGET, evidence));
  expectGuard(result);
  expect(nativeIO.getState).toHaveBeenCalledTimes(1);
  expect(nativeIO.request).not.toHaveBeenCalled();
  expectFacts(await emitFailure(result.error, evidence), 'session_missing', 'not_attempted');
});

it('reports an explicit missing-chain guard separately from a missing session', async () => {
  const evidence: Record<string, unknown> = {};
  let cause: unknown;
  try {
    Reflect.apply(assertNativeSessionChain, undefined, [session([APPROVED]), TARGET, 'Arc Testnet', evidence]);
  } catch (error) {
    cause = error;
  }
  expect(cause).toBeInstanceOf(NativeSessionChainNotApprovedError);
  expect(nativeIO.getState).not.toHaveBeenCalled();
  expect(nativeIO.request).not.toHaveBeenCalled();
  expectFacts(await emitFailure(cause, evidence), 'chain_not_approved', 'not_attempted');
});

it.each([
  { name: 'unknown chain configuration', chainId: UNKNOWN_CHAIN, approved: [APPROVED], recovery: 'chain_unconfigured' },
  { name: 'missing public RPC', chainId: NO_PUBLIC_RPC, approved: [APPROVED], recovery: 'public_rpc_unavailable' },
  { name: 'empty approved-chain list', chainId: TARGET, approved: [], recovery: 'approved_chain_unavailable' }
])('reports $name without asking the wallet to recover it', async ({ chainId, approved, recovery }) => {
  const evidence: Record<string, unknown> = {};
  jest.mocked(nativeIO.getState).mockResolvedValue(session(approved));
  const result = await outcome(prepare(chainId, evidence));
  expectGuard(result);
  expect(nativeIO.getState).toHaveBeenCalledTimes(1);
  expect(nativeIO.request).not.toHaveBeenCalled();
  const genericCategory = chainId === NO_PUBLIC_RPC ? 'rpc' : 'unknown';
  expectFacts(await emitFailure(result.error, evidence, 'none', genericCategory), 'chain_not_approved', recovery);
});

it('reports a rejected add while preserving the final guard and its library identity', async () => {
  const evidence: Record<string, unknown> = {};
  const rejection = Object.freeze({ code: 4001, message: `User rejected ${PRIVATE_TEXT}` });
  jest.mocked(nativeIO.request).mockRejectedValue(rejection);
  const result = await outcome(prepare(TARGET, evidence));
  expectGuard(result);
  expect(result.error).not.toBe(rejection);
  expect(nativeIO.request).toHaveBeenCalledTimes(1);
  expect(nativeIO.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'wallet_addEthereumChain' }));
  expect(nativeIO.getState).toHaveBeenCalledTimes(2);
  expect(nativeIO.addListener).not.toHaveBeenCalled();
  expectFacts(await emitFailure(result.error, evidence), 'chain_not_approved', 'add_request_failed', 'user_rejected');
});

it('reports a rejected switch separately from a rejected add without retrying', async () => {
  const evidence: Record<string, unknown> = {};
  const rejection = Object.freeze({ code: 4001, message: `User rejected ${PRIVATE_TEXT}` });
  jest.mocked(nativeIO.request).mockResolvedValueOnce({ result: null }).mockRejectedValueOnce(rejection);
  const result = await outcome(prepare(TARGET, evidence));
  expectGuard(result);
  expect(nativeIO.request).toHaveBeenCalledTimes(2);
  expect(nativeIO.request).toHaveBeenNthCalledWith(1, expect.objectContaining({ method: 'wallet_addEthereumChain' }));
  expect(nativeIO.request).toHaveBeenNthCalledWith(2, expect.objectContaining({ method: 'wallet_switchEthereumChain' }));
  expect(nativeIO.getState).toHaveBeenCalledTimes(2);
  expect(nativeIO.addListener).not.toHaveBeenCalled();
  expectFacts(await emitFailure(result.error, evidence), 'chain_not_approved', 'switch_request_failed', 'user_rejected');
});

it('reports approval wait expiry only after the unchanged five-second wait', async () => {
  jest.useFakeTimers();
  const evidence: Record<string, unknown> = {};
  let settled = false;
  const pending = outcome(prepare(TARGET, evidence)).then(result => {
    settled = true;
    return result;
  });
  await jest.advanceTimersByTimeAsync(4999);
  expect(settled).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  const result = await pending;
  expectGuard(result);
  expect(nativeIO.request).toHaveBeenCalledTimes(2);
  expect(nativeIO.getState).toHaveBeenCalledTimes(11);
  expect(mockRemoveListener).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
  expectFacts(await emitFailure(result.error, evidence), 'chain_not_approved', 'approval_wait_expired');
});

it('reports initial state-read failure without changing either Error or primitive rejection identity', async () => {
  const wires: string[] = [];
  for (const rejection of [Object.freeze(new Error(PRIVATE_TEXT)), undefined]) {
    const evidence: Record<string, unknown> = {};
    jest.mocked(nativeIO.getState).mockReset().mockRejectedValue(rejection);
    const result = await outcome(prepare(TARGET, evidence));
    expect(result).toEqual({ resolved: false, error: rejection });
    expect(result.error).toBe(rejection);
    expect(nativeIO.getState).toHaveBeenCalledTimes(1);
    expect(nativeIO.request).not.toHaveBeenCalled();
    const library = rejection === undefined ? 'none' : 'other';
    const genericCategory = rejection === undefined ? 'unknown' : 'rpc';
    wires.push(await emitFailure(result.error, evidence, library, genericCategory));
  }
  for (const wire of wires) expectFacts(wire, 'state_read_failed', 'not_attempted');
});

it('keeps already-approved and legacy sessions successful without requests or reports', async () => {
  for (const approved of [[APPROVED, TARGET], undefined]) {
    const state = session(approved);
    jest.mocked(nativeIO.getState).mockResolvedValueOnce(state);
    const evidence: Record<string, unknown> = {};
    await expect(prepare(TARGET, evidence)).resolves.toBeUndefined();
    expect(evidence).not.toHaveProperty('reason');
  }
  expect(nativeIO.getState).toHaveBeenCalledTimes(2);
  expect(nativeIO.request).not.toHaveBeenCalled();
  expect(nativeIO.sendTransaction).not.toHaveBeenCalled();
  await flushWire();
  expect(captured).toEqual([]);
});

it('keeps recovery by session update successful and removes its listener and timers', async () => {
  jest.useFakeTimers();
  const evidence: Record<string, unknown> = {};
  const pending = outcome(prepare(TARGET, evidence));
  await jest.advanceTimersByTimeAsync(1000);
  for (const listener of mockStateListeners) listener(session([APPROVED, TARGET]));
  await jest.advanceTimersByTimeAsync(0);
  expect(await pending).toEqual({ resolved: true });
  expect(nativeIO.request).toHaveBeenCalledTimes(2);
  expect(mockRemoveListener).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
  expect(nativeIO.sendTransaction).not.toHaveBeenCalled();
  await flushWire();
  expect(captured).toEqual([]);
});

it('keeps recovery by a polled approval successful without a session update', async () => {
  jest.useFakeTimers();
  jest
    .mocked(nativeIO.getState)
    .mockResolvedValueOnce(session([APPROVED]))
    .mockResolvedValueOnce(session([APPROVED]))
    .mockResolvedValue(session([APPROVED, TARGET]));
  const evidence: Record<string, unknown> = {};
  const pending = outcome(prepare(TARGET, evidence));
  await jest.advanceTimersByTimeAsync(500);
  expect(await pending).toEqual({ resolved: true });
  expect(nativeIO.getState).toHaveBeenCalledTimes(3);
  expect(nativeIO.request).toHaveBeenCalledTimes(2);
  expect(mockRemoveListener).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
  expect(nativeIO.sendTransaction).not.toHaveBeenCalled();
  await flushWire();
  expect(captured).toEqual([]);
});

it('keeps an approving reread successful even when the wallet rejected the recovery add', async () => {
  jest
    .mocked(nativeIO.getState)
    .mockResolvedValueOnce(session([APPROVED]))
    .mockResolvedValueOnce(session([APPROVED, TARGET]));
  jest.mocked(nativeIO.request).mockRejectedValue(Object.freeze({ code: 4001, message: PRIVATE_TEXT }));
  const evidence: Record<string, unknown> = {};
  await expect(prepare(TARGET, evidence)).resolves.toBeUndefined();
  expect(nativeIO.getState).toHaveBeenCalledTimes(2);
  expect(nativeIO.request).toHaveBeenCalledTimes(1);
  expect(nativeIO.addListener).not.toHaveBeenCalled();
  expect(nativeIO.sendTransaction).not.toHaveBeenCalled();
  await flushWire();
  expect(captured).toEqual([]);
});

it('keeps concurrent preparation evidence isolated when only one session is missing', async () => {
  jest
    .mocked(nativeIO.getState)
    .mockResolvedValueOnce(Object.freeze({ configured: true, connected: false, accounts: [] }))
    .mockResolvedValueOnce(session([APPROVED, TARGET]));
  const failedEvidence: Record<string, unknown> = {};
  const successfulEvidence: Record<string, unknown> = {};
  const [failed, successful] = await Promise.all([
    outcome(prepare(TARGET, failedEvidence)),
    outcome(prepare(TARGET, successfulEvidence))
  ]);
  expectGuard(failed);
  expect(successful).toEqual({ resolved: true });
  expect(successfulEvidence).not.toHaveProperty('reason');
  expect(nativeIO.getState).toHaveBeenCalledTimes(2);
  expect(nativeIO.request).not.toHaveBeenCalled();
  expectFacts(await emitFailure(failed.error, failedEvidence), 'session_missing', 'not_attempted');
});
