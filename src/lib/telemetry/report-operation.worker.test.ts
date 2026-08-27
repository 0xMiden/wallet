/**
 * @jest-environment node
 */

/**
 * The worker's egress path, which nothing else in the suite can reach.
 *
 * This branch is the ENTIRE way out for a settled operation on the extension:
 * the transaction pipeline runs in the service worker, so every outcome a real
 * send or swap produces leaves through here. Every other test in this module
 * runs under jsdom, where `window` always exists, so all of them take the page
 * branch — and deleting the worker branch outright left the whole suite green.
 *
 * Hence the docblock above. A node environment genuinely has no `window`, which
 * is the condition the reporter tests, rather than a jsdom global deleted at
 * runtime — `window` is not configurable there, so a `delete` silently does
 * nothing and the test would pass for the wrong reason.
 */
import { __resetOperationTransportForTest, reportOperation, setOperationTransport } from './report-operation';
import { __resetRunForTest } from './run';

jest.mock('./sink', () => ({ sendEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./context', () => ({ resolveTelemetryContext: () => ({ appVersion: '1.2.3', platform: 'extension' }) }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sendEvent = () => jest.mocked(require('./sink').sendEvent as jest.Mock);

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  __resetRunForTest();
  __resetOperationTransportForTest();
  sendEvent().mockClear();
});

it('has no window, which is what makes the rest of this file meaningful', () => {
  expect(typeof window).toBe('undefined');
});

it('calls the sink directly, because the worker already is where the sink lives', async () => {
  reportOperation({ operation: 'tx_send', result: 'errored', durationMs: 7, errorKind: 'proving', step: 'proving' });
  await settle();

  expect(sendEvent()).toHaveBeenCalledTimes(1);
  expect(sendEvent()).toHaveBeenCalledWith(
    {
      phase: 'settled',
      operation: 'tx_send',
      runId: expect.any(String),
      result: 'errored',
      durationMs: 7,
      errorKind: 'proving',
      step: 'proving'
    },
    // Resolved here rather than passed in: a page's transport carries the event
    // to the worker and the worker adds the context, so this branch has to do
    // both or the event would arrive without a version or a platform.
    { appVersion: '1.2.3', platform: 'extension' }
  );
});

it('still prefers an installed transport, so the offscreen document is not forced through the sink', async () => {
  // The offscreen document has a `window` and would take the page branch — but
  // it is also the realm that installs a transport of its own, forwarding to the
  // worker over the extension's message channel. This asserts the precedence
  // that makes that work: an installed transport wins wherever it is installed.
  const forwarded: unknown[] = [];
  setOperationTransport(event => {
    forwarded.push(event);
    return Promise.resolve();
  });

  reportOperation({ operation: 'prove', result: 'completed', durationMs: 3, step: 'prove_fallback' });
  await settle();

  expect(forwarded).toHaveLength(1);
  expect(sendEvent()).not.toHaveBeenCalled();
});
