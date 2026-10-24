/** @jest-environment node */
import { getGlobalScope, getIsolationScope } from '@sentry/browser';

import { isCrashReportingEnabledAsync } from 'lib/settings/helpers';

import { resolveTelemetryContext } from './context';
import { captureCrash, captureDiagnosticLog, initCrashReporting, stopCrashReporting } from './crash';
import {
  _resetDiagnosticLogLimitsForTest,
  logOperationEnd,
  logOperationStep,
  withOperationStep
} from './diagnostic-log';

jest.mock('lib/settings/helpers', () => ({
  ...jest.requireActual<typeof import('lib/settings/helpers')>('lib/settings/helpers'),
  isCrashReportingEnabledAsync: jest.fn()
}));

const ADDRESS = 'mtst1aqsjql4cyylvpu2d2cwpxumpvvw5depe';
const AMOUNT = '987654321';
const URL_SECRET = 'https://user:s3cret@rpc.private.example/path';
const PHRASE = 'avoid leave side crush call gasp confirm deal student link chunk interest';
const POISON = [ADDRESS, AMOUNT, URL_SECRET, 'rpc.private.example', 's3cret', PHRASE, 'private-user-id', 'user@mail'];

const bodies: string[] = [];
let previousFetch: PropertyDescriptor | undefined;
let previousDsn: string | undefined;

beforeAll(() => {
  previousFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  previousDsn = process.env.SENTRY_DSN;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (_input: unknown, init?: { body?: unknown }) => {
      const body = init?.body;
      bodies.push(typeof body === 'string' ? body : ArrayBuffer.isView(body) ? new TextDecoder().decode(body) : '');
      return new Response('', { status: 200 });
    }
  });
});
afterAll(() => {
  if (previousFetch) Object.defineProperty(globalThis, 'fetch', previousFetch);
  else Reflect.deleteProperty(globalThis, 'fetch');
  if (previousDsn === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = previousDsn;
});
beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'performance'] });
  bodies.length = 0;
  _resetDiagnosticLogLimitsForTest();
  process.env.SENTRY_DSN = 'https://publickey@o0.ingest.de.sentry.io/1';
  jest.mocked(isCrashReportingEnabledAsync).mockResolvedValue(true);
  initCrashReporting({ listenToGlobals: false });
});
afterEach(() => {
  stopCrashReporting();
  getIsolationScope().clear();
  getGlobalScope().clear();
  jest.useRealTimers();
});

/** Lets the permission check settle, then passes Sentry's 5 s log flush interval. */
async function flushLogs(): Promise<void> {
  await jest.advanceTimersByTimeAsync(0);
  await jest.advanceTimersByTimeAsync(5_000);
  await jest.advanceTimersByTimeAsync(0);
}

interface WireLog {
  body: unknown;
  level: unknown;
  attributes: Record<string, { value: unknown; type: unknown }>;
  trace_id?: unknown;
  keys: string[];
}

function wireLogs(): WireLog[] {
  const logs: WireLog[] = [];
  for (const body of bodies) {
    const lines = body.split('\n');
    for (let index = 1; index < lines.length; index += 2) {
      if (JSON.parse(lines[index] ?? '{}').type !== 'log') continue;
      const container = JSON.parse(lines[index + 1] ?? '{}');
      for (const item of container.items) logs.push({ ...item, keys: Object.keys(item).sort() });
    }
  }
  return logs;
}

const values = (log: WireLog | undefined) =>
  Object.fromEntries(Object.entries(log?.attributes ?? {}).map(([key, attribute]) => [key, attribute.value]));

it('sends a step as a Sentry log with only its closed values and the attributes the SDK adds', async () => {
  logOperationStep('swap', 'proposal_create', 'failed', 2_500);
  await flushLogs();
  const logs = wireLogs();
  expect(logs).toHaveLength(1);
  const [log] = logs;
  expect(log?.keys).toEqual(['attributes', 'body', 'level', 'severity_number', 'timestamp', 'trace_id']);
  expect(log?.body).toBe('operation_step');
  expect(log?.level).toBe('info');
  expect(Object.keys(log?.attributes ?? {}).sort()).toEqual(
    ['duration', 'operation', 'outcome', 'sentry.release', 'sentry.timestamp.sequence', 'step'].sort()
  );
  expect(values(log)).toMatchObject({
    operation: 'swap',
    step: 'proposal_create',
    outcome: 'failed',
    duration: '1_to_5s',
    'sentry.release': resolveTelemetryContext().appVersion
  });
});

it('sends the end of an operation under its own fixed name', async () => {
  logOperationEnd('swap', 'timeout');
  await flushLogs();
  expect(wireLogs().map(log => [log.body, values(log).outcome])).toEqual([['operation_end', 'timeout']]);
});

it('carries none of a failed step error, nor a user set on the shared scopes', async () => {
  getIsolationScope().setUser({ id: 'private-user-id', email: 'user@mail', username: ADDRESS });
  const failure = new Error(`swap of ${AMOUNT} from ${ADDRESS} failed at ${URL_SECRET}: ${PHRASE}`);
  await expect(
    withOperationStep(
      'swap',
      'request_build',
      async () => {
        throw failure;
      },
      () => 'failed'
    )
  ).rejects.toBe(failure);
  await flushLogs();
  expect(wireLogs()).toHaveLength(1);
  const wire = bodies.join('\n');
  for (const poison of POISON) expect(wire).not.toContain(poison);
  expect(Object.keys(wireLogs()[0]?.attributes ?? {}).some(key => key.startsWith('user.'))).toBe(false);
});

it('drops the record when any scope carries attributes it would add after scrubbing', async () => {
  getGlobalScope().setAttribute('account', ADDRESS);
  logOperationStep('swap', 'request_build', 'ok');
  await flushLogs();
  expect(wireLogs()).toEqual([]);
  expect(bodies.join('\n')).not.toContain(ADDRESS);
});

it('sends no log a caller outside the closed vocabulary hands the client', async () => {
  captureDiagnosticLog('operation_step', { operation: 'swap', step: ADDRESS, outcome: 'ok' });
  captureDiagnosticLog(`swap ${AMOUNT}`, { operation: 'swap', outcome: 'completed' });
  await flushLogs();
  expect(wireLogs()).toEqual([]);
});

it('sends nothing without crash-report permission', async () => {
  jest.mocked(isCrashReportingEnabledAsync).mockResolvedValue(false);
  logOperationStep('swap', 'request_build', 'ok');
  await flushLogs();
  expect(bodies).toEqual([]);
});

it('discards buffered records when reporting stops before they are sent', async () => {
  logOperationStep('swap', 'request_build', 'ok');
  await jest.advanceTimersByTimeAsync(0);
  stopCrashReporting();
  await flushLogs();
  expect(wireLogs()).toEqual([]);
});

it('leaves crash reports as they were, beside the records', async () => {
  logOperationStep('swap', 'proposal_create', 'failed');
  captureCrash(new Error('proposal failed'));
  await flushLogs();
  expect(wireLogs()).toHaveLength(1);
  const eventItems = bodies.flatMap(body => body.split('\n')).filter(line => line.includes('"type":"event"'));
  expect(eventItems).toHaveLength(1);
});

it('gives a crash report the same trace id as the records sent before it', async () => {
  logOperationStep('swap', 'proposal_execute', 'failed');
  captureCrash(new Error('proposal failed'));
  await flushLogs();
  const traceId = wireLogs()[0]?.trace_id;
  expect(traceId).toMatch(/^[0-9a-f]{32}$/);
  const events = bodies.flatMap(body => {
    const lines = body.split('\n');
    return lines.flatMap((line, index) =>
      line.includes('"type":"event"') ? [JSON.parse(lines[index + 1] ?? '{}')] : []
    );
  });
  expect(events).toHaveLength(1);
  expect(events[0]?.contexts?.trace?.trace_id).toBe(traceId);
});
