import { isTelemetryEnabledAsync } from 'lib/settings/helpers';

import { APTABASE_PROP_KEYS, buildEnvelope, isNameableEvent } from './aptabase';
import { serializeEvent, WIRE_KEYS } from './serialize';
import { __setTransportForTest, dropQueue, sendEvent } from './sink';
import { ScreenVisitEvent, TelemetryContext, TelemetryWirePayload } from './types';

jest.mock('lib/settings/helpers', () => ({
  ...jest.requireActual<typeof import('lib/settings/helpers')>('lib/settings/helpers'),
  isTelemetryEnabledAsync: jest.fn()
}));

const context: TelemetryContext = { appVersion: '1.18.2', platform: 'extension', network: 'mainnet' };
const visit: ScreenVisitEvent = {
  phase: 'visit',
  screen: 'send',
  source: 'push',
  surface: 'popup',
  order: 3,
  visibleMs: 4321.6,
  complete: true,
  runId: 'run-1'
};

// Values a screen could hold that must never reach the wire.
const SECRETS = ['0xdeadbeefdeadbeefdeadbeef', 'mid1qq-account', '12.5 USDC', 'alice@example.com', 'seed words here'];

describe('screen visit on the wire', () => {
  let sent: TelemetryWirePayload[];
  beforeEach(() => {
    sent = [];
    __setTransportForTest(async p => void sent.push(p));
    jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(true);
  });
  afterEach(() => {
    __setTransportForTest(null);
    dropQueue();
    jest.resetAllMocks();
  });

  it('serializes exactly the allowed fields, with visible time rounded', () => {
    expect(serializeEvent(visit, context)).toEqual({
      phase: 'visit',
      runId: 'run-1',
      screen: 'send',
      navSource: 'push',
      surface: 'popup',
      order: 3,
      durationMs: 4322,
      complete: true,
      appVersion: '1.18.2',
      platform: 'extension',
      network: 'mainnet'
    });
  });

  it('maps onto an envelope named after the screen with only allowlisted props', () => {
    const envelope = buildEnvelope(serializeEvent(visit, context), new Date(0));
    expect(envelope.eventName).toBe('send_visit');
    expect(envelope.sessionId).toBe('run-1');
    expect(Object.keys(envelope.props).sort()).toEqual(
      ['complete', 'durationMs', 'navSource', 'network', 'order', 'screen', 'surface'].sort()
    );
    for (const key of Object.keys(envelope.props)) expect(APTABASE_PROP_KEYS).toContain(key);
  });

  it('sends nothing when usage sharing is off', async () => {
    jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(false);
    await sendEvent(visit, context);
    expect(sent).toEqual([]);
  });

  it('never carries an address, amount, identifier or text, even when an untyped sender adds them', async () => {
    const hostile = {
      ...visit,
      recipient: SECRETS[0],
      accountId: SECRETS[1],
      amount: SECRETS[2],
      contact: SECRETS[3],
      clipboard: SECRETS[4],
      pathname: '/send/0xdeadbeef',
      url: 'https://example.com/?q=1',
      error: 'raw message'
    } as unknown as ScreenVisitEvent;
    await sendEvent(hostile, context);
    expect(sent).toHaveLength(1);
    const payload = sent[0]!;
    for (const key of Object.keys(payload)) expect(WIRE_KEYS).toContain(key);
    const wire = JSON.stringify(buildEnvelope(payload));
    for (const secret of SECRETS) expect(wire).not.toContain(secret);
    for (const word of ['recipient', 'accountId', 'amount', 'contact', 'clipboard', 'pathname', 'url', 'error']) {
      expect(wire).not.toContain(`"${word}"`);
    }
  });

  it.each([
    ['screen', { screen: 'unknown' }],
    ['source', { source: '/send/0xdeadbeef' }],
    ['surface', { surface: 'my-device' }],
    ['order', { order: Number.NaN }],
    ['visible time', { visibleMs: Number.POSITIVE_INFINITY }]
  ])('refuses a visit whose %s is outside its closed set', async (_name, patch) => {
    await sendEvent({ ...visit, ...patch } as unknown as ScreenVisitEvent, context);
    expect(sent).toEqual([]);
  });

  it('refuses a visit with no screen to name it', () => {
    const payload = serializeEvent({ ...visit, screen: undefined } as unknown as ScreenVisitEvent, context);
    expect(isNameableEvent(payload)).toBe(false);
  });

  it('carries no persistent or cross-session identifier beyond the in-memory run', () => {
    const keys = Object.keys(serializeEvent(visit, context));
    expect(keys).not.toEqual(expect.arrayContaining(['flowId']));
    expect(keys.filter(k => /device|install|user|account|address|session/i.test(k))).toEqual([]);
  });
});
