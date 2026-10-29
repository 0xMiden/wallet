/** @jest-environment node */
import { OperationAbortedError } from 'lib/miden/back/offscreen-codec';
import { isIOS } from 'lib/platform';
import { signHotDigest } from 'lib/secure-hot-key';
import { HotKey } from 'lib/secure-hot-key/hotKeyPlugin';
import { isCrashReportingEnabledAsync, isTelemetryEnabledAsync } from 'lib/settings/helpers';

import { captureCrash, stopCrashReporting } from './crash';
import { annotateOffscreenDeadline } from './offscreen-deadline-diagnostics';
import { reportTransactionFailure } from './transaction-failure';

jest.mock('lib/settings/helpers', () => ({
  ...jest.requireActual<typeof import('lib/settings/helpers')>('lib/settings/helpers'),
  isCrashReportingEnabledAsync: jest.fn(),
  isTelemetryEnabledAsync: jest.fn()
}));
jest.mock('lib/platform', () => ({ ...jest.requireActual('lib/platform'), isIOS: jest.fn(() => false) }));
jest.mock('lib/secure-hot-key/hotKeyPlugin', () => ({ HotKey: { signWithHotKey: jest.fn() } }));
jest.mock('lib/secure-hot-key/jsFallback', () => ({}));

const captured: string[] = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SENTRY_DSN = 'https://publickey@o0.ingest.de.sentry.io/1';
  captured.length = 0;
  jest.mocked(isCrashReportingEnabledAsync).mockResolvedValue(true);
  jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(false);
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

it('sends a handled failure without usage consent, window, document, or frontend initialization', async () => {
  expect(typeof window).toBe('undefined');
  expect(typeof document).toBe('undefined');
  reportTransactionFailure({ type: 'execute', stage: 'executing', error: 'advice stack read failed' });
  await settle();
  expect(captured).toHaveLength(1);
  expect(captured[0]).toContain('WalletTransactionFailure');
  expect(captured[0]).toContain('advice_stack_read_failed');
  expect(captured[0]).not.toContain('/Users/');
  expect(captured[0]).toContain('"frames":[]');
  expect(isTelemetryEnabledAsync).not.toHaveBeenCalled();
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

it('sends an unknown submit outcome as a warning and only a final failure as an error', async () => {
  const transactionId = `0x${'5c'.repeat(32)}`;
  reportTransactionFailure({
    type: 'consume',
    stage: 'submitting',
    outcome: 'unconfirmed',
    hiddenDuringSubmit: true,
    error: new Error(
      `failed to submit proven transaction: submission of transaction ${transactionId} came back without a definite ` +
        'outcome, so the node may or may not have accepted it; nothing was recorded locally: grpc request failed for ' +
        'submit_proven_transaction: unknown error: JS API error: TypeError: Load failed'
    )
  });
  await settle();
  reportTransactionFailure({
    type: 'consume',
    stage: 'submitting',
    point: 'node_verdict',
    reason: 'never_committed',
    neverCommittedRule: 'superseded',
    error: 'The network confirmed this transaction never went through, so nothing moved. It is safe to retry.'
  });
  await settle();
  expect(captured).toHaveLength(2);
  const [unconfirmed, failed] = captured;
  expect(unconfirmed).toContain(
    'submit_outcome_unknown; endpoint submit_proven_transaction; grpc unknown; app hidden during submit yes; submit leg unavailable. '
  );
  expect(unconfirmed).toContain('"level":"warning"');
  expect(unconfirmed).not.toContain('"level":"error"');
  expect(failed).toContain('point node_verdict; never_committed; rule superseded');
  expect(failed).not.toContain('submit leg');
  expect(failed).toContain('"level":"error"');
  expect(failed).not.toContain('"level":"warning"');
  for (const leak of [transactionId, 'Load failed', 'never went through'])
    expect(captured.join('\n')).not.toContain(leak);
});

it('sends why an execution or a sync was stopped without an id, a note commitment or the operation id', async () => {
  const commitment = `0x${'9a'.repeat(32)}`;
  const opId = '3f2c8a9e-1b4d-4c6e-9a7b-2d5e8f0c1a3b';
  reportTransactionFailure({
    type: 'consume',
    stage: 'creating-proposal',
    error: new Error(
      `failed to execute transaction: invalid transaction request: note with details commitment ${commitment} has already been consumed`
    )
  });
  reportTransactionFailure({
    type: 'consume',
    stage: 'syncing',
    error: Object.assign(new Error(`Offscreen operation ${opId} aborted (deadline)`), {
      name: 'OperationAbortedError',
      reason: 'deadline'
    })
  });
  await settle();
  expect(captured).toHaveLength(2);
  const wire = captured.join('\n');
  expect(wire).toContain('stage signing; signing step creating_proposal');
  expect(wire).toContain('transaction_execution_failed; cause request_note_consumed');
  expect(wire).toContain('point pipeline; offscreen_aborted_deadline');
  for (const leak of [commitment, opId, 'has already been consumed', 'aborted (deadline)']) {
    expect(wire).not.toContain(leak);
  }
});

it('drops a report if browser permission is revoked while the event is being prepared', async () => {
  jest.mocked(isCrashReportingEnabledAsync).mockResolvedValueOnce(true).mockResolvedValue(false);
  reportTransactionFailure({ type: 'send', stage: 'submitting', error: 'RPC rejected submission' });
  await settle();
  expect(captured).toHaveLength(0);
});

it('drops an old pending failure after reporting is stopped and initialized again', async () => {
  let resolvePermission!: (enabled: boolean) => void;
  jest
    .mocked(isCrashReportingEnabledAsync)
    .mockImplementationOnce(() => new Promise(resolve => (resolvePermission = resolve)));
  reportTransactionFailure({ type: 'execute', stage: 'executing' });
  stopCrashReporting();
  resolvePermission(true);
  await settle();
  expect(captured).toHaveLength(0);

  reportTransactionFailure({ type: 'send', stage: 'submitting' });
  await settle();
  expect(captured).toHaveLength(1);
});

it('does not initialize or send when browser permission is denied or unreadable', async () => {
  jest
    .mocked(isCrashReportingEnabledAsync)
    .mockResolvedValueOnce(false)
    .mockRejectedValueOnce(new Error('permissions'));
  reportTransactionFailure({ type: 'send' });
  reportTransactionFailure({ type: 'consume' });
  await settle();
  expect(captured).toHaveLength(0);
  expect(isCrashReportingEnabledAsync).toHaveBeenCalledTimes(2);
});

it('drops an envelope waiting on transport permission when its client is stopped', async () => {
  let resolvePermission!: (enabled: boolean) => void;
  jest
    .mocked(isCrashReportingEnabledAsync)
    .mockResolvedValueOnce(true)
    .mockImplementationOnce(() => new Promise(resolve => (resolvePermission = resolve)));
  reportTransactionFailure({ type: 'execute', stage: 'executing' });
  await settle();
  expect(resolvePermission).toBeDefined();
  stopCrashReporting();
  resolvePermission(true);
  await settle();
  expect(captured).toHaveLength(0);

  reportTransactionFailure({ type: 'send', stage: 'submitting' });
  await settle();
  expect(captured).toHaveLength(1);
});

// BREAD-WALLET-T: published names the recovery-phrase guard read as four wordlist words in a row, which blanked the
// whole report.
it.each([
  ['ERR_NETWORK_ACCOUNT_FEE_ASSET_NOT_NATIVE', '10934363112317927'],
  ['ERR_ACCOUNT_UPGRADE_CODE_ALREADY_SET', '11920212034299147371'],
  ['ERR_NEW_MAX_SUPPLY_BELOW_TOKEN_SUPPLY', '12945332764232818723'],
  ['ERR_LINK_MAP_ENTRY_PTR_IS_OUTSIDE_VALID_MEMORY_REGION', '13712374589788902863'],
  ['ERR_TX_COMPUTE_FEE_EXCLUDE_NOTE_INDEX_OUT_OF_BOUNDS', '16522169966048288548'],
  ['ERR_AUTH_TX_FEE_COLLECTOR_NOTE_MUST_CARRY_ONE_ASSET', '3967837829084778662'],
  ['ERR_TX_COMPUTE_FEE_EXCLUDE_NOTE_INDEX_NOT_U32', '4717112193625091296'],
  ['ERR_INPUT_NOTE_ASSET_INDEX_OUT_OF_BOUNDS', '941128193447999117']
])('sends a report naming %s intact', async (name, code) => {
  reportTransactionFailure({
    type: 'execute',
    stage: 'creating-proposal',
    error: new Error(`failed to execute transaction: assertion failed with error code: ${code}`)
  });
  await settle();
  expect(captured).toHaveLength(1);
  // The report's own text: the envelope's event line also holds a trace context the scrub always redacts.
  const event = JSON.parse(captured[0]!.split('\n')[2]!) as { exception: { values: { value: string }[] } };
  const report = event.exception.values[0]!.value;
  expect(report).toContain(`; point pipeline; ${name}. authentication preparation`);
  expect(report).not.toContain('[redacted]');
  expect(report).not.toContain(code);
});

it('sends none of a recovery phrase a report carries beside a closed name', async () => {
  const phrase = 'avoid leave side crush call gasp confirm deal student link chunk interest';
  const name = 'ERR_INPUT_NOTE_ASSET_INDEX_OUT_OF_BOUNDS';
  captureCrash(new Error(`point pipeline; ${name}. ${phrase}`), 'manual', {
    initializeIfNeeded: true,
    closedNames: new Set([name])
  });
  await settle();
  const wire = captured.join('\n');
  for (const word of ['avoid leave side', 'crush', 'gasp', 'student', 'interest']) expect(wire).not.toContain(word);
  expect(wire).not.toContain(name);
});

it('serializes only independent closed deadline queue and reap evidence without private producer values', async () => {
  const privateValue = 'mtst1aqsjql4cyylvpu2d2cwpxumpvvw5depe';
  const abort = new OperationAbortedError(privateValue, 'deadline', {
    started: true,
    deadline: { owner: 'own', timer: 'started', killer: 'write' }
  });
  annotateOffscreenDeadline(abort, {
    offscreenDeadlineMethod: 'guardianPipeline',
    offscreenDeadlineStage: 'submitting'
  });
  reportTransactionFailure({ type: 'send', stage: 'proving', error: abort });
  reportTransactionFailure({
    type: 'consume',
    stage: 'creating-proposal',
    reason: 'queued_expired',
    queueAdmissionObservation: 'in_progress_gate',
    queueSighting: 'selected',
    preflightSync: 'entered',
    queueHidden: 'under_half',
    error: new Error(privateValue)
  });
  reportTransactionFailure({
    type: 'execute',
    stage: 'proving',
    reason: 'stuck_reaped',
    reap: { age: 'past_limit', attempt: 'not_started_here', startRelation: 'before_realm_cutoff' },
    error: new Error(privateValue)
  });
  await settle();
  expect(captured).toHaveLength(3);
  const wire = captured.join('\n');
  expect(wire).toContain('offscreenDeadlineMethod');
  expect(wire).toContain('guardianPipeline');
  expect(wire).toContain('submitting');
  expect(wire).toContain('queueAdmissionObservation');
  expect(wire).toContain('in_progress_gate');
  expect(wire).toContain('queueSighting');
  expect(wire).toContain('queue sighting selected');
  expect(wire).toContain('preflightSync');
  expect(wire).toContain('sync attempt entered');
  expect(wire).toContain('queueHidden');
  expect(wire).toContain('queue hidden under_half');
  expect(wire).toContain('reapStartRelation');
  expect(wire).toContain('before_realm_cutoff');
  expect(wire).not.toContain(privateValue);
});

it.each(['user_cancelled', 'queued_expired', 'stuck_reaped'] as const)(
  'omits deadline progress from the final wire when effective identity is %s',
  async reason => {
    const error = new OperationAbortedError('private-operation', 'deadline', {
      started: true,
      deadline: { owner: 'own', timer: 'started', killer: 'write' }
    });
    annotateOffscreenDeadline(error, {
      offscreenDeadlineMethod: 'guardianPipeline',
      offscreenDeadlineStage: 'proving'
    });
    reportTransactionFailure({ type: 'send', stage: 'proving', reason, error });
    await settle();
    expect(captured).toHaveLength(1);
    const wire = captured[0]!;
    expect(wire).toContain(reason);
    expect(wire).not.toContain('offscreenDeadlineMethod');
    expect(wire).not.toContain('offscreenDeadlineStage');
    expect(wire).not.toContain('private-operation');
  }
);
