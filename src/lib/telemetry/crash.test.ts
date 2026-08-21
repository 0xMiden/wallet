import { isTelemetryEnabledAsync } from 'lib/settings/helpers';

import {
  CRASH_INTEGRATION_ALLOWLIST,
  captureCrash,
  initCrashReporting,
  scrubEvent,
  selectIntegrations,
  stopCrashReporting
} from './crash';
import { REDACTED } from './redact';

jest.mock('lib/settings/helpers', () => ({ isTelemetryEnabledAsync: jest.fn() }));

interface ClientOptions {
  dsn?: string;
  beforeSend?: (event: unknown) => unknown;
  integrations?: { name: string }[];
  sendDefaultPii?: boolean;
  release?: string;
  transport?: unknown;
  stackParser?: unknown;
}

const clientOptions: ClientOptions[] = [];
const captured: unknown[] = [];
const close = jest.fn();
const setClient = jest.fn();
let constructorThrows = false;

jest.mock('@sentry/browser', () => ({
  BrowserClient: jest.fn((options: ClientOptions) => {
    if (constructorThrows) throw new Error('client unavailable');
    clientOptions.push(options);
    return { init: jest.fn(), close };
  }),
  Scope: jest.fn(() => ({ setClient, captureException: (error: unknown) => captured.push(error) })),
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

const consentOn = () => jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(true);
const consentOff = () => jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(false);

beforeEach(() => {
  process.env.SENTRY_DSN = 'https://publickey@o0.ingest.de.sentry.io/1';
  clientOptions.length = 0;
  captured.length = 0;
  constructorThrows = false;
});

afterEach(() => {
  stopCrashReporting();
  jest.clearAllMocks();
});

describe('integration selection', () => {
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
    consentOn();
    initCrashReporting();
    globalThis.dispatchEvent(new ErrorEvent('error', { error: new Error(`boom ${ADDRESS}`) }));
    await flushMicrotasks();

    expect(captured).toHaveLength(1);
    expect(capturedText()).not.toContain(ADDRESS);
  });

  it('reports an unhandled rejection through the handler it registered', async () => {
    consentOn();
    initCrashReporting();
    globalThis.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error(`boom ${ADDRESS}`) }));
    await flushMicrotasks();

    expect(captured).toHaveLength(1);
    expect(capturedText()).not.toContain(ADDRESS);
  });

  it('stops reporting global errors once crash reporting stops', async () => {
    consentOn();
    initCrashReporting();
    stopCrashReporting();
    globalThis.dispatchEvent(new ErrorEvent('error', { error: new Error('boom') }));
    await flushMicrotasks();

    expect(captured).toHaveLength(0);
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

describe('consent', () => {
  it('sends nothing when consent is off', async () => {
    consentOff();
    initCrashReporting();
    captureCrash(new Error('boom'));
    await flushMicrotasks();
    expect(captured).toHaveLength(0);
  });

  it('sends nothing before the client exists', async () => {
    consentOn();
    captureCrash(new Error('boom'));
    await flushMicrotasks();
    expect(captured).toHaveLength(0);
  });

  it('captures when consent is on', async () => {
    consentOn();
    initCrashReporting();
    captureCrash(new Error('boom'));
    await flushMicrotasks();
    expect(captured).toHaveLength(1);
    expect(capturedText()).toContain('boom');
  });

  it('discards a crash whose consent check resolves after consent is withdrawn', async () => {
    let allowConsent = (_value: boolean) => {};
    jest.mocked(isTelemetryEnabledAsync).mockReturnValue(
      new Promise<boolean>(resolve => {
        allowConsent = resolve;
      })
    );
    initCrashReporting();
    captureCrash(new Error('boom'));

    // Consent is withdrawn while the check is still in flight.
    stopCrashReporting();
    allowConsent(true);
    await flushMicrotasks();

    expect(captured).toHaveLength(0);
  });

  it('closes the client so anything buffered is discarded on withdrawal', () => {
    initCrashReporting();
    stopCrashReporting();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('ignores a non-Error throwable rather than serializing an unknown shape', async () => {
    consentOn();
    initCrashReporting();
    captureCrash({ secret: PHRASE_12 });
    captureCrash('a string');
    await flushMicrotasks();
    expect(captured).toHaveLength(0);
  });

  it('never throws when the scope rejects the capture', async () => {
    consentOn();
    jest.mocked(isTelemetryEnabledAsync).mockRejectedValue(new Error('storage gone'));
    initCrashReporting();
    expect(() => captureCrash(new Error('boom'))).not.toThrow();
    await flushMicrotasks();
    expect(captured).toHaveLength(0);
  });
});

describe('captureCrash scrubs before the event reaches Sentry', () => {
  beforeEach(() => {
    consentOn();
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
