/** @jest-environment node */
import { isTelemetryEnabledAsync } from 'lib/settings/helpers';

import { stopCrashReporting } from './crash';
import { reportTransactionFailure } from './transaction-failure';

jest.mock('lib/settings/helpers', () => ({ isTelemetryEnabledAsync: jest.fn() }));

const captured: string[] = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SENTRY_DSN = 'https://publickey@o0.ingest.de.sentry.io/1';
  captured.length = 0;
  jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(true);
  globalThis.fetch = jest.fn(async (_input, options) => {
    captured.push(String(options?.body));
    return new Response('', { status: 200 });
  });
});

afterEach(() => {
  stopCrashReporting();
  globalThis.fetch = originalFetch;
});

async function settle() {
  for (let pass = 0; pass < 10; pass++) await new Promise(resolve => setTimeout(resolve, 0));
}

it('sends a handled failure with no window, document, or frontend initialization', async () => {
  expect(typeof window).toBe('undefined');
  expect(typeof document).toBe('undefined');
  reportTransactionFailure({ type: 'execute', stage: 'executing', error: 'advice stack read failed' });
  await settle();
  expect(captured).toHaveLength(1);
  expect(captured[0]).toContain('WalletTransactionFailure');
  expect(captured[0]).toContain('advice_stack_read_failed');
  expect(captured[0]).not.toContain('/Users/');
  expect(captured[0]).toContain('"frames":[]');
});

it('drops a report if consent is withdrawn while the event is being prepared', async () => {
  jest.mocked(isTelemetryEnabledAsync).mockResolvedValueOnce(true).mockResolvedValue(false);
  reportTransactionFailure({ type: 'send', stage: 'submitting', error: 'RPC rejected submission' });
  await settle();
  expect(captured).toHaveLength(0);
});

it('drops an old pending failure after reporting is stopped and consent is re-enabled', async () => {
  let resolveConsent!: (enabled: boolean) => void;
  jest.mocked(isTelemetryEnabledAsync).mockImplementationOnce(() => new Promise(resolve => (resolveConsent = resolve)));
  reportTransactionFailure({ type: 'execute', stage: 'executing' });
  stopCrashReporting();
  resolveConsent(true);
  await settle();
  expect(captured).toHaveLength(0);

  reportTransactionFailure({ type: 'send', stage: 'submitting' });
  await settle();
  expect(captured).toHaveLength(1);
});

it('does not initialize or send when consent is off or unreadable', async () => {
  jest.mocked(isTelemetryEnabledAsync).mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('storage'));
  reportTransactionFailure({ type: 'send' });
  reportTransactionFailure({ type: 'consume' });
  await settle();
  expect(captured).toHaveLength(0);
  expect(isTelemetryEnabledAsync).toHaveBeenCalledTimes(2);
});

it('drops an envelope waiting on transport consent when its client is stopped', async () => {
  let resolveConsent!: (enabled: boolean) => void;
  jest
    .mocked(isTelemetryEnabledAsync)
    .mockResolvedValueOnce(true)
    .mockImplementationOnce(() => new Promise(resolve => (resolveConsent = resolve)));
  reportTransactionFailure({ type: 'execute', stage: 'executing' });
  await settle();
  expect(resolveConsent).toBeDefined();
  stopCrashReporting();
  resolveConsent(true);
  await settle();
  expect(captured).toHaveLength(0);

  reportTransactionFailure({ type: 'send', stage: 'submitting' });
  await settle();
  expect(captured).toHaveLength(1);
});
