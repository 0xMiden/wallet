import React from 'react';

import { dedupeIntegration } from '@sentry/browser';
import { act, render, cleanup } from '@testing-library/react';

import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { isCrashReportingEnabledAsync, isTelemetryEnabledAsync } from 'lib/settings/helpers';

import {
  CRASH_INTEGRATION_ALLOWLIST,
  captureCrash,
  initCrashReporting,
  scrubEvent,
  selectIntegrations,
  stopCrashReporting
} from './crash';
import { annotateCrash } from './crash-diagnostics';
import { observeProposalCreateRejection } from './proposal-create-diagnostics';
import { REDACTED } from './redact';
import { __resetRelayDiagnosticsForTest } from './relay-diagnostics';
import { reportTransactionFailure } from './transaction-failure';
import { reportUserVisibleError, _resetUserVisibleErrorLimitsForTest } from './user-visible-error';
import packageJson from '../../../package.json';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

jest.mock('lib/settings/helpers', () => ({
  ...jest.requireActual<typeof import('lib/settings/helpers')>('lib/settings/helpers'),
  isCrashReportingEnabledAsync: jest.fn(),
  isTelemetryEnabledAsync: jest.fn()
}));
jest.mock('lib/miden-chain/effective-endpoints', () => {
  const actual = jest.requireActual<typeof import('lib/miden-chain/effective-endpoints')>(
    'lib/miden-chain/effective-endpoints'
  );
  return { ...actual, getEffectiveNetworkName: jest.fn(actual.getEffectiveNetworkName) };
});

interface ClientOptions {
  dsn?: string;
  beforeSend?: (event: unknown, hint?: { originalException?: unknown }) => unknown;
  integrations?: { name: string }[];
  sendDefaultPii?: boolean;
  release?: string;
  transport?: unknown;
  stackParser?: unknown;
}

const clientOptions: ClientOptions[] = [];
const captured: unknown[] = [];
const capturedHints: unknown[] = [];
const close = jest.fn();
const setClient = jest.fn();
const setTag = jest.fn();
const setTags = jest.fn();
let constructorThrows = false;

jest.mock('@sentry/browser', () => ({
  BrowserClient: jest.fn((options: ClientOptions) => {
    if (constructorThrows) throw new Error('client unavailable');
    clientOptions.push(options);
    return { init: jest.fn(), close };
  }),
  Scope: jest.fn(() => ({
    setClient,
    setTag,
    setTags,
    getPropagationContext: () => ({ traceId: 'a'.repeat(32), sampleRand: 0 }),
    captureException: (error: unknown, hint: unknown) => {
      captured.push(error);
      capturedHints.push(hint);
    }
  })),
  makeFetchTransport: jest.fn(),
  defaultStackParser: jest.fn(),
  inboundFiltersIntegration: jest.fn(() => ({ name: 'InboundFilters' })),
  linkedErrorsIntegration: jest.fn(() => ({ name: 'LinkedErrors' })),
  dedupeIntegration: jest.fn(() => ({ name: 'Dedupe' }))
}));

/** The real v10.70.0 default set, for asserting what the policy would reject. */
const SENTRY_DEFAULT_INTEGRATIONS = [
  'InboundFilters',
  'FunctionToString',
  'ConversationId',
  'BrowserApiErrors',
  'Breadcrumbs',
  'GlobalHandlers',
  'LinkedErrors',
  'Dedupe',
  'HttpContext',
  'CultureContext',
  'BrowserSession'
];

it('bypasses Dedupe for user-visible errors while keeping ordinary crash deduplication', () => {
  const dedupe = {
    name: 'Dedupe',
    processEvent: (_event: unknown, _hint: unknown, _client: unknown): null => null
  } satisfies ReturnType<typeof dedupeIntegration>;
  jest.mocked(dedupeIntegration).mockReturnValueOnce(dedupe);
  initCrashReporting();
  const event = { exception: { values: [{ type: 'WalletUserVisibleError', value: 'closed message' }] } };
  expect(dedupe.processEvent(event, {}, {})).toBe(event);
  expect(
    dedupe.processEvent({ exception: { values: [{ type: 'Error', value: 'ordinary crash' }] } }, {}, {})
  ).toBeNull();
});

const flushMicrotasks = () => new Promise(resolve => setTimeout(resolve, 0));

const PHRASE_12 = 'avoid leave side crush call gasp confirm deal student link chunk interest';
const PHRASE_24 =
  'echo cross route trophy art call defy cat swift tail moral right follow mansion arm intact pulp frame truck connect cotton throw release play';
const ADDRESS = 'mtst1aqsjql4cyylvpu2d2cwpxumpvvw5depe';
const COMPOSITE_ADDRESS = 'mtst1aqsjql4cyylvpu2d2cwpxumpvvw5depe_qr7qqq9wr6w';
const PRIVATE_KEY_HEX = '0x9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

/** Everything the captured errors carry, as one string, for leak assertions. */
const capturedText = () =>
  JSON.stringify(captured.map(error => (error instanceof Error ? serializeError(error) : error)));

const serializeError = (error: Error) => ({ name: error.name, message: error.message, stack: error.stack });

const grantBrowserPermission = () => jest.mocked(isCrashReportingEnabledAsync).mockResolvedValue(true);
const denyBrowserPermission = () => jest.mocked(isCrashReportingEnabledAsync).mockResolvedValue(false);

/** An Error that counts each read of its own name, message and stack. */
function countingFieldReads(message: string): { error: Error; reads: Record<'name' | 'message' | 'stack', number> } {
  const error = new Error(message);
  const reads = { name: 0, message: 0, stack: 0 };
  Object.defineProperties(error, {
    name: {
      get() {
        reads.name++;
        return 'Error';
      }
    },
    message: {
      get() {
        reads.message++;
        return message;
      }
    },
    stack: {
      get() {
        reads.stack++;
        return `Error: ${message}\n    at source (capacitor://localhost/mobile.js:1:5000)`;
      }
    }
  });
  return { error, reads };
}

beforeEach(() => {
  process.env.SENTRY_DSN = 'https://publickey@o0.ingest.de.sentry.io/1';
  clientOptions.length = 0;
  captured.length = 0;
  capturedHints.length = 0;
  constructorThrows = false;
  jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(false);
  grantBrowserPermission();
});

afterEach(() => {
  stopCrashReporting();
  jest.clearAllMocks();
});

describe('integration selection', () => {
  it('does not resurrect a pending lazy report after reporting is stopped', async () => {
    let allow: (value: boolean) => void = () => {};
    jest.mocked(isCrashReportingEnabledAsync).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          allow = resolve;
        })
    );
    captureCrash(new Error('handled transaction failed'), 'manual', { initializeIfNeeded: true });
    stopCrashReporting();
    allow(true);
    await flushMicrotasks();
    expect(clientOptions).toHaveLength(0);
    expect(captured).toHaveLength(0);
  });

  it('initializes handled-only reporting without new global error listeners', async () => {
    grantBrowserPermission();
    const listener = jest.spyOn(globalThis, 'addEventListener');
    captureCrash(new Error('handled transaction failed'), 'manual', { initializeIfNeeded: true });
    await flushMicrotasks();
    expect(captured).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();
    listener.mockRestore();
  });
  it('initializes once when a handled failure arrives without any frontend scope', async () => {
    grantBrowserPermission();
    captureCrash(new Error('handled transaction failed'), 'manual', { initializeIfNeeded: true });
    await flushMicrotasks();
    captureCrash(new Error('another transaction failed'), 'manual', { initializeIfNeeded: true });
    await flushMicrotasks();
    expect(clientOptions).toHaveLength(1);
    expect(captured).toHaveLength(2);
  });

  it('does not initialize a lazy crash client when browser permission is denied', async () => {
    denyBrowserPermission();
    captureCrash(new Error('handled transaction failed'), 'manual', { initializeIfNeeded: true });
    await flushMicrotasks();
    expect(clientOptions).toHaveLength(0);
    expect(captured).toHaveLength(0);
  });
  it('pins the allowlist contents, so nothing can be added without a test change', () => {
    expect(CRASH_INTEGRATION_ALLOWLIST).toEqual(['InboundFilters', 'LinkedErrors', 'Dedupe']);
  });

  it('excludes every integration that touches global state, the DOM, or the network', () => {
    const names = selectIntegrations(SENTRY_DEFAULT_INTEGRATIONS.map(name => ({ name }))).map(
      integration => integration.name
    );

    expect(names.length).toBeGreaterThan(0);
    for (const excluded of [
      'FunctionToString',
      'ConversationId',
      'BrowserApiErrors',
      'Breadcrumbs',
      'GlobalHandlers',
      'HttpContext',
      'CultureContext',
      'BrowserSession'
    ]) {
      expect(names).not.toContain(excluded);
    }
    expect(names).toEqual(expect.arrayContaining(['Dedupe', 'LinkedErrors', 'InboundFilters']));
  });

  it('is an allowlist, so an integration added by a future SDK release is excluded by default', () => {
    expect(selectIntegrations([{ name: 'SomeIntegrationSentryAddsLater' }])).toEqual([]);
  });

  it('admits nothing beyond the documented allowlist', () => {
    const names = selectIntegrations(CRASH_INTEGRATION_ALLOWLIST.map(name => ({ name }))).map(i => i.name);
    expect(names).toEqual([...CRASH_INTEGRATION_ALLOWLIST]);
  });
});

describe('client construction', () => {
  it('builds a client without Sentry.init and wires the scrubber as beforeSend', () => {
    initCrashReporting();
    expect(clientOptions).toHaveLength(1);
    const [options] = clientOptions;
    expect(options?.beforeSend).toBe(scrubEvent);
    expect(options?.sendDefaultPii).toBe(false);
    expect(options?.release).toEqual(expect.any(String));
    expect(setClient).toHaveBeenCalledTimes(1);
  });

  it('passes exactly the allowlisted integrations to the client', () => {
    initCrashReporting();
    const names = (clientOptions[0]?.integrations ?? []).map(integration => integration.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toEqual(['InboundFilters', 'LinkedErrors', 'Dedupe']);
  });

  it('builds with an empty DSN when none is configured, rather than failing to start', () => {
    delete process.env.SENTRY_DSN;
    initCrashReporting();
    expect(clientOptions).toHaveLength(1);
    expect(clientOptions[0]?.dsn).toBe('');
  });

  it('does not throw when the client cannot be constructed', () => {
    constructorThrows = true;
    expect(() => initCrashReporting()).not.toThrow();
  });

  it('registers global error handlers because GlobalHandlers is excluded', () => {
    const add = jest.spyOn(globalThis, 'addEventListener');
    initCrashReporting();
    const events = add.mock.calls.map(call => call[0]);
    expect(events).toContain('error');
    expect(events).toContain('unhandledrejection');
    add.mockRestore();
  });

  it('reports an uncaught global error through the handler it registered', async () => {
    grantBrowserPermission();
    initCrashReporting();
    globalThis.dispatchEvent(new ErrorEvent('error', { error: new Error(`boom ${ADDRESS}`) }));
    await flushMicrotasks();

    expect(captured).toHaveLength(1);
    expect(capturedText()).not.toContain(ADDRESS);
  });

  it('reports an unhandled rejection through the handler it registered', async () => {
    grantBrowserPermission();
    initCrashReporting();
    globalThis.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error(`boom ${ADDRESS}`) }));
    await flushMicrotasks();

    expect(captured).toHaveLength(1);
    expect(capturedText()).not.toContain(ADDRESS);
  });

  it('stops reporting global errors once crash reporting stops', async () => {
    grantBrowserPermission();
    const add = jest.spyOn(globalThis, 'addEventListener');
    initCrashReporting();
    const handler = add.mock.calls.find(([type]) => type === 'error')?.[1] as EventListener;
    expect(typeof handler).toBe('function');
    stopCrashReporting();
    handler(new ErrorEvent('error', { error: new Error('boom') }));
    await flushMicrotasks();

    expect(captured).toHaveLength(0);
    add.mockRestore();
  });

  it('does not throw when closing the client fails', () => {
    initCrashReporting();
    close.mockImplementationOnce(() => {
      throw new Error('close failed');
    });
    expect(() => stopCrashReporting()).not.toThrow();
  });

  it('removes the global handlers when crash reporting stops', () => {
    initCrashReporting();
    const remove = jest.spyOn(globalThis, 'removeEventListener');
    stopCrashReporting();
    const events = remove.mock.calls.map(call => call[0]);
    expect(events).toContain('error');
    expect(events).toContain('unhandledrejection');
    remove.mockRestore();
  });
});

describe('browser permission and reporting lifecycle', () => {
  it('sends nothing when browser permission is denied', async () => {
    denyBrowserPermission();
    initCrashReporting();
    captureCrash(new Error('boom'));
    await flushMicrotasks();
    expect(captured).toHaveLength(0);
  });

  it('sends nothing before the client exists', async () => {
    grantBrowserPermission();
    captureCrash(new Error('boom'));
    await flushMicrotasks();
    expect(captured).toHaveLength(0);
  });

  it('captures with browser permission even when usage sharing is off', async () => {
    grantBrowserPermission();
    initCrashReporting();
    captureCrash(new Error('boom'));
    await flushMicrotasks();
    expect(captured).toHaveLength(1);
    expect(capturedText()).toContain('boom');
    expect(isTelemetryEnabledAsync).not.toHaveBeenCalled();
  });

  it('discards a crash whose permission check resolves after reporting stops', async () => {
    let allowPermission = (_value: boolean) => {};
    jest.mocked(isCrashReportingEnabledAsync).mockReturnValue(
      new Promise<boolean>(resolve => {
        allowPermission = resolve;
      })
    );
    initCrashReporting();
    captureCrash(new Error('boom'));

    // Reporting stops while the browser permission check is still in flight.
    stopCrashReporting();
    allowPermission(true);
    await flushMicrotasks();

    expect(captured).toHaveLength(0);
  });

  it('does not resume an old pending report when reporting is enabled again', async () => {
    let allowPermission = (_value: boolean) => {};
    jest.mocked(isCrashReportingEnabledAsync).mockReturnValue(
      new Promise<boolean>(resolve => {
        allowPermission = resolve;
      })
    );
    initCrashReporting();
    captureCrash(new Error('old pending failure'));
    stopCrashReporting();
    initCrashReporting();
    allowPermission(true);
    await flushMicrotasks();
    expect(captured).toEqual([]);
  });

  it('closes the client so anything buffered is discarded when reporting stops', () => {
    initCrashReporting();
    stopCrashReporting();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('ignores a non-Error throwable rather than serializing an unknown shape', async () => {
    grantBrowserPermission();
    initCrashReporting();
    captureCrash({ secret: PHRASE_12 });
    captureCrash('a string');
    await flushMicrotasks();
    expect(captured).toHaveLength(0);
  });

  it('never throws when reading browser permission fails', async () => {
    grantBrowserPermission();
    jest.mocked(isCrashReportingEnabledAsync).mockRejectedValue(new Error('permissions unavailable'));
    initCrashReporting();
    expect(() => captureCrash(new Error('boom'))).not.toThrow();
    await flushMicrotasks();
    expect(captured).toHaveLength(0);
  });
});

describe('captureCrash scrubs before the event reaches Sentry', () => {
  beforeEach(() => {
    grantBrowserPermission();
    initCrashReporting();
  });

  it('keeps the error class when the message has to be dropped', async () => {
    class MidenAddressError extends Error {}
    const error = new MidenAddressError(`invalid mnemonic: ${PHRASE_12}`);
    error.name = 'MidenAddressError';
    captureCrash(error);
    await flushMicrotasks();

    expect(captured).toHaveLength(1);
    const text = capturedText();
    expect(text).not.toContain('avoid');
    expect(text).toContain('MidenAddressError');
  });

  it('redacts an address from the message', async () => {
    captureCrash(new Error(`cannot reach ${COMPOSITE_ADDRESS}`));
    await flushMicrotasks();
    expect(captured).toHaveLength(1);
    expect(capturedText()).not.toContain('qr7qqq9wr6w');
  });

  it('redacts a password from the message', async () => {
    captureCrash(new Error('unlock failed for password=hunter2correcthorse'));
    await flushMicrotasks();
    expect(captured).toHaveLength(1);
    expect(capturedText()).not.toContain('hunter2correcthorse');
  });

  it('never lets the original message survive in the stack header', async () => {
    const error = new Error(`private key ${PRIVATE_KEY_HEX}`);
    error.stack = `Error: private key ${PRIVATE_KEY_HEX}\n    at send (chrome-extension://abc/index.js:1:2)`;
    captureCrash(error);
    await flushMicrotasks();

    expect(captured).toHaveLength(1);
    const text = capturedText();
    expect(text).not.toContain('9f86d081');
    // The frame is the diagnostic value, and it must survive.
    expect(text).toContain('at send');
  });

  it('redacts an address smuggled into a stack frame path', async () => {
    const error = new Error('sync failed');
    error.stack = `Error: sync failed\n    at load (chrome-extension://abc/accounts/${ADDRESS}/index.js:1:2)`;
    captureCrash(error);
    await flushMicrotasks();

    expect(captured).toHaveLength(1);
    const text = capturedText();
    expect(text).not.toContain(ADDRESS);
    expect(text).toContain('at load');
  });

  it('drops the stack entirely when a frame carries seed material', async () => {
    const error = new Error('sync failed');
    error.stack = `Error: sync failed\n    at restore (file:///${PHRASE_12.split(' ').join('/')}/index.js:1:2)`;
    captureCrash(error);
    await flushMicrotasks();

    expect(captured).toHaveLength(1);
    expect(capturedText()).not.toContain('avoid');
  });

  it('handles a Firefox-style stack with no `at` prefix', async () => {
    const error = new Error(`boom ${ADDRESS}`);
    error.stack = `send@moz-extension://abc/index.js:1:2\nrun@moz-extension://abc/index.js:3:4`;
    captureCrash(error);
    await flushMicrotasks();

    expect(captured).toHaveLength(1);
    const text = capturedText();
    expect(text).not.toContain(ADDRESS);
    expect(text).toContain('send@moz-extension');
  });

  it('handles an error with no stack at all', async () => {
    const error = new Error('boom');
    error.stack = undefined;
    captureCrash(error);
    await flushMicrotasks();
    expect(captured).toHaveLength(1);
    expect(capturedText()).toContain('boom');
  });

  it('discards a multi-line stack header rather than scrubbing it', async () => {
    // A message containing a newline puts caller-written text above the first
    // frame. `credentials for hunter2correcthorse` matches no value pattern, so
    // scrubbing that header line would not save us — it has to be dropped.
    const error = new Error('boom');
    error.stack = [
      'Error: boom',
      'credentials for hunter2correcthorse',
      '    at send (chrome-extension://abc/index.js:1:2)'
    ].join('\n');
    captureCrash(error);
    await flushMicrotasks();

    expect(captured).toHaveLength(1);
    const text = capturedText();
    expect(text).not.toContain('hunter2correcthorse');
    expect(text).toContain('at send');
  });

  it('drops a stack whose lines are all header and no frames', async () => {
    const error = new Error(`boom ${PRIVATE_KEY_HEX}`);
    error.stack = `Error: boom ${PRIVATE_KEY_HEX}`;
    captureCrash(error);
    await flushMicrotasks();
    expect(captured).toHaveLength(1);
    expect(capturedText()).not.toContain('9f86d081');
  });

  it('scrubs a secret hidden in the error name', async () => {
    const error = new Error('boom');
    error.name = `Error${COMPOSITE_ADDRESS}`;
    captureCrash(error);
    await flushMicrotasks();
    expect(captured).toHaveLength(1);
    expect(capturedText()).not.toContain('qr7qqq9wr6w');
  });
});

describe('scrubEvent — the beforeSend hook', () => {
  it('drops the whole event when a recovery phrase appears anywhere in it', () => {
    expect(scrubEvent({ extra: { restore: { input: PHRASE_12 } } })).toBeNull();
    expect(scrubEvent({ breadcrumbs: [{ message: PHRASE_24 }] })).toBeNull();
  });

  it('drops the whole event when the phrase is base64-encoded', () => {
    const encoded = Buffer.from(PHRASE_12, 'utf8').toString('base64');
    expect(scrubEvent({ extra: { body: encoded } })).toBeNull();
  });

  it('drops the whole event when the phrase is in a wrapped-error cause chain', () => {
    // LinkedErrors materializes `error.cause` as extra exception values. This
    // is the path Task 8 missed: the outer error is innocuous, the inner is not.
    const event = {
      exception: {
        values: [
          { type: 'Error', value: 'import failed' },
          { type: 'Error', value: `caused by: ${PHRASE_12}` }
        ]
      }
    };
    expect(scrubEvent(event)).toBeNull();
  });

  it('scrubs secrets in a wrapped-error cause chain that is not seed material', () => {
    const event = {
      exception: {
        values: [
          { type: 'Error', value: 'import failed' },
          { type: 'Error', value: `caused by: send to ${COMPOSITE_ADDRESS}` }
        ]
      }
    };
    const scrubbed = scrubEvent(event);
    expect(scrubbed).not.toBeNull();
    const text = JSON.stringify(scrubbed);
    expect(text).not.toContain('qr7qqq9wr6w');
    expect(text).toContain('import failed');
  });

  it("keeps only the client scope's own trace id and scrubs anything else under the trace context", () => {
    const traceEvent = (traceId: string) => ({
      contexts: {
        trace: { trace_id: traceId, span_id: 'b'.repeat(16), parent_span_id: 'c'.repeat(16), note: PRIVATE_KEY_HEX }
      }
    });
    const allRedacted = { trace_id: REDACTED, span_id: REDACTED, parent_span_id: REDACTED, note: REDACTED };
    expect(scrubEvent(traceEvent('a'.repeat(32)))?.contexts.trace).toEqual(allRedacted);
    initCrashReporting();
    expect(scrubEvent(traceEvent('a'.repeat(32)))?.contexts.trace).toEqual({
      ...allRedacted,
      trace_id: 'a'.repeat(32)
    });
    expect(scrubEvent(traceEvent('d'.repeat(32)))?.contexts.trace).toEqual(allRedacted);
    const forged = scrubEvent({
      contexts: { trace: { trace_id: `${PRIVATE_KEY_HEX} ${COMPOSITE_ADDRESS}`, span_id: PRIVATE_KEY_HEX } }
    });
    expect(JSON.stringify(forged)).not.toContain('9f86d081');
    expect(JSON.stringify(forged)).not.toContain('qr7qqq9wr6w');
  });

  it('scrubs secrets nested deep in extra, contexts, and breadcrumbs', () => {
    const event = {
      extra: { request: { body: { password: 'hunter2' } } },
      contexts: { wallet: { balance: 4200000000, activeAccount: COMPOSITE_ADDRESS } },
      breadcrumbs: [{ message: `GET https://rpc.io/v1?apiKey=sk_live_998877`, data: { note: PRIVATE_KEY_HEX } }]
    };
    const scrubbed = scrubEvent(event);
    expect(scrubbed).not.toBeNull();
    const text = JSON.stringify(scrubbed);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('4200000000');
    expect(text).not.toContain('qr7qqq9wr6w');
    expect(text).not.toContain('sk_live_998877');
    expect(text).not.toContain('9f86d081');
  });

  it('scrubs request data and URLs', () => {
    const event = {
      request: {
        url: `https://rpc.testnet.miden.io/v1/notes?account=${ADDRESS}`,
        headers: { Authorization: 'Bearer abcdef.ghijkl.mnopqr' }
      }
    };
    const text = JSON.stringify(scrubEvent(event));
    expect(text).not.toContain(ADDRESS);
    expect(text).not.toContain('abcdef.ghijkl.mnopqr');
  });

  it('keeps an ordinary event intact and routable', () => {
    const event = {
      event_id: '0123456789abcdef0123456789abcdef',
      release: '1.15.21',
      exception: { values: [{ type: 'TypeError', value: 'rpc endpoint returned status' }] }
    };
    const scrubbed = scrubEvent(event);
    expect(scrubbed).not.toBeNull();
    expect(JSON.stringify(scrubbed)).toContain('0123456789abcdef0123456789abcdef');
    expect(JSON.stringify(scrubbed)).toContain('rpc endpoint returned status');
    expect(JSON.stringify(scrubbed)).toContain('TypeError');
  });

  it('returns the same event object so Sentry keeps its identity', () => {
    const event = { exception: { values: [{ type: 'Error', value: 'ok' }] } };
    expect(scrubEvent(event)).toBe(event);
  });

  it('is the function the client was given, so the hook cannot come loose', () => {
    initCrashReporting();
    const beforeSend = clientOptions[0]?.beforeSend;
    expect(beforeSend).toBeDefined();
    expect(beforeSend?.({ extra: { seed: PHRASE_12 } })).toBeNull();
    expect(JSON.stringify(beforeSend?.({ extra: { a: ADDRESS } }))).not.toContain(ADDRESS);
  });

  it('never returns the marker in place of a whole clean event', () => {
    const event = { extra: { note: 'sync finished' } };
    expect(JSON.stringify(scrubEvent(event))).not.toContain(REDACTED);
  });
});

describe('diagnostic snapshots', () => {
  it('snapshotsBeforePermissionAndDoesNotReuseNativeTags', async () => {
    let allowPermission = (_value: boolean) => {};
    jest.mocked(isCrashReportingEnabledAsync).mockReturnValueOnce(
      new Promise<boolean>(resolve => {
        allowPermission = resolve;
      })
    );
    initCrashReporting();
    const error = new Error('native failure');
    const nativeGroup = {
      reownNativeOrigin: 'wallet_error',
      reownWalletResponseCode: 'internal_error',
      reownRequestAge: '120_to_300s',
      reownPublished: 'confirmed',
      reownBackgrounded: 'yes'
    };
    annotateCrash(error, nativeGroup);
    captureCrash(error);
    annotateCrash(error, {
      reownNativeOrigin: 'publish_error',
      reownRequestAge: 'under_30s',
      reownPublished: 'unobserved'
    });
    allowPermission(true);
    await flushMicrotasks();
    expect(captured).toHaveLength(1);
    const firstEvent = { tags: { kept: 'yes' }, extra: { arbitrary: 'private' } };
    expect(scrubEvent(firstEvent, { originalException: captured[0] })).toBe(firstEvent);
    expect(firstEvent.extra).toEqual({ walletDiagnostics: expect.objectContaining(nativeGroup) });
    expect(firstEvent.tags).toEqual({
      kept: 'yes',
      network: 'testnet',
      reown_native_origin: 'wallet_error',
      reown_wallet_response_code: 'internal_error',
      reown_request_age: '120_to_300s',
      reown_published: 'confirmed',
      reown_backgrounded: 'yes'
    });
    grantBrowserPermission();
    captureCrash(new Error('unrelated failure'));
    await flushMicrotasks();
    expect(captured).toHaveLength(2);
    const secondEvent = {
      tags: {
        reown_native_origin: 'wallet_error',
        reown_wallet_response_code: 'internal_error',
        reown_request_age: 'under_30s',
        reown_published: 'confirmed',
        reown_backgrounded: 'no'
      },
      extra: { walletDiagnostics: {} }
    };
    scrubEvent(secondEvent, { originalException: captured[1] });
    for (const [field, tag] of [
      ['reownNativeOrigin', 'reown_native_origin'],
      ['reownWalletResponseCode', 'reown_wallet_response_code'],
      ['reownRequestAge', 'reown_request_age'],
      ['reownPublished', 'reown_published'],
      ['reownBackgrounded', 'reown_backgrounded']
    ]) {
      expect(secondEvent.tags).not.toHaveProperty(tag!);
      expect(secondEvent.extra.walletDiagnostics).not.toHaveProperty(field!);
    }
  });

  it('restoresOnlyThePresentValidatedNativeTags', async () => {
    grantBrowserPermission();
    initCrashReporting();
    const error = new Error('publisher failed');
    annotateCrash(error, {
      reownNativeOrigin: 'publish_error',
      reownWalletResponseCode: 'internal_error',
      reownRequestAge: 'unknown',
      reownPublished: 'unobserved',
      reownBackgrounded: 'unavailable'
    });
    captureCrash(error);
    await flushMicrotasks();
    const event = { tags: { reown_wallet_response_code: 'internal_error', reown_backgrounded: 'yes' }, extra: {} };
    scrubEvent(event, { originalException: captured[0] });
    expect(event.tags).toEqual({
      network: 'testnet',
      reown_native_origin: 'publish_error',
      reown_request_age: 'unknown',
      reown_published: 'unobserved'
    });
    expect(event.extra).toEqual({
      walletDiagnostics: expect.objectContaining({
        reownNativeOrigin: 'publish_error',
        reownRequestAge: 'unknown',
        reownPublished: 'unobserved'
      })
    });
    expect(event.extra).not.toHaveProperty('walletDiagnostics.reownWalletResponseCode');
    expect(event.extra).not.toHaveProperty('walletDiagnostics.reownBackgrounded');
  });

  it('snapshots storage and live page visibility before permission resolves', async () => {
    let allowPermission = (_value: boolean) => {};
    jest.mocked(isCrashReportingEnabledAsync).mockReturnValueOnce(
      new Promise<boolean>(resolve => {
        allowPermission = resolve;
      })
    );
    initCrashReporting();
    const descriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    try {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      const error = Object.assign(new Error('cursor failed'), {
        pageVisibility: 'visible',
        storageDiagnostics: { pageVisibility: 'visible' }
      });
      annotateCrash(error, {
        storageOwner: 'wallet_transactions',
        storageOperation: 'cursor',
        pageVisibility: 'visible'
      });
      captureCrash(error);
      expect(captured).toHaveLength(0);
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      annotateCrash(error, { storageOwner: 'wallet_limits', storageOperation: 'get', pageVisibility: 'unknown' });
      captureCrash(new Error('later failure'));
      allowPermission(true);
      await flushMicrotasks();
      expect(captured).toHaveLength(2);
      const reportable = captured.find(error => error instanceof Error && error.message === 'cursor failed');
      expect(reportable).toBeInstanceOf(Error);
      const event: Record<string, unknown> = {
        extra: { walletDiagnostics: { pageVisibility: 'visible' } }
      };
      scrubEvent(event, { originalException: reportable });
      const extra = event.extra;
      if (typeof extra !== 'object' || extra === null || !('walletDiagnostics' in extra))
        throw new Error('missing diagnostics');
      expect(extra.walletDiagnostics).toMatchObject({
        storageOwner: 'wallet_transactions',
        storageOperation: 'cursor',
        pageVisibility: 'hidden'
      });
      const later: Record<string, unknown> = {};
      scrubEvent(later, {
        originalException: captured.find(error => error instanceof Error && error.message === 'later failure')
      });
      expect(later.tags).toEqual({ network: 'testnet' });
      expect(later.tags).not.toHaveProperty('page_visibility');
    } finally {
      if (descriptor) Object.defineProperty(document, 'visibilityState', descriptor);
      else Reflect.deleteProperty(document, 'visibilityState');
    }
  });

  it('restores closed storage fields as per-event extra and tags', async () => {
    initCrashReporting();
    const descriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    try {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      jest.mocked(getEffectiveNetworkName).mockReturnValueOnce(MIDEN_NETWORK_NAME.MAINNET);
      const error = new Error('cursor failed');
      annotateCrash(error, { storageOwner: 'wallet_transactions', storageOperation: 'cursor' });
      captureCrash(error);
      await flushMicrotasks();
      const event: Record<string, unknown> = {
        tags: { kept: 'yes' },
        extra: { arbitrary: ADDRESS, walletDiagnostics: { pageVisibility: 'visible' } },
        exception: { values: [{ type: 'Error' }] }
      };
      const beforeSend = clientOptions[0]?.beforeSend;
      expect(beforeSend).toBe(scrubEvent);
      expect(beforeSend?.(event, { originalException: captured[0] })).toBe(event);
      expect(event.tags).toEqual({
        kept: 'yes',
        network: 'mainnet',
        storage_owner: 'wallet_transactions',
        storage_operation: 'cursor'
      });
      expect(event.tags).not.toHaveProperty('page_visibility');
      expect(event.extra).toEqual({
        walletDiagnostics: expect.objectContaining({
          storageOwner: 'wallet_transactions',
          storageOperation: 'cursor',
          pageVisibility: 'hidden'
        })
      });
      expect(JSON.stringify(event)).not.toContain(ADDRESS);
    } finally {
      if (descriptor) Object.defineProperty(document, 'visibilityState', descriptor);
      else Reflect.deleteProperty(document, 'visibilityState');
    }
  });

  it('keeps stackless global rejections unhandled with storage metadata', async () => {
    initCrashReporting();
    const error = new Error('cursor failed');
    error.name = 'UnknownError';
    error.stack = undefined;
    annotateCrash(error, { storageOwner: 'wallet_transactions', storageOperation: 'cursor' });
    globalThis.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: error }));
    await flushMicrotasks();
    expect(captured).toHaveLength(1);
    expect(capturedHints).toEqual([
      expect.objectContaining({ mechanism: { type: 'onunhandledrejection', handled: false } })
    ]);
    const reportable = captured[0];
    if (!(reportable instanceof Error)) throw new Error('missing error');
    expect(serializeError(reportable)).toEqual({
      name: 'UnknownError',
      message: 'cursor failed',
      stack: 'UnknownError: cursor failed'
    });
    const event: Record<string, unknown> = {};
    clientOptions[0]?.beforeSend?.(event, { originalException: reportable });
    expect(event.tags).toEqual({
      network: 'testnet',
      storage_owner: 'wallet_transactions',
      storage_operation: 'cursor'
    });
    expect(event.tags).not.toHaveProperty('page_visibility');
    expect(event.extra).toEqual({
      walletDiagnostics: expect.objectContaining({ storageOwner: 'wallet_transactions', storageOperation: 'cursor' })
    });
  });

  it('does not inherit storage metadata or change grouping', async () => {
    initCrashReporting();
    const descriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    try {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      const error = new Error('cursor failed');
      error.name = 'UnknownError';
      error.stack = 'UnknownError: cursor failed\n    at scan (capacitor://localhost/mobile.js:1:5000)';
      captureCrash(error, 'onunhandledrejection', { level: 'warning' });
      annotateCrash(error, { storageOwner: 'wallet_transactions', storageOperation: 'cursor' });
      captureCrash(error, 'onunhandledrejection', { level: 'warning' });
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      captureCrash(new Error('unrelated failure'));
      await flushMicrotasks();
      expect(captured).toHaveLength(3);
      const [plain, annotated, unrelated] = captured;
      if (!(plain instanceof Error) || !(annotated instanceof Error) || !(unrelated instanceof Error))
        throw new Error('missing errors');
      expect(serializeError(annotated)).toEqual(serializeError(plain));
      expect(capturedHints[1]).toEqual(capturedHints[0]);
      expect(capturedHints[1]).toEqual({
        mechanism: { type: 'onunhandledrejection', handled: false },
        captureContext: { level: 'warning' }
      });
      const events = [plain, annotated, unrelated].map(reportable => {
        const event: Record<string, unknown> = {
          message: reportable.message,
          exception: { values: [{ type: reportable.name, value: reportable.message }] }
        };
        clientOptions[0]?.beforeSend?.(event, { originalException: reportable });
        return event;
      });
      expect(events[1]).toMatchObject({ message: events[0]?.message, exception: events[0]?.exception });
      expect(events.map(event => event.fingerprint)).toEqual([undefined, undefined, undefined]);
      expect(events[1]?.tags).toEqual({
        network: 'testnet',
        storage_owner: 'wallet_transactions',
        storage_operation: 'cursor'
      });
      expect(events[1]?.tags).not.toHaveProperty('page_visibility');
      expect(events[2]?.tags).toEqual({ network: 'testnet' });
      expect(events[2]?.tags).not.toHaveProperty('page_visibility');
      expect(events[2]?.extra).toEqual({
        walletDiagnostics: expect.objectContaining({ pageVisibility: 'visible' })
      });
      expect(JSON.stringify(events[2])).not.toMatch(/storageOwner|storageOperation|wallet_transactions|cursor/);
      expect(unrelated.message).toBe('unrelated failure');
      expect(setTag).not.toHaveBeenCalled();
      expect(setTags).not.toHaveBeenCalled();
    } finally {
      if (descriptor) Object.defineProperty(document, 'visibilityState', descriptor);
      else Reflect.deleteProperty(document, 'visibilityState');
    }
  });

  it('captures scrubbed bounded cause chains synchronously before browser permission resolves', async () => {
    let allowPermission = (_value: boolean) => {};
    jest.mocked(isCrashReportingEnabledAsync).mockReturnValue(
      new Promise<boolean>(resolve => {
        allowPermission = resolve;
      })
    );
    initCrashReporting();
    const cause = new Error(`network failed for ${ADDRESS}`);
    const error = new Error('initialize failed', { cause });
    annotateCrash(error, { operation: 'sdk_initialize', stage: 'client_create', workerMode: 'disabled' });
    captureCrash(error);
    error.message = 'changed after capture';
    cause.message = 'changed cause';
    annotateCrash(error, { stage: 'mock_create' });
    allowPermission(true);
    await flushMicrotasks();
    const reportable = captured[0];
    expect(reportable).toBeInstanceOf(Error);
    if (!(reportable instanceof Error)) throw new Error('missing error');
    expect(reportable.message).toBe('initialize failed');
    expect(reportable.cause).toBeInstanceOf(Error);
    if (!(reportable.cause instanceof Error)) throw new Error('missing cause');
    expect(reportable.cause.message).toContain('network failed');
    expect(reportable.cause.message).not.toContain(ADDRESS);
    const event = { extra: { arbitrary: ADDRESS }, exception: { values: [{ type: 'Error' }] } };
    scrubEvent(event, { originalException: reportable });
    expect(event.extra).toEqual({
      walletDiagnostics: expect.objectContaining({
        operation: 'sdk_initialize',
        stage: 'client_create',
        workerMode: 'disabled',
        appVersion: packageJson.version
      })
    });
  });

  it('names the network the crash happened on, in the diagnostics and as a tag beside any other', async () => {
    grantBrowserPermission();
    initCrashReporting();
    // Only the capture sees mainnet: the report is sent after a switch back, and still says where it happened.
    jest.mocked(getEffectiveNetworkName).mockReturnValueOnce(MIDEN_NETWORK_NAME.MAINNET);
    captureCrash(new Error('sync failed'));
    await flushMicrotasks();
    const event: Record<string, unknown> = { tags: { kept: 'yes' }, exception: { values: [{ type: 'Error' }] } };
    scrubEvent(event, { originalException: captured[0] });
    expect(event.extra).toEqual({ walletDiagnostics: expect.objectContaining({ network: 'mainnet' }) });
    expect(event.tags).toEqual({ kept: 'yes', network: 'mainnet' });
    expect(event.tags).not.toHaveProperty('page_visibility');
  });

  it('reads each raw error field only once before asynchronous browser permission', async () => {
    grantBrowserPermission();
    initCrashReporting();
    const { error, reads } = countingFieldReads('body');
    captureCrash(error);
    await flushMicrotasks();
    expect(reads).toEqual({ name: 1, message: 1, stack: 1 });
  });

  describe('reads each raw field of a relay failure only once, whether or not it is reported', () => {
    const RELAY_FAILURE = 'WebSocket connection failed for host: wss://relay.walletconnect.org';

    beforeEach(() => {
      __resetRelayDiagnosticsForTest();
      grantBrowserPermission();
      initCrashReporting();
    });

    it('when it is reported', async () => {
      const { error, reads } = countingFieldReads(RELAY_FAILURE);
      captureCrash(error);
      await flushMicrotasks();
      expect(captured).toHaveLength(1);
      expect(reads).toEqual({ name: 1, message: 1, stack: 1 });
    });

    it('when the same Error is captured again, and counts it once', async () => {
      const { error, reads } = countingFieldReads(RELAY_FAILURE);
      captureCrash(error);
      await flushMicrotasks();
      Object.assign(reads, { name: 0, message: 0, stack: 0 });
      captureCrash(error);
      await flushMicrotasks();
      expect(captured).toHaveLength(1);
      expect(reads).toEqual({ name: 1, message: 1, stack: 1 });
    });

    it('when a new Error falls in a range already reported', async () => {
      captureCrash(new Error(RELAY_FAILURE));
      await flushMicrotasks();
      captureCrash(new Error(RELAY_FAILURE));
      await flushMicrotasks();
      const { error, reads } = countingFieldReads(RELAY_FAILURE);
      captureCrash(error);
      await flushMicrotasks();
      expect(captured).toHaveLength(2);
      expect(reads).toEqual({ name: 1, message: 1, stack: 1 });
    });

    it('when it is classified while offline', async () => {
      const { error, reads } = countingFieldReads(RELAY_FAILURE);
      const offline = jest.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      captureCrash(error);
      offline.mockRestore();
      await flushMicrotasks();
      expect(captured).toHaveLength(0);
      expect(reads).toEqual({ name: 1, message: 1, stack: 1 });
    });
  });

  it('replaces SDK-created frames with the trusted empty frame snapshot', async () => {
    grantBrowserPermission();
    initCrashReporting();
    jest.requireMock<{ defaultStackParser: jest.Mock }>('@sentry/browser').defaultStackParser.mockReturnValueOnce([]);
    const failure = new Error('message\n    at injected (https://unknown.example/path:7:777)');
    failure.stack = undefined;
    captureCrash(failure);
    await flushMicrotasks();
    const event = {
      exception: {
        values: [{ stacktrace: { frames: [{ filename: 'https://unknown.example/path', lineno: 7, colno: 777 }] } }]
      }
    };
    scrubEvent(event, { originalException: captured[0] });
    expect(event.exception.values[0]?.stacktrace.frames).toEqual([]);
  });

  it('bounds causes to three links and terminates cyclic chains', async () => {
    grantBrowserPermission();
    initCrashReporting();
    const fifth = new Error('fifth');
    const fourth = new Error('fourth', { cause: fifth });
    const third = new Error('third', { cause: fourth });
    const second = new Error('second', { cause: third });
    const first = new Error('first', { cause: second });
    captureCrash(first);
    Object.defineProperty(second, 'cause', { value: first });
    captureCrash(second);
    await flushMicrotasks();
    let next: unknown = captured[0];
    const names: string[] = [];
    while (next instanceof Error) {
      names.push(next.message);
      next = next.cause;
    }
    expect(names).toEqual(['first', 'second', 'third', 'fourth']);
    next = captured[1];
    const cyclic: string[] = [];
    while (next instanceof Error) {
      cyclic.push(next.message);
      next = next.cause;
    }
    expect(cyclic).toEqual(['second', 'first']);
  });

  it('classifies uncaught errors and rejections accurately without global metadata', async () => {
    grantBrowserPermission();
    initCrashReporting();
    globalThis.dispatchEvent(new ErrorEvent('error', { error: new Error('uncaught') }));
    globalThis.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('rejected') }));
    captureCrash(new Error('manual'));
    await flushMicrotasks();
    expect(capturedHints).toEqual([
      expect.objectContaining({ mechanism: { type: 'onerror', handled: false } }),
      expect.objectContaining({ mechanism: { type: 'onunhandledrejection', handled: false } }),
      expect.objectContaining({ mechanism: { type: 'generic', handled: true } })
    ]);
  });
});

it('restores only root producer evidence after SDK and native-style enrichment before serialization', async () => {
  initCrashReporting();
  const error = new Error('failed to get input note: ' + ADDRESS);
  observeProposalCreateRejection(error);
  annotateCrash(error, { proposalStep: 'proposal_create' });
  reportTransactionFailure({ type: 'consume', stage: 'creating-proposal', error });
  await flushMicrotasks();
  expect(captured).toHaveLength(1);
  const reportable = captured[0];
  const event: Record<string, unknown> = {
    extra: {
      walletDiagnostics: {
        proposalCreateApi: 'consume_notes',
        proposalCreateFamily: 'private-canary',
        guardianProvingSubstep: 'private-canary',
        offscreenDeadlineMethod: ADDRESS,
        reapStartRelation: ADDRESS
      },
      account: ADDRESS
    }
  };
  scrubEvent(event, { originalException: reportable });
  expect(event.extra).toEqual({
    walletDiagnostics: expect.objectContaining({
      proposalCreateApi: 'consume_notes',
      proposalCreateFamily: 'sdk_input_note_read'
    })
  });
  event.extra = {
    walletDiagnostics: { proposalCreateFamily: 'sdk_account_read', raw: ADDRESS },
    nativePrivate: ADDRESS
  };
  scrubEvent(event, { originalException: reportable });
  const wire = JSON.stringify(event);
  expect(wire).toContain('sdk_input_note_read');
  expect(wire).not.toContain('sdk_account_read');
  expect(wire).not.toContain('private-canary');
  expect(wire).not.toContain(ADDRESS);
  expect(wire).not.toContain('guardianProvingSubstep');
  expect(wire).not.toContain('offscreenDeadlineMethod');
  expect(wire).not.toContain('reapStartRelation');
});

it('retains the current UI producer root through both final scrubs without enrichment injection', async () => {
  _resetUserVisibleErrorLimitsForTest();
  initCrashReporting();
  Reflect.apply(reportUserVisibleError, undefined, [
    'submissionUnanswered',
    'status_screen',
    {
      kind: 'submission_feedback',
      submissionFeedbackBranch: 'guardian_unanswered'
    }
  ]);
  await flushMicrotasks();
  expect(captured).toHaveLength(1);
  const originalException = captured[0];
  const event: Record<string, unknown> = {
    extra: {
      walletDiagnostics: { submissionFeedbackBranch: 'private-canary', recipientValidationStage: 'decoder_throw' },
      raw: ADDRESS
    }
  };
  scrubEvent(event, { originalException });
  expect(event.extra).toEqual({
    walletDiagnostics: expect.objectContaining({ submissionFeedbackBranch: 'guardian_unanswered' })
  });
  event.extra = { walletDiagnostics: { submissionFeedbackBranch: 'grpc_unknown', raw: ADDRESS } };
  scrubEvent(event, { originalException });
  const wire = JSON.stringify(event);
  expect(wire).toContain('guardian_unanswered');
  expect(wire).not.toContain('grpc_unknown');
  expect(wire).not.toContain('recipientValidationStage');
  expect(wire).not.toContain(ADDRESS);
});

it.each(['off', 'not-configured', 'not-deployed', 'service-down'] as const)(
  'emits the actual displayed feature reason %s through the final wire',
  async reason => {
    jest.useFakeTimers();
    try {
      _resetUserVisibleErrorLimitsForTest();
      initCrashReporting();
      const { FeatureUnavailableNotice } = await import('components/FeatureUnavailable');
      const component = FeatureUnavailableNotice as React.ComponentType<{
        availability: { state: 'unavailable'; reason: typeof reason; detail: string };
        feature: string;
      }>;
      render(
        React.createElement(component, {
          availability: { state: 'unavailable', reason, detail: ADDRESS },
          feature: 'earnDeposit'
        })
      );
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1000);
      });
      expect(captured).toHaveLength(1);
      const event: Record<string, unknown> = { extra: { private: ADDRESS } };
      scrubEvent(event, { originalException: captured[0] });
      expect(event.extra).toEqual({
        walletDiagnostics: expect.objectContaining({
          featureUnavailableFeature: 'earnDeposit',
          featureUnavailableReason: reason
        })
      });
      expect(JSON.stringify(event)).not.toContain(ADDRESS);
    } finally {
      cleanup();
      jest.useRealTimers();
    }
  }
);
