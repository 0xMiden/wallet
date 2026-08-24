import { act, renderHook } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { useAppLifecycleTelemetry } from 'app/hooks/useAppLifecycleTelemetry';
import { useFundTelemetry } from 'app/hooks/useFundTelemetry';
import { useReportNoteClaim } from 'app/hooks/useReportNoteClaim';
import { request } from 'lib/miden/front';
import { isTelemetryEnabledAsync } from 'lib/settings/helpers';
import { WalletMessageType } from 'lib/shared/types';
import { enterSendFlow, settleSendFlow } from 'screens/send-flow/send-telemetry';

import { resolveTelemetryContext } from './context';
import { captureCrash, initCrashReporting, stopCrashReporting } from './crash';
import { encodingVariantsOf } from './egress-guard';
import { beginFlow, classifyError } from './report-flow';
import { __resetRunForTest } from './run';
import { WIRE_KEYS } from './serialize';
import { sendEvent } from './sink';
import { TelemetryErrorKind, TelemetryEvent, TelemetryFlow, TelemetryOperation, TelemetryResult } from './types';

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
 * Nothing here mocks the telemetry stack. `fetch` is the only thing replaced,
 * because `fetch` IS the wire.
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
  isTelemetryEnabledAsync: jest.fn()
}));

// Partial for the same reason: `resolveTelemetryContext` reads `isIOS`/
// `isAndroid` from this module, and stubbing those away would stop the guard
// from seeing the real `platform` value that goes on the wire.
jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isMobile: () => true
}));

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
 * `Welcome.tsx`'s "Missing password or seed phrase", which names neither — and
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

const FLOWS: readonly TelemetryFlow[] = Object.values(EVERY_FLOW);
const RESULTS: readonly TelemetryResult[] = Object.values(EVERY_RESULT);
const ERROR_KINDS: readonly TelemetryErrorKind[] = Object.values(EVERY_ERROR_KIND);
const OPERATIONS: readonly TelemetryOperation[] = Object.values(EVERY_OPERATION);

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

  // `note_handle`: completed, errored on a poisoned rejection, then abandoned.
  const claim = renderHook(() => useReportNoteClaim());
  await act(async () => {
    await claim.result.current(() => Promise.resolve('claim queued'));
  });
  await act(async () => {
    await swallowRejection(() => claim.result.current(() => Promise.reject(poisonedError('network claim failed'))));
  });
  // A claim still in flight when the surface goes away: the unmount has to
  // settle it as abandoned rather than leave an unmatched `started`.
  await act(async () => {
    void swallowRejection(() => claim.result.current(() => new Promise(() => undefined)));
    claim.unmount();
  });

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

const consentOn = () => jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(true);
const consentOff = () => jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(false);

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
    expect([...observed].sort()).toEqual(['durationMs', 'errorKind', 'flowId', 'result']);
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

    const eventNames = new Set(FLOWS.flatMap(flow => [`${flow}_started`, `${flow}_ended`]));
    const propValues = new Set<string>([...RESULTS, ...ERROR_KINDS]);
    const platforms = new Set<string>(['extension', 'ios', 'android']);

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
        if (key === 'appVersion' && /^\d+\.\d+\.\d+$/.test(value)) continue;
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

    // The settled axis, swept the same way and for the same reason. Both shapes
    // of it: with a duration and without, since an operation with no honest
    // interval omits the field and the two take different branches through the
    // serializer.
    events.push(
      ...OPERATIONS.flatMap((operation): TelemetryEvent[] => [
        { phase: 'settled', operation, runId: 'sweep-run', result: 'completed', durationMs: 41.9 },
        { phase: 'settled', operation, runId: 'sweep-run', result: 'completed' },
        ...ERROR_KINDS.map(
          (errorKind): TelemetryEvent => ({
            phase: 'settled',
            operation,
            runId: 'sweep-run',
            result: 'errored',
            errorKind,
            durationMs: 8.4,
            step: 'sending'
          })
        )
      ])
    );

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

  it('reaches only the configured Sentry host', async () => {
    consentOn();
    initCrashReporting();
    captureCrash(poisonedError('send failed'));
    await flushEgress();

    const hosts = new Set(captured.map(entry => new URL(entry.url).host));
    expect(hosts).toEqual(new Set(['o0.ingest.de.sentry.io']));
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
  it('sends nothing at all — product events or crash reports — with consent off', async () => {
    consentOff();
    initCrashReporting();
    captureCrash(poisonedError('send failed'));
    await driveEveryInstrumentedFlow();

    expect(captured).toEqual([]);
  });

  it('sends both once consent is granted, so the silence above is the gate and not a broken driver', async () => {
    consentOn();
    initCrashReporting();
    captureCrash(poisonedError('send failed'));
    await driveEveryInstrumentedFlow();

    expect(envelopes().length).toBeGreaterThan(0);
    expect(captured.filter(entry => entry.url !== INGEST_URL).length).toBeGreaterThan(0);
  });

  it('sends nothing when the consent check itself fails', async () => {
    jest.mocked(isTelemetryEnabledAsync).mockRejectedValue(new Error('storage unavailable'));
    initCrashReporting();
    captureCrash(poisonedError('send failed'));
    await driveEveryInstrumentedFlow();

    expect(captured).toEqual([]);
  });
});
