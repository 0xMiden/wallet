import { request } from 'lib/miden/front';
import { WalletMessageType } from 'lib/shared/types';

import { beginFlow, classifyError } from './report-flow';
import { FlowEndedEvent, TelemetryEvent } from './types';

jest.mock('lib/miden/front', () => ({ request: jest.fn() }));

// The repo-wide manual mock at `__mocks__/nanoid.ts` returns the constant `id`,
// which would make every flow share one identifier and hide the very thing
// `beginFlow` has to get right. A counter keeps the id deterministic while
// still failing if the implementation ever hoists `nanoid()` out of the call.
jest.mock('nanoid', () => {
  let issued = 0;
  return { nanoid: () => `flow-${++issued}` };
});

const flushMicrotasks = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Only telemetry requests, narrowed off the `WalletRequest` union rather than
 * cast, so a change to the message shape fails `yarn ts` here too.
 */
const sentEvents = (): TelemetryEvent[] =>
  jest
    .mocked(request)
    .mock.calls.flatMap(([req]) => (req.type === WalletMessageType.ReportTelemetryEventRequest ? [req.event] : []));

const eventAt = (index: number): TelemetryEvent => {
  const event = sentEvents()[index];
  if (event === undefined) throw new Error(`expected a telemetry event at index ${index}`);
  return event;
};

const endedEventAt = (index: number): FlowEndedEvent => {
  const event = eventAt(index);
  if (event.phase !== 'ended') throw new Error(`expected the event at index ${index} to have ended`);
  return event;
};

describe('beginFlow', () => {
  beforeEach(() => {
    jest.mocked(request).mockResolvedValue({ type: WalletMessageType.ReportTelemetryEventResponse });
  });

  afterEach(() => jest.resetAllMocks());

  it('emits a started event immediately', () => {
    beginFlow('send');
    const [call] = jest.mocked(request).mock.calls;
    expect(call?.[0].type).toBe(WalletMessageType.ReportTelemetryEventRequest);
    expect(eventAt(0)).toMatchObject({ phase: 'started', flow: 'send' });
  });

  it('emits completed with a duration on complete', () => {
    beginFlow('send').complete();
    expect(endedEventAt(1)).toMatchObject({ phase: 'ended', flow: 'send', result: 'completed' });
    expect(typeof endedEventAt(1).durationMs).toBe('number');
  });

  it('emits cancelled on cancel', () => {
    beginFlow('import').cancel();
    expect(eventAt(1)).toMatchObject({ result: 'cancelled' });
  });

  it('emits errored with the supplied kind on fail', () => {
    beginFlow('recover').fail('rpc');
    expect(eventAt(1)).toMatchObject({ result: 'errored', errorKind: 'rpc' });
  });

  it('omits errorKind on a non-error outcome', () => {
    beginFlow('send').complete();
    expect(endedEventAt(1).errorKind).toBeUndefined();
  });

  it('pairs started and ended by flowId', () => {
    beginFlow('send').complete();
    expect(eventAt(0).flowId).toBe(eventAt(1).flowId);
    expect(eventAt(0).flowId.length).toBeGreaterThan(0);
  });

  it('gives concurrent flows distinct ids', () => {
    beginFlow('send');
    beginFlow('fund');
    expect(eventAt(0).flowId).not.toBe(eventAt(1).flowId);
  });

  it('ignores a second terminal call on the same handle', () => {
    const flow = beginFlow('send');
    flow.complete();
    flow.cancel();
    flow.fail('rpc');
    expect(sentEvents()).toHaveLength(2);
  });

  it('never throws or leaves a rejection unhandled when the intercom request fails', async () => {
    const unhandled: unknown[] = [];
    const collect = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', collect);

    try {
      jest.mocked(request).mockRejectedValue(new Error('port closed'));
      expect(() => beginFlow('send').complete()).not.toThrow();
      await flushMicrotasks();
      expect(jest.mocked(request).mock.calls.length).toBe(2);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', collect);
    }
  });
});

describe('classifyError', () => {
  // Every alternative in every `||` is listed, so no operand can rot unnoticed
  // behind a sibling that short-circuits first.
  it.each([
    ['Failed to fetch', 'network'],
    ['network unreachable', 'network'],
    ['network request timed out', 'timeout'],
    ['request timeout exceeded', 'timeout'],
    ['rpc error: invalid response', 'rpc'],
    ['proving failed after fallback', 'proving'],
    ['QuotaExceededError writing to disk', 'storage'],
    ['object store not found', 'storage'],
    ['IndexedDB is unavailable', 'storage'],
    ['invalid password', 'auth'],
    ['unauthorized', 'auth'],
    ['biometric prompt dismissed', 'auth'],
    ['invalid recipient address', 'validation'],
    ['amount must be positive', 'validation'],
    ['recipient is required', 'validation'],
    ['something nobody predicted', 'unknown']
  ])('classifies %s as %s', (message, expected) => {
    expect(classifyError(new Error(message))).toBe(expected);
  });

  it('classifies a non-Error as unknown', () => {
    expect(classifyError('a bare string')).toBe('unknown');
  });

  it('never returns the original message', () => {
    const kind = classifyError(new Error('account mtst1secret balance 4200'));
    expect(kind).not.toContain('mtst1');
    expect(kind).not.toContain('4200');
  });
});
