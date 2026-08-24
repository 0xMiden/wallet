import {
  __resetOperationTransportForTest,
  OperationTransport,
  reportOperation,
  setOperationTransport
} from './report-operation';
import { __resetRunForTest } from './run';
import { OperationSettledEvent } from './types';

jest.mock('./sink', () => ({ sendEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./context', () => ({ resolveTelemetryContext: () => ({ appVersion: '1.2.3', platform: 'extension' }) }));

/* eslint-disable @typescript-eslint/no-var-requires */
const sendEvent = () => jest.mocked(require('./sink').sendEvent as jest.Mock);
/* eslint-enable @typescript-eslint/no-var-requires */

/**
 * `reportOperation` is fire-and-forget, so let its promise chain drain.
 *
 * A macrotask rather than a microtask: the reporter awaits inside an async IIFE,
 * so a single `await Promise.resolve()` here would return before the transport
 * had been reached and every assertion below would read an empty array.
 */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const sent: OperationSettledEvent[] = [];
const capturing: OperationTransport = event => {
  sent.push(event);
  return Promise.resolve();
};

/** The one event that should have been sent, or a failure naming what went wrong. */
const onlyEvent = (): OperationSettledEvent => {
  expect(sent).toHaveLength(1);
  const [event] = sent;
  if (event === undefined) throw new Error('expected one reported event');
  return event;
};

beforeEach(() => {
  sent.length = 0;
  __resetRunForTest();
  __resetOperationTransportForTest();
  sendEvent().mockClear();
});

describe('reporting an operation', () => {
  it('sends what happened, with the outcome and where it got to', async () => {
    setOperationTransport(capturing);
    reportOperation({
      operation: 'tx_send',
      result: 'errored',
      durationMs: 4200,
      errorKind: 'proving',
      step: 'proving'
    });
    await settle();

    expect(sent).toEqual([
      {
        phase: 'settled',
        operation: 'tx_send',
        runId: expect.any(String),
        result: 'errored',
        durationMs: 4200,
        errorKind: 'proving',
        step: 'proving'
      }
    ]);
  });

  it('omits the optional fields rather than sending them undefined', async () => {
    // An explicit `undefined` survives `JSON.stringify` as a missing key, so
    // this is not about the wire — it is about the allowlist assertions, which
    // check the KEYS present on the payload. A key that exists with no value
    // would count as one collected field more than the docs declare.
    setOperationTransport(capturing);
    reportOperation({ operation: 'prove', result: 'completed', durationMs: 10 });
    await settle();

    expect(Object.keys(onlyEvent()).sort()).toEqual(['durationMs', 'operation', 'phase', 'result', 'runId']);
  });

  it('groups everything one realm reported under a single run', async () => {
    setOperationTransport(capturing);
    reportOperation({ operation: 'tx_send', result: 'completed', durationMs: 1 });
    reportOperation({ operation: 'tx_swap', result: 'errored', durationMs: 2 });
    await settle();

    expect(new Set(sent.map(event => event.runId)).size).toBe(1);
  });
});

describe('a duration that cannot be true', () => {
  it.each([
    ['negative, from a clock that stepped back', -5000],
    ['not a number, from arithmetic on a missing start time', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY]
  ])('drops a %s duration to zero rather than polluting an average', async (_why, durationMs) => {
    setOperationTransport(capturing);
    reportOperation({ operation: 'tx_send', result: 'completed', durationMs });
    await settle();

    // Zero, not absent: the event still says the operation finished, which is
    // the fact worth having. Only the number it could not measure is discarded.
    expect(onlyEvent().durationMs).toBe(0);
  });
});

describe('choosing an egress for the realm it is running in', () => {
  it('uses the installed transport when a page installed one', async () => {
    setOperationTransport(capturing);
    reportOperation({ operation: 'tx_send', result: 'completed', durationMs: 1 });
    await settle();

    expect(sent).toHaveLength(1);
    expect(sendEvent()).not.toHaveBeenCalled();
  });

  it('drops the event in a page that installed nothing, rather than opening a second egress', async () => {
    // `window` exists under jsdom, so this IS the page case. The wallet has one
    // auditable egress point because exactly one place reaches the network; a
    // page calling the sink directly would make that two, and losing an event is
    // the smaller of the two failures.
    expect(typeof window).not.toBe('undefined');

    reportOperation({ operation: 'tx_send', result: 'completed', durationMs: 1 });
    await settle();

    expect(sendEvent()).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
});

describe('never becoming a failure of its own', () => {
  it('swallows a transport that rejects', async () => {
    setOperationTransport(() => Promise.reject(new Error('the worker is gone')));

    // The call itself must not throw, and the rejection must not escape as an
    // unhandled one — a `void`ed promise that rejects is a crash in some
    // runtimes, and this is called from the middle of failing a transaction.
    expect(() => reportOperation({ operation: 'tx_send', result: 'errored', durationMs: 1 })).not.toThrow();
    await expect(settle()).resolves.toBeUndefined();
  });

  it('swallows a transport that throws synchronously', async () => {
    setOperationTransport(() => {
      throw new Error('installed wrong');
    });

    expect(() => reportOperation({ operation: 'tx_send', result: 'errored', durationMs: 1 })).not.toThrow();
    await settle();
  });
});
