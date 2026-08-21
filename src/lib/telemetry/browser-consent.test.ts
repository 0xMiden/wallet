import { readFileSync } from 'fs';
import { resolve } from 'path';

import { isExtension } from 'lib/platform';
import { TELEMETRY_STORAGE_KEY } from 'lib/settings/constants';
import { isTelemetryEnabledAsync } from 'lib/settings/helpers';

import { captureCrash, initCrashReporting, stopCrashReporting } from './crash';
import { __setTransportForTest, dropQueue, sendEvent } from './sink';
import { TelemetryWirePayload } from './types';

/**
 * Firefox's browser-level data-collection consent, ANDed with the wallet's own
 * setting.
 *
 * Firefox 140+ asks the user — at install time, and again in `about:addons` →
 * Permissions and data — whether the extension may collect
 * `technicalAndInteraction` data. That is a second consent sitting beside
 * "Share usage data", and two consents that can disagree is a defect: a user
 * who declines at the Firefox prompt and then turns the wallet setting on must
 * not be collected from.
 *
 * The hard part is not the AND, it is telling **"this browser has no such
 * concept"** apart from **"this browser said no"**, because getting it backwards
 * fails silently in one of two directions:
 *
 * - Read an absent mechanism as a refusal, and telemetry dies everywhere —
 *   Chrome, iOS and Android included — with no error and no failing test.
 * - Read a refusal as an absent mechanism, and we collect from a user who
 *   explicitly declined, which is the whole thing this exists to prevent.
 *
 * So the matrix below is the point of this file, and every row is driven
 * against the REAL settings module and the REAL sink rather than a stubbed
 * consent gate. `egress-boundary.test.ts` substitutes `isTelemetryEnabledAsync`
 * wholesale to drive both sides of it, which is the right call there and would
 * make this file prove nothing.
 */

const mockKvStore: Record<string, unknown> = {};
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) => {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (k in mockKvStore) out[k] = mockKvStore[k];
      return out;
    },
    set: async (obj: Record<string, unknown>) => {
      Object.assign(mockKvStore, obj);
    }
  })
}));

// Partially, never wholesale: a wholesale mock strips `isIOS` / `isAndroid`,
// which `./context` calls to resolve `platform` on every event.
jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isExtension: jest.fn()
}));

const mockGetAll = jest.fn();
jest.mock('webextension-polyfill', () => ({
  __esModule: true,
  default: {
    permissions: {
      getAll: (...args: unknown[]) => mockGetAll(...args)
    }
  }
}));

const mockIsExtension = jest.mocked(isExtension);

/**
 * The one string tying the gate to the manifests. `firefoxAnswers` below grants
 * exactly this, so changing the gate's own constant reddens the whole matrix,
 * and the manifest test reddens if either manifest stops declaring it.
 */
const CHECKED_PERMISSION = 'technicalAndInteraction';

const CONTEXT = { appVersion: '1.15.22', platform: 'extension' } as const;
const STARTED = { phase: 'started', flow: 'send', flowId: 'browser-consent' } as const;

let sent: TelemetryWirePayload[] = [];

/** The wallet's own setting, written straight to the store the background reads. */
const walletSetting = (enabled: boolean): void => {
  mockKvStore[TELEMETRY_STORAGE_KEY] = enabled;
};

/** Firefox, with the user's answer to the browser-level prompt. */
const firefoxAnswers = (granted: boolean): void => {
  mockIsExtension.mockReturnValue(true);
  mockGetAll.mockResolvedValue({
    permissions: ['storage'],
    origins: ['<all_urls>'],
    // Present-and-empty is a refusal. Present-and-containing is a grant.
    data_collection: granted ? [CHECKED_PERMISSION] : []
  });
};

/**
 * Chrome, or any Firefox below 140: the `permissions` API exists and answers,
 * but has no `data_collection` key at all. This is the absence case, and it is
 * the one that must NOT read as a refusal.
 */
const browserHasNoDataCollectionConcept = (): void => {
  mockIsExtension.mockReturnValue(true);
  mockGetAll.mockResolvedValue({ permissions: ['storage'], origins: ['<all_urls>'] });
};

beforeEach(() => {
  for (const k of Object.keys(mockKvStore)) delete mockKvStore[k];
  mockGetAll.mockReset();
  mockIsExtension.mockReset();
  mockIsExtension.mockReturnValue(false);
  sent = [];
  __setTransportForTest(async payload => {
    sent.push(payload);
  });
});

afterEach(() => {
  __setTransportForTest(null);
  dropQueue();
});

// ---------------------------------------------------------------------------
// The consent matrix, asserted at the egress point.
// ---------------------------------------------------------------------------

describe('the consent matrix, at the product-event egress point', () => {
  it('sends when the browser allows and the wallet setting is on', async () => {
    // Positive control, and deliberately first: every "sends nothing" case
    // below is only meaningful because this one proves the driver can send at
    // all. Without it they would all pass against a broken harness.
    walletSetting(true);
    firefoxAnswers(true);

    await sendEvent(STARTED, CONTEXT);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.flow).toBe('send');
  });

  it('sends nothing when the browser denies, even though the wallet setting is on', async () => {
    walletSetting(true);
    firefoxAnswers(false);

    await sendEvent(STARTED, CONTEXT);

    expect(sent).toEqual([]);
    // The browser was actually consulted — otherwise this passes for the wrong
    // reason, namely a gate that never ran.
    expect(mockGetAll).toHaveBeenCalled();
  });

  it('sends nothing when the browser allows but the wallet setting is off', async () => {
    walletSetting(false);
    firefoxAnswers(true);

    await sendEvent(STARTED, CONTEXT);

    expect(sent).toEqual([]);
  });

  it('sends nothing when neither says yes', async () => {
    walletSetting(false);
    firefoxAnswers(false);

    await sendEvent(STARTED, CONTEXT);

    expect(sent).toEqual([]);
  });

  it('sends nothing when reading the permission throws', async () => {
    // Fail closed. An error reading a permission is an unknown state, and an
    // unknown state must never resolve to "granted".
    walletSetting(true);
    mockIsExtension.mockReturnValue(true);
    mockGetAll.mockRejectedValue(new Error('permissions API unavailable'));

    await sendEvent(STARTED, CONTEXT);

    expect(sent).toEqual([]);
  });

  it('sends nothing when the permissions API is missing entirely inside an extension', async () => {
    walletSetting(true);
    mockIsExtension.mockReturnValue(true);
    mockGetAll.mockImplementation(() => {
      throw new TypeError('getAll is not a function');
    });

    await sendEvent(STARTED, CONTEXT);

    expect(sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Absence is not refusal. This is the half that breaks Chrome if it is wrong.
// ---------------------------------------------------------------------------

describe('a browser with no data-collection consent mechanism', () => {
  it('still sends on Chrome, where the concept does not exist', async () => {
    walletSetting(true);
    browserHasNoDataCollectionConcept();

    await sendEvent(STARTED, CONTEXT);

    // The distinguishing fact: `getAll()` answered, and its answer carried no
    // `data_collection` key. That is Mozilla's own documented way to
    // feature-detect the mechanism, and it is why an absent key cannot be
    // confused with an empty one.
    expect(mockGetAll).toHaveBeenCalled();
    expect(sent).toHaveLength(1);
  });

  it('still honours the wallet setting on Chrome, so absence is not a bypass', async () => {
    walletSetting(false);
    browserHasNoDataCollectionConcept();

    await sendEvent(STARTED, CONTEXT);

    expect(sent).toEqual([]);
  });

  it('sends on mobile, where there is no extension permission model at all', async () => {
    walletSetting(true);
    mockIsExtension.mockReturnValue(false);

    await sendEvent(STARTED, CONTEXT);

    expect(sent).toHaveLength(1);
    // Never even reached for the polyfill: importing it off-extension is what
    // `storage-adapter` guards against too.
    expect(mockGetAll).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The gate itself, read directly.
// ---------------------------------------------------------------------------

describe('isTelemetryEnabledAsync', () => {
  it('is false when the browser answer is present but does not name our data type', async () => {
    walletSetting(true);
    mockIsExtension.mockReturnValue(true);
    mockGetAll.mockResolvedValue({ data_collection: ['healthInfo'] });

    await expect(isTelemetryEnabledAsync()).resolves.toBe(false);
  });

  it('is false when the browser answer is malformed rather than an array', async () => {
    // A string would satisfy a naive `.includes()` check and read as granted.
    walletSetting(true);
    mockIsExtension.mockReturnValue(true);
    mockGetAll.mockResolvedValue({ data_collection: 'technicalAndInteraction' });

    await expect(isTelemetryEnabledAsync()).resolves.toBe(false);
  });

  it('is false when the browser answer is null rather than absent', async () => {
    walletSetting(true);
    mockIsExtension.mockReturnValue(true);
    mockGetAll.mockResolvedValue({ data_collection: null });

    await expect(isTelemetryEnabledAsync()).resolves.toBe(false);
  });

  it('does not consult the browser when the wallet setting is already off', async () => {
    // Order matters: the cheap local read comes first, so the overwhelmingly
    // common opted-out case never touches an extension API.
    walletSetting(false);
    mockIsExtension.mockReturnValue(true);
    firefoxAnswers(true);
    mockGetAll.mockClear();

    await expect(isTelemetryEnabledAsync()).resolves.toBe(false);
    expect(mockGetAll).not.toHaveBeenCalled();
  });

  it('is true only when both consents agree', async () => {
    walletSetting(true);
    firefoxAnswers(true);

    await expect(isTelemetryEnabledAsync()).resolves.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The gate and the manifest have to name the same permission.
// ---------------------------------------------------------------------------

describe('the declared permission and the permission we check', () => {
  // Two manifests declare `technicalAndInteraction` to Firefox and the gate
  // checks for it at runtime. Drift between them is silent and asymmetric:
  // declare a type we never read and the browser's answer is ignored, read a
  // type we never declared and the answer is always no. Neither breaks a build.
  it.each(['public/manifest.json', 'public/manifest.v2.json'])('is the same string in %s as the gate checks', file => {
    const source = readFileSync(resolve(__dirname, '../../..', file), 'utf8');

    // Positive fact first: the declaration is really in this file, so a renamed
    // or removed key cannot pass by making the second assertion moot.
    expect(source).toContain('"data_collection_permissions"');
    expect(source).toContain(`"optional": ["${CHECKED_PERMISSION}"]`);
  });
});

// ---------------------------------------------------------------------------
// The same gate governs crash reports, because there is only one gate.
// ---------------------------------------------------------------------------

describe('the crash egress point uses the same gate', () => {
  const requests: string[] = [];
  let originalFetch: PropertyDescriptor | undefined;

  beforeAll(() => {
    originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    Object.defineProperty(globalThis, 'fetch', {
      value: (input: unknown) => {
        requests.push(String(input));
        return Promise.resolve({ status: 200, headers: new Headers() });
      },
      writable: true,
      configurable: true
    });
  });

  afterAll(() => {
    if (originalFetch === undefined) Reflect.deleteProperty(globalThis, 'fetch');
    else Object.defineProperty(globalThis, 'fetch', originalFetch);
  });

  beforeEach(() => {
    requests.length = 0;
    process.env.SENTRY_DSN = 'https://publickey@o0.ingest.de.sentry.io/1';
  });

  afterEach(async () => {
    stopCrashReporting();
    await flush();
  });

  /** Drain the fire-and-forget reporting chain and Sentry's transport buffer. */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 5));
  };

  it('reports a crash when both consents agree', async () => {
    // Positive control first, for the same reason as above.
    walletSetting(true);
    firefoxAnswers(true);

    initCrashReporting();
    captureCrash(new Error('rpc endpoint returned status'));
    await flush();

    expect(requests.filter(url => url.includes('sentry.io')).length).toBeGreaterThan(0);
  });

  it('reports nothing when the browser denies, even with the wallet setting on', async () => {
    walletSetting(true);
    firefoxAnswers(false);

    initCrashReporting();
    captureCrash(new Error('rpc endpoint returned status'));
    await flush();

    expect(requests.filter(url => url.includes('sentry.io'))).toEqual([]);
  });
});
