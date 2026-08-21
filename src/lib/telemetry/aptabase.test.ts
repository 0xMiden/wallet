import {
  APTABASE_ENVELOPE_KEYS,
  APTABASE_PROP_KEYS,
  APTABASE_SDK_VERSION,
  APTABASE_SYSTEM_PROP_KEYS,
  buildEnvelope,
  resolveAptabaseEndpoint
} from './aptabase';
import { TelemetryErrorKind, TelemetryFlow, TelemetryResult, TelemetryWirePayload } from './types';

/**
 * The two collisions between Aptabase's contract and this design are decided
 * here, so a future change that "completes" either one fails rather than ships:
 *
 * 1. `sessionId` is the per-flow id, not a reused session. Aptabase's own SDKs
 *    keep one session id across events with a four-hour timeout, which would
 *    link every flow a user performs into one trail. There is nowhere to keep
 *    such an id anyway — `guarantees.test.ts` asserts the telemetry module
 *    cannot reach a persistence API at all.
 * 2. `systemProps` carries four fields and never the three fingerprinting ones.
 *    `osVersion`, `locale` and `deviceModel` are data this wallet does not
 *    collect, and Aptabase does not require them.
 */

const NOW = new Date('2026-08-21T19:32:11.482Z');

const started: TelemetryWirePayload = {
  phase: 'started',
  flow: 'send',
  flowId: 'flow-1',
  appVersion: '1.15.21',
  platform: 'extension'
};

const ended: TelemetryWirePayload = {
  phase: 'ended',
  flow: 'send',
  flowId: 'flow-1',
  result: 'errored',
  errorKind: 'proving',
  durationMs: 1234,
  appVersion: '1.15.21',
  platform: 'extension'
};

/**
 * Written as a `Record` over each union so TypeScript, not a reviewer, notices
 * a twelfth flow or a fourth result: widening the union fails `yarn ts` here
 * until the new member is mapped.
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

const FLOWS: readonly TelemetryFlow[] = Object.values(EVERY_FLOW);
const RESULTS: readonly TelemetryResult[] = Object.values(EVERY_RESULT);
const ERROR_KINDS: readonly TelemetryErrorKind[] = Object.values(EVERY_ERROR_KIND);

/** Every payload the wire type can hold, so the assertions below are exhaustive. */
const EVERY_PAYLOAD: readonly TelemetryWirePayload[] = FLOWS.flatMap(flow => [
  { phase: 'started', flow, flowId: 'f', appVersion: '1.15.21', platform: 'ios' },
  ...RESULTS.map(
    (result): TelemetryWirePayload => ({
      phase: 'ended',
      flow,
      flowId: 'f',
      result,
      durationMs: 7,
      appVersion: '1.15.21',
      platform: 'android'
    })
  ),
  ...ERROR_KINDS.map(
    (errorKind): TelemetryWirePayload => ({
      phase: 'ended',
      flow,
      flowId: 'f',
      result: 'errored',
      errorKind,
      durationMs: 7,
      appVersion: '1.15.21',
      platform: 'extension'
    })
  )
]);

/**
 * The three fields Aptabase's own SDKs send that this wallet does not collect.
 *
 * Restated here rather than imported from the module under test: a guard that
 * reads its own subject's constant agrees with a mistake in it.
 */
const FINGERPRINTING_FIELDS = ['osVersion', 'locale', 'deviceModel'];

describe('the Aptabase envelope', () => {
  it('names the event from the flow and the phase, both closed unions', () => {
    expect(buildEnvelope(started, NOW).eventName).toBe('send_started');
    expect(buildEnvelope(ended, NOW).eventName).toBe('send_ended');
  });

  it('names every flow on both phases, and never anything else', () => {
    const expected = FLOWS.flatMap(flow => [`${flow}_started`, `${flow}_ended`]);
    const observed = new Set(EVERY_PAYLOAD.map(payload => buildEnvelope(payload, NOW).eventName));
    expect([...observed].sort()).toEqual([...expected].sort());
  });

  it('carries exactly the envelope keys Aptabase defines', () => {
    for (const payload of EVERY_PAYLOAD) {
      expect(Object.keys(buildEnvelope(payload, NOW)).sort()).toEqual([...APTABASE_ENVELOPE_KEYS].sort());
    }
  });

  it('stamps an ISO-8601 timestamp from the clock it is handed', () => {
    expect(buildEnvelope(started, NOW).timestamp).toBe('2026-08-21T19:32:11.482Z');
  });

  it('stamps the current time when no clock is supplied', () => {
    const before = Date.now();
    const stamped = Date.parse(buildEnvelope(started).timestamp);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Date.now());
  });
});

describe('sessionId is the per-flow id, never a reused session', () => {
  it('sets sessionId to the flow id', () => {
    expect(buildEnvelope(started, NOW).sessionId).toBe('flow-1');
  });

  it('pairs one flow’s started and ended events under one session id', () => {
    // The pairing that is already intended, already true of the current
    // payload, and adds no linkability that `flowId` did not already carry.
    const openStarted = buildEnvelope({ ...started, flowId: 'abc' }, NOW);
    const openEnded = buildEnvelope({ ...ended, flowId: 'abc' }, NOW);
    expect(openStarted.sessionId).toBe(openEnded.sessionId);
  });

  it('gives two different flows two different session ids', () => {
    // This is the assertion that fails if anyone adopts Aptabase's four-hour
    // session, which would link every flow one person performs into one trail.
    const first = buildEnvelope({ ...started, flowId: 'flow-a' }, NOW);
    const second = buildEnvelope({ ...started, flowId: 'flow-b' }, NOW);
    expect(first.sessionId).toBe('flow-a');
    expect(second.sessionId).toBe('flow-b');
    expect(first.sessionId).not.toBe(second.sessionId);
  });

  it('mints no identifier of its own — every session id came from the payload', () => {
    const ids = new Set(EVERY_PAYLOAD.map(payload => buildEnvelope(payload, NOW).sessionId));
    expect([...ids]).toEqual(['f']);
  });
});

describe('systemProps carries the minimum and no fingerprint', () => {
  it('carries exactly isDebug, osName, appVersion and sdkVersion', () => {
    for (const payload of EVERY_PAYLOAD) {
      expect(Object.keys(buildEnvelope(payload, NOW).systemProps).sort()).toEqual(
        [...APTABASE_SYSTEM_PROP_KEYS].sort()
      );
    }
  });

  it.each(FINGERPRINTING_FIELDS)('never sends %s, on any event shape', field => {
    // The assertion that stops someone "completing" systemProps later. Each of
    // these is data the wallet does not collect and a fingerprinting vector.
    const offenders = EVERY_PAYLOAD.flatMap(payload => {
      const envelope = buildEnvelope(payload, NOW);
      const inSystem = field in envelope.systemProps;
      const inProps = field in envelope.props;
      const inJson = JSON.stringify(envelope).includes(field);
      return inSystem || inProps || inJson ? [`${envelope.eventName} carries ${field}`] : [];
    });
    expect(offenders).toEqual([]);
  });

  it('reports the platform we already collect as osName', () => {
    expect(buildEnvelope({ ...started, platform: 'ios' }, NOW).systemProps.osName).toBe('ios');
    expect(buildEnvelope({ ...started, platform: 'android' }, NOW).systemProps.osName).toBe('android');
    expect(buildEnvelope({ ...started, platform: 'extension' }, NOW).systemProps.osName).toBe('extension');
  });

  it('passes the app version through from the background-derived context', () => {
    expect(buildEnvelope({ ...started, appVersion: '9.9.9' }, NOW).systemProps.appVersion).toBe('9.9.9');
  });

  it('identifies this wallet transport as the SDK, not a vendor SDK', () => {
    expect(buildEnvelope(started, NOW).systemProps.sdkVersion).toBe(APTABASE_SDK_VERSION);
    expect(APTABASE_SDK_VERSION).toMatch(/^[a-z0-9-]+@\d+\.\d+\.\d+$/);
  });

  describe('isDebug', () => {
    // `NODE_ENV` is typed read-only, and neither `as` nor `any` is permitted in
    // this repo. `Reflect.set` writes it without either.
    const original = process.env.NODE_ENV;
    const setNodeEnv = (value: string | undefined): void => {
      if (value === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
      else Reflect.set(process.env, 'NODE_ENV', value);
    };

    afterEach(() => setNodeEnv(original));

    it('is false in a production build', () => {
      setNodeEnv('production');
      expect(buildEnvelope(started, NOW).systemProps.isDebug).toBe(false);
    });

    it('is true anywhere else', () => {
      setNodeEnv('development');
      expect(buildEnvelope(started, NOW).systemProps.isDebug).toBe(true);
    });
  });
});

describe('props is built field by field from the allowlist', () => {
  it('sends no props for a started event', () => {
    expect(buildEnvelope(started, NOW).props).toEqual({});
  });

  it('sends the result and the duration for an ended event', () => {
    expect(buildEnvelope({ ...ended, result: 'completed', errorKind: undefined }, NOW).props).toEqual({
      result: 'completed',
      durationMs: 1234
    });
  });

  it('sends the error kind only when the flow failed with one', () => {
    expect(buildEnvelope(ended, NOW).props).toEqual({
      result: 'errored',
      errorKind: 'proving',
      durationMs: 1234
    });
    expect('errorKind' in buildEnvelope({ ...ended, errorKind: undefined }, NOW).props).toBe(false);
  });

  it('carries only allowlisted prop keys, on every event shape', () => {
    const outside = EVERY_PAYLOAD.flatMap(payload =>
      Object.keys(buildEnvelope(payload, NOW).props).filter(key => !APTABASE_PROP_KEYS.includes(key))
    );
    expect(outside).toEqual([]);
  });

  it('carries only strings and numbers, which is all Aptabase permits', () => {
    const wrong = EVERY_PAYLOAD.flatMap(payload =>
      Object.entries(buildEnvelope(payload, NOW).props).flatMap(([key, value]) =>
        typeof value === 'string' || typeof value === 'number' ? [] : [`${key} is ${typeof value}`]
      )
    );
    expect(wrong).toEqual([]);
  });

  it('drops a field the payload grew that the mapper does not name', () => {
    // The type system cannot help here: Aptabase's `props` is an open object,
    // so the allowlist discipline has to live in the mapper. This is what
    // fails if anyone spreads the payload instead of mapping it field by field.
    const smuggled = Object.assign({ ...ended }, { locale: 'en-GB', deviceModel: 'Pixel 8', account: 'mtst1aqs' });
    const envelope = buildEnvelope(smuggled, NOW);

    expect(envelope.props).toEqual({ result: 'errored', errorKind: 'proving', durationMs: 1234 });
    expect(JSON.stringify(envelope)).not.toContain('en-GB');
    expect(JSON.stringify(envelope)).not.toContain('Pixel 8');
    expect(JSON.stringify(envelope)).not.toContain('mtst1aqs');
  });
});

describe('resolving the endpoint from the app key', () => {
  it('derives the EU host from an A-EU key', () => {
    expect(resolveAptabaseEndpoint('A-EU-1234567890', '')).toEqual({
      url: 'https://eu.aptabase.com/api/v0/event',
      appKey: 'A-EU-1234567890'
    });
  });

  it('derives the US host from an A-US key', () => {
    expect(resolveAptabaseEndpoint('A-US-1234567890', '')?.url).toBe('https://us.aptabase.com/api/v0/event');
  });

  it('posts one event per request, never the batch endpoint', () => {
    // MV3 service workers have no guaranteed lifetime, so a batch buffer is a
    // buffer that gets killed. The bounded queue plus per-event send is the
    // deliberate choice; `/api/v0/events` would imply the opposite.
    const url = resolveAptabaseEndpoint('A-EU-1234567890', '')?.url ?? '';
    expect(url.endsWith('/api/v0/event')).toBe(true);
  });

  it('requires an explicit host for a self-hosted key', () => {
    expect(resolveAptabaseEndpoint('A-SH-1234567890', '')).toBeNull();
    expect(resolveAptabaseEndpoint('A-SH-1234567890', 'https://analytics.example.org')?.url).toBe(
      'https://analytics.example.org/api/v0/event'
    );
  });

  it('requires an explicit host for a development key', () => {
    // There is no hosted "dev" region to derive, and Aptabase's own web SDK
    // points these at a local dev server — a machine-specific address that has
    // no business being compiled into a shipped wallet.
    expect(resolveAptabaseEndpoint('A-DEV-1234567890', '')).toBeNull();
    expect(resolveAptabaseEndpoint('A-DEV-1234567890', 'http://localhost:3000')?.url).toBe(
      'http://localhost:3000/api/v0/event'
    );
  });

  it('honours an explicit host over the region default', () => {
    // An operator who sets a host and has it silently ignored ships a build
    // pointing somewhere they did not intend.
    expect(resolveAptabaseEndpoint('A-EU-1234567890', 'https://proxy.example.org')?.url).toBe(
      'https://proxy.example.org/api/v0/event'
    );
  });

  it('tolerates a trailing slash and surrounding whitespace on the host', () => {
    expect(resolveAptabaseEndpoint('A-SH-1234567890', '  https://analytics.example.org/  ')?.url).toBe(
      'https://analytics.example.org/api/v0/event'
    );
  });

  it.each([
    ['unset', ''],
    ['whitespace', '   '],
    ['no A- prefix', 'EU-1234567890'],
    ['unknown region', 'A-XX-1234567890'],
    ['lowercase region', 'a-eu-1234567890'],
    ['empty identifier', 'A-EU-'],
    ['a whole URL pasted in', 'https://eu.aptabase.com'],
    ['punctuation smuggled in', 'A-EU-123/../..'],
    ['a newline smuggled in', 'A-EU-123\nX-Injected: 1']
  ])('disables sending for a %s app key, without throwing', (_label, appKey) => {
    expect(resolveAptabaseEndpoint(appKey, '')).toBeNull();
  });

  it.each([
    ['not a URL', 'not-a-url'],
    ['a bare host', 'analytics.example.org'],
    ['a non-HTTP scheme', 'ftp://analytics.example.org'],
    // Concatenated rather than written out: the literal trips `no-script-url`,
    // and the point here is that the resolver rejects the scheme, not that this
    // file may write one down.
    ['a script URL', `${'java'}${'script'}:alert(1)`],
    ['a data: URL', 'data:text/plain,x']
  ])('disables sending for a host that is %s, without throwing', (_label, host) => {
    expect(resolveAptabaseEndpoint('A-SH-1234567890', host)).toBeNull();
  });

  it('never throws, whatever it is handed', () => {
    const keys = ['', 'A-EU-1', 'A-SH-1', '\u0000', 'A-'.repeat(5000)];
    const hosts = ['', 'https://x.invalid', '://', '%%%', 'https://'];
    for (const appKey of keys) {
      for (const host of hosts) {
        expect(() => resolveAptabaseEndpoint(appKey, host)).not.toThrow();
      }
    }
  });
});
