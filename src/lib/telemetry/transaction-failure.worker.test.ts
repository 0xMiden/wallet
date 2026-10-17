/** @jest-environment node */
import { isIOS } from 'lib/platform';
import { signHotDigest } from 'lib/secure-hot-key';
import { HotKey } from 'lib/secure-hot-key/hotKeyPlugin';
import { isTelemetryEnabledAsync } from 'lib/settings/helpers';

import { stopCrashReporting } from './crash';
import { reportTransactionFailure } from './transaction-failure';

jest.mock('lib/settings/helpers', () => ({ isTelemetryEnabledAsync: jest.fn() }));
jest.mock('lib/platform', () => ({ ...jest.requireActual('lib/platform'), isIOS: jest.fn(() => false) }));
jest.mock('lib/secure-hot-key/hotKeyPlugin', () => ({ HotKey: { signWithHotKey: jest.fn() } }));
jest.mock('lib/secure-hot-key/jsFallback', () => ({}));

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

it('sends why a claim failed without the failure text, an account id or a URL', async () => {
  const account = 'mtst1aqsjql4cyylvpu2d2cwpxumpvvw5depe';
  const url = 'https://guardian.example.org/v1/proposals';
  // The shape of @openzeppelin/guardian-client's GuardianHttpError, which jest maps to a stub.
  const refusal = Object.assign(new Error(`GUARDIAN HTTP error 409: Conflict - stale state for ${account} at ${url}`), {
    name: 'GuardianHttpError',
    status: 409,
    statusText: 'Conflict',
    code: 'commitment_mismatch',
    rawCode: 'commitment_mismatch'
  });
  reportTransactionFailure({
    type: 'consume',
    stage: 'creating-proposal',
    error: new Error(`claim for ${account} failed`, { cause: refusal })
  });
  jest.mocked(isIOS).mockReturnValueOnce(true);
  jest
    .mocked(HotKey.signWithHotKey)
    .mockRejectedValueOnce(
      Object.assign(new Error(`Authentication failed: ${account} ${url}`), { code: 'AUTH_FAILED' })
    );
  const rejection = await signHotDigest('tag:wrapped', '0x01').catch((error: unknown) => error);
  reportTransactionFailure({ type: 'consume', stage: 'signing-proposal', error: rejection });
  reportTransactionFailure({
    type: 'consume',
    stage: 'signing-proposal',
    reason: 'user_cancelled',
    error: new Error(`cancelled while signing for ${account} at ${url}`)
  });
  await settle();
  expect(captured).toHaveLength(3);
  const wire = captured.join('\n');
  expect(wire).toContain('guardian_http_409; guardian code commitment_mismatch');
  expect(wire).toContain('hot_key; hot key code AUTH_FAILED');
  expect(wire).toContain('point pipeline; user_cancelled');
  for (const leak of [
    account,
    url,
    'guardian.example.org',
    'stale state',
    'Authentication failed',
    'cancelled while'
  ]) {
    expect(wire).not.toContain(leak);
  }
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
