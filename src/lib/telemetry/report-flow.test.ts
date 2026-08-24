import { request } from 'lib/miden/front';
import { WalletMessageType } from 'lib/shared/types';

import { __resetRunForTest, beginFlow, classifyError, RUN_IDLE_ROTATE_MS } from './report-flow';
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

describe('runId', () => {
  beforeEach(() => {
    jest.mocked(request).mockResolvedValue({ type: WalletMessageType.ReportTelemetryEventResponse });
    __resetRunForTest();
  });

  afterEach(() => jest.resetAllMocks());

  it('is shared by every flow of one run, which is what makes a session a visit', () => {
    // The property the redesign exists for. Sending the per-flow id as the
    // Aptabase session made each session hold one flow and last 0s, so the
    // dashboard could not say that a person opened the wallet and then swapped.
    beginFlow('open').complete();
    beginFlow('swap').complete();

    const runs = new Set(sentEvents().map(event => event.runId));
    expect(runs.size).toBe(1);
  });

  it('is carried by both halves of a flow, so a pair never straddles two runs', () => {
    beginFlow('send').complete();
    expect(eventAt(0).runId).toBe(eventAt(1).runId);
  });

  it('starts over for a new run, since nothing about it is written down', () => {
    beginFlow('open').complete();
    const first = eventAt(0).runId;

    // What a reopened popup or a relaunched app does: the module is evaluated
    // again and the previous id is simply gone. There is no storage to clear.
    __resetRunForTest();
    beginFlow('open').complete();

    expect(eventAt(2).runId).not.toBe(first);
  });

  it('rotates after a long idle, bounding how much activity one id can cover', () => {
    const now = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      beginFlow('open').complete();

      // A wallet left open in a background tab overnight. Tomorrow's activity
      // must not be joinable to today's just because the page never reloaded.
      now.mockReturnValue(1_000_000 + RUN_IDLE_ROTATE_MS + 1);
      beginFlow('open').complete();

      expect(eventAt(2).runId).not.toBe(eventAt(0).runId);
    } finally {
      now.mockRestore();
    }
  });

  it('does not rotate while the run is still being used', () => {
    const now = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      beginFlow('open').complete();

      // Stepping away from a half-finished send and coming back is one visit,
      // so the threshold has to be measured from the last event and not the
      // first — this fails if the rotation is keyed on the run's total age.
      now.mockReturnValue(1_000_000 + RUN_IDLE_ROTATE_MS - 1);
      beginFlow('send').complete();
      now.mockReturnValue(1_000_000 + 2 * RUN_IDLE_ROTATE_MS - 2);
      beginFlow('swap').complete();

      const runs = new Set(sentEvents().map(event => event.runId));
      expect(runs.size).toBe(1);
    } finally {
      now.mockRestore();
    }
  });

  it('rotates after a flow that was itself left open past the idle window', () => {
    const now = jest.spyOn(Date, 'now');
    try {
      // A send left open on a full-page tab overnight and dismissed in the
      // morning. Settling it is activity, but activity that arrives this late
      // must retire the run rather than re-arm it — otherwise one id covers
      // both days, and every subsequent long flow extends it again.
      now.mockReturnValue(1_000_000);
      const overnight = beginFlow('send');
      now.mockReturnValue(1_000_000 + RUN_IDLE_ROTATE_MS + 1);
      overnight.cancel();

      now.mockReturnValue(1_000_000 + RUN_IDLE_ROTATE_MS + 2);
      beginFlow('swap').complete();

      // The stale flow's own two events still pair, since the id is captured up
      // front. It is the morning's flow that has to land somewhere new.
      expect(eventAt(1).runId).toBe(eventAt(0).runId);
      expect(eventAt(2).runId).not.toBe(eventAt(0).runId);
    } finally {
      now.mockRestore();
    }
  });

  it('rotates when the clock jumps backwards, which would otherwise stall it forever', () => {
    const now = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      beginFlow('open').complete();

      // An NTP correction. A negative elapsed time is never greater than the
      // threshold, so without an explicit check the run would never rotate
      // again for as long as the page lived.
      now.mockReturnValue(1_000_000 - RUN_IDLE_ROTATE_MS);
      beginFlow('open').complete();

      expect(eventAt(2).runId).not.toBe(eventAt(0).runId);
    } finally {
      now.mockRestore();
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

describe('step', () => {
  beforeEach(() => {
    jest.mocked(request).mockResolvedValue({ type: WalletMessageType.ReportTelemetryEventResponse });
  });

  afterEach(() => jest.resetAllMocks());

  it('rides out on `ended` rather than emitting an event of its own', async () => {
    const flow = beginFlow('send');
    flow.step('select_amount');
    flow.step('review');
    flow.cancel();
    await flushMicrotasks();

    // Two events for the whole flow, not four: progress is free.
    expect(sentEvents()).toHaveLength(2);
    expect(endedEventAt(1).step).toBe('review');
  });

  it('is absent when the flow never reported one, rather than guessing a default', async () => {
    beginFlow('unlock').complete();
    await flushMicrotasks();

    expect(endedEventAt(1)).not.toHaveProperty('step');
  });

  it('keeps the last step reported, so going back a screen does not erase having reached review', async () => {
    const flow = beginFlow('swap');
    flow.step('review');
    // The user navigates back to the amounts screen and gives up there. What
    // matters for drop-off is that they had already got as far as review.
    flow.step('swap_amounts');
    flow.cancel();
    await flushMicrotasks();

    expect(endedEventAt(1).step).toBe('swap_amounts');
  });

  it('ignores a step recorded after the flow settled', async () => {
    const flow = beginFlow('earn');
    flow.step('review');
    flow.complete();
    // A screen unmounting after its flow completed must not rewrite history.
    flow.step('select_amount');
    await flushMicrotasks();

    expect(sentEvents()).toHaveLength(2);
    expect(endedEventAt(1).step).toBe('review');
  });
});
