import { createElement } from 'react';

import { Capacitor, registerPlugin } from '@capacitor/core';
import { Scope } from '@sentry/browser';
import { act, render, renderHook } from '@testing-library/react';
import Dexie from 'dexie';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { englishWordlist } from '@miden/hd-key';
import { useAppLifecycleTelemetry } from 'app/hooks/useAppLifecycleTelemetry';
import { useFundTelemetry } from 'app/hooks/useFundTelemetry';
import { ErrorLine } from 'components/ui/ErrorLine';
import { deserializeInternalError } from 'lib/intercom/helpers';
import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { request } from 'lib/miden/front';
import { reportNoteClaim } from 'lib/miden/front/claim-telemetry';
import { createSchemaFor, Table } from 'lib/miden/repo';
import { MidenMessageType } from 'lib/miden/types';
import { ensureSdkWasmReady } from 'lib/miden-chain/constants';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { isCrashReportingEnabledAsync, isTelemetryEnabledAsync } from 'lib/settings/helpers';
import { WalletMessageType } from 'lib/shared/types';
import { NativeReown, type ReownPlugin } from 'lib/walletconnect/native';
import { enterSendFlow, settleSendFlow } from 'screens/send-flow/send-telemetry';

import { resolveTelemetryContext } from './context';
import { captureCrash, initCrashReporting, stopCrashReporting } from './crash';
import { getCrashBuildIdentity } from './crash-build';
import { annotateCrash } from './crash-diagnostics';
import { encodingVariantsOf } from './egress-guard';
import { containsSeedMaterial } from './redact';
import { __resetRelayDiagnosticsForTest, recordRelaySurface } from './relay-diagnostics';
import { beginFlow, classifyError } from './report-flow';
import { __resetRunForTest } from './run';
import { WIRE_KEYS } from './serialize';
import { sendEvent } from './sink';
import { reportTransactionFailure, type TransactionFailure } from './transaction-failure';
import {
  TelemetryErrorKind,
  TelemetryEvent,
  TelemetryFlow,
  TelemetryOperation,
  TelemetryResult,
  TelemetryStep
} from './types';
import { USER_ERROR_SURFACES, _resetUserVisibleErrorLimitsForTest, reportUserVisibleError } from './user-visible-error';
import packageJson from '../../../package.json';

jest.mock('./crash-artifacts', () => ({
  crashAssetBase: 'capacitor://localhost/',
  crashArtifactLines: { 'mobile.js': [90000] }
}));

/**
 * The adversarial anti-leak guard, asserted at the two egress boundaries rather
 * than at any call site.
 *
 * Every earlier task defended privacy where it instrumented — Welcome, Unlock,
 * the send flow, the crash reporter. Those defences are per-site, and the next
 * person to instrument a flow will not read any of them. This file asserts the
 * invariant once, downstream of all of them, so a leak fails the build no
 * matter which call site introduced it:
 *
 * 1. Product events — `sendEvent`, the single consent-gated egress point, over
 *    its real `fetch` transport.
 * 2. Crash reports — a real `@sentry/browser` client, over its real fetch
 *    transport, so what is asserted is the actual envelope on the wire and not
 *    an argument to a mocked `captureException`.
 *
 * The telemetry stack stays real. Native rejection cases also replace the raw
 * Capacitor plugin entry point; `fetch` captures the resulting wire.
 */

// The frontend→background hop is the intercom, which cannot run in Jest. The
// mock below replaces the hop only, then hands the event to the real background
// gate exactly as `handleReportTelemetryEvent` does.
jest.mock('lib/miden/front', () => ({ request: jest.fn() }));

// Partial, never wholesale: a wholesale mock strips `getThemeSetting`, which a
// transitive import calls at module scope and which takes the suite down before
// a single test runs.
jest.mock('lib/settings/helpers', () => ({
  ...jest.requireActual('lib/settings/helpers'),
  isCrashReportingEnabledAsync: jest.fn(),
  isTelemetryEnabledAsync: jest.fn()
}));

// Partial for the same reason: `resolveTelemetryContext` reads `isIOS`/
// `isAndroid` from this module, and stubbing those away would stop the guard
// from seeing the real `platform` value that goes on the wire.
jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isMobile: () => true
}));

jest.mock('@capacitor/core', () => {
  const actual = jest.requireActual<typeof import('@capacitor/core')>('@capacitor/core');
  const reown = { sendTransaction: jest.fn(), request: jest.fn(), launchWallet: jest.fn() };
  return {
    ...actual,
    Capacitor: { ...actual.Capacitor, getPlatform: jest.fn(actual.Capacitor.getPlatform) },
    registerPlugin: jest.fn((name: string, implementations?: Parameters<typeof actual.registerPlugin>[1]) =>
      name === 'Reown' ? reown : actual.registerPlugin(name, implementations)
    )
  };
});

const rawReown = registerPlugin<ReownPlugin>('Reown');
const { Capacitor: actualCapacitor } = jest.requireActual<typeof import('@capacitor/core')>('@capacitor/core');

// Real unless a test moves it: the network is read from here on every event, and a test that moves it has to see the
// wire follow.
jest.mock('lib/miden-chain/effective-endpoints', () => {
  const actual = jest.requireActual<typeof import('lib/miden-chain/effective-endpoints')>(
    'lib/miden-chain/effective-endpoints'
  );
  return { ...actual, getEffectiveNetworkName: jest.fn(actual.getEffectiveNetworkName) };
});
const { getEffectiveNetworkName: buildNetwork } = jest.requireActual<
  typeof import('lib/miden-chain/effective-endpoints')
>('lib/miden-chain/effective-endpoints');

/** Every event sent while `run` is out reads `network` as the effective one. */
async function onNetwork(network: MIDEN_NETWORK_NAME, run: () => Promise<void>): Promise<void> {
  jest.mocked(getEffectiveNetworkName).mockReturnValue(network);
  try {
    await run();
  } finally {
    jest.mocked(getEffectiveNetworkName).mockImplementation(buildNetwork);
  }
}

jest.mock('@capacitor/app', () => ({
  App: { addListener: jest.fn(() => Promise.resolve({ remove: jest.fn() })) }
}));

// The repo-wide manual mock at `__mocks__/nanoid.ts` hands every suite the
// constant `id`, which would collapse every flow onto one identifier and hide a
// flowId that carried something it should not.
jest.mock('nanoid', () => {
  let issued = 0;
  return { nanoid: () => `flow-${++issued}` };
});

// The SDK's start, so a startup trap reaches the wire through `ensureSdkWasmReady`'s own catch.
const mockSdkReady = jest.fn(async (): Promise<void> => undefined);
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual<Record<string, unknown>>('@miden-sdk/miden-sdk/lazy'),
  MidenClient: { ready: () => mockSdkReady() }
}));

// ---------------------------------------------------------------------------
// The poison corpus.
//
// Realistic in format, because a leak check against `SECRET_VALUE_1` proves
// nothing about a payload built from a real address. Every value below is
// something this wallet actually holds.
// ---------------------------------------------------------------------------

const PHRASE_12 = 'avoid leave side crush call gasp confirm deal student link chunk interest';
const PHRASE_24 =
  'echo cross route trophy art call defy cat swift tail moral right follow mansion arm intact pulp frame truck connect cotton throw release play';

/**
 * Only ever asserted inside the URL that carries it, because on its own
 * `user:password` is a context-free secret (see `CONTEXTUAL_POISON`) — it is
 * `https://` in front of it that gives `redact.ts` something to recognise.
 */
const RPC_CREDENTIALS = 'midenuser:s3cr3tpassw0rd';

/**
 * Secrets dense enough that a surviving fragment is still the secret: half a
 * private key is a brute force that finishes, and half an address still names
 * the account. These are checked in sliding windows as well as whole, so a
 * scrubber that mangles a value without destroying it cannot pass.
 */
const HIGH_ENTROPY_POISON = {
  privateKeyHex: '0x9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  authSecretKey: '7c4a8d09ca3762af61e59520943dc26494f8941b7c4a8d09ca3762af61e59520',
  // Every Miden bech32 flavour: mainnet, testnet, devnet, localnet.
  addressMainnet: 'mm1aqsjql4cyylvpu2d2cwpxumpvvw5depe',
  addressTestnet: 'mtst1aqsjql4cyylvpu2d2cwpxumpvvw5depe',
  addressDevnet: 'mdev1aqsjql4cyylvpu2d2cwpxumpvvw5depe',
  addressLocalnet: 'mlcl1aqsjql4cyylvpu2d2cwpxumpvvw5depe',
  // The composite `<address>_<routing suffix>` form `WalletAccount.publicKey`
  // takes (`src/utils/miden.ts`).
  compositePublicKey: 'mtst1aqsjql4cyylvpu2d2cwpxumpvvw5depe_qr7qqq9wr6w',
  noteId: '0x9f8e7d6c5b4a39281706f5e4d3c2b1a0',
  transactionId: '0x00112233445566778899aabbccddeeff'
};

/**
 * Structural secrets that are not windowed: the phrases get word windows
 * instead, the quantities are shorter than a window, and the full RPC URL
 * deliberately keeps its host and path (`redact.ts` treats those as diagnosis),
 * so windowing it would flag the redactor's intended output.
 */
const WHOLE_VALUE_POISON = {
  mnemonic12: PHRASE_12,
  mnemonic24: PHRASE_24,
  amount: '4242424242',
  balance: '918273645500000',
  apiKey: 'sk_live_998877',
  rpcUrlWithCredentials: `https://${RPC_CREDENTIALS}@rpc.testnet.miden.io/v1?apiKey=sk_live_998877`
};

/**
 * Values with a shape of their own — a bech32 prefix, a hex run, a digit run, a
 * URL's userinfo. These must not survive anywhere, in any encoding, however
 * they are framed.
 */
const STRUCTURAL_POISON = { ...HIGH_ENTROPY_POISON, ...WHOLE_VALUE_POISON };

/**
 * Values with no shape at all. `hunter2correcthorsebatterystaple` is
 * indistinguishable from a request id, a filename, or a feature flag, so no
 * pattern scrubber can recognise one standing on its own — only the key beside
 * it betrays it, which is exactly why `SENSITIVE_KEY_PARTS` and the assignment
 * rule in `redact.ts` exist.
 *
 * So these are asserted in the forms the wallet can actually produce: named in
 * an assignment, or held under a sensitive key in a structure. Nothing in `src`
 * throws an error whose message is a bare credential — the closest is
 * `Welcome.tsx`'s "Missing password or recovery phrase", which names neither — and
 * an unframed credential in a crash message would be a bug at the throw site
 * that this boundary cannot see.
 */
const CONTEXTUAL_POISON = {
  password: 'hunter2correcthorsebatterystaple',
  passcode: '246813579'
};

const POISON = { ...STRUCTURAL_POISON, ...CONTEXTUAL_POISON, rpcCredentials: RPC_CREDENTIALS };

/**
 * Four-word windows of each phrase, checked alongside the whole phrases.
 *
 * A substring check for the full 12 words is defeated by a payload that carries
 * half of it, and half a phrase plus a second crash is still a recovered
 * wallet. Four is the run `redact.ts` treats as seed material, so anything this
 * catches is something that module already considers a phrase.
 */
function wordWindows(phrase: string, size: number): string[] {
  const words = phrase.split(' ');
  const windows: string[] = [];
  for (let i = 0; i + size <= words.length; i++) windows.push(words.slice(i, i + size).join(' '));
  return windows;
}

/**
 * Sliding fragments of a dense secret.
 *
 * A whole-value check calls a scrubber that mangles a private key — redacting
 * the one digit run inside it and leaving the other fifty characters — a pass.
 * Overlapping windows make any surviving run of 23 characters or more fail.
 */
const WINDOW = 16;
const STRIDE = 8;

function charWindows(value: string): string[] {
  const windows: string[] = [];
  for (let i = 0; i + WINDOW <= value.length; i += STRIDE) windows.push(value.slice(i, i + WINDOW));
  return windows;
}

const FORBIDDEN: readonly string[] = [
  ...Object.values(POISON),
  ...wordWindows(PHRASE_12, 4),
  ...wordWindows(PHRASE_24, 4),
  ...[...Object.values(HIGH_ENTROPY_POISON), RPC_CREDENTIALS].flatMap(charWindows)
];

/** Precomputed once: ~14 values x ~12 encodings, rechecked by several tests. */
const FORBIDDEN_VARIANTS: ReadonlyArray<{ value: string; variant: string }> = FORBIDDEN.flatMap(value =>
  encodingVariantsOf(value).map(variant => ({ value, variant }))
);

/**
 * Errors carrying poison, wrapped three deep.
 *
 * The `cause` chain is the shape a caught object most often takes here — every
 * layer rewraps — and it is the exact path a success-only privacy assertion
 * misses, because the outer error is innocuous and the inner one is not.
 */
function poisonedError(outer: string): Error {
  const root = new Error(`recovery phrase rejected: ${POISON.mnemonic12}`);
  const middle = new Error(
    `could not load account ${POISON.compositePublicKey} (key ${POISON.privateKeyHex}, password=${POISON.password}, passcode=${POISON.passcode})`,
    { cause: root }
  );
  return new Error(`${outer} — endpoint ${POISON.rpcUrlWithCredentials}, amount ${POISON.amount}`, { cause: middle });
}

// ---------------------------------------------------------------------------
// The wire.
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  /** Headers are wire too: the App-Key rides in one, and so could a leak. */
  headers: string;
  body: string;
}

const captured: CapturedRequest[] = [];

function bodyToText(body: unknown): string {
  if (typeof body === 'string') return body;
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
  if (body === undefined || body === null) return '';
  return JSON.stringify(body);
}

function headersToText(headers: unknown): string {
  if (headers === undefined || headers === null) return '';
  if (headers instanceof Headers) return [...headers.entries()].map(([name, value]) => `${name}: ${value}`).join('\n');
  if (typeof headers !== 'object') return String(headers);
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${String(value)}`)
    .join('\n');
}

/**
 * Installed once and never reswapped: Sentry caches the fetch implementation it
 * resolves, so replacing the stub per test would leave the crash transport
 * writing into an array nobody reads — and a leak assertion over an empty array
 * passes.
 */
const fetchStub = (
  input: unknown,
  init?: { body?: unknown; headers?: unknown }
): Promise<{ status: number; headers: Headers }> => {
  captured.push({ url: String(input), headers: headersToText(init?.headers), body: bodyToText(init?.body) });
  return Promise.resolve({ status: 200, headers: new Headers() });
};

/**
 * A real hosted app key shape, with no host override, so what this file asserts
 * against is the endpoint a release build would actually derive — region
 * derivation included. Nothing leaves: `fetch` is stubbed for the whole file.
 */
const APP_KEY = 'A-EU-1234567890';
const INGEST_URL = 'https://eu.aptabase.com/api/v0/event';
const SENTRY_DSN = 'https://publickey@o0.ingest.de.sentry.io/1';

const wireText = (): string => captured.map(entry => `${entry.url}\n${entry.headers}\n${entry.body}`).join('\n');

/** Flush the fire-and-forget reporting chain, plus Sentry's transport buffer. */
async function flushEgress(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 5));
}

function parsePayload(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`telemetry body is not a JSON object: ${text}`);
  }
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) payload[key] = value;
  return payload;
}

function sentryEvents(): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const entry of captured) {
    if (!new URL(entry.url).pathname.endsWith('/envelope/')) continue;
    const lines = entry.body.split('\n');
    for (let index = 1; index < lines.length; index += 2) {
      const header = lines[index];
      const payload = lines[index + 1];
      if (header === undefined || payload === undefined) throw new Error('incomplete Sentry envelope item');
      if (parsePayload(header).type === 'event') events.push(parsePayload(payload));
    }
  }
  return events;
}

function storageWireIncrement(): {
  event: Record<string, unknown>;
  baseline: Record<string, unknown>;
  increment: number;
} {
  expect(captured).toHaveLength(1);
  const request = captured[0];
  if (request === undefined) throw new Error('missing wire report');
  expect(new URL(request.url).pathname.endsWith('/envelope/')).toBe(true);
  const lines = request.body.split('\n');
  const eventIndexes: number[] = [];
  for (let index = 1; index < lines.length; index += 2) {
    const header = lines[index];
    if (header === undefined) throw new Error('missing envelope item header');
    if (parsePayload(header).type === 'event') eventIndexes.push(index + 1);
  }
  expect(eventIndexes).toHaveLength(1);
  const eventIndex = eventIndexes[0];
  if (eventIndex === undefined) throw new Error('missing event item');
  const payload = lines[eventIndex];
  if (payload === undefined) throw new Error('missing event payload');
  const event = parsePayload(payload);
  expect(JSON.stringify(event)).toBe(payload);

  const baseline = parsePayload(payload);
  const extra = objectAt(baseline, 'extra');
  const diagnostics = objectAt(extra, 'walletDiagnostics');
  const tags = objectAt(baseline, 'tags');
  for (const key of ['storageOwner', 'storageOperation', 'pageVisibility']) delete diagnostics[key];
  for (const key of ['storage_owner', 'storage_operation', 'page_visibility']) delete tags[key];
  extra.walletDiagnostics = diagnostics;
  baseline.extra = extra;
  baseline.tags = tags;
  expect(Object.keys(diagnostics).length).toBeGreaterThan(0);
  expect(Object.keys(tags).length).toBeGreaterThan(0);
  expect(baseline.fingerprint).toEqual(event.fingerprint);
  const actualDiagnostics = objectAt(objectAt(event, 'extra'), 'walletDiagnostics');
  const actualTags = objectAt(event, 'tags');
  expect([
    diagnostics.userErrorId,
    diagnostics.userErrorSurface,
    tags['user_error.id'],
    tags['user_error.surface']
  ]).toEqual([
    actualDiagnostics.userErrorId,
    actualDiagnostics.userErrorSurface,
    actualTags['user_error.id'],
    actualTags['user_error.surface']
  ]);
  expect({ ...baseline, extra: event.extra, tags: event.tags }).toEqual(event);

  // Replace only the event payload so all actual envelope headers and unrelated items keep their wire bytes.
  const baselineLines = [...lines];
  baselineLines[eventIndex] = JSON.stringify(baseline);
  expect(baselineLines.filter((_, index) => index !== eventIndex)).toEqual(
    lines.filter((_, index) => index !== eventIndex)
  );
  expect(leaksIn(wireText())).toEqual([]);
  const encoder = new TextEncoder();
  return {
    event,
    baseline,
    increment: encoder.encode(request.body).byteLength - encoder.encode(baselineLines.join('\n')).byteLength
  };
}

interface CursorFaultEvidence {
  opened: number;
  requestErrors: number;
}

async function withCursorRequestFailure(
  target: Dexie,
  failure: Error,
  run: (evidence: CursorFaultEvidence) => Promise<void>
): Promise<void> {
  const evidence: CursorFaultEvidence = { opened: 0, requestErrors: 0 };
  const backend = target.backendDB();
  const restores: Array<() => void> = [];
  const openCursor = IDBObjectStore.prototype.openCursor;
  const spy = jest.spyOn(IDBObjectStore.prototype, 'openCursor').mockImplementation(function (
    this: IDBObjectStore,
    query?: IDBValidKey | IDBKeyRange | null,
    direction?: IDBCursorDirection
  ) {
    const request = openCursor.call(this, query, direction);
    if (this.transaction.db !== backend) return request;
    const onSuccess = () => {
      const cursor: unknown = request.result;
      if (!(cursor instanceof IDBCursor)) throw new Error('fault fixture did not open a real cursor');
      const iterate: unknown = Reflect.get(cursor, '_iterate');
      if (typeof iterate !== 'function') throw new Error('fault fixture cannot find cursor iteration');
      evidence.opened++;
      const own = Object.getOwnPropertyDescriptor(cursor, '_iterate');
      // fake-indexeddb schedules this private method for the next real request, after open has succeeded.
      Object.defineProperty(cursor, '_iterate', {
        configurable: true,
        writable: true,
        value: () => {
          throw failure;
        }
      });
      restores.push(() => {
        if (own === undefined) Reflect.deleteProperty(cursor, '_iterate');
        else Object.defineProperty(cursor, '_iterate', own);
      });
    };
    const onError = () => {
      if (evidence.opened === 0 || request.error !== failure) {
        throw new Error('fault fixture did not observe the post-open request failure');
      }
      evidence.requestErrors++;
    };
    request.addEventListener('success', onSuccess);
    request.addEventListener('error', onError);
    restores.push(() => {
      request.removeEventListener('success', onSuccess);
      request.removeEventListener('error', onError);
    });
    return request;
  });
  try {
    await run(evidence);
  } finally {
    for (const restore of restores.reverse()) restore();
    spy.mockRestore();
  }
}

/** Every Aptabase envelope that reached the wire, parsed. */
const envelopes = (): Record<string, unknown>[] =>
  captured.filter(entry => entry.url === INGEST_URL).map(entry => parsePayload(entry.body));

/**
 * One of the envelope's two nested objects, or a loud failure. Throwing rather
 * than returning `{}` matters: an absence assertion over an empty object passes
 * for the wrong reason, which is the exact way this file could rot.
 */
function objectAt(envelope: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = envelope[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`envelope.${key} is not a JSON object: ${JSON.stringify(envelope)}`);
  }
  const nested: Record<string, unknown> = {};
  for (const [nestedKey, nestedValue] of Object.entries(value)) nested[nestedKey] = nestedValue;
  return nested;
}

const stringAt = (envelope: Record<string, unknown>, key: string): string => {
  const value = envelope[key];
  return typeof value === 'string' ? value : `<${typeof value}>`;
};

/**
 * The three `systemProps` fields Aptabase's own SDKs send and this wallet does
 * not collect. Each is a fingerprinting vector; none is required.
 *
 * Restated here rather than imported, deliberately. A guard that reads the
 * subject's own constant agrees with a mistake in it — the same reasoning that
 * keeps the Playwright key list independent of `WIRE_KEYS`.
 */
const FINGERPRINTING_FIELDS: readonly string[] = ['osVersion', 'locale', 'deviceModel'];

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Names every leaked value rather than just failing, so a red build diagnoses itself. */
function leaksIn(haystack: string): string[] {
  return FORBIDDEN_VARIANTS.filter(({ variant }) => haystack.includes(variant)).map(
    ({ value, variant }) => `leaked "${value}" encoded as "${variant}"`
  );
}

// ---------------------------------------------------------------------------
// Driving the real flows.
// ---------------------------------------------------------------------------

/**
 * Written as a `Record` over the union so TypeScript, not a reviewer, is what
 * notices a seventeenth flow: adding one to `TelemetryFlow` fails `yarn ts` here
 * until it is driven.
 */
const EVERY_FLOW: Record<TelemetryFlow, TelemetryFlow> = {
  open: 'open',
  unlock: 'unlock',
  create: 'create',
  import: 'import',
  recover: 'recover',
  return: 'return',
  fund: 'fund',
  receive_share: 'receive_share',
  send: 'send',
  swap: 'swap',
  earn: 'earn',
  dapp_connect: 'dapp_connect',
  dapp_tx: 'dapp_tx',
  guardian_rotate: 'guardian_rotate',
  note_handle: 'note_handle',
  activity_view: 'activity_view'
};

const EVERY_RESULT: Record<TelemetryResult, TelemetryResult> = {
  completed: 'completed',
  cancelled: 'cancelled',
  errored: 'errored'
};

const EVERY_ERROR_KIND: Record<TelemetryErrorKind, TelemetryErrorKind> = {
  network: 'network',
  rpc: 'rpc',
  proving: 'proving',
  validation: 'validation',
  storage: 'storage',
  auth: 'auth',
  timeout: 'timeout',
  unknown: 'unknown'
};

/**
 * The second axis, and the one this file used to have no opinion about at all.
 *
 * The sweep below was named for "the entire event type space" while enumerating
 * only flows, so every `*_settled` envelope crossed the allowlist boundary
 * unobserved. A mutation that put a raw mainnet address on `props` failed four
 * tests when unconditional and none at all when wrapped in
 * `if (payload.phase === 'settled')`. That was the whole settled axis outside the
 * privacy guarantee, at exactly the moment two more operations were added to it.
 */
const EVERY_OPERATION: Record<TelemetryOperation, TelemetryOperation> = {
  tx_send: 'tx_send',
  tx_receive: 'tx_receive',
  tx_swap: 'tx_swap',
  tx_earn: 'tx_earn',
  tx_bridge: 'tx_bridge',
  tx_guardian: 'tx_guardian',
  tx_dapp: 'tx_dapp',
  tx_other: 'tx_other',
  prove: 'prove',
  service_prover: 'service_prover',
  service_node: 'service_node',
  service_network: 'service_network'
};

/**
 * Every step, so the closed-union check below has the whole vocabulary to
 * compare against and a settled event can be swept carrying each one.
 */
const EVERY_STEP: Record<TelemetryStep, TelemetryStep> = {
  select_recipient: 'select_recipient',
  select_amount: 'select_amount',
  select_route: 'select_route',
  review: 'review',
  submitting: 'submitting',
  swap_amounts: 'swap_amounts',
  choose_protection: 'choose_protection',
  setup_passcode: 'setup_passcode',
  setup_biometric: 'setup_biometric',
  set_password: 'set_password',
  recovery_method: 'recovery_method',
  choose_guardian: 'choose_guardian',
  enter_phrase: 'enter_phrase',
  awaiting_approval: 'awaiting_approval',
  syncing: 'syncing',
  executing: 'executing',
  proving: 'proving',
  sending: 'sending',
  confirming: 'confirming',
  signing: 'signing',
  prove_delegate: 'prove_delegate',
  prove_local: 'prove_local',
  prove_fallback: 'prove_fallback'
};

const FLOWS: readonly TelemetryFlow[] = Object.values(EVERY_FLOW);
const RESULTS: readonly TelemetryResult[] = Object.values(EVERY_RESULT);
const ERROR_KINDS: readonly TelemetryErrorKind[] = Object.values(EVERY_ERROR_KIND);
const OPERATIONS: readonly TelemetryOperation[] = Object.values(EVERY_OPERATION);
const STEPS: readonly TelemetryStep[] = Object.values(EVERY_STEP);

/**
 * Every shape a settled event can take, enumerated rather than chosen.
 *
 * The flow axis reaches the wire through the real reporters, so its shapes are
 * whatever the app produces. The settled axis is constructed by hand, so its
 * shapes are whatever this function says — and a leak conditioned on a shape it
 * omits is invisible to every assertion downstream. Three shapes were omitted
 * once, and all three are things the wallet emits constantly: a successful
 * `prove_settled` (completed WITH a step), an outage start (errored with NO
 * errorKind), and a phase writer on a row with no `initiatedAt` (an errorKind
 * with NO duration). So the four optional dimensions are crossed rather than
 * sampled, and `step` gets a pass of its own over the full union.
 */
function everySettledShape(): TelemetryEvent[] {
  const verdicts: readonly ('completed' | 'errored')[] = ['completed', 'errored'];

  const crossed = OPERATIONS.flatMap(operation =>
    verdicts.flatMap(result =>
      [...ERROR_KINDS, undefined].flatMap(errorKind =>
        [8.4, undefined].flatMap(durationMs =>
          (['sending', undefined] as const).map(
            (step): TelemetryEvent => ({
              phase: 'settled',
              operation,
              runId: 'sweep-run',
              result,
              ...(errorKind !== undefined ? { errorKind } : {}),
              ...(durationMs !== undefined ? { durationMs } : {}),
              ...(step !== undefined ? { step } : {})
            })
          )
        )
      )
    )
  );

  // Crossing `step` against everything else as well would multiply the sweep by
  // twenty-four for no extra coverage: nothing downstream branches on WHICH step
  // it is, only on whether there is one. One pass over the union is what the
  // closed-union value check needs.
  const perStep = STEPS.map(
    (step): TelemetryEvent => ({
      phase: 'settled',
      operation: 'tx_send',
      runId: 'sweep-run',
      result: 'errored',
      errorKind: 'unknown',
      durationMs: 3.3,
      step
    })
  );

  return [...crossed, ...perStep];
}

/** Put every settled shape on the wire, for assertions that read the wire back. */
async function sendEveryDeclaredOperation(): Promise<void> {
  const context = resolveTelemetryContext();
  for (const event of everySettledShape()) await sendEvent(event, context);
  await flushEgress();
}

const LOADING = { locked: false, ready: false, hydrated: false };
const UNLOCK = { locked: true, ready: true, hydrated: true };
const APP = { locked: false, ready: true, hydrated: true };

/** Swallow the rethrow: the wrappers pass a caller's error straight back through. */
async function swallowRejection(attempt: () => Promise<unknown>): Promise<void> {
  await attempt().then(
    () => undefined,
    () => undefined
  );
}

/**
 * Exercise every instrumented flow through the code the call sites actually
 * call — the lifecycle hook, the fund and note-claim wrappers, the module-scoped
 * send handle, and `beginFlow` for the page-level flows — on the success, the
 * cancellation and the error path, with poison in every error.
 *
 * The pages themselves are not rendered: a page adds a `beginFlow` call and
 * nothing else to this chain, which is the whole reason the guard sits at the
 * boundary. What must be real is everything downstream of that call, and all of
 * it is.
 */
async function driveEveryInstrumentedFlow(): Promise<void> {
  // `open` completing, and `return` beginning on foreground and completing once
  // the wallet is usable again.
  const lifecycle = renderHook(props => useAppLifecycleTelemetry(props), { initialProps: LOADING });
  lifecycle.rerender(UNLOCK);
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  lifecycle.rerender(APP);
  lifecycle.unmount();

  // `open` cancelled: the app shell went away while still booting.
  renderHook(() => useAppLifecycleTelemetry(LOADING)).unmount();

  // `return` cancelled: foregrounded onto the lock screen, then left.
  const abandonedReturn = renderHook(props => useAppLifecycleTelemetry(props), { initialProps: UNLOCK });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  abandonedReturn.unmount();

  // `fund`: completed, errored on a poisoned rejection, then abandoned.
  const fund = renderHook(() => useFundTelemetry());
  await act(async () => {
    await fund.result.current(() => Promise.resolve('deposit accepted'));
  });
  await act(async () => {
    await swallowRejection(() => fund.result.current(() => Promise.reject(poisonedError('rpc deposit failed'))));
  });
  fund.unmount();

  // `note_handle`: completed, then errored on a poisoned rejection.
  await reportNoteClaim(() => Promise.resolve('claim queued'));
  await swallowRejection(() => reportNoteClaim(() => Promise.reject(poisonedError('network claim failed'))));

  // `send`: the module-scoped handle, settled three ways.
  enterSendFlow();
  settleSendFlow(handle => handle.complete());
  enterSendFlow();
  settleSendFlow(handle => handle.cancel());
  enterSendFlow();
  settleSendFlow(handle => handle.fail(classifyError(poisonedError('proving failed'))));

  // The page-level flows, driven exactly as their call sites drive them.
  for (const flow of FLOWS) {
    beginFlow(flow).complete();
    beginFlow(flow).cancel();
    beginFlow(flow).fail(classifyError(poisonedError('storage quota exceeded')));
  }

  await flushEgress();
}

// ---------------------------------------------------------------------------

const consentOn = () => {
  jest.mocked(isCrashReportingEnabledAsync).mockResolvedValue(true);
  jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(true);
};
const consentOff = () => {
  jest.mocked(isCrashReportingEnabledAsync).mockResolvedValue(false);
  jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(false);
};

let originalFetch: PropertyDescriptor | undefined;

beforeAll(() => {
  originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'fetch', { value: fetchStub, writable: true, configurable: true });
});

afterAll(() => {
  if (originalFetch === undefined) Reflect.deleteProperty(globalThis, 'fetch');
  else Object.defineProperty(globalThis, 'fetch', originalFetch);
});

beforeEach(() => {
  captured.length = 0;
  jest.mocked(Capacitor.getPlatform).mockImplementation(actualCapacitor.getPlatform);
  jest.mocked(rawReown.sendTransaction).mockReset();
  jest.mocked(rawReown.launchWallet).mockReset();
  process.env.APTABASE_APP_KEY = APP_KEY;
  // No host override: the endpoint has to come from the key's region, which is
  // how a release build is configured.
  delete process.env.APTABASE_HOST;
  process.env.SENTRY_DSN = SENTRY_DSN;
  // `send-telemetry` holds its handle module-scoped, so a flow left open by the
  // previous test would otherwise settle inside this one.
  settleSendFlow(handle => handle.cancel());
  jest.mocked(request).mockImplementation(async req => {
    // What `handleReportTelemetryEvent` in `lib/miden/back/actions` does: hand
    // the event to the real consent gate with a background-derived context.
    if (req.type === WalletMessageType.ReportTelemetryEventRequest) {
      await sendEvent(req.event, resolveTelemetryContext());
    }
    return { type: WalletMessageType.ReportTelemetryEventResponse };
  });
});

afterEach(async () => {
  stopCrashReporting();
  await flushEgress();
  jest.clearAllMocks();
});

describe('product-event egress', () => {
  it('sends something at all, so every absence assertion below can fail', async () => {
    consentOn();
    await driveEveryInstrumentedFlow();
    expect(envelopes().length).toBeGreaterThan(0);
  });

  it('reaches only the Aptabase endpoint derived from the app key', async () => {
    consentOn();
    await driveEveryInstrumentedFlow();
    expect(new Set(captured.map(entry => entry.url))).toEqual(new Set([INGEST_URL]));
  });

  it('sends one event per request, never the 25-event batch endpoint', async () => {
    // An MV3 service worker has no guaranteed lifetime, so a batch buffer is a
    // buffer that gets killed. Asserted on the wire, not on a constant.
    consentOn();
    await driveEveryInstrumentedFlow();

    expect(envelopes().length).toBeGreaterThan(1);
    for (const entry of captured.filter(request => request.url === INGEST_URL)) {
      const parsed: unknown = JSON.parse(entry.body);
      expect(Array.isArray(parsed)).toBe(false);
    }
  });

  it('authenticates with the App-Key header Aptabase requires', async () => {
    consentOn();
    await driveEveryInstrumentedFlow();

    const ingest = captured.filter(entry => entry.url === INGEST_URL);
    expect(ingest.length).toBeGreaterThan(0);
    for (const entry of ingest) expect(entry.headers).toContain(`App-Key: ${APP_KEY}`);
  });

  it('reports every flow, on the success, cancellation and error path', async () => {
    consentOn();
    await driveEveryInstrumentedFlow();

    const sent = envelopes();
    // Per flow, not merely across all of them: an error path that stopped being
    // driven would otherwise hide behind some other flow's `errored`, and the
    // error path is where a caught object is most likely to be passed on whole.
    const reported: Record<string, string[]> = {};
    for (const flow of FLOWS) {
      reported[flow] = [
        ...new Set(
          sent.flatMap(envelope => {
            if (envelope.eventName !== `${flow}_ended`) return [];
            const result = objectAt(envelope, 'props').result;
            return typeof result === 'string' ? [result] : [];
          })
        )
      ].sort();
    }

    const expected: Record<string, string[]> = {};
    for (const flow of FLOWS) expected[flow] = [...RESULTS].sort();
    expect(reported).toEqual(expected);
  });

  it('leaks no forbidden value, in any encoding, on any path', async () => {
    consentOn();
    await driveEveryInstrumentedFlow();

    expect(envelopes().length).toBeGreaterThan(0);
    expect(leaksIn(wireText())).toEqual([]);
  });

  it('puts exactly the Aptabase envelope keys on the wire and nothing else', async () => {
    consentOn();
    await driveEveryInstrumentedFlow();

    const sent = envelopes();
    expect(sent.length).toBeGreaterThan(0);
    // Exactly, not merely a subset: a field added to the envelope has to fail
    // here rather than ship silently, and one that stops being emitted has to
    // fail too.
    const observed = new Set(sent.flatMap(envelope => Object.keys(envelope)));
    expect([...observed].sort()).toEqual(['eventName', 'props', 'sessionId', 'systemProps', 'timestamp']);
  });

  it('puts exactly the four systemProps on the wire, and none of the fingerprinting three', async () => {
    consentOn();
    await driveEveryInstrumentedFlow();

    const sent = envelopes();
    expect(sent.length).toBeGreaterThan(0);
    const observed = new Set(sent.flatMap(envelope => Object.keys(objectAt(envelope, 'systemProps'))));
    expect([...observed].sort()).toEqual(['appVersion', 'isDebug', 'osName', 'sdkVersion']);
  });

  it.each(FINGERPRINTING_FIELDS)('never puts %s anywhere in an envelope, on any path', async field => {
    // The assertion that stops someone "completing" systemProps later.
    // `osVersion`, `locale` and `deviceModel` are all data this wallet does not
    // collect and all fingerprinting vectors. Checked against the whole
    // envelope, not just `systemProps`, so relocating one does not evade it.
    consentOn();
    await driveEveryInstrumentedFlow();

    const sent = envelopes();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.filter(envelope => JSON.stringify(envelope).includes(field))).toEqual([]);
  });

  it('derives every prop key from the allowlist and nothing else', async () => {
    consentOn();
    await driveEveryInstrumentedFlow();

    const sent = envelopes();
    expect(sent.length).toBeGreaterThan(0);
    const observed = new Set(sent.flatMap(envelope => Object.keys(objectAt(envelope, 'props'))));
    expect([...observed].sort()).toEqual(['durationMs', 'errorKind', 'flowId', 'network', 'result']);
  });

  it('names the effective network on every event, flows and settled operations alike', async () => {
    consentOn();
    await onNetwork(MIDEN_NETWORK_NAME.MAINNET, async () => {
      await driveEveryInstrumentedFlow();
      await sendEveryDeclaredOperation();
    });

    const sent = envelopes();
    expect(sent.some(envelope => stringAt(envelope, 'eventName') === 'tx_send_settled')).toBe(true);
    expect(sent.filter(envelope => objectAt(envelope, 'props').network !== 'mainnet')).toEqual([]);
  });

  it('includes a finite nonnegative duration on every completed product flow', async () => {
    consentOn();
    await driveEveryInstrumentedFlow();
    const ended = envelopes().filter(envelope => stringAt(envelope, 'eventName').endsWith('_ended'));
    expect(ended.length).toBeGreaterThan(0);
    for (const envelope of ended) {
      const duration = objectAt(envelope, 'props').durationMs;
      expect(typeof duration).toBe('number');
      expect(Number.isFinite(duration)).toBe(true);
      expect(duration).toBeGreaterThanOrEqual(0);
    }
  });

  it('retains provided settled-operation durations and leaves absent intervals absent', async () => {
    consentOn();
    const context = resolveTelemetryContext();
    await sendEvent(
      { phase: 'settled', operation: 'service_node', runId: 'duration-probe', result: 'completed', durationMs: 8.4 },
      context
    );
    await sendEvent(
      { phase: 'settled', operation: 'service_node', runId: 'duration-probe', result: 'completed' },
      context
    );
    await flushEgress();
    expect(envelopes().map(envelope => objectAt(envelope, 'props').durationMs)).toEqual([8, undefined]);
  });

  it('carries no nested structure beyond the two objects Aptabase defines', async () => {
    consentOn();
    await driveEveryInstrumentedFlow();

    const sent = envelopes();
    expect(sent.length).toBeGreaterThan(0);

    const nested = sent.flatMap(envelope => [
      // Top level: three strings and the two known objects, nothing else.
      ...Object.entries(envelope).flatMap(([key, value]) =>
        key === 'systemProps' || key === 'props' || typeof value === 'string' ? [] : [`${key} is ${typeof value}`]
      ),
      // Inside them: scalars only. A value cannot hide one level deeper.
      ...['systemProps', 'props'].flatMap(group =>
        Object.entries(objectAt(envelope, group)).flatMap(([key, value]) =>
          typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
            ? []
            : [`${group}.${key} is ${typeof value}`]
        )
      )
    ]);
    expect(nested).toEqual([]);
  });

  it('carries no string value beyond the closed unions, the version, the flow id and two constants', async () => {
    consentOn();
    await driveEveryInstrumentedFlow();
    // The settled axis too, which this assertion never reached. It ran only
    // against the driven flows, so no `*_settled` envelope ever had its prop
    // VALUES checked against the closed unions — only its keys, and only against
    // `WIRE_KEYS`. A leak in a settled prop's value was outside the one
    // assertion written to catch exactly that.
    await sendEveryDeclaredOperation();

    const eventNames = new Set([
      ...FLOWS.flatMap(flow => [`${flow}_started`, `${flow}_ended`]),
      ...OPERATIONS.map(operation => `${operation}_settled`)
    ]);
    const propValues = new Set<string>([...RESULTS, ...ERROR_KINDS, ...STEPS]);
    const platforms = new Set<string>(['extension', 'ios', 'android']);
    // Restated rather than read from the network enum: the closed set is the claim this checks.
    const networks = new Set<string>(['mainnet', 'testnet', 'devnet', 'localnet']);

    const sent = envelopes();
    expect(sent.length).toBeGreaterThan(0);

    const unexpected = sent.flatMap(envelope => {
      const problems: string[] = [];
      const eventName = stringAt(envelope, 'eventName');
      if (!eventNames.has(eventName)) problems.push(`eventName=${eventName}`);
      // nanoid's alphabet: no spaces, so no phrase; bounded, so no blob.
      const sessionId = stringAt(envelope, 'sessionId');
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(sessionId)) problems.push(`sessionId=${sessionId}`);
      const timestamp = stringAt(envelope, 'timestamp');
      if (!ISO_8601.test(timestamp)) problems.push(`timestamp=${timestamp}`);

      const system = objectAt(envelope, 'systemProps');
      for (const [key, value] of Object.entries(system)) {
        if (typeof value !== 'string') continue;
        if (key === 'appVersion' && value === packageJson.version) continue;
        if (key === 'osName' && platforms.has(value)) continue;
        if (key === 'sdkVersion' && /^[a-z0-9-]+@\d+\.\d+\.\d+$/.test(value)) continue;
        problems.push(`systemProps.${key}=${value}`);
      }

      for (const [key, value] of Object.entries(objectAt(envelope, 'props'))) {
        if (typeof value === 'number') continue;
        // The one prop that is an opaque id rather than a member of a closed
        // union, so it gets the shape check the session id gets instead of
        // being looked up. Same alphabet, same bound: no phrase, no blob.
        if (key === 'flowId') {
          if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(value)) {
            problems.push(`props.flowId=${String(value)}`);
          }
          continue;
        }
        if (key === 'network') {
          if (typeof value !== 'string' || !networks.has(value)) problems.push(`props.network=${String(value)}`);
          continue;
        }
        if (typeof value === 'string' && propValues.has(value)) continue;
        problems.push(`props.${key}=${String(value)}`);
      }
      return problems;
    });
    expect(unexpected).toEqual([]);
  });

  it('groups one run under one session id, and pairs flows by the flow id inside it', async () => {
    // The linkage this design permits, asserted from both ends. Everything a
    // person does in one run of the app shares a session id — that is what makes
    // the data describe a visit rather than a pile of unrelated 0s sessions —
    // and inside it, `props.flowId` is what pairs a started with its ended.
    consentOn();
    await driveEveryInstrumentedFlow();

    const sent = envelopes();
    expect(sent.length).toBeGreaterThan(0);

    // One run, one id. More than one would mean something is minting per flow
    // again, and the dashboard would go back to showing nothing but 0s sessions.
    const sessions = new Set(sent.map(envelope => stringAt(envelope, 'sessionId')));
    expect(sessions.size).toBe(1);

    // A flow id, on the other hand, may pair a started with its ended and never
    // more: it is the join key, so a shared one would fuse two unrelated flows
    // into one funnel entry.
    const perFlow = new Map<string, string[]>();
    for (const envelope of sent) {
      const id = String(objectAt(envelope, 'props').flowId);
      perFlow.set(id, [...(perFlow.get(id) ?? []), stringAt(envelope, 'eventName')]);
    }
    const overlinked = [...perFlow].flatMap(([id, names]) => {
      const flows = new Set(names.map(name => name.replace(/_(started|ended)$/, '')));
      if (flows.size > 1) return [`flow ${id} spans flows ${[...flows].sort().join(', ')}`];
      return names.length > 2 ? [`flow ${id} carries ${names.length} events`] : [];
    });
    expect(overlinked).toEqual([]);

    // The driver runs every flow several times, so the join key has to be far
    // more varied than the session key — this is the assertion that fails if
    // somebody "simplifies" `flowId` into the run id and destroys the pairing.
    expect(perFlow.size).toBeGreaterThan(FLOWS.length);
  });

  it('mints a different session id for a different run, so nothing links across launches', async () => {
    // The whole basis for calling the run id ephemeral. It lives in module scope
    // and is written nowhere, so a fresh page — a reopened popup, a relaunched
    // app — starts again from nothing. `__resetRunForTest` is exactly that:
    // forgetting, not clearing storage, because there is no storage to clear.
    consentOn();
    beginFlow('open').complete();
    await flushEgress();
    const first = envelopes().map(envelope => stringAt(envelope, 'sessionId'));

    __resetRunForTest();
    beginFlow('open').complete();
    await flushEgress();
    const second = envelopes()
      .map(envelope => stringAt(envelope, 'sessionId'))
      .filter(id => !first.includes(id));

    expect(new Set(first).size).toBe(1);
    expect(second.length).toBeGreaterThan(0);
  });

  it('holds the allowlist across the entire event type space, not just the paths driven above', async () => {
    consentOn();
    const context = resolveTelemetryContext();

    const events: TelemetryEvent[] = FLOWS.flatMap(flow => [
      { phase: 'started', flow, flowId: 'sweep', runId: 'sweep-run' },
      ...RESULTS.map(
        (result): TelemetryEvent => ({
          phase: 'ended',
          flow,
          flowId: 'sweep',
          runId: 'sweep-run',
          result,
          durationMs: 12.7
        })
      ),
      ...ERROR_KINDS.map(
        (errorKind): TelemetryEvent => ({
          phase: 'ended',
          flow,
          flowId: 'sweep',
          runId: 'sweep-run',
          result: 'errored',
          errorKind,
          durationMs: 3.2
        })
      )
    ]);

    events.push(...everySettledShape());

    for (const event of events) await sendEvent(event, context);
    await flushEgress();

    const sent = envelopes();
    expect(sent).toHaveLength(events.length);
    const outside = sent.flatMap(envelope => [
      ...Object.keys(envelope).filter(
        key => !['timestamp', 'sessionId', 'eventName', 'systemProps', 'props'].includes(key)
      ),
      ...Object.keys(objectAt(envelope, 'systemProps')).filter(
        key => !['isDebug', 'osName', 'appVersion', 'sdkVersion'].includes(key)
      ),
      // The ten-field allowlist has to survive the crossing into an object
      // Aptabase leaves open, where the type system can no longer hold it.
      ...Object.keys(objectAt(envelope, 'props')).filter(key => !WIRE_KEYS.includes(key))
    ]);
    expect(outside).toEqual([]);
    expect(leaksIn(wireText())).toEqual([]);
  });
});

describe('crash-report egress', () => {
  it('reports only the closed iOS per-call diagnostic on the real Sentry wire', async () => {
    consentOn();
    jest.mocked(Capacitor.getPlatform).mockReturnValue('ios');
    const address = `0x${'a1'.repeat(20)}`;
    const poison = ['private-topic-123', address, '1234.5678', 'https://private.example.invalid/path'];
    const code = 'REOWN_IOS_REQUEST_FAILURE:request_call_error';
    const original = Object.assign(new Error(poison.join(' ')), { code, data: { privateData: poison } });
    jest.mocked(rawReown.sendTransaction).mockRejectedValueOnce(original);
    let caught: unknown;
    try {
      await NativeReown.sendTransaction({ chainId: 1, to: address });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(original);
    reportTransactionFailure({
      type: 'bridged-receive',
      point: 'bridge_receive_settlement',
      bridgeReceive: { route: 'usdcx', step: 'wallet_deposit', cause: caught },
      error: caught
    });
    await flushEgress();
    const events = sentryEvents();
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event === undefined) throw new Error('Expected one Sentry event');
    expect(objectAt(objectAt(event, 'extra'), 'walletDiagnostics')).toMatchObject({
      reownNativeOrigin: 'request_call_error', reownRequestAge: 'unknown', reownPublished: 'unobserved'
    });
    expect(objectAt(event, 'tags')).toMatchObject({
      reown_native_origin: 'request_call_error', reown_request_age: 'unknown', reown_published: 'unobserved'
    });
    for (const text of [...poison, code, 'REOWN_IOS_REQUEST_FAILURE:']) {
      for (const variant of encodingVariantsOf(text)) expect(wireText()).not.toContain(variant);
    }
    expect(leaksIn(wireText())).toEqual([]);
  });

  it('realNativeRejectionReportsOnlyClosedDiagnosticsOnTheWire', async () => {
    consentOn();
    jest.mocked(Capacitor.getPlatform).mockReturnValue('android');
    const address = `0x${'a1'.repeat(20)}`;
    const poison = {
      requestId: 'request-private-123',
      topic: 'topic-private-456',
      address,
      amount: '1234.5678',
      url: 'https://native-poison.example.invalid/private',
      hostname: 'native-poison.example.invalid',
      walletCode: '-32603',
      requestAge: '123456',
      text: 'native-private-free-text'
    };
    const privateText = Object.values(poison).join(' ');
    const code =
      'REOWN_NATIVE_REQUEST_FAILURE:' +
      JSON.stringify({
        nativeOrigin: 'wallet_error',
        walletResponseCode: 'internal_error',
        requestAge: '120_to_300s',
        published: 'confirmed',
        backgrounded: 'yes'
      });
    const rawError = Object.assign(new Error(`Request expired\n${privateText}`, { cause: new Error(privateText) }), {
      code,
      details: `Request expired\n${privateText}`,
      data: poison
    });
    rawError.stack = `Error: ${privateText}\n    at nativeRequest (${poison.url}:123456:1)`;
    jest.mocked(rawReown.sendTransaction).mockRejectedValueOnce(rawError);
    let caught: unknown;
    try {
      await NativeReown.sendTransaction({ chainId: 1, to: address });
    } catch (rejection) {
      caught = rejection;
    }
    expect(rawReown.sendTransaction).toHaveBeenCalledTimes(1);
    expect(caught).toBe(rawError);

    reportTransactionFailure({
      type: 'bridged-receive',
      point: 'bridge_receive_settlement',
      bridgeReceive: { route: 'usdcx', step: 'wallet_approve', cause: caught },
      error: caught
    });
    await flushEgress();

    expect(captured).toHaveLength(1);
    const events = sentryEvents();
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event === undefined) throw new Error('Expected one Sentry event');
    expect(objectAt(objectAt(event, 'extra'), 'walletDiagnostics')).toMatchObject({
      reownNativeOrigin: 'wallet_error',
      reownWalletResponseCode: 'internal_error',
      reownRequestAge: '120_to_300s',
      reownPublished: 'confirmed',
      reownBackgrounded: 'yes'
    });
    expect(objectAt(event, 'tags')).toMatchObject({
      reown_native_origin: 'wallet_error',
      reown_wallet_response_code: 'internal_error',
      reown_request_age: '120_to_300s',
      reown_published: 'confirmed',
      reown_backgrounded: 'yes'
    });
    const exception = objectAt(event, 'exception');
    expect(exception.values).toHaveLength(1);
    if (!Array.isArray(exception.values)) throw new Error('Expected exception values');
    const value: unknown = exception.values[0];
    if (typeof value !== 'object' || value === null) throw new Error('Expected a synthetic exception');
    expect(Reflect.get(value, 'type')).toBe('WalletTransactionFailure');
    expect(Reflect.get(value, 'value')).toContain('via usdcx; failed at wallet_approve; evm error request_expired');
    expect(value).not.toHaveProperty('cause');
    const stacktrace: unknown = Reflect.get(value, 'stacktrace');
    const frames: unknown =
      typeof stacktrace === 'object' && stacktrace !== null ? Reflect.get(stacktrace, 'frames') : stacktrace;
    expect(frames ?? []).toEqual([]);
    expect(event.fingerprint).toBeUndefined();
    for (const text of [...Object.values(poison), 'REOWN_NATIVE_REQUEST_FAILURE:', code]) {
      for (const variant of encodingVariantsOf(text)) expect(wireText()).not.toContain(variant);
    }
    expect(leaksIn(wireText())).toEqual([]);
  });

  describe('native request diagnostic omissions', () => {
    const closedCode =
      'REOWN_NATIVE_REQUEST_FAILURE:' +
      JSON.stringify({
        nativeOrigin: 'wallet_error',
        walletResponseCode: 'internal_error',
        requestAge: '120_to_300s',
        published: 'confirmed',
        backgrounded: 'yes'
      });
    const expectedDiagnostics = {
      reownNativeOrigin: 'wallet_error',
      reownWalletResponseCode: 'internal_error',
      reownRequestAge: '120_to_300s',
      reownPublished: 'confirmed',
      reownBackgrounded: 'yes'
    };
    const expectedTags = {
      reown_native_origin: 'wallet_error',
      reown_wallet_response_code: 'internal_error',
      reown_request_age: '120_to_300s',
      reown_published: 'confirmed',
      reown_backgrounded: 'yes'
    };

    function expectNoNativeDiagnostics(event: Record<string, unknown>): void {
      const diagnostics = objectAt(objectAt(event, 'extra'), 'walletDiagnostics');
      const tags = objectAt(event, 'tags');
      for (const field of Object.keys(expectedDiagnostics)) expect(diagnostics).not.toHaveProperty(field);
      for (const tag of Object.keys(expectedTags)) expect(tags).not.toHaveProperty(tag);
    }

    it.each(['ios', 'web', 'legacy code', 'invalid envelope', 'auxiliary native method', 'text-flattened cause'])(
      'unsupportedNativePathsStillSendWithoutNativeDiagnostics: %s',
      async path => {
        consentOn();
        jest.mocked(Capacitor.getPlatform).mockReturnValue(path === 'ios' || path === 'web' ? path : 'android');
        const code =
          path === 'legacy code'
            ? 'LEGACY_REOWN_FAILURE'
            : path === 'invalid envelope'
              ? 'REOWN_NATIVE_REQUEST_FAILURE:{"nativeOrigin":"wallet_error","requestAge":123456,"published":"confirmed"}'
              : closedCode;
        const rawError = Object.assign(new Error('Request expired'), { code });
        const rawMethod = path === 'auxiliary native method' ? rawReown.launchWallet : rawReown.sendTransaction;
        jest.mocked(rawMethod).mockRejectedValueOnce(rawError);
        let caught: unknown;
        try {
          if (path === 'auxiliary native method') await NativeReown.launchWallet();
          else await NativeReown.sendTransaction({ chainId: 1, to: `0x${'a1'.repeat(20)}` });
        } catch (rejection) {
          caught = rejection;
        }
        expect(rawMethod).toHaveBeenCalledTimes(1);
        expect(caught).toBe(rawError);
        if (!(caught instanceof Error)) throw new Error('Expected a native rejection');
        const cause = path === 'text-flattened cause' ? new Error(caught.message) : caught;
        reportTransactionFailure({
          type: 'bridged-receive',
          point: 'bridge_receive_settlement',
          bridgeReceive: { route: 'usdcx', step: 'wallet_approve', cause },
          error: cause
        });
        await flushEgress();

        expect(captured).toHaveLength(1);
        const events = sentryEvents();
        expect(events).toHaveLength(1);
        const event = events[0];
        if (event === undefined) throw new Error('Expected a Sentry event for an unsupported native path');
        expect(JSON.stringify(objectAt(event, 'exception'))).toContain('WalletTransactionFailure');
        expectNoNativeDiagnostics(event);
        expect(leaksIn(wireText())).toEqual([]);
      }
    );

    it('followingUnrelatedEventDoesNotInheritNativeDiagnostics', async () => {
      consentOn();
      jest.mocked(Capacitor.getPlatform).mockReturnValue('android');
      const rawError = Object.assign(new Error('Request expired'), { code: closedCode });
      jest.mocked(rawReown.sendTransaction).mockRejectedValueOnce(rawError);
      let caught: unknown;
      try {
        await NativeReown.sendTransaction({ chainId: 1, to: `0x${'a1'.repeat(20)}` });
      } catch (rejection) {
        caught = rejection;
      }
      expect(rawReown.sendTransaction).toHaveBeenCalledTimes(1);
      expect(caught).toBe(rawError);
      reportTransactionFailure({
        type: 'bridged-receive',
        point: 'bridge_receive_settlement',
        bridgeReceive: { route: 'usdcx', step: 'wallet_approve', cause: caught },
        error: caught
      });
      await flushEgress();
      reportTransactionFailure({ type: 'execute', stage: 'executing', error: 'advice stack read failed' });
      await flushEgress();

      expect(captured).toHaveLength(2);
      const events = sentryEvents();
      expect(events).toHaveLength(2);
      const [native, unrelated] = events;
      if (native === undefined || unrelated === undefined) throw new Error('Expected two Sentry events');
      expect(objectAt(objectAt(native, 'extra'), 'walletDiagnostics')).toMatchObject(expectedDiagnostics);
      expect(objectAt(native, 'tags')).toMatchObject(expectedTags);
      expect(JSON.stringify(objectAt(unrelated, 'exception'))).toContain('WalletTransactionFailure');
      expect(JSON.stringify(objectAt(unrelated, 'exception'))).toContain('advice_stack_read_failed');
      expectNoNativeDiagnostics(unrelated);
    });
  });

  it('reports a startup-interrupted claim by its fixed startup facts within 192 added wire bytes', async () => {
    consentOn();
    const failure = (startup?: TransactionFailure['startup']): TransactionFailure => ({
      type: 'consume',
      stage: 'signing-proposal',
      entryPoint: 'claim',
      reason: 'interrupted_on_startup',
      error: poisonedError('interrupted on startup'),
      startup
    });
    reportTransactionFailure(failure());
    await flushEgress();
    reportTransactionFailure(
      failure({ selection: 'before_session', stageAge: 'under_1d', submit: 'no_submit_recorded' })
    );
    await flushEgress();

    expect(captured).toHaveLength(2);
    const [without, withFacts] = captured.map(entry => entry.body);
    expect(withFacts).toContain(
      '; startup selection before_session; stored stage age under_1d; submit no_submit_recorded; point pipeline; interrupted_on_startup.'
    );
    expect(without).toContain(
      '; startup selection unavailable; stored stage age unavailable; submit unavailable; point pipeline; interrupted_on_startup.'
    );
    // The whole added segment, measured as sent: the report carries it in its exception value, once.
    const segment = /; startup selection [a-z_0-9]+; stored stage age [a-z_0-9]+; submit [a-z_]+/.exec(withFacts ?? '');
    expect(segment).not.toBeNull();
    expect(new TextEncoder().encode(segment?.[0] ?? '').length).toBeLessThanOrEqual(192);
    expect((withFacts ?? '').split('startup selection').length - 1).toBe(1);
    expect(leaksIn(wireText())).toEqual([]);
  });

  it('reports a handled offscreen assertion without raw transaction data or a frontend scope', async () => {
    consentOn();
    reportTransactionFailure({
      type: 'execute',
      stage: 'executing',
      delegateTransaction: true,
      error: poisonedError(
        "Offscreen call 'newTransaction' failed: assertion failed with error code: 15404814807981965102"
      ),
      diagnostics: { authPreparation: 'provided', authLayout: 'guardian', commitmentMatch: 'guardian' }
    });
    await flushEgress();
    expect(captured).toHaveLength(1);
    expect(wireText()).toContain('ERR_FEE_CONVERSION_INFO_COMMITMENT_MISMATCH');
    expect(wireText()).toContain('WalletTransactionFailure');
    expect(wireText()).toContain('executing');
    expect(wireText()).toContain('offscreen');
    expect(leaksIn(wireText())).toEqual([]);
  });

  // The text an Android Fast deposit stores when the wallet refuses: viem's flattened message, which names the RPC
  // endpoint, the sender, the transaction and the amount, and hands over as its cause. Only the fixed values may cross
  // the wire.
  it('reports a failed inbound bridge by its route, step and library error, and nothing its text says', async () => {
    consentOn();
    const host = 'rpc.walletconnect.org';
    const sender = `0x${'a1'.repeat(20)}`;
    const amount = '1234.5678';
    const stored = [
      'An unknown RPC error occurred.',
      '',
      `URL: https://${host}/v1/?chainId=eip155:11155111&projectId=0123456789abcdef`,
      'Request Arguments:',
      `  from:   ${sender}`,
      `  value:  ${amount} USDC`,
      `  data:   ${POISON.privateKeyHex}`,
      '',
      'Details: User rejected the request.',
      'Version: viem@2.55.4'
    ].join('\n');

    reportTransactionFailure({
      type: 'bridged-receive',
      point: 'bridge_receive_settlement',
      error: stored,
      bridgeReceive: { route: 'epoch', step: 'epoch_solve', cause: stored }
    });
    await flushEgress();

    expect(captured).toHaveLength(1);
    const values = captured
      .flatMap(entry => entry.body.split('\n'))
      .flatMap(line => {
        try {
          const item: unknown = JSON.parse(line);
          const exception: unknown = typeof item === 'object' && item !== null ? Reflect.get(item, 'exception') : null;
          const listed: unknown =
            typeof exception === 'object' && exception !== null ? Reflect.get(exception, 'values') : null;
          return Array.isArray(listed)
            ? listed.map((value: unknown) => String(Reflect.get(Object(value), 'value')))
            : [];
        } catch {
          return [];
        }
      });
    expect(values).toEqual([
      expect.stringMatching(
        /^Transaction failed: tx_bridge; stage unknown; realm unknown; proving preference unknown; platform [a-z]+; point bridge_receive_settlement; rpc; via epoch; failed at epoch_solve; evm error user_rejected\. authentication preparation unavailable; layout unavailable; commitment match unavailable; account code unavailable\. SDK \d+\.\d+\.\d+; Guardian client \d+\.\d+\.\d+$/
      )
    ]);
    for (const text of [
      host,
      'eip155',
      '0123456789abcdef',
      sender,
      'a1a1',
      amount,
      'viem',
      'User rejected',
      'Request Arguments'
    ]) {
      expect(wireText()).not.toContain(text);
    }
    expect(leaksIn(wireText())).toEqual([]);
  });

  it('retains each separate terminal failure even when their diagnostic facts match', async () => {
    consentOn();
    for (let attempt = 0; attempt < 2; attempt++) {
      reportTransactionFailure({ type: 'execute', stage: 'executing', error: 'advice stack read failed' });
      await flushEgress();
    }
    expect(captured).toHaveLength(2);
  });

  it('sends an envelope at all, so every absence assertion below can fail', async () => {
    consentOn();
    initCrashReporting();
    captureCrash(new Error('rpc endpoint returned status'));
    await flushEgress();

    expect(captured).toHaveLength(1);
    expect(wireText()).toContain('rpc endpoint returned status');
  });

  it('leaks no forbidden value from a wrapped-error cause chain, in any encoding', async () => {
    consentOn();
    initCrashReporting();
    captureCrash(poisonedError('send failed'));
    await flushEgress();

    expect(captured.length).toBeGreaterThan(0);
    expect(leaksIn(wireText())).toEqual([]);
  });

  it('leaks no forbidden value from a poisoned stack', async () => {
    consentOn();
    initCrashReporting();
    const error = new Error('sync failed');
    error.name = `Error${POISON.compositePublicKey}`;
    error.stack = [
      `Error: sync failed for ${POISON.addressMainnet}`,
      `    at load (chrome-extension://abc/accounts/${POISON.addressTestnet}/index.js:1:2)`,
      `    at restore (file:///${PHRASE_12.split(' ').join('/')}/index.js:3:4)`
    ].join('\n');
    captureCrash(error);
    await flushEgress();

    expect(captured.length).toBeGreaterThan(0);
    expect(leaksIn(wireText())).toEqual([]);
  });

  it.each(Object.entries(STRUCTURAL_POISON))(
    'leaks no forbidden value when %s is the whole message, raw or encoded',
    async (_name, value) => {
      consentOn();
      initCrashReporting();
      captureCrash(new Error(value));
      // Base64 and percent-encoded forms of the same value, since a caught
      // network error routinely carries an encoded request body or path.
      captureCrash(new Error(`request body ${btoa(value)}`));
      captureCrash(new Error(`request path ${encodeURIComponent(value)}`));
      captureCrash(new Error(`response ${JSON.stringify({ detail: value })}`));
      await flushEgress();

      expect(captured.length).toBeGreaterThan(0);
      expect(leaksIn(wireText())).toEqual([]);
    }
  );

  it.each(Object.entries(CONTEXTUAL_POISON))('leaks no %s when it is named, raw or encoded', async (name, value) => {
    consentOn();
    initCrashReporting();
    captureCrash(new Error(`unlock rejected: ${name}=${value}`));
    captureCrash(new Error(`unlock rejected: "${name}": "${value}"`));
    captureCrash(new Error(`unlock rejected: ${name}=${btoa(value)}`));
    captureCrash(new Error(`unlock rejected: ${name}=${encodeURIComponent(value)}`));
    await flushEgress();

    expect(captured.length).toBeGreaterThan(0);
    expect(leaksIn(wireText())).toEqual([]);
  });

  it('leaks no credentials out of an RPC URL, raw or encoded', async () => {
    consentOn();
    initCrashReporting();
    const url = POISON.rpcUrlWithCredentials;
    captureCrash(new Error(`GET ${url} failed`));
    captureCrash(new Error(`GET ${btoa(url)} failed`));
    captureCrash(new Error(`GET ${encodeURIComponent(url)} failed`));
    await flushEgress();

    expect(captured.length).toBeGreaterThan(0);
    // Not just the whole URL: the userinfo has to go even though the host and
    // path deliberately stay, so this is where the credentials are checked.
    expect(leaksIn(wireText())).toEqual([]);
  });

  it('sends exact source-bound diagnostics and scrubbed causes on the real Sentry wire', async () => {
    consentOn();
    initCrashReporting();
    const failure = new Error('approval failed', { cause: new Error(`network failed password=${POISON.password}`) });
    annotateCrash(failure, {
      operation: 'confirm_payload',
      confirmationId: 'empty',
      payload: POISON.mnemonic12,
      stage: POISON.mnemonic12
    });
    captureCrash(failure, 'react');
    captureCrash(new Error('unrelated failure'));
    await flushEgress();
    const text = wireText();
    expect(captured.length).toBeGreaterThan(0);
    expect(text).toContain('network failed');
    expect(text).toContain('"type":"react","handled":true');
    expect(text).toContain('"confirmationId":"empty"');
    expect(text).toContain(`"appVersion":"${packageJson.version}"`);
    expect(leaksIn(text)).toEqual([]);
    expect(text.match(/"confirmationId":"empty"/g)).toHaveLength(1);
    expect(text).not.toContain('"payload"');
  });

  describe('storage rejection egress', () => {
    const poison = {
      database: 'wire-poison-database-hazel',
      firstPrimaryKey: 'wire-poison-primary-a',
      secondPrimaryKey: 'wire-poison-primary-b',
      indexedQueryKey: 'wire-poison-primary-',
      accountId: 'wire-poison-account-opaque',
      transactionId: HIGH_ENTROPY_POISON.transactionId,
      noteId: HIGH_ENTROPY_POISON.noteId,
      address: HIGH_ENTROPY_POISON.addressTestnet,
      amount: '715326498217',
      fieldName: 'wirePoisonOpaqueField',
      fieldValue: 'wire-poison-row-field-value',
      nestedFieldName: 'wirePoisonNestedField',
      nestedFieldValue: 'wire-poison-nested-field-value',
      errorCredential: 'wire-poison-credential',
      causeCredential: 'wire-poison-cause',
      invalidOwner: 'wire-poison-owner',
      invalidOperation: 'wire-poison-operation'
    };
    let target: Dexie;
    let injectedFailure: Error;
    let visibility: PropertyDescriptor | undefined;

    beforeEach(async () => {
      visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      target = createSchemaFor(poison.database);
      await target.open();
      const rows: Array<ITransaction & Record<string, unknown>> = [poison.firstPrimaryKey, poison.secondPrimaryKey].map(
        id => ({
          id,
          type: 'send',
          accountId: poison.accountId,
          transactionId: poison.transactionId,
          noteId: poison.noteId,
          secondaryAccountId: poison.address,
          amount: BigInt(poison.amount),
          status: ITransactionStatus.Queued,
          initiatedAt: 1,
          displayIcon: 'SEND',
          [poison.fieldName]: poison.fieldValue,
          extraInputs: { [poison.nestedFieldName]: poison.nestedFieldValue }
        })
      );
      await target.table<ITransaction, string>(Table.Transactions).bulkAdd(rows);
      // An existing Dexie class preserves this exact Error and its cause through request-error mapping.
      injectedFailure = new Dexie.UnknownError('cursor request failed password=wire-poison-credential');
      injectedFailure.cause = new Error('continuation failed password=wire-poison-cause');
    });

    afterEach(async () => {
      stopCrashReporting();
      target.close();
      try {
        await target.delete();
      } finally {
        if (visibility === undefined) Reflect.deleteProperty(document, 'visibilityState');
        else Object.defineProperty(document, 'visibilityState', visibility);
      }
    });

    function scanFailure(): Promise<unknown> {
      // A filter forces cursor iteration instead of Dexie's getAll fast path; the range poisons an actual query key.
      return target
        .table<ITransaction, string>(Table.Transactions)
        .where(':id')
        .aboveOrEqual(poison.indexedQueryKey)
        .filter(() => true)
        .toArray()
        .then(
          () => undefined,
          (failure: unknown) => failure
        );
    }

    function expectNoStoragePoison(text: string): void {
      for (const sentinel of Object.values(poison)) {
        for (const variant of encodingVariantsOf(sentinel)) expect(text).not.toContain(variant);
      }
      expect(leaksIn(text)).toEqual([]);
    }

    function expectOriginalExceptions(event: Record<string, unknown>): void {
      expect(objectAt(event, 'exception').values).toEqual([
        expect.objectContaining({ type: 'Error', value: expect.stringContaining('continuation failed') }),
        expect.objectContaining({ type: 'UnknownError', value: expect.stringContaining('cursor request failed') })
      ]);
      expect(event).not.toHaveProperty('title');
      expect(event).not.toHaveProperty('message');
      expect(event).not.toHaveProperty('fingerprint');
      expect(JSON.stringify(objectAt(event, 'exception'))).not.toMatch(
        /wallet_transactions|storageOwner|storageOperation/
      );
    }

    it('keeps the maximum storage diagnostic increment within192 wire bytes', async () => {
      const previousTarget = process.env.WALLET_BUILD_TARGET;
      process.env.WALLET_BUILD_TARGET = 'mobile';
      try {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'prerender' });
        consentOn();
        initCrashReporting();
        const failure = new Error(`storage operation failed password=${POISON.password}`);
        failure.name = 'WalletUserVisibleError';
        annotateCrash(failure, {
          storageOwner: 'wallet_transactions',
          storageOperation: 'transaction',
          userErrorId: 'usdcxFaucetUnavailable',
          userErrorSurface: 'review'
        });
        captureCrash(failure);
        await flushEgress();

        const { event, baseline, increment } = storageWireIncrement();
        expect(objectAt(objectAt(event, 'extra'), 'walletDiagnostics')).toMatchObject({
          appVersion: packageJson.version,
          network: 'testnet',
          target: 'mobile',
          storageOwner: 'wallet_transactions',
          storageOperation: 'transaction',
          pageVisibility: 'unknown',
          userErrorId: 'usdcxFaucetUnavailable',
          userErrorSurface: 'review'
        });
        expect(objectAt(event, 'exception').values).toEqual([
          expect.objectContaining({
            type: 'WalletUserVisibleError',
            value: expect.stringContaining('storage operation failed')
          })
        ]);
        expect(event.fingerprint).toEqual(['WalletUserVisibleError', 'usdcxFaucetUnavailable', 'review']);
        expect(objectAt(objectAt(baseline, 'extra'), 'walletDiagnostics')).toMatchObject({
          appVersion: packageJson.version,
          network: 'testnet',
          target: 'mobile',
          userErrorId: 'usdcxFaucetUnavailable',
          userErrorSurface: 'review'
        });
        expect(increment).toBeLessThanOrEqual(192);
        expect(event.tags).toEqual({
          network: 'testnet',
          storage_owner: 'wallet_transactions',
          storage_operation: 'transaction',
          'user_error.id': 'usdcxFaucetUnavailable',
          'user_error.surface': 'review'
        });
        expect(event.tags).not.toHaveProperty('page_visibility');
      } finally {
        if (previousTarget === undefined) delete process.env.WALLET_BUILD_TARGET;
        else process.env.WALLET_BUILD_TARGET = previousTarget;
      }
    });

    it('keeps a real cursor diagnostic increment within192 wire bytes', async () => {
      consentOn();
      initCrashReporting();
      await withCursorRequestFailure(target, injectedFailure, async evidence => {
        const publicFailure = await scanFailure();
        expect(publicFailure).toBe(injectedFailure);
        globalThis.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: publicFailure }));
        await flushEgress();

        const { event, increment } = storageWireIncrement();
        expect(evidence.opened).toBeGreaterThan(0);
        expect(evidence.requestErrors).toBe(1);
        expect(objectAt(objectAt(event, 'extra'), 'walletDiagnostics')).toMatchObject({
          storageOwner: 'wallet_transactions',
          storageOperation: 'cursor',
          pageVisibility: 'hidden'
        });
        expect(event.tags).toEqual({
          network: 'testnet',
          storage_owner: 'wallet_transactions',
          storage_operation: 'cursor'
        });
        expect(event.tags).not.toHaveProperty('page_visibility');
        expect(increment).toBeGreaterThan(0);
        expect(increment).toBeLessThanOrEqual(192);
      });
    });

    it('keeps an unannotated report within192 added wire bytes without storage attribution', async () => {
      consentOn();
      initCrashReporting();
      captureCrash(new Error('unannotated wire budget control'));
      await flushEgress();

      const { event, increment } = storageWireIncrement();
      const diagnostics = objectAt(objectAt(event, 'extra'), 'walletDiagnostics');
      expect(diagnostics).not.toHaveProperty('storageOwner');
      expect(diagnostics).not.toHaveProperty('storageOperation');
      expect(diagnostics.pageVisibility).toBe('hidden');
      expect(event.tags).toEqual({ network: 'testnet' });
      expect(event.tags).not.toHaveProperty('page_visibility');
      expect(event).not.toHaveProperty('fingerprint');
      expect(increment).toBeGreaterThan(0);
      expect(increment).toBeLessThanOrEqual(192);
    });

    it('sends only closed storage values from a real post-open cursor rejection', async () => {
      consentOn();
      initCrashReporting();
      await withCursorRequestFailure(target, injectedFailure, async evidence => {
        const publicFailure = await scanFailure();
        if (!(publicFailure instanceof Error)) throw new Error('cursor scan did not reject with an Error');
        globalThis.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: publicFailure }));
        await flushEgress();

        expect(evidence.opened).toBeGreaterThan(0);
        expect(evidence.requestErrors).toBe(1);
        expect(publicFailure).toBe(injectedFailure);
        expect(publicFailure.name).toBe('UnknownError');
        expect(captured).toHaveLength(1);
        expect(sentryEvents()).toHaveLength(1);
        expect(wireText()).toContain('continuation failed');
        expect(wireText()).toContain('"type":"onunhandledrejection","handled":false');
        expect(wireText()).toContain('"pageVisibility":"hidden"');
        expect(wireText()).not.toContain('"page_visibility"');
        expect(wireText()).toContain('"storageOwner":"wallet_transactions"');
        expect(wireText()).toContain('"storageOperation":"cursor"');
        expect(wireText()).toContain('"storage_owner":"wallet_transactions"');
        expect(wireText()).toContain('"storage_operation":"cursor"');
        expectNoStoragePoison(wireText());
        const event = sentryEvents()[0];
        if (event === undefined) throw new Error('missing cursor report');
        expectOriginalExceptions(event);
      });
    });

    it('sends nothing when the same cursor failure is consumed', async () => {
      consentOn();
      initCrashReporting();
      await withCursorRequestFailure(target, injectedFailure, async evidence => {
        expect(await scanFailure()).toBe(injectedFailure);
        await flushEgress();
        expect(evidence.opened).toBeGreaterThan(0);
        expect(evidence.requestErrors).toBe(1);
        expect(captured).toHaveLength(0);
      });
    });

    it('sends nothing for a real cursor failure when consent is denied', async () => {
      consentOff();
      initCrashReporting();
      await withCursorRequestFailure(target, injectedFailure, async evidence => {
        const publicFailure = await scanFailure();
        expect(publicFailure).toBe(injectedFailure);
        globalThis.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: publicFailure }));
        await flushEgress();
        expect(evidence.opened).toBeGreaterThan(0);
        expect(evidence.requestErrors).toBe(1);
        expect(captured).toHaveLength(0);
      });
    });

    it('drops unlisted storage labels on the real wire', async () => {
      consentOn();
      initCrashReporting();
      const publicFailure = new Error('unlisted storage annotation');
      // This adversarial annotation is separate from every genuine cursor rejection above.
      annotateCrash(publicFailure, { storageOwner: poison.invalidOwner, storageOperation: poison.invalidOperation });
      globalThis.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: publicFailure }));
      await flushEgress();
      expect(captured).toHaveLength(1);
      const events = sentryEvents();
      expect(events).toHaveLength(1);
      const event = events[0];
      if (event === undefined) throw new Error('missing adversarial report');
      const diagnostics = objectAt(objectAt(event, 'extra'), 'walletDiagnostics');
      expect(diagnostics).not.toHaveProperty('storageOwner');
      expect(diagnostics).not.toHaveProperty('storageOperation');
      expect(diagnostics.pageVisibility).toBe('hidden');
      const tags = objectAt(event, 'tags');
      expect(tags).not.toHaveProperty('storage_owner');
      expect(tags).not.toHaveProperty('storage_operation');
      expect(tags).not.toHaveProperty('page_visibility');
      expectNoStoragePoison(wireText());
    });

    it("does not attach a cursor failure's storage labels to the next event", async () => {
      consentOn();
      initCrashReporting();
      await withCursorRequestFailure(target, injectedFailure, async evidence => {
        const publicFailure = await scanFailure();
        expect(publicFailure).toBe(injectedFailure);
        globalThis.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: publicFailure }));
        await flushEgress();
        expect(evidence.opened).toBeGreaterThan(0);
        expect(evidence.requestErrors).toBe(1);
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        globalThis.dispatchEvent(
          Object.assign(new Event('unhandledrejection'), { reason: new Error('unrelated storage control') })
        );
        await flushEgress();
        expect(captured).toHaveLength(2);
        const events = sentryEvents();
        expect(events).toHaveLength(2);
        const [first, second] = events;
        if (first === undefined || second === undefined) throw new Error('missing sequential reports');
        expect(objectAt(objectAt(first, 'extra'), 'walletDiagnostics').pageVisibility).toBe('hidden');
        expect(objectAt(first, 'tags')).not.toHaveProperty('page_visibility');
        const diagnostics = objectAt(objectAt(second, 'extra'), 'walletDiagnostics');
        expect(diagnostics).not.toHaveProperty('storageOwner');
        expect(diagnostics).not.toHaveProperty('storageOperation');
        expect(diagnostics.pageVisibility).toBe('visible');
        const tags = objectAt(second, 'tags');
        expect(tags).not.toHaveProperty('storage_owner');
        expect(tags).not.toHaveProperty('storage_operation');
        expect(tags).not.toHaveProperty('page_visibility');
        expectNoStoragePoison(wireText());
      });
    });
  });

  it('retains exact validated local compiled positions and source build identity only', async () => {
    process.env.WALLET_BUILD_TARGET = 'mobile';
    process.env.WALLET_BUILD_REVISION = '0123456789abcdef0123456789abcdef01234567';
    process.env.WALLET_BUILD_DIRTY = 'false';
    try {
      consentOn();
      initCrashReporting();
      const cause = new Error('wasm init failed');
      cause.stack = 'Error: wasm init failed\n    at startup (capacitor://localhost/mobile.js:1:5000)';
      const failure = new Error('sdk failed', { cause });
      failure.stack = 'Error: sdk failed\n    at caller (capacitor://localhost/mobile.js:1:87000)';
      captureCrash(failure);
      await flushEgress();
      const text = wireText();
      expect(text).toContain('"filename":"app:///mobile.js","lineno":1,"colno":5000');
      expect(text).toContain('"filename":"app:///mobile.js","lineno":1,"colno":87000');
      expect(text).toContain('"revision":"0123456789abcdef0123456789abcdef01234567"');
      expect(text).toContain('"target":"mobile","revision"');
      expect(text).not.toContain('capacitor://localhost');
      expect(leaksIn(text)).toEqual([]);
    } finally {
      delete process.env.WALLET_BUILD_TARGET;
      delete process.env.WALLET_BUILD_REVISION;
      delete process.env.WALLET_BUILD_DIRTY;
    }
  });

  it('retains ordinary scrubbed WASM frames beside validated local frames without their raw offsets', async () => {
    consentOn();
    initCrashReporting();
    const failure = new Error('initialization failed');
    failure.stack =
      'Error: initialization failed\n    at __wbindgen_malloc (wasm://wasm/app.wasm:777:888)\n    at startup (capacitor://localhost/mobile.js:1:5000)';
    captureCrash(failure);
    await flushEgress();
    const text = wireText();
    expect(text).toContain('__wbindgen_malloc');
    expect(text).toContain('"filename":"app:///mobile.js","lineno":1,"colno":5000');
    expect(text).not.toContain('"lineno":777');
    expect(text).not.toContain('"colno":888');
    expect(leaksIn(text)).toEqual([]);
  });

  describe('closed values for a startup trap and an unanswered dApp approval', () => {
    // Chrome's extension ids are 32 letters from a to p.
    const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const CONFIRMATION_ID = 'V1StGXR8_Z5jdHi6B-myT';
    const NOTE_ID = `0x${'a1b2c3d4e5f60718'.repeat(4)}`;
    // The approval window's own address carries its confirmation id.
    const CONFIRM_FRAME = `    at load (${EXTENSION_ORIGIN}/confirm.html#?id=${CONFIRMATION_ID}:1:2)`;

    const restores: Array<() => void> = [];
    const replace = (target: object, key: string, value: unknown) => {
      const own = Object.getOwnPropertyDescriptor(target, key);
      Object.defineProperty(target, key, { value, configurable: true, writable: true });
      restores.push(() => {
        if (own === undefined) Reflect.deleteProperty(target, key);
        else Object.defineProperty(target, key, own);
      });
    };
    afterEach(() => {
      for (const restore of restores.splice(0).reverse()) restore();
    });

    const expectNothingIdentifying = (text: string) => {
      expect(text).not.toMatch(/0x[0-9a-f]/i);
      expect(text).not.toContain(CONFIRMATION_ID);
      expect(text).not.toContain('chrome-extension://');
      expect(leaksIn(text)).toEqual([]);
    };

    function startupTrap(): Error {
      const trap = new WebAssembly.RuntimeError('unreachable');
      const wasm = `${EXTENSION_ORIGIN}/static/wasm/miden_client_web.hMHvbzfs.wasm`;
      trap.stack = [
        'RuntimeError: unreachable',
        `    at miden_client_web.wasm.__wbindgen_malloc (${wasm}:wasm-function[11015]:0x18e0a2c)`,
        `    at miden_client_web.wasm.__wbindgen_start (${wasm}:wasm-function[10922]:0x18dc693)`,
        `    at xl (${EXTENSION_ORIGIN}/chunks/Cargo-B2P22_Kp.CjbEv7yQ.js:9:24623)`,
        CONFIRM_FRAME
      ].join('\n');
      trap.cause = new Error(`note ${NOTE_ID} could not be read`);
      return trap;
    }

    async function captureStartupFailure(failure: Error): Promise<string> {
      consentOn();
      initCrashReporting();
      mockSdkReady.mockRejectedValueOnce(failure);
      const caught = await ensureSdkWasmReady().then(
        () => undefined,
        (error: unknown) => error
      );
      expect(caught).toBe(failure);
      captureCrash(caught, 'onunhandledrejection');
      await flushEgress();
      expect(captured).toHaveLength(1);
      return wireText();
    }

    it("names a startup trap's shared-memory probe and window count, and nothing that identifies it", async () => {
      replace(globalThis, 'crossOriginIsolated', true);
      replace(
        WebAssembly,
        'Memory',
        jest.fn(() => ({
          grow: () => {
            throw new RangeError('WebAssembly.Memory.grow(): Maximum memory size exceeded');
          }
        }))
      );
      replace(chrome.extension, 'getViews', () => Array.from({ length: 5 }, () => globalThis));
      const text = await captureStartupFailure(startupTrap());
      expect(text).toContain('"sharedMemoryProbe":"refused"');
      expect(text).toContain('"extensionViews":"4+"');
      expect(text).toContain('"stage":"wasm_ready"');
      expect(text).toContain('"type":"onunhandledrejection","handled":false');
      expect(text).toContain('__wbindgen_malloc');
      expect(text).not.toContain('wasm-function[');
      expectNothingIdentifying(text);
    });

    it('names a shared memory that still grows beside a lone window', async () => {
      replace(globalThis, 'crossOriginIsolated', true);
      replace(
        WebAssembly,
        'Memory',
        jest.fn(() => ({ grow: () => 1 }))
      );
      replace(chrome.extension, 'getViews', () => [globalThis]);
      const text = await captureStartupFailure(startupTrap());
      expect(text).toContain('"sharedMemoryProbe":"grew"');
      expect(text).toContain('"extensionViews":"1"');
      expectNothingIdentifying(text);
    });

    it('adds no memory evidence to a startup failure that is not a WebAssembly trap', async () => {
      replace(globalThis, 'crossOriginIsolated', true);
      replace(chrome.extension, 'getViews', () => [globalThis]);
      const failure = new Error(`wasm fetch failed for note ${NOTE_ID}`);
      failure.stack = [`Error: ${failure.message}`, CONFIRM_FRAME].join('\n');
      const text = await captureStartupFailure(failure);
      expect(text).toContain('"stage":"wasm_ready"');
      expect(text).not.toContain('sharedMemoryProbe');
      expect(text).not.toContain('extensionViews');
      expectNothingIdentifying(text);
    });

    it("names the background's state for an unanswered dApp approval, and nothing that identifies it", async () => {
      consentOn();
      initCrashReporting();
      // As the approval window's intercom client receives the background's Not Found.
      const failure = deserializeInternalError([
        'Not Found',
        undefined,
        'Error',
        undefined,
        { code: 'confirmation_unknown:array_with_string:pruned:over_300s' }
      ]);
      failure.stack = [
        'Error: Not Found',
        `    at s (${EXTENSION_ORIGIN}/chunks/front.BXR4C5cr.js:1:41768)`,
        CONFIRM_FRAME
      ].join('\n');
      failure.cause = new Error(`no handler for note ${NOTE_ID}`);
      annotateCrash(failure, {
        operation: 'intercom_request',
        requestType: MidenMessageType.DAppGetPayloadRequest,
        confirmationHandler: failure.code,
        pageNavigation: 'reload',
        portReconnected: true,
        confirmationId: CONFIRMATION_ID,
        approval: NOTE_ID
      });
      captureCrash(failure, 'react');
      // A code that is not exactly one of the background's names carries no state.
      const hostileCodes = [
        `0x${'ab'.repeat(32)}`,
        `confirmation_unknown ${NOTE_ID}`,
        `confirmation_${CONFIRMATION_ID}`,
        `confirmation_unknown:${CONFIRMATION_ID}:empty:under_10s`,
        `confirmation_unknown:array_with_string:empty:${NOTE_ID}`
      ];
      hostileCodes.forEach((code, index) => {
        const hostile = deserializeInternalError(['Not Found', undefined, 'Error', undefined, { code }]);
        // Its own frame, so deduplication cannot drop it and pass this test for the wrong reason.
        hostile.stack = `Error: Not Found\n    at attempt (capacitor://localhost/mobile.js:1:${index + 1})`;
        annotateCrash(hostile, {
          operation: 'intercom_request',
          confirmationHandler: hostile.code,
          pageNavigation: EXTENSION_ORIGIN,
          portReconnected: 'true'
        });
        captureCrash(hostile, 'react');
      });
      await flushEgress();
      const text = wireText();
      expect(captured).toHaveLength(1 + hostileCodes.length);
      expect(text).toContain('"confirmationHandler":"unknown"');
      expect(text).toContain('"portReconnected":true');
      expect(text).toContain(`"requestType":"${MidenMessageType.DAppGetPayloadRequest}"`);
      expect(text).toContain('"confirmationRequestShape":"array_with_string"');
      expect(text).toContain('"confirmationRegistry":"pruned"');
      expect(text).toContain('"backgroundAge":"over_300s"');
      expect(text).toContain('"pageNavigation":"reload"');
      expect(text.match(/"confirmationHandler"/g)).toHaveLength(1);
      expect(text.match(/"confirmationRequestShape"/g)).toHaveLength(1);
      expect(text.match(/"pageNavigation"/g)).toHaveLength(1);
      expect(text.match(/"portReconnected"/g)).toHaveLength(1);
      expect(text).not.toContain('"confirmationId"');
      expect(text).not.toContain('"approval"');
      expectNothingIdentifying(text);
    });
  });

  it('replaces unknown URLs with a static filename while retaining scrubbed frame symbols', async () => {
    consentOn();
    initCrashReporting();
    const failure = new Error('initialization failed');
    failure.stack =
      'Error: initialization failed\n    at __wbindgen_malloc (https://private-user:private-password@private-host.example/private-path?token=private-query:777:888)\n    at startup (capacitor://localhost/mobile.js:1:5000)';
    captureCrash(failure);
    await flushEgress();
    const text = wireText();
    expect(text).toContain('__wbindgen_malloc');
    expect(text).toContain('"filename":"[unvalidated]"');
    for (const value of ['private-user', 'private-password', 'private-host.example', 'private-path', 'private-query']) {
      expect(text).not.toContain(value);
    }
    expect(text).not.toContain('"lineno":777');
    expect(text).not.toContain('"colno":888');
  });

  it('never promotes frame-looking multiline message data into compiled positions', async () => {
    consentOn();
    initCrashReporting();
    const message = 'request failed\n    at userData (capacitor://localhost/mobile.js:1:4242)';
    const failure = new Error(message);
    failure.stack = `Error: ${message}\n    at actual (capacitor://localhost/mobile.js:1:5000)`;
    captureCrash(failure);
    await flushEgress();
    expect(wireText()).not.toContain('"colno":4242');
    expect(wireText()).toContain('"colno":5000');
  });

  it('fails closed when a header-shaped stack disagrees with the captured error', async () => {
    consentOn();
    initCrashReporting();
    const failure = new Error('actual message');
    failure.stack = 'Error: unrelated header\n    at userData (capacitor://localhost/mobile.js:1:4242)';
    captureCrash(failure);
    await flushEgress();
    expect(wireText()).not.toContain('"colno":4242');
  });

  it.each([
    '    at initialize (capacitor://localhost/mobile.js:1:5000)',
    'initialize@capacitor://localhost/mobile.js:1:5000',
    '@capacitor://localhost/mobile.js:1:5000'
  ])('accepts a legitimate headerless frame stack: %s', async stack => {
    consentOn();
    initCrashReporting();
    const failure = new Error('initialization failed');
    failure.stack = stack;
    captureCrash(failure);
    await flushEgress();
    expect(wireText()).toContain('"filename":"app:///mobile.js","lineno":1,"colno":5000');
  });

  it.each([
    { location: 'root', label: 'missing', stack: undefined },
    { location: 'root', label: 'empty', stack: '' },
    { location: 'root', label: 'rejected', stack: 'Error: unrelated header' },
    { location: 'cause', label: 'missing', stack: undefined },
    { location: 'cause', label: 'empty', stack: '' },
    { location: 'cause', label: 'rejected', stack: 'Error: unrelated header' }
  ])('enforces the authoritative empty frame snapshot for $location/$label stacks', async ({ location, stack }) => {
    consentOn();
    initCrashReporting();
    const injected = new Error('zxywvu\n    at zzzqqq (https://qxzyw.example/qxzyw:7:777)');
    injected.stack = stack;
    const failure = location === 'root' ? injected : new Error('outer failure', { cause: injected });
    if (location === 'cause') {
      failure.stack = 'Error: outer failure\n    at actual (capacitor://localhost/mobile.js:1:5000)';
    }
    captureCrash(failure);
    await flushEgress();
    const text = wireText();
    expect(captured.length).toBeGreaterThan(0);
    expect(text).toContain('zxywvu');
    expect(text).toContain('"stacktrace":{"frames":[]}');
    expect(text).not.toContain('"filename":"https://qxzyw.example/qxzyw"');
    expect(text).not.toContain('"lineno":7');
    expect(text).not.toContain('"colno":777');
    expect(text.includes('"colno":5000')).toBe(location === 'cause');
  });

  it('names the network the crash happened on, as a tag and in the diagnostics', async () => {
    // Browser permission answers once the network is back on the build's, so the report is sent from there.
    let allow = (_granted: boolean) => {};
    jest.mocked(isCrashReportingEnabledAsync).mockReturnValue(
      new Promise<boolean>(resolve => {
        allow = resolve;
      })
    );
    initCrashReporting();
    await onNetwork(MIDEN_NETWORK_NAME.MAINNET, async () => captureCrash(poisonedError('send failed')));
    allow(true);
    await flushEgress();

    const text = wireText();
    expect(captured.length).toBeGreaterThan(0);
    expect(text).toContain('"tags":{"network":"mainnet"}');
    expect(text).not.toContain('"page_visibility"');
    expect(text).toMatch(/"walletDiagnostics":\{[^}]*"network":"mainnet"/);
    expect(leaksIn(text)).toEqual([]);
  });

  it('reaches only the configured Sentry host', async () => {
    consentOn();
    initCrashReporting();
    captureCrash(poisonedError('send failed'));
    await flushEgress();

    const hosts = new Set(captured.map(entry => new URL(entry.url).host));
    expect(hosts).toEqual(new Set(['o0.ingest.de.sentry.io']));
  });
});

describe('user-visible error reports', () => {
  it('sends only the closed startup attempt evidence through the real crash wire', async () => {
    consentOn();
    const reporter = reportUserVisibleError as (...args: unknown[]) => void;
    reporter('walletAccessUnavailableBody', 'startup', {
      startupEligibilityStage: 'eligibility_retry',
      startupEligibilityReason: 'version_mismatch',
      startupEligibilityRetry: 'retry_failed',
      raw: POISON.mnemonic12,
      account: POISON.compositePublicKey
    });
    await flushEgress();
    expect(captured).toHaveLength(1);
    const event = parsePayload(captured[0]?.body.split('\n')[2] ?? '');
    expect(objectAt(objectAt(event, 'extra'), 'walletDiagnostics')).toMatchObject({
      startupEligibilityStage: 'eligibility_retry',
      startupEligibilityReason: 'version_mismatch',
      startupEligibilityRetry: 'retry_failed'
    });
    expect(objectAt(objectAt(event, 'extra'), 'walletDiagnostics')).not.toHaveProperty('raw');
    expect(objectAt(objectAt(event, 'extra'), 'walletDiagnostics')).not.toHaveProperty('account');
    expect(leaksIn(wireText())).toEqual([]);
  });

  beforeEach(() => {
    _resetUserVisibleErrorLimitsForTest();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('a raw display leaks none of its text', async () => {
    consentOn();
    jest.useFakeTimers();
    try {
      render(
        createElement(
          ErrorLine,
          { errorId: 'raw_send_submit_failed' },
          `Unable to send ${POISON.amount} to ${POISON.addressTestnet}: ${PHRASE_12}`
        )
      );
      act(() => jest.advanceTimersByTime(1000));
    } finally {
      jest.useRealTimers();
    }
    await flushEgress();

    expect(captured).toHaveLength(1);
    const event = parsePayload(captured[0]?.body.split('\n')[2] ?? '');
    expect(event.tags).toEqual({
      network: 'testnet',
      'user_error.id': 'raw_send_submit_failed',
      'user_error.surface': 'inline'
    });
    expect(event.tags).not.toHaveProperty('page_visibility');
    expect(event.fingerprint).toEqual(['WalletUserVisibleError', 'raw_send_submit_failed', 'inline']);
    expect(wireText()).toContain('raw_send_submit_failed');
    expect(leaksIn(wireText())).toEqual([]);
  });

  it('puts only the closed id and surface on the wire', async () => {
    consentOn();
    reportUserVisibleError('usdcxFaucetUnavailable', 'review');
    await flushEgress();

    expect(captured).toHaveLength(1);
    const event = parsePayload(captured[0]?.body.split('\n')[2] ?? '');
    expect(objectAt(event, 'exception').values).toEqual([
      expect.objectContaining({
        type: 'WalletUserVisibleError',
        value: 'User-visible error: usdcxFaucetUnavailable; surface review',
        stacktrace: { frames: [] },
        mechanism: expect.objectContaining({ handled: true })
      })
    ]);
    expect(event.level).toBe('warning');
    expect(event.tags).toEqual({
      network: 'testnet',
      'user_error.id': 'usdcxFaucetUnavailable',
      'user_error.surface': 'review'
    });
    expect(event.tags).not.toHaveProperty('page_visibility');
    expect(event.fingerprint).toEqual(['WalletUserVisibleError', 'usdcxFaucetUnavailable', 'review']);
    expect(objectAt(objectAt(event, 'extra'), 'walletDiagnostics')).toEqual({
      ...resolveTelemetryContext(),
      ...getCrashBuildIdentity(),
      pageVisibility: 'visible',
      userErrorId: 'usdcxFaucetUnavailable',
      userErrorSurface: 'review'
    });
    expect(wireText()).not.toContain('"filename"');
    expect(wireText()).not.toContain('"cause"');
    expect(leaksIn(wireText())).toEqual([]);
  });

  it('preserves every closed surface through crash scrubbing', async () => {
    consentOn();
    for (const surface of USER_ERROR_SURFACES) {
      reportUserVisibleError('usdcxFaucetUnavailable', surface);
      await flushEgress();
    }
    expect(captured).toHaveLength(12);
    for (const [index, surface] of USER_ERROR_SURFACES.entries()) {
      const event = parsePayload(captured[index]?.body.split('\n')[2] ?? '');
      expect(objectAt(event, 'tags')['user_error.surface']).toBe(surface);
      expect(event.fingerprint).toEqual(['WalletUserVisibleError', 'usdcxFaucetUnavailable', surface]);
    }
    expect(leaksIn(wireText())).toEqual([]);
  });

  it.each([
    ['identifier fragments in a breadcrumb', 'breadcrumb', 'account', 'key', 'seed'],
    ['identifier fragments in extra data', 'extra', 'account', 'key', 'seed'],
    ['a closed surface in a breadcrumb', 'breadcrumb', 'review', 'review', 'review'],
    ['a closed surface in extra data', 'extra', 'review', 'review', 'review']
  ] as const)('drops a contaminated report despite %s', async (_name, location, first, second, third) => {
    const syntheticWords = [
      'abandon',
      'ability',
      'able',
      first,
      'about',
      'above',
      'absent',
      second,
      'absorb',
      'abstract',
      'absurd',
      third
    ];
    const text = syntheticWords.join(' ');
    expect(syntheticWords.every(word => englishWordlist.includes(word))).toBe(true);
    expect(containsSeedMaterial(text, englishWordlist)).toBe(true);
    consentOn();
    const policyInputs: unknown[] = [];
    const stopObservers: Array<() => void> = [];
    const captureException = Scope.prototype.captureException;
    const capture = jest.spyOn(Scope.prototype, 'captureException').mockImplementationOnce(function (
      this: Scope,
      error,
      hint
    ) {
      if (location === 'breadcrumb') this.addBreadcrumb({ category: 'fixture', message: text });
      else this.setExtra('fixture', text);
      const reportingClient = this.getClient();
      if (!reportingClient) throw new Error('Missing reporting client');
      stopObservers.push(
        reportingClient.on('postprocessEvent', event => {
          policyInputs.push(
            location === 'breadcrumb'
              ? event.breadcrumbs?.find(breadcrumb => breadcrumb.category === 'fixture')?.message
              : event.extra?.fixture
          );
        })
      );
      return captureException.call(this, error, hint);
    });

    try {
      reportUserVisibleError('raw_account_export_failed', 'review');
      await flushEgress();
    } finally {
      stopObservers.forEach(stop => stop());
    }

    expect(capture).toHaveBeenCalledTimes(1);
    expect(policyInputs).toEqual([text]);
    expect(captured).toHaveLength(0);
    expect(wireText()).not.toContain(text);
  });

  it('preserves canonical closed data with harmless free-text fields', async () => {
    consentOn();
    const captureException = Scope.prototype.captureException;
    const capture = jest.spyOn(Scope.prototype, 'captureException').mockImplementationOnce(function (
      this: Scope,
      error,
      hint
    ) {
      this.addBreadcrumb({ category: 'fixture', message: 'fallback unavailable' });
      this.setExtra('fixture', 'fallback unavailable');
      return captureException.call(this, error, hint);
    });

    reportUserVisibleError('raw_account_export_failed', 'review');
    await flushEgress();

    expect(capture).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(1);
    const event = parsePayload(captured[0]?.body.split('\n')[2] ?? '');
    expect(event.tags).toEqual({
      network: 'testnet',
      'user_error.id': 'raw_account_export_failed',
      'user_error.surface': 'review'
    });
    expect(event.tags).not.toHaveProperty('page_visibility');
    expect(event.fingerprint).toEqual(['WalletUserVisibleError', 'raw_account_export_failed', 'review']);
    expect(objectAt(event, 'exception').values).toEqual([
      expect.objectContaining({
        type: 'WalletUserVisibleError',
        value: 'User-visible error: raw_account_export_failed; surface review'
      })
    ]);
    expect(event.breadcrumbs).toEqual([
      expect.objectContaining({ category: 'fixture', message: 'fallback unavailable' })
    ]);
    expect(objectAt(event, 'extra')).toEqual({
      walletDiagnostics: {
        ...resolveTelemetryContext(),
        ...getCrashBuildIdentity(),
        pageVisibility: 'visible',
        userErrorId: 'raw_account_export_failed',
        userErrorSurface: 'review'
      }
    });
  });

  it('retains a repeated report after the minute instead of letting Sentry deduplicate it', async () => {
    consentOn();
    const clock = jest.spyOn(performance, 'now').mockReturnValue(0);
    reportUserVisibleError('usdcxFaucetUnavailable', 'review');
    await flushEgress();
    clock.mockReturnValue(59_999);
    reportUserVisibleError('usdcxFaucetUnavailable', 'review');
    await flushEgress();
    expect(captured).toHaveLength(1);
    clock.mockReturnValue(60_000);
    reportUserVisibleError('usdcxFaucetUnavailable', 'review');
    await flushEgress();
    expect(captured).toHaveLength(2);
  });

  it('drops raw text containing an address, amount and recovery phrase before capture', async () => {
    consentOn();
    const report: unknown = reportUserVisibleError;
    if (typeof report !== 'function') throw new Error('Missing reporter');
    report(`Unable to send ${POISON.amount} to ${POISON.addressTestnet}: ${PHRASE_12}`, 'review');
    report('usdcxFaucetUnavailable', `toast ${POISON.addressTestnet}`);
    await flushEgress();
    expect(captured).toHaveLength(0);
    reportUserVisibleError('usdcxFaucetUnavailable', 'review');
    await flushEgress();
    expect(captured).toHaveLength(1);
    expect(leaksIn(wireText())).toEqual([]);
  });

  it('sends nothing without crash-report permission', async () => {
    consentOff();
    reportUserVisibleError('usdcxFaucetUnavailable', 'review');
    await flushEgress();
    expect(captured).toEqual([]);
  });
});

describe('WalletConnect relay failure reports', () => {
  const PREFIX = 'WebSocket connection failed for host: ';
  const PROJECT_ID = '3f8a2c1d9e7b6a5f4c3d2e1f0a9b8c7d';
  // Shaped like the relay's JWT: header, claims and signature.
  const RELAY_AUTH =
    'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJkaWQ6a2V5Ono2TWtvZFRQNTJ4Z3BZOHRGbXJhRmlqUTlCMXpjSGUxbXZxYlMifQ.bW9jay1zaWduYXR1cmUtbW9jay1zaWduYXR1cmU';
  const TOPIC = `0x${'7c4a8d09ca3762af'.repeat(4)}`;

  const relayFailure = (host = 'relay.walletconnect.org'): Error =>
    new Error(`${PREFIX}wss://${host}?projectId=${PROJECT_ID}&auth=${RELAY_AUTH}`, {
      cause: new Error(`Subscribing to ${TOPIC} failed, please try again`)
    });

  // Sentry's own report and trace ids are hex by design, so they are the one hex the wire may carry.
  const withoutSentryIds = (text: string): string =>
    text.replace(/"(?:event_id|trace_id|span_id|parent_span_id)":"[0-9a-f]+"/g, '');

  /** The failure range of each report on the wire, in the order sent. */
  const relayRanges = (): Array<string | undefined> =>
    captured.map(entry => /"relayFailures":"([^"]+)"/.exec(entry.body)?.[1]);

  /** The event item of a Sentry envelope: its header, the item's header, then the event. */
  const sentryEvent = (entry: CapturedRequest | undefined): Record<string, unknown> =>
    parsePayload(entry?.body.split('\n')[2] ?? '');

  // Fields every crash report carries, whatever it is.
  const EVERY_REPORT_KEYS = ['appVersion', 'platform', 'network', 'target', 'revision', 'dirty'];

  const restores: Array<() => void> = [];
  const replace = (target: object, key: string, value: unknown) => {
    const own = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { value, configurable: true, writable: true });
    restores.push(() => {
      if (own === undefined) Reflect.deleteProperty(target, key);
      else Object.defineProperty(target, key, own);
    });
  };

  beforeEach(() => {
    __resetRelayDiagnosticsForTest();
    recordRelaySurface('confirm');
  });

  afterEach(() => {
    for (const restore of restores.splice(0).reverse()) restore();
  });

  it('names the relay and only its closed context, at warning level, with none of the failure text', async () => {
    consentOn();
    initCrashReporting();
    captureCrash(relayFailure(), 'onunhandledrejection');
    await flushEgress();

    expect(captured).toHaveLength(1);
    const text = wireText();
    expect(text).toContain('"service":"walletconnect_relay"');
    expect(text).toContain('"level":"warning"');
    expect(text).toContain('"surface":"confirm"');
    expect(text).toContain('"relayFailures":"1"');
    expect(text).toContain('"connectivity":"steady"');
    expect(text).toContain('"type":"onunhandledrejection","handled":false');
    expect(text).not.toMatch(/0x[0-9a-f]/i);
    expect(withoutSentryIds(text)).not.toMatch(/[0-9a-f]{32,}/i);
    expect(text).not.toContain('projectId');
    expect(text).not.toContain(PROJECT_ID);
    expect(text).not.toContain('eyJ');
    expect(text).not.toContain('Subscribing');
    expect(leaksIn(text)).toEqual([]);

    const event = sentryEvent(captured[0]);
    expect(objectAt(event, 'tags')).toEqual({
      network: resolveTelemetryContext().network,
      service: 'walletconnect_relay'
    });
    expect(objectAt(event, 'tags')).not.toHaveProperty('page_visibility');
    const diagnostics = objectAt(objectAt(event, 'extra'), 'walletDiagnostics');
    expect(Object.fromEntries(Object.entries(diagnostics).filter(([key]) => !EVERY_REPORT_KEYS.includes(key)))).toEqual(
      {
        service: 'walletconnect_relay',
        connectivity: 'steady',
        pageVisibility: 'visible',
        visibility: 'visible',
        surface: 'confirm',
        relayTrigger: 'no_connect_modal',
        relayEverConnected: false,
        relayFailures: '1'
      }
    );
    // The title the issue already has, and no cause.
    expect(objectAt(event, 'exception').values).toEqual([
      expect.objectContaining({ type: 'Error', value: `${PREFIX}wss://relay.walletconnect.org` })
    ]);
  });

  it('names the report Error whatever the failure called itself, under the fixed text and its own frames', async () => {
    consentOn();
    initCrashReporting();
    const failure = relayFailure();
    failure.name = 'UpstreamRelayError';
    failure.stack = `UpstreamRelayError: ${failure.message}\n    at openRelaySocket (capacitor://localhost/mobile.js:1:5000)`;
    captureCrash(failure, 'onunhandledrejection');
    await flushEgress();

    expect(captured).toHaveLength(1);
    const text = wireText();
    expect(text).not.toContain('UpstreamRelayError');
    expect(text).toContain('"filename":"app:///mobile.js","lineno":1,"colno":5000,"function":"openRelaySocket"');
    expect(objectAt(sentryEvent(captured[0]), 'exception').values).toEqual([
      expect.objectContaining({ type: 'Error', value: `${PREFIX}wss://relay.walletconnect.org` })
    ]);
  });

  it('labels no host outside the relay allowlist, and leaves its level alone', async () => {
    consentOn();
    initCrashReporting();
    captureCrash(new Error(`${PREFIX}wss://relay.example.invalid`), 'onunhandledrejection');
    captureCrash(new Error(`${PREFIX}wss://relay.walletconnect.org.example.invalid`), 'onunhandledrejection');
    await flushEgress();

    expect(captured).toHaveLength(2);
    const text = wireText();
    expect(text.match(/"level":"error"/g)).toHaveLength(2);
    expect(text).not.toContain('"level":"warning"');
    expect(text).not.toContain('walletconnect_relay');
    expect(text).not.toContain('relayFailures');
  });

  it('sends a stuck relay once per failure bucket: three reports for seven failures', async () => {
    consentOn();
    initCrashReporting();
    for (let attempt = 0; attempt < 7; attempt++) captureCrash(relayFailure(), 'onunhandledrejection');
    await flushEgress();

    expect(captured).toHaveLength(3);
    expect(captured.map(entry => /"relayFailures":"([^"]+)"/.exec(entry.body)?.[1]).sort()).toEqual(['1', '2-5', '6+']);
  });

  it('sends nothing while the device is offline, and still counts the failure', async () => {
    consentOn();
    initCrashReporting();
    replace(navigator, 'onLine', false);
    captureCrash(relayFailure(), 'onunhandledrejection');
    await flushEgress();
    expect(captured).toEqual([]);

    restores.pop()?.();
    captureCrash(relayFailure(), 'onunhandledrejection');
    await flushEgress();
    expect(captured).toHaveLength(1);
    expect(wireText()).toContain('"relayFailures":"2-5"');
  });

  it('drops an offline failure before browser permission answers, and sends the next range', async () => {
    consentOn();
    initCrashReporting();
    captureCrash(relayFailure(), 'onunhandledrejection');
    await flushEgress();
    expect(relayRanges()).toEqual(['1']);

    let allow = (_granted: boolean) => {};
    jest.mocked(isCrashReportingEnabledAsync).mockReturnValueOnce(
      new Promise<boolean>(resolve => {
        allow = resolve;
      })
    );
    captureCrash(relayFailure(), 'onunhandledrejection');
    replace(navigator, 'onLine', false);
    allow(true);
    await flushEgress();
    expect(relayRanges()).toEqual(['1']);

    restores.pop()?.();
    captureCrash(relayFailure(), 'onunhandledrejection');
    await flushEgress();
    expect(relayRanges()).toEqual(['1', '2-5']);
  });

  it.each<[string, (capture: () => void) => void, () => void]>([
    [
      'browser permission is denied',
      capture => {
        jest.mocked(isCrashReportingEnabledAsync).mockResolvedValue(false);
        capture();
      },
      consentOn
    ],
    [
      'reporting stopped before its permission check answered',
      capture => {
        capture();
        stopCrashReporting();
      },
      () => initCrashReporting()
    ],
    [
      'there was no client to capture it',
      capture => {
        stopCrashReporting();
        capture();
      },
      () => initCrashReporting()
    ]
  ])('sends nothing for a failure dropped because %s, and the range of the next one', async (_label, drop, restore) => {
    consentOn();
    initCrashReporting();
    captureCrash(relayFailure(), 'onunhandledrejection');
    await flushEgress();
    drop(() => captureCrash(relayFailure(), 'onunhandledrejection'));
    await flushEgress();
    expect(relayRanges()).toEqual(['1']);

    restore();
    captureCrash(relayFailure(), 'onunhandledrejection');
    await flushEgress();
    expect(relayRanges()).toEqual(['1', '2-5']);
  });

  it('sends one report for two failures of one range captured before either is sent', async () => {
    consentOn();
    initCrashReporting();
    captureCrash(relayFailure(), 'onunhandledrejection');
    await flushEgress();
    captureCrash(relayFailure(), 'onunhandledrejection');
    captureCrash(relayFailure(), 'onunhandledrejection');
    await flushEgress();
    expect(relayRanges()).toEqual(['1', '2-5']);
  });

  it('counts an Error captured by every path as one failure, and a new Error with the same text as the next', async () => {
    consentOn();
    initCrashReporting();
    const failure = relayFailure();
    captureCrash(failure, 'onunhandledrejection');
    captureCrash(failure, 'onerror');
    captureCrash(failure, 'react');
    captureCrash(failure);
    await flushEgress();
    expect(relayRanges()).toEqual(['1']);

    captureCrash(relayFailure(), 'onunhandledrejection');
    await flushEgress();
    expect(relayRanges()).toEqual(['1', '2-5']);
  });

  it('names a network change the crash listeners saw in the 30 seconds before, and none once they stopped', async () => {
    consentOn();
    initCrashReporting();
    globalThis.dispatchEvent(new Event('online'));
    captureCrash(relayFailure(), 'onunhandledrejection');
    await flushEgress();
    expect(wireText()).toContain('"connectivity":"just_changed"');

    stopCrashReporting();
    __resetRelayDiagnosticsForTest();
    globalThis.dispatchEvent(new Event('offline'));
    initCrashReporting();
    captured.length = 0;
    captureCrash(relayFailure(), 'onunhandledrejection');
    await flushEgress();
    expect(captured).toHaveLength(1);
    expect(wireText()).toContain('"connectivity":"steady"');
  });
});

describe('the boundary is the only way out', () => {
  // Everything above asserts what leaves through the two egress points. This
  // asserts that there are only two — a call site that opened a third would be
  // invisible to every assertion in this file, and no amount of scrubbing at
  // the boundary helps if the payload never passes through it.
  const SRC = resolve(__dirname, '..', '..');

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return entry.name === '__mocks__' ? [] : sourceFiles(path);
      if (!/\.tsx?$/.test(entry.name) || /\.(test|spec)\.tsx?$/.test(entry.name)) return [];
      return [path];
    });
  }

  const importers = (pattern: RegExp): string[] =>
    sourceFiles(SRC)
      .filter(path => pattern.test(readFileSync(path, 'utf8')))
      .map(path => relative(SRC, path).split(sep).join('/'))
      .sort();

  it('has one consent-gated sender, reached from one place outside the telemetry module', () => {
    // Three files, one sender. `sink.ts` defines it. `actions.ts` is the
    // worker's handler for an event a page forwarded. `report-operation.ts` is
    // the worker reporting on its own work, which has no page to forward from —
    // and it calls this only in the worker branch, where it already IS the
    // background. Every one of the three passes through the same consent check
    // inside `sendEvent`, which is what makes this a boundary rather than a
    // convention.
    expect(importers(/\bsendEvent\b/)).toEqual([
      'lib/miden/back/actions.ts',
      'lib/telemetry/report-operation.ts',
      'lib/telemetry/sink.ts'
    ]);
  });

  it('confines the crash-reporting SDK to the module that scrubs before it', () => {
    expect(importers(/from '@sentry\//)).toEqual(['lib/telemetry/crash.ts']);
  });
});

describe('consent boundary', () => {
  it('sends crash reports without product events when usage sharing is off', async () => {
    consentOff();
    jest.mocked(isCrashReportingEnabledAsync).mockResolvedValue(true);
    initCrashReporting();
    captureCrash(poisonedError('send failed'));
    await driveEveryInstrumentedFlow();

    expect(envelopes()).toEqual([]);
    expect(captured.filter(entry => entry.url !== INGEST_URL).length).toBeGreaterThan(0);
  });

  it('sends both when usage consent and browser permission are granted', async () => {
    consentOn();
    initCrashReporting();
    captureCrash(poisonedError('send failed'));
    await driveEveryInstrumentedFlow();

    expect(envelopes().length).toBeGreaterThan(0);
    expect(captured.filter(entry => entry.url !== INGEST_URL).length).toBeGreaterThan(0);
  });

  it('sends nothing when both permission and usage-consent checks fail', async () => {
    jest.mocked(isCrashReportingEnabledAsync).mockRejectedValue(new Error('permissions unavailable'));
    jest.mocked(isTelemetryEnabledAsync).mockRejectedValue(new Error('storage unavailable'));
    initCrashReporting();
    captureCrash(poisonedError('send failed'));
    await driveEveryInstrumentedFlow();

    expect(captured).toEqual([]);
  });
});
