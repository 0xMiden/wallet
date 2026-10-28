import { GUARDIAN_ERROR_CODES } from '@openzeppelin/guardian-client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { OperationAbortedError } from 'lib/miden/back/offscreen-codec';
import { TRANSACTION_STAGES } from 'lib/miden/db/types';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';
import { isDesktop, isIOS } from 'lib/platform';
import { signHotDigest } from 'lib/secure-hot-key';
import { HotKey } from 'lib/secure-hot-key/hotKeyPlugin';
import { signHotDigest as fallbackSignHotDigest } from 'lib/secure-hot-key/jsFallback';
import {
  markReownNativeFailure,
  type ReownNativeFailure,
  REOWN_NATIVE_ORIGINS,
  REOWN_WALLET_RESPONSE_CODES,
  REOWN_REQUEST_AGES,
  REOWN_PUBLICATIONS,
  REOWN_BACKGROUND_ANSWERS
} from 'lib/walletconnect/native-request-failure';

import { resolveTelemetryContext } from './context';
import { captureCrash } from './crash';
import { annotateCrash, snapshotCrashDiagnostics } from './crash-diagnostics';
import assertions from './protocol-assertions.json';
import {
  ACCOUNT_AUTH_CODES,
  AUTH_LAYOUTS,
  AUTH_PREPARATIONS,
  CLAIM_FEE_ADMISSIONS,
  COMMITMENT_MATCHES,
  CONFIRMING_STEPS,
  CONSUME_DEFERRAL_CAUSES,
  CONSUME_ENTRY_POINTS,
  EXECUTION_CAUSES,
  EXECUTION_REALMS,
  FAILURE_OUTCOMES,
  FAILURE_PLATFORMS,
  FAILURE_POINTS,
  FAILURE_REASONS,
  HOT_KEY_CODES,
  NEVER_COMMITTED_RULES,
  PREFLIGHT_SYNC_REPORTS,
  QUEUE_AGE_BUCKETS,
  QUEUE_HIDDEN_BUCKETS,
  QUEUE_SIGHTINGS,
  SUBMIT_CROSSINGS,
  OFFSCREEN_DEADLINE_KILLERS,
  OFFSCREEN_DEADLINE_OWNERS,
  OFFSCREEN_DEADLINE_TIMERS,
  OFFSCREEN_OP_STARTED,
  PIPELINE_KILLS,
  PROOF_WAIT_BUCKETS,
  PROVING_PREFERENCES,
  REAP_AGES,
  REAPED_ATTEMPT_ORIGINS,
  REPORTED_IDENTITIES,
  reportTransactionFailure,
  SIGNING_STEPS,
  STARTUP_SELECTIONS,
  STORED_STAGE_AGES,
  SUBMIT_ENDPOINTS,
  SUBMIT_RECORDS,
  SUBMIT_GRPC_STATUSES,
  SUBMIT_HIDDEN_ANSWERS,
  SUBMIT_LEG_BUCKETS,
  SUBMIT_NODE_ERRORS,
  SUBMIT_UNKNOWN_OUTCOME_STATUSES,
  type TransactionFailure
} from './transaction-failure';
import { stepOfStage, TRANSACTION_OPERATIONS, TRANSACTION_STEPS } from './transaction-operation';
import { TELEMETRY_ERROR_KINDS } from './types';
// The shipped class, past the stub jest maps the package to, so the fields the report reads are the ones it sets.
import { GuardianHttpError } from '../../../node_modules/@openzeppelin/guardian-client/dist/http.js';

jest.mock('./crash', () => ({ captureCrash: jest.fn() }));
jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isIOS: jest.fn(() => false),
  isDesktop: jest.fn(() => false)
}));
jest.mock('./context', () => ({ resolveTelemetryContext: jest.fn() }));
jest.mock('lib/secure-hot-key/hotKeyPlugin', () => ({ HotKey: { signWithHotKey: jest.fn() } }));
jest.mock('lib/secure-hot-key/jsFallback', () => ({ signHotDigest: jest.fn() }));

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

const reportedMessage = async (): Promise<string> => {
  await settle();
  return (jest.mocked(captureCrash).mock.calls[0]![0] as Error).message;
};

// The message of the `index`th captured report, shown to be there first: a missing report fails this assertion.
const capturedMessage = (index: number): string => {
  const error: unknown = jest.mocked(captureCrash).mock.calls[index]?.[0];
  expect(error).toBeInstanceOf(Error);
  return error instanceof Error ? error.message : '';
};

const REPO_ROOT = join(__dirname, '..', '..', '..');

const THROWN_CLASS_VALUES = [
  'wasm_runtime_error',
  'type_error',
  'range_error',
  'reference_error',
  'syntax_error',
  'error',
  'string',
  'non_error',
  'none'
] as const;

// Jest maps @openzeppelin/guardian-client to a stub, so this builds the shape its GuardianHttpError has: the code
// normalized to the published list (null otherwise), the wire code verbatim, both null without a JSON envelope.
const guardianRefusal = (status: number, statusText: string, code: string | null, rawCode = code) =>
  Object.assign(new Error(`GUARDIAN HTTP error ${status}: ${statusText} - refused at https://guardian.example.org`), {
    name: 'GuardianHttpError',
    status,
    statusText,
    code,
    rawCode
  });

const hotKeyRejection = async (message: string, code?: string): Promise<unknown> => {
  jest.mocked(isIOS).mockReturnValueOnce(true);
  jest
    .mocked(HotKey.signWithHotKey)
    .mockRejectedValueOnce(Object.assign(new Error(message), code === undefined ? {} : { code }));
  return signHotDigest('tag:wrapped', '0x01').catch((error: unknown) => error);
};

const nativeHotKeyCodes = (): string[] => {
  const codes = new Set<string>();
  for (const source of [
    'android/app/src/main/java/com/miden/wallet/HotKeyPlugin.kt',
    'ios/App/App/HotKeyPlugin.swift'
  ]) {
    const text = readFileSync(join(REPO_ROOT, source), 'utf8');
    for (const match of text.matchAll(/,\s*"([A-Z][A-Z_]+)"\s*\)/g)) codes.add(match[1]!);
    for (const match of text.matchAll(/const val ERR_[A-Z_]+ = "([A-Z][A-Z_]+)"/g)) codes.add(match[1]!);
  }
  return [...codes].sort();
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(isDesktop).mockReturnValue(false);
  jest
    .mocked(resolveTelemetryContext)
    .mockReturnValue({ platform: 'extension', network: 'testnet', appVersion: '1.17.6' });
});

it('reports the screenshot assertion as a fixed diagnostic instead of redacted numeric text', async () => {
  reportTransactionFailure({
    type: 'execute',
    stage: 'executing',
    delegateTransaction: true,
    error: new Error("Offscreen call 'newTransaction' failed: assertion failed with error code: 15404814807981965102"),
    diagnostics: { authPreparation: 'provided', authLayout: 'guardian', commitmentMatch: 'guardian' }
  });
  await settle();
  const [error, source, options] = jest.mocked(captureCrash).mock.calls[0]!;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).name).toBe('WalletTransactionFailure');
  expect((error as Error).message).toContain('ERR_FEE_CONVERSION_INFO_COMMITMENT_MISMATCH');
  expect((error as Error).message).toContain('tx_dapp');
  expect((error as Error).message).toContain('executing');
  expect((error as Error).message).toContain('offscreen');
  expect((error as Error).message).toContain('guardian');
  expect(options).toEqual({ initializeIfNeeded: true, level: 'error', closedNames: expect.any(Set) });
  expect(source).toBe('manual');
});

it('hands crash scrubbing every closed name a report can carry, and nothing else', async () => {
  reportTransactionFailure({ type: 'send' });
  await settle();
  const closedNames = jest.mocked(captureCrash).mock.calls[0]?.[2]?.closedNames;
  const closedLists: ReadonlyArray<readonly string[]> = [
    Object.values(assertions),
    REPORTED_IDENTITIES,
    FAILURE_REASONS,
    NEVER_COMMITTED_RULES,
    SUBMIT_GRPC_STATUSES,
    SUBMIT_ENDPOINTS,
    SUBMIT_NODE_ERRORS,
    SUBMIT_HIDDEN_ANSWERS,
    ['under_9s', '9_to_11s', 'over_11s', 'unavailable'],
    ['under_half_window', 'over_half_window', 'past_window', 'unavailable'],
    THROWN_CLASS_VALUES,
    PIPELINE_KILLS,
    OFFSCREEN_DEADLINE_OWNERS,
    OFFSCREEN_DEADLINE_TIMERS,
    OFFSCREEN_DEADLINE_KILLERS,
    OFFSCREEN_OP_STARTED,
    EXECUTION_CAUSES,
    SIGNING_STEPS,
    CONFIRMING_STEPS,
    CONSUME_ENTRY_POINTS,
    CONSUME_DEFERRAL_CAUSES,
    CLAIM_FEE_ADMISSIONS,
    REAP_AGES,
    REAPED_ATTEMPT_ORIGINS,
    STARTUP_SELECTIONS,
    STORED_STAGE_AGES,
    QUEUE_AGE_BUCKETS,
    QUEUE_SIGHTINGS,
    PREFLIGHT_SYNC_REPORTS,
    QUEUE_HIDDEN_BUCKETS,
    SUBMIT_CROSSINGS,
    SUBMIT_RECORDS,
    ['none', 'unrecorded', 'unavailable', 'other'],
    HOT_KEY_CODES,
    GUARDIAN_ERROR_CODES,
    TELEMETRY_ERROR_KINDS,
    FAILURE_OUTCOMES,
    TRANSACTION_OPERATIONS,
    TRANSACTION_STEPS,
    EXECUTION_REALMS,
    PROVING_PREFERENCES,
    FAILURE_PLATFORMS,
    FAILURE_POINTS,
    AUTH_PREPARATIONS,
    AUTH_LAYOUTS,
    COMMITMENT_MATCHES,
    ACCOUNT_AUTH_CODES,
    REOWN_NATIVE_ORIGINS,
    REOWN_WALLET_RESPONSE_CODES,
    REOWN_REQUEST_AGES,
    REOWN_PUBLICATIONS,
    REOWN_BACKGROUND_ANSWERS,
    ['invalid_permissions']
  ];
  expect([...(closedNames ?? [])].sort()).toEqual([...new Set(closedLists.flat())].sort());
});

it('reports a failure already reported at warning, still as a failure', async () => {
  reportTransactionFailure({
    type: 'consume',
    stage: 'submitting',
    point: 'node_verdict',
    reason: 'never_committed',
    neverCommittedRule: 'superseded',
    alreadyReported: true
  });
  reportTransactionFailure({
    type: 'consume',
    point: 'node_verdict',
    reason: 'never_committed',
    alreadyReported: false
  });
  await settle();
  const [already, first] = jest.mocked(captureCrash).mock.calls;
  expect((already?.[0] as Error).message).toMatch(/^Transaction failed: tx_receive; stage submitting;/);
  expect(already?.[2]?.level).toBe('warning');
  expect(first?.[2]?.level).toBe('error');
});

// BREAD-WALLET-R: one blocked queue expired every claim behind it at once, each one an error.
it('reports a queued row the loop never started that expired at warning', async () => {
  reportTransactionFailure({
    type: 'consume',
    point: 'pipeline',
    reason: 'queued_expired',
    error: 'Transaction expired after being queued too long'
  });
  await settle();
  const [error, , options] = jest.mocked(captureCrash).mock.calls[0]!;
  expect((error as Error).message).toMatch(/^Transaction failed: tx_receive; stage unknown; realm unknown;/);
  expect((error as Error).message).toContain('; point pipeline; queued_expired. authentication');
  expect(options?.level).toBe('warning');
});

it.each([
  ['a requeued Guardian row that had started', { reason: 'queued_expired', stage: 'creating-proposal' }],
  ['another wallet reason on a row with no stage', { reason: 'user_cancelled' }],
  ['a failure with no reason on a row with no stage', {}]
] as const)('keeps %s at error', async (_name, fields) => {
  reportTransactionFailure({ type: 'consume', point: 'pipeline', ...fields });
  await settle();
  expect(jest.mocked(captureCrash).mock.calls[0]?.[2]?.level).toBe('error');
});

it('reports an unknown submit outcome at warning and a final failure at error', async () => {
  reportTransactionFailure({ type: 'consume', stage: 'submitting', outcome: 'unconfirmed' });
  reportTransactionFailure({ type: 'consume', stage: 'submitting', point: 'node_verdict' });
  reportTransactionFailure({ type: 'consume', stage: 'submitting', outcome: 'failed' });
  await settle();
  expect(jest.mocked(captureCrash).mock.calls.map(([, , options]) => options?.level)).toEqual([
    'warning',
    'error',
    'error'
  ]);
});

it('does not forward unknown assertion codes, error text, or poisoned metadata', async () => {
  const poison = 'wallet-owner-password@example.org';
  reportTransactionFailure({
    type: poison,
    stage: poison,
    error: new Error(`assertion failed with error code: 99887766554433221100 ${poison}`),
    diagnostics: { authPreparation: poison, authLayout: poison, commitmentMatch: poison, request: poison }
  } as never);
  await settle();
  const [error] = jest.mocked(captureCrash).mock.calls[0]!;
  const text = `${(error as Error).message} ${(error as Error).stack}`;
  expect(text).not.toContain(poison);
  expect(text).not.toContain('99887766554433221100');
  expect(text).toContain('kernel_assertion_outside_shipped_sources');
  expect(text).toContain('tx_other');
});

it('distinguishes an unknown outcome from a final failure', async () => {
  reportTransactionFailure({ type: 'send', outcome: 'unconfirmed' });
  await settle();
  expect((jest.mocked(captureCrash).mock.calls[0]![0] as Error).message).toContain('unconfirmed');
});

it('does not confuse local proving with execution in the offscreen document', async () => {
  reportTransactionFailure({
    type: 'send',
    delegateTransaction: false,
    error: "Offscreen call 'sendTransaction' failed: advice stack read failed"
  });
  await settle();
  const error = jest.mocked(captureCrash).mock.calls[0]![0] as Error;
  expect(error.message).toContain('realm offscreen');
  expect(error.message).toContain('proving preference local');
});

it('names the wallet reason a claim failed at its signing proposal', async () => {
  reportTransactionFailure({
    point: 'pipeline',
    type: 'consume',
    stage: 'signing-proposal',
    delegateTransaction: true,
    reason: 'user_cancelled',
    error: 'Transaction was cancelled by user'
  });
  const message = await reportedMessage();
  expect(message).toContain('tx_receive; stage signing;');
  expect(message).toContain('; point pipeline; user_cancelled. authentication preparation');
  expect(message).not.toContain('cancelled by user');
});

// BREAD-WALLET-G: a consume failed with ERR_RECLAIM_DISABLED, and nothing said which entry point had queued it.
it('names what queued a failed claim by a fixed value, and no id, address or note content', async () => {
  const noteId = '0x8c3a1f0e2b7d4c6a9e5f1b3d7a2c4e6f8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a';
  const accountId = '0xa1b2c3d4e5f60718293a4b5c6d7e8f';
  reportTransactionFailure({
    point: 'pipeline',
    type: 'consume',
    stage: 'creating-proposal',
    delegateTransaction: true,
    entryPoint: 'claim_all',
    lastDeferral: 'wallet_locked',
    feeAdmission: 'known_sufficient',
    error: new Error(
      `failed to create consume proposal for account ${accountId}: failed to execute transaction: note ${noteId} ` +
        'failed: assertion failed with error code: 6980628190221363142'
    )
  });
  const message = await reportedMessage();
  expect(message).toContain('tx_receive; stage signing;');
  expect(message).toContain(
    '; queued by claim_all; last deferral wallet_locked; claim fee admission known_sufficient; ' +
      'point pipeline; ERR_RECLAIM_DISABLED. '
  );
  for (const leak of [
    noteId,
    noteId.slice(2),
    accountId,
    accountId.slice(2),
    '6980628190221363142',
    'consume proposal'
  ]) {
    expect(message).not.toContain(leak);
  }
});

it.each([
  [undefined, 'unrecorded'],
  ['nonsense', 'other'],
  ['wallet-owner-password@example.org', 'other'],
  ['claim', 'claim']
])('reports claim entry point %s as %s', async (entryPoint, expected) => {
  const failure: TransactionFailure = { type: 'consume', error: 'failed' };
  Reflect.set(failure, 'entryPoint', entryPoint);
  reportTransactionFailure(failure);
  const message = await reportedMessage();
  expect(message).toContain(
    `; queued by ${expected}; last deferral none; claim fee admission unrecorded; point pipeline;`
  );
  expect(message).not.toContain('nonsense');
  expect(message).not.toContain('wallet-owner-password@example.org');
});

it.each([
  [undefined, undefined, 'none', 'unrecorded'],
  ['wallet_locked', 'known_sufficient', 'wallet_locked', 'known_sufficient'],
  ['nonsense', undefined, 'other', 'unrecorded'],
  [undefined, 'nonsense', 'none', 'other'],
  ['nonsense', 'nonsense', 'other', 'other']
])(
  'reports claim deferral %s and fee admission %s as %s and %s',
  async (lastDeferral, feeAdmission, expectedDeferral, expectedAdmission) => {
    const failure: TransactionFailure = { type: 'consume' };
    Reflect.set(failure, 'lastDeferral', lastDeferral);
    Reflect.set(failure, 'feeAdmission', feeAdmission);
    reportTransactionFailure(failure);
    const message = await reportedMessage();
    expect(message).toContain(`; last deferral ${expectedDeferral}; claim fee admission ${expectedAdmission}; point `);
    expect(message).not.toContain('nonsense');
  }
);

it('omits the claim-only segments from a send but keeps its recorded last deferral', async () => {
  reportTransactionFailure({
    type: 'send',
    entryPoint: 'claim',
    lastDeferral: 'wallet_locked',
    feeAdmission: 'known_sufficient'
  });
  const message = await reportedMessage();
  expect(message).not.toContain('queued by');
  expect(message).not.toContain('claim fee admission');
  expect(message).toMatch(/; platform (?:desktop|extension|ios|android); last deferral wallet_locked; point pipeline;/);
});

// Without a recorded deferral the segment is left out, so the existing non-consume groups keep their message.
it('adds no last deferral segment to a non-consume report that recorded none', async () => {
  reportTransactionFailure({ type: 'swap', reason: 'queued_expired' });
  expect(await reportedMessage()).not.toContain('last deferral');
});

it('names an unlisted non-consume deferral as other', async () => {
  const failure: TransactionFailure = { type: 'send', reason: 'queued_expired' };
  Reflect.set(failure, 'lastDeferral', 'nonsense');
  reportTransactionFailure(failure);
  expect(await reportedMessage()).toContain(
    '; last deferral other; queue sighting never; sync attempt not_entered; queue hidden unavailable; point pipeline;'
  );
});

it('names the queue facts of an expired row whose error carries ids, hex and amounts', async () => {
  const accountId = '0x7bfb0f38b0fafa103f86a80559417021';
  reportTransactionFailure({
    type: 'consume',
    reason: 'queued_expired',
    queueAge: '30m_to_1h',
    queueSighting: 'selected',
    preflightSync: 'entered',
    queueHidden: 'half_or_more',
    error: new Error(
      `claim ${AMOUNT} for ${accountId} note ${NOTE_ID} op ${OP_ID} failed: Load failed https://rpc.example/secret`
    )
  });
  const message = await reportedMessage();
  expect(message).toContain(
    '; queue age 30m_to_1h; queue sighting selected; sync attempt entered; queue hidden half_or_more; point pipeline; queued_expired.'
  );
  expectNoTransactionData(message);
});

it('sends only the fixed deferral of an expired send whose error carries ids, hex and amounts', async () => {
  const accountId = '0x7bfb0f38b0fafa103f86a805594170';
  const noteId = '0x' + 'ab12'.repeat(16);
  reportTransactionFailure({
    type: 'send',
    reason: 'queued_expired',
    lastDeferral: 'guardian_backpressure',
    error: new Error(`send of 1250000 to ${accountId} with note ${noteId} expired after 42 attempts`)
  });
  const message = await reportedMessage();
  expect(message).toContain(
    '; last deferral guardian_backpressure; queue sighting never; sync attempt not_entered; queue hidden unavailable; point pipeline; queued_expired.'
  );
  for (const leaked of [accountId, noteId, '1250000', '42 attempts', 'ab12']) expect(message).not.toContain(leaked);
});

it('places claim segments after platform and before the failure point in the first sentence', async () => {
  reportTransactionFailure({
    type: 'consume',
    entryPoint: 'claim',
    lastDeferral: 'wallet_locked',
    feeAdmission: 'known_sufficient',
    reason: 'queued_expired'
  });
  expect(await reportedMessage()).toMatch(
    /; platform (?:desktop|extension|ios|android); queued by claim; last deferral wallet_locked; claim fee admission known_sufficient; queue sighting never; sync attempt not_entered; queue hidden unavailable; point pipeline; queued_expired\. authentication/
  );
});

it('places reap segments after claim segments and before the failure point in the first sentence', async () => {
  reportTransactionFailure({
    type: 'consume',
    entryPoint: 'claim',
    lastDeferral: 'wallet_locked',
    feeAdmission: 'known_sufficient',
    reason: 'stuck_reaped',
    reap: { age: 'past_limit', attempt: 'not_started_here' }
  });
  expect(await reportedMessage()).toMatch(
    /; platform (?:desktop|extension|ios|android); queued by claim; last deferral wallet_locked; claim fee admission known_sufficient; reap age past_limit; reaped attempt not_started_here; point pipeline; stuck_reaped\. authentication/
  );
});

it('places reap segments after platform for a stuck send without adding claim segments', async () => {
  reportTransactionFailure({
    type: 'send',
    reason: 'stuck_reaped',
    reap: { age: 'past_limit', attempt: 'not_started_here' }
  });
  expect(await reportedMessage()).toMatch(
    /; platform (?:desktop|extension|ios|android); reap age past_limit; reaped attempt not_started_here; point pipeline; stuck_reaped\. authentication/
  );
});

it.each([
  { name: 'absent', reap: undefined, age: 'unavailable', attempt: 'unavailable' },
  {
    name: 'listed',
    reap: { age: 'missing_start', attempt: 'started_here' },
    age: 'missing_start',
    attempt: 'started_here'
  },
  { name: 'unlisted', reap: { age: 'nonsense', attempt: 'nonsense' }, age: 'unavailable', attempt: 'unavailable' },
  {
    name: 'unlisted age',
    reap: { age: 'nonsense', attempt: 'started_here' },
    age: 'unavailable',
    attempt: 'started_here'
  },
  {
    name: 'unlisted attempt',
    reap: { age: 'past_limit', attempt: 'nonsense' },
    age: 'past_limit',
    attempt: 'unavailable'
  }
])('reports $name reap fields through their closed lists', async ({ reap, age, attempt }) => {
  const failure: TransactionFailure = { type: 'consume', reason: 'stuck_reaped' };
  Reflect.set(failure, 'reap', reap);
  reportTransactionFailure(failure);
  const message = await reportedMessage();
  expect(message).toContain(`; reap age ${age}; reaped attempt ${attempt}; point pipeline; stuck_reaped.`);
  expect(message).not.toContain('nonsense');
});

it('places startup segments after platform and before the failure point for a startup-interrupted claim', async () => {
  reportTransactionFailure({
    type: 'consume',
    stage: 'signing-proposal',
    entryPoint: 'claim',
    reason: 'interrupted_on_startup',
    startup: { selection: 'before_session', stageAge: 'under_10m', submit: 'no_submit_recorded' }
  });
  expect(await reportedMessage()).toMatch(
    /; claim fee admission unrecorded; startup selection before_session; stored stage age under_10m; submit no_submit_recorded; point pipeline; interrupted_on_startup\. authentication/
  );
});

it.each([
  { name: 'absent', startup: undefined, selection: 'unavailable', age: 'unavailable', submit: 'unavailable' },
  {
    name: 'listed',
    startup: { selection: 'future_stamp', stageAge: 'over_1d', submit: 'submit_recorded' },
    selection: 'future_stamp',
    age: 'over_1d',
    submit: 'submit_recorded'
  },
  {
    name: 'unlisted',
    startup: { selection: 'nonsense', stageAge: 'nonsense', submit: 'nonsense' },
    selection: 'unavailable',
    age: 'unavailable',
    submit: 'unavailable'
  }
])('reports $name startup fields through their closed lists', async ({ startup, selection, age, submit }) => {
  const failure: TransactionFailure = { type: 'send', reason: 'interrupted_on_startup' };
  Reflect.set(failure, 'startup', startup);
  reportTransactionFailure(failure);
  const message = await reportedMessage();
  expect(message).toContain(
    `; startup selection ${selection}; stored stage age ${age}; submit ${submit}; point pipeline; interrupted_on_startup.`
  );
  expect(message).not.toContain('nonsense');
});

it.each(['stuck_reaped', 'user_cancelled', undefined] as const)(
  'omits startup segments for reason %s',
  async reason => {
    reportTransactionFailure({
      type: 'consume',
      reason,
      startup: { selection: 'missing_start', stageAge: 'under_1m', submit: 'submit_recorded' }
    });
    const message = await reportedMessage();
    expect(message).not.toContain('startup selection');
    expect(message).not.toContain('stored stage age');
  }
);

it.each(['queued_expired', 'user_cancelled', undefined] as const)('omits reap segments for reason %s', async reason => {
  reportTransactionFailure({
    type: 'consume',
    reason,
    reap: { age: 'past_limit', attempt: 'not_started_here' }
  });
  const message = await reportedMessage();
  expect(message).not.toContain('reap age');
  expect(message).not.toContain('reaped attempt');
});

it('sends a reason outside the wallet list as other', async () => {
  const poison = 'wallet-owner-password@example.org';
  reportTransactionFailure({ type: 'consume', reason: poison, error: 'Transaction was cancelled by user' } as never);
  const message = await reportedMessage();
  expect(message).not.toContain(poison);
  expect(message).toContain('; point pipeline; other. authentication preparation');
});

it('reports a Guardian refusal by its HTTP status and published code, through a wrapping error', async () => {
  reportTransactionFailure({
    type: 'consume',
    stage: 'creating-proposal',
    error: new Error('claim for mtst1aqsjql4cyylvpu2d2cwpxumpvvw5depe failed', {
      cause: guardianRefusal(409, 'Conflict', 'conflict_pending_delta')
    })
  });
  const message = await reportedMessage();
  expect(message).toContain('; point pipeline; guardian_http_409; guardian code conflict_pending_delta. ');
  expect(message).not.toContain('mtst1');
  expect(message).not.toContain('guardian.example.org');
  expect(message).not.toContain('Conflict');
});

it('reports a Guardian code outside the published list as other, and a refusal without one as none', async () => {
  reportTransactionFailure({ type: 'consume', error: guardianRefusal(409, 'Conflict', null, 'shard_7_overloaded') });
  reportTransactionFailure({ type: 'consume', error: guardianRefusal(409, 'Conflict', 'shard_7_overloaded') });
  reportTransactionFailure({ type: 'consume', error: guardianRefusal(502, 'Bad Gateway', null) });
  await settle();
  const [unknown, unlisted, none] = jest.mocked(captureCrash).mock.calls.map(([error]) => (error as Error).message);
  expect(unknown).toContain('; guardian_http_409; guardian code other. ');
  expect(unlisted).toContain('; guardian_http_409; guardian code other. ');
  expect(`${unknown} ${unlisted}`).not.toContain('shard_7');
  expect(none).toContain('; guardian_http_502; guardian code none. ');
});

it('reports the shipped GuardianHttpError by the status and code it sets, for a published and an unknown code', async () => {
  const envelope = (code: string) =>
    JSON.stringify({ code, message: 'account mtst1poison is paused', meta: { retryable: false } });
  reportTransactionFailure({
    type: 'consume',
    error: new GuardianHttpError(409, 'Conflict', envelope('GUARDIAN_ACCOUNT_PAUSED'))
  });
  reportTransactionFailure({
    type: 'consume',
    error: new GuardianHttpError(503, 'Service Unavailable', envelope('shard_7_overloaded'))
  });
  await settle();
  const [published, unknown] = jest.mocked(captureCrash).mock.calls.map(([error]) => (error as Error).message);
  expect(published).toContain('; point pipeline; guardian_http_409; guardian code account_paused. ');
  expect(unknown).toContain('; point pipeline; guardian_http_503; guardian code other. ');
  for (const text of [
    'Conflict',
    'Service Unavailable',
    'mtst1poison',
    'GUARDIAN_ACCOUNT_PAUSED',
    'shard_7',
    'retryable'
  ]) {
    expect(`${published} ${unknown}`).not.toContain(text);
  }
});

it.each([...GUARDIAN_ERROR_CODES])('reports the published Guardian code %s', async code => {
  reportTransactionFailure({ type: 'send', error: guardianRefusal(400, 'Bad Request', code) });
  expect(await reportedMessage()).toContain(`; guardian_http_400; guardian code ${code}. `);
});

it.each([
  ['a marked hot-key cause', () => hotKeyRejection('rejected', 'AUTH_FAILED'), '; hot_key; hot key code AUTH_FAILED. '],
  [
    'a Guardian cause',
    async () => guardianRefusal(409, 'Conflict', 'conflict_pending_delta'),
    '; guardian_http_409; guardian code conflict_pending_delta. '
  ]
] as const)('reports %s under a Guardian-shaped link whose status getter throws', async (_name, cause, identity) => {
  const hostile = Object.defineProperty(new Error('GUARDIAN HTTP error', { cause: await cause() }), 'status', {
    get: () => {
      throw new Error('hostile accessor');
    }
  });
  hostile.name = 'GuardianHttpError';
  reportTransactionFailure({ type: 'consume', error: hostile });
  await settle();
  expect(captureCrash).toHaveBeenCalledTimes(1);
  expect(await reportedMessage()).toContain(`; point pipeline${identity}`);
});

it.each([
  [100, 'Continue'],
  [599, 'Network Connect Timeout Error']
])('reports a Guardian status of %s, at an edge of the range, as its number', async (status, statusText) => {
  reportTransactionFailure({ type: 'consume', error: guardianRefusal(status, statusText, 'conflict_pending_delta') });
  expect(await reportedMessage()).toContain(
    `; point pipeline; guardian_http_${status}; guardian code conflict_pending_delta. `
  );
});

it.each([
  ['99', { status: 99 }],
  ['600', { status: 600 }],
  ['409.5', { status: 409.5 }],
  ["the string '409'", { status: '409' }],
  ['a missing status', {}]
])('reports a Guardian status of %s as other', async (_name, fields) => {
  const refusal = Object.assign(
    new Error('GUARDIAN HTTP error'),
    { name: 'GuardianHttpError', code: 'conflict_pending_delta', rawCode: 'conflict_pending_delta' },
    fields
  );
  reportTransactionFailure({ type: 'consume', error: refusal });
  const message = await reportedMessage();
  expect(message).toContain('; point pipeline; guardian_http_other; guardian code conflict_pending_delta. ');
  expect(message).not.toContain(`guardian_http_${String(Reflect.get(fields, 'status'))}`);
  expect(message).not.toContain('409.5');
});

it('reports a hot-key plugin rejection by its code and nothing it says', async () => {
  reportTransactionFailure({
    type: 'consume',
    stage: 'signing-proposal',
    error: await hotKeyRejection('Authentication cancelled', 'USER_CANCELLED')
  });
  const message = await reportedMessage();
  expect(message).toContain('; point pipeline; hot_key; hot key code USER_CANCELLED. ');
  expect(message).not.toContain('Authentication cancelled');
});

it.each([
  ['failed to execute transaction', ''],
  ['assertion failed with error code: 1', '; kernel_assertion_outside_shipped_sources'],
  ['advice stack read failed', ''],
  ['WebClient terminated', '']
])('reports a Guardian refusal whose text says "%s" by its status and code', async (text, protocol) => {
  const refusal = Object.assign(guardianRefusal(409, 'Conflict', 'conflict_pending_delta'), {
    message: `GUARDIAN HTTP error 409: Conflict - ${text}`
  });
  reportTransactionFailure({ type: 'consume', error: new Error(`claim failed: ${text}`, { cause: refusal }) });
  expect(await reportedMessage()).toContain(
    `; point pipeline; guardian_http_409; guardian code conflict_pending_delta${protocol}. `
  );
});

it('keeps the protocol identity a Guardian refusal carries after its status and code', async () => {
  const refusal = Object.assign(guardianRefusal(500, 'Internal Server Error', null), {
    message: 'GUARDIAN HTTP error 500: Internal Server Error - assertion failed with error code: 15404814807981965102'
  });
  reportTransactionFailure({ type: 'consume', error: refusal });
  const message = await reportedMessage();
  expect(message).toContain(
    '; point pipeline; guardian_http_500; guardian code none; ERR_FEE_CONVERSION_INFO_COMMITMENT_MISMATCH. '
  );
  expect(message).not.toContain('15404814807981965102');
});

it.each([
  ['a known code', 'claim failed', '15404814807981965102', 'ERR_FEE_CONVERSION_INFO_COMMITMENT_MISMATCH'],
  ['an unknown code', 'claim failed', '9876543210123', 'kernel_assertion_outside_shipped_sources'],
  [
    'a known code under a wrapper carrying another',
    'claim failed: assertion failed with error code: 10256002255343504776',
    '15404814807981965102',
    'ERR_FEE_CONVERSION_INFO_COMMITMENT_MISMATCH'
  ]
])(
  'reports the protocol identity a wrapped Guardian refusal carries, for %s',
  async (_name, wrapper, code, protocol) => {
    const refusal = Object.assign(guardianRefusal(500, 'Internal Server Error', null), {
      message: `GUARDIAN HTTP error 500: Internal Server Error - assertion failed with error code: ${code}`
    });
    reportTransactionFailure({ type: 'consume', error: new Error(wrapper, { cause: refusal }) });
    const message = await reportedMessage();
    expect(message).toContain(`; point pipeline; guardian_http_500; guardian code none; ${protocol}. `);
    expect(message).not.toContain(code);
    expect(message).not.toContain('ERR_PROLOGUE_KERNEL_PROCEDURE_COMMITMENT_MISMATCH');
  }
);

it("reports a wrapper's protocol identity after a Guardian refusal whose own message carries none", async () => {
  reportTransactionFailure({
    type: 'consume',
    error: new Error('claim failed: assertion failed with error code: 10256002255343504776', {
      cause: guardianRefusal(500, 'Internal Server Error', 'storage_error')
    })
  });
  const message = await reportedMessage();
  expect(message).toContain(
    '; point pipeline; guardian_http_500; guardian code storage_error; ERR_PROLOGUE_KERNEL_PROCEDURE_COMMITMENT_MISMATCH. '
  );
  expect(message).not.toContain('10256002255343504776');
  expect(message).not.toContain('guardian.example.org');
});

it('reports a hot-key rejection whose text says the client terminated by its code', async () => {
  reportTransactionFailure({ type: 'consume', error: await hotKeyRejection('WebClient terminated', 'DEVICE_LOCKED') });
  expect(await reportedMessage()).toContain('; point pipeline; hot_key; hot key code DEVICE_LOCKED. ');
});

it('reports a hot-key code outside the plugin list as other, and a rejection without one as none', async () => {
  reportTransactionFailure({ type: 'consume', error: await hotKeyRejection('vendor fault 0x1f', 'VENDOR_TEE_FAULT') });
  reportTransactionFailure({ type: 'consume', error: await hotKeyRejection('Unwrapped hot-key has wrong length') });
  await settle();
  const [other, none] = jest.mocked(captureCrash).mock.calls.map(([error]) => (error as Error).message);
  expect(other).toContain('; hot_key; hot key code other. ');
  expect(other).not.toContain('VENDOR_TEE_FAULT');
  expect(none).toContain('; hot_key; hot key code none. ');
  expect(none).not.toContain('wrong length');
});

it('reports a JS-fallback signing failure by its own identity, and only a native rejection as a device-key refusal', async () => {
  jest.mocked(fallbackSignHotDigest).mockRejectedValueOnce(new Error('invalid hot key blob'));
  const fallback = await signHotDigest('0a0b0c', '0x01').catch((error: unknown) => error);
  reportTransactionFailure({ type: 'consume', error: fallback });
  reportTransactionFailure({ type: 'consume', error: await hotKeyRejection('rejected', 'KEY_NOT_FOUND') });
  await settle();
  const [js, native] = jest.mocked(captureCrash).mock.calls.map(([error]) => (error as Error).message);
  expect(js).toContain('; point pipeline; validation. ');
  expect(js).not.toContain('hot_key');
  expect(native).toContain('; point pipeline; hot_key; hot key code KEY_NOT_FOUND. ');
});

it.each(nativeHotKeyCodes())('reports the native HotKey plugin code %s', async code => {
  reportTransactionFailure({ type: 'consume', error: await hotKeyRejection('rejected', code) });
  expect(await reportedMessage()).toContain(`; hot_key; hot key code ${code}. `);
});

it('reads the native code list it checks against', () => {
  expect(nativeHotKeyCodes()).toEqual(expect.arrayContaining(['HARDWARE_UNAVAILABLE', 'USER_CANCELLED']));
  expect(nativeHotKeyCodes().length).toBeGreaterThanOrEqual(12);
});

const ACCOUNT = 'mtst1aqsjql4cyylvpu2d2cwpxumpvvw5depe';
const ACCOUNT_HEX = '0x7bfb0f38b0fafa103f86a80559417021';
const TX_ID = `0x${'c4'.repeat(32)}`;
const NOTE_ID = `0x${'3e'.repeat(32)}`;
const NOTE_COMMITMENT = `0x${'9a'.repeat(32)}`;
const OP_ID = '3f2c8a9e-1b4d-4c6e-9a7b-2d5e8f0c1a3b';
const AMOUNT = '1500000';

const expectNoTransactionData = (message: string) => {
  for (const leak of ['0x', ACCOUNT, OP_ID, AMOUNT, 'https://', 'Load failed']) expect(message).not.toContain(leak);
};

// web-sdk 0.17.3 `submitProvenTransaction` over miden-client 0.17.3 `SubmissionOutcomeUnknown` and `RpcError`.
const submitOutcomeUnknown = (kind: string, endpoint = 'submit_proven_transaction') =>
  new Error(
    `failed to submit proven transaction: submission of transaction ${TX_ID} came back without a definite outcome, ` +
      'so the node may or may not have accepted it; nothing was recorded locally: grpc request failed for ' +
      `${endpoint}: ${kind}`
  );

// `cause` wrapped in `times` Errors, the outermost last.
const wrapIn = (cause: unknown, times: number): unknown =>
  times === 0 ? cause : wrapIn(new Error('opaque detail', { cause }), times - 1);

describe('a failure with no named identity', () => {
  it.each<[string, () => unknown, string]>([
    [
      'a wrapped WASM trap',
      () => new Error('opaque detail', { cause: new WebAssembly.RuntimeError('opaque trap') }),
      'wasm_runtime_error'
    ],
    [
      'a WASM trap five wrappers deep',
      () => wrapIn(new WebAssembly.RuntimeError('opaque trap'), 5),
      'wasm_runtime_error'
    ],
    ['a string under a wrapper', () => new Error('opaque detail', { cause: 'opaque cause' }), 'string'],
    ['a number under a wrapper', () => new Error('opaque detail', { cause: 42 }), 'non_error'],
    ['an Error whose cause is undefined', () => new Error('opaque detail', { cause: undefined }), 'error'],
    ['a type error', () => new TypeError('opaque detail'), 'type_error'],
    ['a range error', () => new RangeError('opaque detail'), 'range_error'],
    ['a reference error', () => new ReferenceError('opaque detail'), 'reference_error'],
    ['a syntax error', () => new SyntaxError('opaque detail'), 'syntax_error'],
    ['an Error', () => new Error('opaque detail'), 'error'],
    ['a string', () => 'opaque detail', 'string'],
    ['undefined', () => undefined, 'none'],
    ['null', () => null, 'none'],
    ['an object', () => ({}), 'non_error'],
    ['a number', () => 42, 'non_error'],
    ['an unlisted name', () => Object.assign(new Error('opaque detail'), { name: 'constructor' }), 'error'],
    [
      'a throwing name accessor',
      () =>
        Object.defineProperty(new Error('opaque detail'), 'name', {
          get: () => {
            throw new Error('hostile accessor');
          }
        }),
      'error'
    ],
    [
      'a throwing cause accessor',
      () =>
        Object.defineProperty(new TypeError('opaque detail'), 'cause', {
          get: () => {
            throw new Error('hostile accessor');
          }
        }),
      'type_error'
    ]
  ])('names the thrown class for %s without sending its text', async (_name, error, thrown) => {
    reportTransactionFailure({ type: 'execute', stage: 'executing', error: error() });
    const message = await reportedMessage();
    expect(message).toContain(`; point pipeline; unknown; thrown ${thrown}. authentication`);
    expect(message).not.toContain('opaque');
    expect(message).not.toContain('constructor');
    expect(message).not.toContain('hostile accessor');
  });

  it.each([
    [true, 'yes'],
    [false, 'no'],
    [undefined, 'unavailable']
  ] as const)('at submitting, includes the hidden answer %s and submit leg', async (hiddenDuringSubmit, answer) => {
    reportTransactionFailure({
      type: 'execute',
      stage: 'submitting',
      error: new Error('opaque detail'),
      hiddenDuringSubmit,
      submitLegMs: 9500
    });
    expect(await reportedMessage()).toContain(
      `; point pipeline; unknown; thrown error; app hidden during submit ${answer}; submit leg 9_to_11s. authentication`
    );
  });

  it.each<[number | undefined, string]>([
    [0, 'under_9s'],
    [8999, 'under_9s'],
    [9000, '9_to_11s'],
    [11000, '9_to_11s'],
    [11001, 'over_11s'],
    [undefined, 'unavailable'],
    [-1, 'unavailable'],
    [NaN, 'unavailable'],
    [Infinity, 'unavailable'],
    [-Infinity, 'unavailable']
  ])('at submitting, reports %s ms as %s without sending the duration', async (submitLegMs, bucket) => {
    reportTransactionFailure({ type: 'send', stage: 'submitting', error: new Error('opaque detail'), submitLegMs });
    const message = await reportedMessage();
    expect(message).toContain(
      `; unknown; thrown error; app hidden during submit unavailable; submit leg ${bucket}. authentication`
    );
    expect(message).not.toMatch(/submitLegMs|\b(?:8999|9000|11000|11001|NaN|Infinity)\b/);
  });

  it.each([...TRANSACTION_STAGES.filter(stage => stage !== 'submitting'), undefined])(
    'at %s, stops after the thrown class even with submit measurements',
    async stage => {
      reportTransactionFailure({
        type: 'execute',
        stage,
        error: new Error('opaque detail'),
        hiddenDuringSubmit: true,
        submitLegMs: 9500
      });
      const message = await reportedMessage();
      expect(message).toContain('; point pipeline; unknown; thrown error. authentication');
      expect(message).not.toContain('app hidden during submit');
      expect(message).not.toContain('submit leg');
    }
  );

  it('enriches only unknown, keeping timeout and wallet identities unchanged at submitting', async () => {
    for (const fields of [
      { error: new Error('opaque detail') },
      { error: new Error('request timed out') },
      { reason: 'user_cancelled', error: new TypeError('opaque detail') }
    ] as const) {
      reportTransactionFailure({
        type: 'send',
        stage: 'submitting',
        hiddenDuringSubmit: false,
        submitLegMs: 9500,
        ...fields
      });
    }
    await settle();
    expect(capturedMessage(0)).toContain(
      '; unknown; thrown error; app hidden during submit no; submit leg 9_to_11s. authentication'
    );
    expect(capturedMessage(1)).toContain('; point pipeline; timeout. authentication');
    expect(capturedMessage(2)).toContain('; point pipeline; user_cancelled. authentication');
  });
});

it.each([
  ['exact', () => new Error('Client terminated')],
  ['wrapped', () => new Error('Transaction failed', { cause: new Error('Client terminated') })],
  ['five-wrappers-deep', () => wrapIn(new Error('Client terminated'), 5)]
] as const)('names an %s Client terminated as client_terminated', async (_name, error) => {
  reportTransactionFailure({
    type: 'execute',
    stage: 'submitting',
    error: error(),
    hiddenDuringSubmit: false,
    submitLegMs: 9500
  });
  expect(await reportedMessage()).toContain('; point pipeline; client_terminated. authentication');
});

it('reads a bounded stretch of a cause chain whose accessor keeps returning new links', async () => {
  let reads = 0;
  // Stops itself after 10000 reads so an unbounded walk ends too and the read count can say what it did.
  const endless = (): object => ({
    get cause() {
      reads += 1;
      return reads < 10000 ? endless() : undefined;
    }
  });
  // Four wrappers keep the eviction past the kill identity's four links, and the pipeline's kill check stops at it.
  const error = wrapIn(new WasmClientPoisonedError('watchdog', endless()), 4);
  reportTransactionFailure({ type: 'execute', stage: 'executing', error });
  expect(await reportedMessage()).toContain('; point pipeline; unknown; thrown non_error. authentication');
  expect(reads).toBeLessThan(200);
});

it.each<[string, () => object]>([
  [
    'a revoked Proxy',
    () => {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      return proxy;
    }
  ],
  [
    'a Proxy whose prototype read throws',
    () =>
      new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw new Error('hostile trap');
          }
        }
      )
  ]
])('still reports a failure whose cause is %s, as a thrown non_error', async (_name, cause) => {
  reportTransactionFailure({
    type: 'execute',
    stage: 'executing',
    error: new Error('opaque detail', { cause: cause() })
  });
  await settle();
  expect(capturedMessage(0)).toContain('; point pipeline; unknown; thrown non_error. authentication');
});

describe('an unknown submit outcome', () => {
  it('sends a status outside the unknown-outcome list as other', async () => {
    reportTransactionFailure({
      type: 'consume',
      stage: 'submitting',
      outcome: 'unconfirmed',
      hiddenDuringSubmit: false,
      error: submitOutcomeUnknown(`resource not found: ${ACCOUNT_HEX}`)
    });
    const message = await reportedMessage();
    expect(message).toContain(
      '; submit_outcome_unknown; endpoint submit_proven_transaction; grpc other; app hidden during submit no; submit leg unavailable. '
    );
    expect(message).not.toContain('not_found');
  });

  it('includes the source-known RPC endpoint and no raw request data', async () => {
    reportTransactionFailure({
      type: 'consume',
      stage: 'submitting',
      outcome: 'unconfirmed',
      hiddenDuringSubmit: false,
      error: submitOutcomeUnknown(
        `request to Miden node timed out; the node may be under heavy load ${ACCOUNT} ${AMOUNT} ${TX_ID} https://rpc.testnet.miden.io`,
        'get_transaction_encryption_key'
      )
    });
    const message = await reportedMessage();
    expect(message).toContain(
      '; point pipeline; submit_outcome_unknown; endpoint get_transaction_encryption_key; grpc deadline_exceeded; app hidden during submit no; submit leg unavailable. authentication'
    );
    expectNoTransactionData(message);
  });

  it.each([
    [
      'unavailable',
      'Miden node is unavailable; check that the node is running and reachable: transport error at https://rpc.testnet.miden.io'
    ],
    ['unknown', 'unknown error: JS API error: TypeError: Load failed'],
    ['internal', `Miden node returned an internal error; this is likely a node-side issue: nonce of ${ACCOUNT_HEX}`],
    ['cancelled', 'operation was cancelled'],
    ['aborted', 'operation was aborted'],
    ['data_loss', 'unrecoverable data loss or corruption'],
    ['deadline_exceeded', 'request to Miden node timed out; the node may be under heavy load'],
    ['other', `upstream proxy refused ${AMOUNT} bytes for ${ACCOUNT}`]
  ])('names gRPC status %s and nothing the SDK said', async (status, kind) => {
    reportTransactionFailure({
      type: 'consume',
      stage: 'submitting',
      outcome: 'unconfirmed',
      hiddenDuringSubmit: false,
      error: submitOutcomeUnknown(kind)
    });
    const message = await reportedMessage();
    expect(message).toContain(
      `; point pipeline; submit_outcome_unknown; endpoint submit_proven_transaction; grpc ${status}; app hidden during submit no; submit leg unavailable. authentication`
    );
    expectNoTransactionData(message);
  });

  it.each([
    [true, 'yes'],
    [false, 'no'],
    [undefined, 'unavailable']
  ])('says whether the app was hidden during the submit (%s reads %s)', async (hiddenDuringSubmit, answer) => {
    reportTransactionFailure({
      type: 'send',
      stage: 'submitting',
      outcome: 'unconfirmed',
      hiddenDuringSubmit,
      error: new Error("Offscreen call 'guardianPipeline' failed", {
        cause: submitOutcomeUnknown('Miden node is unavailable; check that the node is running and reachable')
      })
    });
    const message = await reportedMessage();
    expect(message).toContain(
      `; submit_outcome_unknown; endpoint submit_proven_transaction; grpc unavailable; app hidden during submit ${answer}; submit leg unavailable. `
    );
    expectNoTransactionData(message);
  });

  it.each<[number | undefined, string]>([
    [0, 'under_9s'],
    [8999, 'under_9s'],
    [9000, '9_to_11s'],
    [11000, '9_to_11s'],
    [11001, 'over_11s'],
    [undefined, 'unavailable'],
    [-1, 'unavailable'],
    [NaN, 'unavailable'],
    [Infinity, 'unavailable'],
    [-Infinity, 'unavailable']
  ])('reports a submit leg of %s ms as %s without sending the duration', async (submitLegMs, bucket) => {
    reportTransactionFailure({
      type: 'send',
      stage: 'submitting',
      outcome: 'unconfirmed',
      submitLegMs,
      error: submitOutcomeUnknown('request to Miden node timed out; the node may be under heavy load')
    });
    const message = await reportedMessage();
    expect(message).toContain(
      `; submit_outcome_unknown; endpoint submit_proven_transaction; grpc deadline_exceeded; app hidden during submit unavailable; submit leg ${bucket}. `
    );
    expect(message).not.toMatch(/submitLegMs|\b(?:8999|9000|11000|11001|NaN|Infinity)\b/);
    expectNoTransactionData(message);
  });
});

describe('a submit the node refused', () => {
  // miden-client 0.17.3: `RpcError::RequestError` under web-sdk 0.17.3's "failed to submit proven transaction" context.
  const refused = (endpoint: string, kind: string) =>
    new Error(
      `failed to submit proven transaction: RPC error: grpc request failed for ${endpoint}: ${kind}: status: ` +
        `'${kind}', self: "tx ${TX_ID} for ${ACCOUNT}"`
    );

  it('names the endpoint, the gRPC status and the node error, and nothing the node said', async () => {
    reportTransactionFailure({
      type: 'consume',
      stage: 'submitting',
      error: refused(
        'submit_proven_transaction',
        `invalid request parameters (transaction conflicts with current state: nonce of ${ACCOUNT_HEX} is ${AMOUNT}, expected ${NOTE_COMMITMENT})`
      )
    });
    const message = await reportedMessage();
    expect(message).toContain(
      '; point pipeline; submit_rejected; endpoint submit_proven_transaction; grpc invalid_argument; node state_conflict. authentication'
    );
    expect(message).not.toContain('nonce of');
    expectNoTransactionData(message);
  });

  it.each([
    ['internal', 'internal server error'],
    ['expired', 'transaction expired'],
    ['state_conflict', `transaction conflicts with current state: ${NOTE_COMMITMENT}`],
    ['capacity_exceeded', 'the mempool is at capacity'],
    ['missing_fee', 'transaction does not contain a canonical fee output note'],
    ['consumes_inflight_fee_notes', 'transaction consumes in-flight fee notes'],
    ['invalid_fee_asset', 'transaction fee output note must use only the native asset'],
    ['batch_id_mismatch', 'batch proof ID does not match the batch ID'],
    ['authentication_failed', `failed to authenticate transaction: signature over ${TX_ID} rejected`],
    ['unknown_code', `unknown error code 42: ${ACCOUNT}`],
    ['other', `a later node's words about ${ACCOUNT_HEX}`]
  ])('names node error %s from its fixed words', async (node, text) => {
    reportTransactionFailure({
      type: 'send',
      stage: 'submitting',
      error: refused('submit_proven_batch', `precondition failed (${text})`)
    });
    const message = await reportedMessage();
    expect(message).toContain(
      `; submit_rejected; endpoint submit_proven_batch; grpc failed_precondition; node ${node}` +
        `${node === 'expired' ? '; proof wait unavailable' : ''}. authentication`
    );
    expectNoTransactionData(message);
  });

  describe('an expired proof', () => {
    const expired = () => refused('submit_proven_transaction', 'invalid request parameters (transaction expired)');

    it.each([
      [0, 'under_half_window'],
      [49, 'under_half_window'],
      [50, 'over_half_window'],
      [100, 'over_half_window'],
      [101, 'past_window'],
      [4321, 'past_window']
    ])('reports a wait of %s blocks in a 100 block window as %s, without either number', async (wait, bucket) => {
      reportTransactionFailure({
        type: 'send',
        stage: 'submitting',
        error: expired(),
        proofWaitBlocks: wait,
        expiryWindowBlocks: 100
      });
      const message = await reportedMessage();
      expect(message).toContain(
        `; submit_rejected; endpoint submit_proven_transaction; grpc invalid_argument; node expired; proof wait ${bucket}. authentication`
      );
      expect(message).not.toMatch(/\b(?:49|50|100|101|4321)\b/);
    });

    it.each([
      ['no wait', undefined, 100],
      ['no window', 10, undefined],
      ['an empty window', 10, 0],
      ['a negative window', 10, -5],
      ['a negative wait', -1, 100],
      ['a wait that is not finite', Number.NaN, 100],
      ['a window that is not finite', 10, Number.POSITIVE_INFINITY]
    ])('reports %s as unavailable', async (_name, wait, window) => {
      reportTransactionFailure({
        type: 'send',
        stage: 'submitting',
        error: expired(),
        proofWaitBlocks: wait,
        expiryWindowBlocks: window
      });
      expect(await reportedMessage()).toContain('node expired; proof wait unavailable. authentication');
    });

    it('leaves a refusal that is not an expiry without the wait', async () => {
      reportTransactionFailure({
        type: 'send',
        stage: 'submitting',
        error: refused('submit_proven_transaction', 'internal server error'),
        proofWaitBlocks: 90,
        expiryWindowBlocks: 100
      });
      expect(await reportedMessage()).not.toContain('proof wait');
    });
  });

  it.each([
    ['not_found', 'resource not found'],
    ['invalid_argument', 'invalid request parameters'],
    ['permission_denied', 'permission denied'],
    ['already_exists', 'resource already exists'],
    ['resource_exhausted', "request was rate-limited or the node's resources are exhausted; retry after a delay"],
    ['failed_precondition', 'precondition failed'],
    ['out_of_range', 'operation was attempted past the valid range'],
    ['unimplemented', 'the requested method is not implemented by this version of the Miden node'],
    ['unauthenticated', 'request was rejected as unauthenticated; check your credentials and connection settings']
  ])('names gRPC status %s with no node error as none', async (status, kind) => {
    reportTransactionFailure({ type: 'send', stage: 'submitting', error: refused('submit_proven_transaction', kind) });
    expect(await reportedMessage()).toContain(
      `; submit_rejected; endpoint submit_proven_transaction; grpc ${status}; node none. authentication`
    );
  });

  it('names the encryption-key read inside a submit, and an endpoint or status it does not know as other', async () => {
    reportTransactionFailure({
      type: 'send',
      stage: 'submitting',
      error: refused('get_transaction_encryption_key', 'resource not found')
    });
    reportTransactionFailure({
      type: 'send',
      stage: 'submitting',
      error: refused('submit_signed_bundle', `the node said no to ${ACCOUNT_HEX} (${AMOUNT})`)
    });
    await settle();
    const [key, unknown] = jest.mocked(captureCrash).mock.calls.map(([error]) => (error as Error).message);
    expect(key).toContain('; submit_rejected; endpoint get_transaction_encryption_key; grpc not_found; node none. ');
    expect(unknown).toContain('; submit_rejected; endpoint other; grpc other; node none. ');
    expect(unknown).not.toContain('submit_signed_bundle');
    expectNoTransactionData(`${key} ${unknown}`);
  });

  it('keeps the identity of an RPC failure outside a submit', async () => {
    reportTransactionFailure({
      type: 'consume',
      stage: 'creating-proposal',
      error: new Error(
        'failed to execute transaction: RPC error: grpc request failed for get_account: invalid request parameters (unknown account)'
      )
    });
    const message = await reportedMessage();
    expect(message).toContain('; point pipeline; transaction_execution_failed; cause rpc. authentication');
    expect(message).not.toContain('submit_rejected');
  });

  it('keeps an unknown submit outcome as one', async () => {
    reportTransactionFailure({
      type: 'consume',
      stage: 'submitting',
      outcome: 'unconfirmed',
      error: submitOutcomeUnknown('operation was cancelled')
    });
    const message = await reportedMessage();
    expect(message).toContain(
      '; submit_outcome_unknown; endpoint submit_proven_transaction; grpc cancelled; app hidden during submit unavailable; submit leg unavailable. '
    );
    expect(message).not.toContain('submit_rejected');
  });
});

describe('a pipeline killed from outside', () => {
  const sync = (cause: unknown) => new Error(`pre-flight sync for ${ACCOUNT} failed`, { cause });

  const unrecorded =
    'deadline owner unavailable; deadline timer unavailable; deadline op unavailable; op start reported unavailable';
  it.each([
    ['deadline', `offscreen_aborted_deadline; ${unrecorded}`],
    ['deadline-no-kill', `offscreen_aborted_deadline_no_kill; ${unrecorded}`],
    ['doc-closed', 'offscreen_aborted_doc_closed; op start reported unavailable'],
    ['transport', 'offscreen_aborted_transport; op start reported unavailable'],
    [`stalled on ${ACCOUNT_HEX}`, 'offscreen_aborted_other; op start reported unavailable']
  ])('names an offscreen abort for %s by its reason, never its operation id', async (reason, identity) => {
    reportTransactionFailure({
      type: 'consume',
      stage: 'syncing',
      point: 'pipeline',
      error: sync(new OperationAbortedError(OP_ID, reason))
    });
    const message = await reportedMessage();
    expect(message).toContain(`; stage syncing; realm unknown;`);
    expect(message).toContain(`; point pipeline; ${identity}. authentication`);
    expect(message).not.toContain('aborted (');
    expectNoTransactionData(message);
  });

  it.each([
    ['watchdog', 'wasm_lock_evicted_watchdog'],
    ['realm-error', 'wasm_lock_evicted_realm_error']
  ] as const)('names a WASM lock eviction by the %s mechanism', async (reason, identity) => {
    const trap = new Error(`RuntimeError: unreachable while syncing ${ACCOUNT_HEX} for ${AMOUNT}`);
    reportTransactionFailure({
      type: 'consume',
      stage: 'syncing',
      error: sync(new WasmClientPoisonedError(reason, trap))
    });
    const message = await reportedMessage();
    expect(message).toContain(`; point pipeline; ${identity}. authentication`);
    expect(message).not.toContain('RuntimeError');
    expectNoTransactionData(message);
  });

  it('names an eviction carried by name whose reason is unknown or unreadable as other', async () => {
    const foreign = Object.assign(new Error('evicted'), { name: 'WasmClientPoisonedError', reason: ACCOUNT_HEX });
    const hostile = Object.defineProperty(new Error('aborted'), 'reason', {
      get: () => {
        throw new Error('hostile accessor');
      }
    });
    hostile.name = 'OperationAbortedError';
    reportTransactionFailure({ type: 'consume', stage: 'syncing', error: foreign });
    reportTransactionFailure({ type: 'consume', stage: 'syncing', error: hostile });
    await settle();
    const [evicted, aborted] = jest.mocked(captureCrash).mock.calls.map(([error]) => (error as Error).message);
    expect(evicted).toContain('; point pipeline; wasm_lock_evicted_other. ');
    expect(aborted).toContain('; point pipeline; offscreen_aborted_other; op start reported unavailable. ');
    expectNoTransactionData(`${evicted} ${aborted}`);
  });

  it.each([
    [
      'its own deadline after it started',
      { started: true, deadline: { owner: 'own', timer: 'started', killer: 'write' } },
      'deadline owner own; deadline timer started; deadline op write; op start reported yes'
    ],
    [
      "another op's dispatch deadline before it started",
      { started: false, deadline: { owner: 'collateral', timer: 'dispatch', killer: 'read' } },
      'deadline owner collateral; deadline timer dispatch; deadline op read; op start reported no'
    ],
    [
      'a resumed deadline',
      { started: true, deadline: { owner: 'own', timer: 'resumed', killer: 'write' } },
      'deadline owner own; deadline timer resumed; deadline op write; op start reported yes'
    ],
    [
      'values outside the lists',
      { started: 'yes', deadline: { owner: ACCOUNT_HEX, timer: AMOUNT, killer: OP_ID } },
      'deadline owner unavailable; deadline timer unavailable; deadline op unavailable; op start reported unavailable'
    ]
  ])('names a deadline abort with %s by closed facts only', async (_label, facts, expected) => {
    reportTransactionFailure({
      type: 'consume',
      stage: 'sending',
      error: sync(new OperationAbortedError(OP_ID, 'deadline', facts as never))
    });
    const message = await reportedMessage();
    expect(message).toContain(`; point pipeline; offscreen_aborted_deadline; ${expected}. authentication`);
    expectNoTransactionData(message);
  });

  it('names whether a transport abort had started, and survives a hostile facts accessor', async () => {
    const hostile = new OperationAbortedError(OP_ID, 'transport');
    Object.defineProperty(hostile, 'facts', {
      get: () => {
        throw new Error(`facts for ${ACCOUNT_HEX}`);
      }
    });
    reportTransactionFailure({
      type: 'consume',
      stage: 'sending',
      error: new OperationAbortedError(OP_ID, 'transport', { started: true })
    });
    reportTransactionFailure({ type: 'consume', stage: 'sending', error: hostile });
    await settle();
    const [started, unreadable] = jest.mocked(captureCrash).mock.calls.map(([error]) => (error as Error).message);
    expect(started).toContain('; point pipeline; offscreen_aborted_transport; op start reported yes. ');
    expect(unreadable).toContain('; point pipeline; offscreen_aborted_transport; op start reported unavailable. ');
    expectNoTransactionData(`${started} ${unreadable}`);
  });

  it('names the kill rather than the unknown outcome text it abandoned', async () => {
    reportTransactionFailure({
      type: 'send',
      stage: 'submitting',
      error: new WasmClientPoisonedError('watchdog', submitOutcomeUnknown('operation was cancelled'))
    });
    const message = await reportedMessage();
    expect(message).toContain('; point pipeline; wasm_lock_evicted_watchdog. ');
    expect(message).not.toContain('submit_outcome_unknown');
  });
});

describe('an SDK execution failure with no assertion code', () => {
  // The pinned SDK's own Display text: miden-client 0.17.3 `ClientError` and `TransactionRequestError`, miden-tx
  // 0.17.1 `TransactionExecutorError`, `TransactionKernelError` and `DataStoreError`, joined by web-sdk 0.17.3's
  // `build_error_chain` under "failed to execute transaction".
  const kernel = (diagnostic: string) =>
    `transaction execution failed: failed to execute transaction kernel program:\n  x ${diagnostic}`;
  const dashed = String.fromCharCode(0x2014);

  it.each([
    [
      'request_note_consumed',
      `invalid transaction request: note with details commitment ${NOTE_COMMITMENT} has already been consumed`
    ],
    [
      'request_note_processing',
      `invalid transaction request: note with details commitment ${NOTE_COMMITMENT} is being consumed by pending transaction ${TX_ID}`
    ],
    [
      'request_note_unauthenticated',
      `invalid transaction request: note ${NOTE_ID} cannot be used as an authenticated input: it does not have a valid inclusion proof`
    ],
    [
      'request_duplicate_note',
      `invalid transaction request: duplicate input note: note ${NOTE_ID} was added more than once to the transaction`
    ],
    [
      'request_empty',
      'invalid transaction request: empty transaction: the request has no input notes and no account state changes'
    ],
    [
      'request_fee_conversion',
      "invalid transaction request: the request declares a fee conversion salt but the account's auth component " +
        'auth::guardian does not read the auth args as fee conversion info'
    ],
    [
      'request_fee_conversion',
      "invalid transaction request: account's `auth::guardian` component reuses the fee conversion salt as a replay " +
        'guard, so the caller must declare a fresh one with `TransactionRequestBuilder::fee_conversion_salt`'
    ],
    ['request_other', `invalid transaction request: storage slot 3 not found in account ID ${ACCOUNT_HEX}`],
    [
      'recency_check',
      `transaction failed a recency check: reference block 790 is stale ${dashed} the reference block may be too old; try syncing and resubmitting`
    ],
    ['account_locked', `account ${ACCOUNT_HEX} is locked because the local state may be out of date with the network`],
    ['account_data_not_found', `account data wasn't found for account id ${ACCOUNT_HEX}`],
    [
      'output_mismatch',
      `transaction output mismatch: expected output notes with recipient digests [${NOTE_ID}] were not produced by the transaction`
    ],
    ['data_store', `data store error: vault of ${ACCOUNT_HEX} holds ${AMOUNT}`],
    ['store', `storage error: account ${ACCOUNT_HEX} could not be written`],
    [
      'rpc',
      `RPC error: grpc request failed for get_account: Miden node is unavailable; check that the node is running and reachable: ${ACCOUNT_HEX}`
    ],
    [
      'fetch_inputs',
      `transaction execution failed: failed to fetch transaction inputs from the data store: no witness for ${ACCOUNT_HEX}`
    ],
    [
      'block_after_reference',
      'transaction execution failed: failed to fetch transaction inputs from the data store: requested block 812 is ' +
        'after transaction reference block 790'
    ],
    [
      'account_not_in_store',
      `transaction execution failed: failed to fetch transaction inputs from the data store: account with id ${ACCOUNT_HEX} not found in data store`
    ],
    [
      'block_not_in_store',
      'transaction execution failed: failed to fetch transaction inputs from the data store: block with number 812 not found in data store'
    ],
    [
      'fetch_asset_witness',
      `transaction execution failed: failed to fetch asset witnesses from the data store: vault ${NOTE_COMMITMENT}`
    ],
    [
      'foreign_account_not_anchored',
      `transaction execution failed: foreign account inputs for ID ${ACCOUNT_HEX} are not anchored on reference block`
    ],
    [
      'note_past_reference_block',
      `transaction execution failed: input note ${NOTE_ID} was created in a block past the transaction reference block number (790)`
    ],
    ['kernel_program', kernel('division by zero: divisor must be non-zero for division or modulo operations')],
    [
      'summary_block_unknown',
      kernel(
        'error during processing of event\n  `-> transaction summary binds block 812, which the transaction does not authenticate'
      )
    ],
    [
      'summary_expiration_mismatch',
      kernel(
        "error during processing of event\n  `-> transaction summary binds expiration delta 20 but the transaction's expiration delta is 30"
      )
    ],
    [
      'summary_commitment_mismatch',
      kernel(
        `error during processing of event\n  \`-> transaction returned unauthorized event but a commitment did not match: ${NOTE_COMMITMENT}`
      )
    ],
    [
      'signature_failed',
      kernel(`error during processing of event\n  \`-> failed to generate signature: signature rejected: ${ACCOUNT}`)
    ],
    [
      'executor_other',
      `transaction execution failed: account witness provided for account ID ${ACCOUNT_HEX} is invalid: bad path`
    ],
    ['other', `wasm-bindgen: unexpected value ${ACCOUNT_HEX} for ${AMOUNT}`]
  ])('names cause %s from the fixed SDK text and nothing it interpolates', async (cause, chain) => {
    reportTransactionFailure({
      type: 'consume',
      stage: 'creating-proposal',
      error: new Error(`failed to execute transaction: ${chain}`)
    });
    const message = await reportedMessage();
    expect(message).toContain(`; point pipeline; transaction_execution_failed; cause ${cause}. authentication`);
    expectNoTransactionData(message);
    expect(message).not.toContain('790');
  });

  it('reads the cause through an offscreen wrapper and down the cause chain', async () => {
    reportTransactionFailure({
      type: 'consume',
      stage: 'signing-proposal',
      error: new Error(
        `Offscreen call 'guardianPipeline' failed: failed to execute transaction: invalid transaction request`,
        {
          cause: new Error(
            `failed to execute transaction: invalid transaction request: note with details commitment ${NOTE_COMMITMENT} has already been consumed`
          )
        }
      )
    });
    const message = await reportedMessage();
    expect(message).toContain('; transaction_execution_failed; cause request_note_consumed. ');
    expectNoTransactionData(message);
  });

  it.each([
    ['a published code', '10404896929510279404', 'ERR_NOTE_TAG_MUST_BE_U32'],
    ['an unknown code', '7', 'kernel_u32_assertion_outside_shipped_sources']
  ])('names a u32 assertion with %s and not its stack values', async (_name, code, identity) => {
    reportTransactionFailure({
      type: 'send',
      stage: 'sending',
      error: new Error(
        `failed to execute transaction: ${kernel(
          `u32 assertion failed: u32assert2 requires both stack values to be valid 32-bit unsigned integers; error code: ${code}; invalid values: [4294967296, ${AMOUNT}]`
        )}`
      )
    });
    const message = await reportedMessage();
    expect(message).toContain(`; point pipeline; ${identity}. authentication`);
    expect(message).not.toContain('4294967296');
    expect(message).not.toContain(`error code: ${code}`);
    expectNoTransactionData(message);
  });

  it.each([
    [
      'a u32 assertion',
      `u32 assertion failed: u32assert2 requires both stack values to be valid 32-bit unsigned integers; error code: 10404896929510279404; invalid values: [4294967296, ${AMOUNT}]`,
      'ERR_NOTE_TAG_MUST_BE_U32'
    ],
    [
      'an assertion',
      'assertion failed with error code: 15404814807981965102',
      'ERR_FEE_CONVERSION_INFO_COMMITMENT_MISMATCH'
    ]
  ])('names %s whose code only a cause carries', async (_name, diagnostic, identity) => {
    reportTransactionFailure({
      type: 'consume',
      stage: 'signing-proposal',
      error: new Error(`claim for ${ACCOUNT} failed`, {
        cause: new Error(`failed to execute transaction: ${kernel(diagnostic)}`)
      })
    });
    const message = await reportedMessage();
    expect(message).toContain(`; point pipeline; ${identity}. authentication`);
    expect(message).not.toContain('4294967296');
    expectNoTransactionData(message);
  });

  it('classifies a long run of u32 assertion prefixes with no delimiter within a fixed bound', async () => {
    const started = performance.now();
    reportTransactionFailure({
      type: 'send',
      stage: 'sending',
      error: new Error(`failed to execute transaction: ${'u32 assertion failed:'.repeat(20_000)}`)
    });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(await reportedMessage()).toContain('; point pipeline; transaction_execution_failed; cause other. ');
  });

  it("never lets an opaque variant's payload choose the cause", async () => {
    reportTransactionFailure({
      type: 'consume',
      stage: 'creating-proposal',
      error: new Error(
        'failed to execute transaction: RPC error: grpc request failed for get_account: unknown error: failed to generate signature'
      )
    });
    reportTransactionFailure({
      type: 'consume',
      stage: 'creating-proposal',
      error: new Error(
        `failed to execute transaction: storage error: note with details commitment ${NOTE_COMMITMENT} has already been consumed`
      )
    });
    reportTransactionFailure({
      type: 'consume',
      stage: 'creating-proposal',
      error: new Error(
        `failed to execute transaction: data store error: input note ${NOTE_ID} was created in a block past the transaction reference block number (790)`
      )
    });
    await settle();
    expect(
      jest.mocked(captureCrash).mock.calls.map(([error]) => /; cause ([a-z_]+)\./.exec((error as Error).message)?.[1])
    ).toEqual(['rpc', 'store', 'data_store']);
  });

  it('still names a real SDK cause carried by a later link under an opaque variant', async () => {
    reportTransactionFailure({
      type: 'consume',
      stage: 'creating-proposal',
      error: new Error("Offscreen call 'guardianPipeline' failed: failed to execute transaction: RPC error", {
        cause: new Error(
          'failed to execute transaction: transaction execution failed: failed to fetch transaction inputs from the data store: requested block 812 is after transaction reference block 790'
        )
      })
    });
    expect(await reportedMessage()).toContain('; transaction_execution_failed; cause block_after_reference. ');
  });
});

// BREAD-WALLET-T: a dApp transaction failed a check whose code was public, but the table held only the protocol and
// standards constants.
describe('an assertion from the crates the shipped SDK was built from', () => {
  const u32 = (code: string) =>
    `u32 assertion failed: u32assert2 requires both stack values to be valid 32-bit unsigned integers; error code: ${code}; invalid values: [4294967296, ${AMOUNT}]`;

  it.each([
    ['a core library message written inline', '17772623450895643168', 'CORE_LIB_INVALID_PUBLIC_KEY_COMMITMENT'],
    [
      'a core library preimage check',
      '11387458292363377498',
      'CORE_LIB_PIPE_DOUBLE_WORDS_PREIMAGE_TO_MEMORY_COMMITMENT_DOES_NOT_MATCH'
    ],
    ['a core library constant without the ERR_ prefix', '8884138617546109530', 'LEAF_VALUE_MISMATCH'],
    ['an AggLayer constant', '14064239620284524827', 'ERR_CLAIM_ALREADY_SPENT'],
    [
      'a protocol message written inline',
      '7815687906632357981',
      'PROTOCOL_NUMBER_OF_STORAGE_MAP_ELEMENTS_MUST_BE_A_MULTIPLE_OF_8'
    ]
  ])('names %s and not its number', async (_name, code, identity) => {
    reportTransactionFailure({
      type: 'execute',
      stage: 'creating-proposal',
      error: new Error(`failed to execute transaction: ${ACCOUNT}: assertion failed with error code: ${code}`)
    });
    const message = await reportedMessage();
    expect(message).toContain(`; point pipeline; ${identity}. authentication`);
    expect(message).not.toContain(code);
    expectNoTransactionData(message);
  });

  it.each([
    ['a core library range check', '4656276824384881619', 'CORE_LIB_INVALID_SHA256_MESSAGE_WORD'],
    ['a protocol range check', '10617534845770812077', 'PROTOCOL_INVALID_ATTACHMENT_NUM_ELEMENTS_ADVICE_INPUT']
  ])('names %s on the u32 path, and not its stack values', async (_name, code, identity) => {
    reportTransactionFailure({ type: 'execute', stage: 'creating-proposal', error: new Error(u32(code)) });
    const message = await reportedMessage();
    expect(message).toContain(`; point pipeline; ${identity}. authentication`);
    expect(message).not.toContain(code);
    expect(message).not.toContain('4294967296');
    expectNoTransactionData(message);
  });

  it.each([
    ['a check', 'assertion failed with error code: 0', 'kernel_assertion_without_message'],
    ['a range check', u32('0'), 'kernel_u32_assertion_without_message']
  ])('names %s written with no message', async (_name, text, identity) => {
    reportTransactionFailure({ type: 'execute', stage: 'signing-proposal', error: new Error(text) });
    expect(await reportedMessage()).toContain(`; point pipeline; ${identity}. authentication`);
  });

  it.each([
    ['a check', 'assertion failed with error code: 9876543210123', 'kernel_assertion_outside_shipped_sources'],
    ['a range check', u32('9876543210123'), 'kernel_u32_assertion_outside_shipped_sources']
  ])('says %s whose number no shipped source publishes came from outside them', async (_name, text, identity) => {
    reportTransactionFailure({ type: 'execute', stage: 'signing-proposal', error: new Error(text) });
    const message = await reportedMessage();
    expect(message).toContain(`; point pipeline; ${identity}. authentication`);
    expect(message).not.toContain('9876543210123');
  });
});

describe('the signing step', () => {
  it.each([
    ['creating-proposal', 'creating_proposal'],
    ['signing-proposal', 'signing_proposal'],
    ['signing-locally', 'signing_locally']
  ] as const)('names %s inside the signing stage', async (stage, step) => {
    reportTransactionFailure({ type: 'consume', stage, error: new Error('failed to execute transaction') });
    expect(await reportedMessage()).toContain(`tx_receive; stage signing; signing step ${step}; realm unknown;`);
  });

  it('names no signing step outside the signing stage', async () => {
    reportTransactionFailure({ type: 'consume', stage: 'sending' });
    const message = await reportedMessage();
    expect(message).toContain('tx_receive; stage sending; realm unknown;');
    expect(message).not.toContain('signing step');
  });
});

describe('the confirming step', () => {
  it.each([
    ['confirming', 'confirming'],
    ['delivering', 'delivering'],
    ['registering-guardian', 'registering_guardian'],
    ['guardian-syncing', 'guardian_syncing'],
    ['guardian-synced', 'guardian_synced']
  ] as const)('names %s inside the confirming stage', async (stage, step) => {
    reportTransactionFailure({ type: 'consume', stage, error: new Error('failed to execute transaction') });
    expect(await reportedMessage()).toContain(`tx_receive; stage confirming; confirming step ${step}; realm unknown;`);
  });

  // BREAD-WALLET-S: a Guardian claim failed after its submit, and the report could not say whether it failed during
  // the post-submit Guardian sync or after it.
  it('names the Guardian sync a submitted claim failed in, beside the wallet reason', async () => {
    reportTransactionFailure({
      type: 'consume',
      stage: 'guardian-syncing',
      point: 'pipeline',
      reason: 'user_cancelled'
    });
    const message = await reportedMessage();
    expect(message).toContain('tx_receive; stage confirming; confirming step guardian_syncing; realm unknown;');
    expect(message).toContain('; point pipeline; user_cancelled. authentication');
  });

  it.each(TRANSACTION_STAGES)('names a confirming step for %s only when it folds into confirming', async stage => {
    reportTransactionFailure({ type: 'consume', stage });
    const message = await reportedMessage();
    expect(message.includes('; confirming step ')).toBe(stepOfStage(stage) === 'confirming');
  });
});

describe('the never-committed verdict', () => {
  it.each(['expired', 'superseded', 'spent_elsewhere', 'mixed'] as const)(
    'names the wallet verdict and the %s check that proved it',
    async rule => {
      reportTransactionFailure({
        point: 'node_verdict',
        type: 'consume',
        stage: 'submitting',
        reason: 'never_committed',
        neverCommittedRule: rule,
        error: 'The network confirmed this transaction never went through, so nothing moved. It is safe to retry.'
      });
      const message = await reportedMessage();
      const proofWait = rule === 'expired' ? '; proof wait unavailable' : '';
      expect(message).toContain(`; point node_verdict; never_committed; rule ${rule}${proofWait}. authentication`);
      expect(message).not.toContain('; network.');
    }
  );

  it('adds only the prior failure identity and expiry-relative wait bucket', async () => {
    const priorError = new Error(
      `failed to execute transaction: failed to fetch transaction inputs from the data store: account with id ${ACCOUNT_HEX}, amount 4200`
    );
    const failure: TransactionFailure = {
      point: 'node_verdict',
      type: 'send',
      reason: 'never_committed',
      neverCommittedRule: 'expired',
      proofWaitBlocks: 360,
      expiryWindowBlocks: 600
    };
    Reflect.set(failure, 'priorError', priorError);
    reportTransactionFailure(failure);

    const message = await reportedMessage();
    expect(message).toContain(
      '; point node_verdict; never_committed; rule expired; prior transaction_execution_failed; cause fetch_inputs; proof wait over_half_window. authentication'
    );
    expectNoTransactionData(message);
  });

  it('omits prior failure identity for non-expired never-committed verdicts', async () => {
    reportTransactionFailure({
      point: 'node_verdict',
      type: 'send',
      reason: 'never_committed',
      neverCommittedRule: 'superseded',
      priorError: new Error('failed to fetch transaction inputs from the data store')
    });

    const message = await reportedMessage();
    expect(message).toContain('; point node_verdict; never_committed; rule superseded. authentication');
    expect(message).not.toContain('prior transaction_execution_failed');
  });

  it('names a verdict with no rule by its reason alone, and a rule outside the list as other', async () => {
    reportTransactionFailure({ point: 'guardian_node_verdict', type: 'switch-guardian', reason: 'never_committed' });
    const malformed: TransactionFailure = { point: 'node_verdict', type: 'send', reason: 'never_committed' };
    // A rule outside the list can only arrive from a stored row an older or newer build wrote, past the type.
    Reflect.set(malformed, 'neverCommittedRule', ACCOUNT_HEX);
    reportTransactionFailure(malformed);
    await settle();
    const guardian = capturedMessage(0);
    const poisoned = capturedMessage(1);
    expect(guardian).toContain('; point guardian_node_verdict; never_committed. authentication');
    expect(poisoned).toContain('; point node_verdict; never_committed; rule other. authentication');
    expectNoTransactionData(poisoned);
  });

  it('carries a rule only with the never-committed reason', async () => {
    reportTransactionFailure({ type: 'consume', reason: 'user_cancelled', neverCommittedRule: 'expired' });
    const message = await reportedMessage();
    expect(message).toContain('; point pipeline; user_cancelled. authentication');
    expect(message).not.toContain('rule');
  });
});

const crashReportPolicy = (): string => {
  const policy = readFileSync(join(REPO_ROOT, 'docs/privacy/index.md'), 'utf8');
  const section = policy.slice(policy.indexOf('### Crash reports'));
  return section.slice(0, section.indexOf('\n#', 1));
};

/**
 * The Crash reports bullet that opens with `heading`, cut from `from` up to `to` when given, so each list is checked
 * against the text that documents it and not against a word another list shares. Empty when an anchor is missing.
 */
const policyText = (heading: string, from?: string, to?: string): string => {
  const bullet = crashReportPolicy()
    .split('\n')
    .find(line => line.startsWith(`- **${heading}**`));
  if (bullet === undefined) return '';
  const start = from === undefined ? 0 : bullet.indexOf(from);
  const end = start === -1 || to === undefined ? bullet.length : bullet.indexOf(to, start);
  return start === -1 || end === -1 ? '' : bullet.slice(start, end);
};

/** The Crash reports paragraph that opens with `opening`, for a list documented in a clause of its own. */
const policyParagraph = (opening: string): string =>
  crashReportPolicy()
    .split('\n')
    .find(line => line.startsWith(opening)) ?? '';

const OWN_REASON = "The App's own reason";
const NEVER_COMMITTED_RULE = 'With `never_committed`';
const GUARDIAN = 'A guardian refusal';
const GUARDIAN_CODES = 'It also carries';
const DEVICE_KEY = 'A device key refusal';
const DEVICE_KEY_CODES = 'when it is one of';
const UNKNOWN_OUTCOME = 'A submit with no definite answer';
const SUBMIT_LEG = '; and how long the submit took';
const REFUSED = 'A submit the network refused';
const EXECUTION = 'What the transaction software said went wrong';
const EXECUTION_CAUSE_LIST = 'its own fixed wording names';
const COINED_ASSERTIONS = "A check in the transaction's program";
const NO_MESSAGE = 'A check that fails with no message';
const OUTSIDE_SOURCES = 'and one whose number';
const ENGINE = 'Two failures the transaction engine names itself';
const BROAD = 'A broad category';
const THROWN = 'With `unknown`';
const UNKNOWN_SUBMIT = 'When the transaction was being submitted';
const CLAIM_ORIGIN = 'A failed claim of an incoming transfer also says what queued the claim';

// Each identity the reporter coins, with the text that documents it.
const IDENTITY_TEXT: Record<string, () => string> = {
  submit_outcome_unknown: () => policyText(UNKNOWN_OUTCOME, undefined, 'It carries'),
  submit_rejected: () => policyText(REFUSED, undefined, 'It names'),
  kernel_assertion_outside_shipped_sources: () => policyText(EXECUTION, OUTSIDE_SOURCES),
  kernel_u32_assertion_outside_shipped_sources: () => policyText(EXECUTION, OUTSIDE_SOURCES),
  kernel_assertion_without_message: () => policyText(EXECUTION, NO_MESSAGE, OUTSIDE_SOURCES),
  kernel_u32_assertion_without_message: () => policyText(EXECUTION, NO_MESSAGE, OUTSIDE_SOURCES),
  advice_stack_read_failed: () => policyText(ENGINE),
  client_terminated: () => policyText(ENGINE),
  transaction_execution_failed: () => policyText(EXECUTION, undefined, EXECUTION_CAUSE_LIST),
  hot_key: () => policyText(DEVICE_KEY, undefined, DEVICE_KEY_CODES),
  guardian_http_: () => policyText(GUARDIAN, undefined, GUARDIAN_CODES)
};

// A label, the list it checks, and the policy text that documents it. Read inside the test, so a list the reporter
// does not export yet fails here rather than at collection.
type PolicyRow = readonly [label: string, values: () => readonly string[], documenting: () => string];

const POLICY_ROWS: readonly PolicyRow[] = [
  ['wallet reason', () => [...FAILURE_REASONS, 'other'], () => policyText(OWN_REASON, undefined, NEVER_COMMITTED_RULE)],
  [
    'never-committed rule',
    () => [...NEVER_COMMITTED_RULES, 'other'],
    () => policyText(OWN_REASON, NEVER_COMMITTED_RULE)
  ],
  [
    'Guardian refusal code',
    () => [...GUARDIAN_ERROR_CODES, 'other', 'none'],
    () => policyText(GUARDIAN, GUARDIAN_CODES)
  ],
  ['device key code', () => [...HOT_KEY_CODES, 'other', 'none'], () => policyText(DEVICE_KEY, DEVICE_KEY_CODES)],
  [
    'unknown-outcome RPC endpoint',
    () => SUBMIT_ENDPOINTS,
    () => policyText(UNKNOWN_OUTCOME, 'request endpoint', 'It carries the kind of answer')
  ],
  [
    'unknown-outcome gRPC status',
    () => SUBMIT_UNKNOWN_OUTCOME_STATUSES,
    () => policyText(UNKNOWN_OUTCOME, 'kind of answer', 'and whether the App')
  ],
  [
    'hidden-during-submit answer',
    () => SUBMIT_HIDDEN_ANSWERS,
    () => policyText(UNKNOWN_OUTCOME, 'and whether the App', SUBMIT_LEG)
  ],
  ['submit leg bucket', () => SUBMIT_LEG_BUCKETS, () => policyText(UNKNOWN_OUTCOME, SUBMIT_LEG)],
  ['proof wait bucket', () => PROOF_WAIT_BUCKETS, () => policyText(REFUSED, '; and for an expired proof')],
  ['refused endpoint', () => SUBMIT_ENDPOINTS, () => policyText(REFUSED, 'It names', '; the kind of answer')],
  [
    'refused gRPC status',
    () => SUBMIT_GRPC_STATUSES,
    () => policyText(REFUSED, '; the kind of answer', "; and the network's own reason")
  ],
  ['refusal node error', () => SUBMIT_NODE_ERRORS, () => policyText(REFUSED, "; and the network's own reason")],
  ['pipeline kill', () => PIPELINE_KILLS, () => policyText('Work the App stopped')],
  ['execution cause', () => EXECUTION_CAUSES, () => policyText(EXECUTION, EXECUTION_CAUSE_LIST, COINED_ASSERTIONS)],
  ['signing step', () => SIGNING_STEPS, () => policyText('The signing step')],
  ['confirming step', () => CONFIRMING_STEPS, () => policyText('The confirming step')],
  ['broad category', () => TELEMETRY_ERROR_KINDS, () => policyText(BROAD, undefined, THROWN)],
  [
    'thrown class',
    () => {
      const values: unknown = Reflect.get(jest.requireActual('./transaction-failure'), 'THROWN_CLASSES');
      expect(values).toEqual(THROWN_CLASS_VALUES);
      return THROWN_CLASS_VALUES;
    },
    () => policyText(BROAD, THROWN, UNKNOWN_SUBMIT)
  ],
  ['claim entry point', () => [...CONSUME_ENTRY_POINTS, 'unrecorded', 'other'], () => policyParagraph(CLAIM_ORIGIN)],
  ['last deferral', () => [...CONSUME_DEFERRAL_CAUSES, 'none', 'other'], () => policyText('The last deferral')],
  [
    'claim fee admission',
    () => [...CLAIM_FEE_ADMISSIONS, 'unrecorded', 'other'],
    () => policyText("The claim fee check's admission")
  ],
  ['reap age', () => [...REAP_AGES, 'unavailable'], () => policyText('The stuck-transaction check')],
  ['reaped attempt', () => [...REAPED_ATTEMPT_ORIGINS, 'unavailable'], () => policyText('The stuck-transaction check')],
  ['startup selection', () => [...STARTUP_SELECTIONS, 'unavailable'], () => policyText('The startup check')],
  ['stored stage age', () => [...STORED_STAGE_AGES, 'unavailable'], () => policyText('The startup check')],
  ['queue age bucket', () => QUEUE_AGE_BUCKETS, () => policyText('The age of a queued row that expired')],
  ['queue sighting', () => QUEUE_SIGHTINGS, () => policyText('The queue sighting')],
  ['preflight sync', () => PREFLIGHT_SYNC_REPORTS, () => policyText('The preflight sync')],
  ['queue hidden', () => QUEUE_HIDDEN_BUCKETS, () => policyText('Hidden time while a queued row waited')],
  ['submit crossing', () => SUBMIT_CROSSINGS, () => policyText("The attempt's submit crossing")],
  ['submit record', () => [...SUBMIT_RECORDS, 'unavailable'], () => policyText('The startup check')],
  ...Object.entries(IDENTITY_TEXT).map(
    ([identity, text]): PolicyRow => [`reported identity ${identity}`, () => [identity], text]
  )
];

it.each(POLICY_ROWS)(
  'the privacy policy lists every reportable %s where it documents them',
  (_name, values, documenting) => {
    const listed: readonly string[] | undefined = values();
    const text = documenting();
    expect(listed).toEqual(expect.arrayContaining([expect.any(String)]));
    expect(text).not.toBe('');
    expect((listed ?? []).filter(value => !text.includes(`\`${value}\``))).toEqual([]);
  }
);

it('checks every reported identity and every unknown-outcome status against its own text', () => {
  expect([...REPORTED_IDENTITIES].sort()).toEqual(Object.keys(IDENTITY_TEXT).sort());
  expect(
    SUBMIT_UNKNOWN_OUTCOME_STATUSES.filter(status => !SUBMIT_GRPC_STATUSES.some(listed => listed === status))
  ).toEqual([]);
});

it('names the published protocol identities as the policy section does', () => {
  expect(crashReportPolicy()).toContain('known public protocol error identities');
});

// The identity at the head of a report, the text after its point.
const reportedIdentity = (message: string): string => /; point [a-z_]+; ([^;.]+)/.exec(message)?.[1] ?? '';

// Whether `identity` is a value of a list the policy documents: a coined name or prefix, a broad category, or a
// published protocol identity.
const documentedIdentity = (identity: string): boolean =>
  REPORTED_IDENTITIES.some(listed =>
    listed.endsWith('_')
      ? /^\d{3}$|^other$/.test(identity.slice(listed.length)) && identity.startsWith(listed)
      : listed === identity
  ) ||
  (TELEMETRY_ERROR_KINDS ?? []).some(kind => kind === identity) ||
  Object.values(assertions).some(name => name === identity);

describe('every identity the reporter coins sits in a documented list', () => {
  it.each([
    ['advice_stack_read_failed', () => new Error('advice stack read failed at clock 812')],
    ['client_terminated', () => new Error('WebClient terminated')],
    ['transaction_execution_failed', () => new Error(`failed to execute transaction: wasm-bindgen: ${ACCOUNT_HEX}`)],
    ['guardian_http_409', () => guardianRefusal(409, 'Conflict', 'conflict_pending_delta')],
    ['guardian_http_other', () => guardianRefusal(700, 'Odd', null)],
    ['kernel_assertion_outside_shipped_sources', () => new Error('assertion failed with error code: 9')],
    [
      'kernel_u32_assertion_outside_shipped_sources',
      () =>
        new Error(
          'u32 assertion failed: u32assert2 requires both stack values to be valid 32-bit unsigned integers; error code: 7; invalid values: [1, 2]'
        )
    ],
    ['kernel_assertion_without_message', () => new Error('assertion failed with error code: 0')],
    [
      'kernel_u32_assertion_without_message',
      () =>
        new Error(
          'u32 assertion failed: u32assert2 requires both stack values to be valid 32-bit unsigned integers; error code: 0; invalid values: [1, 2]'
        )
    ],
    ['submit_outcome_unknown', () => submitOutcomeUnknown('operation was aborted')],
    [
      'submit_rejected',
      () =>
        new Error(
          'failed to submit proven transaction: RPC error: grpc request failed for submit_proven_transaction: resource not found'
        )
    ]
  ])('%s', async (identity, error) => {
    reportTransactionFailure({ type: 'send', stage: 'sending', error: error() });
    const reported = reportedIdentity(await reportedMessage());
    expect(reported).toBe(identity);
    expect(documentedIdentity(reported)).toBe(true);
  });

  it('hot_key', async () => {
    reportTransactionFailure({ type: 'consume', error: await hotKeyRejection('rejected', 'AUTH_FAILED') });
    const reported = reportedIdentity(await reportedMessage());
    expect(reported).toBe('hot_key');
    expect(documentedIdentity(reported)).toBe(true);
  });

  const BROAD_CATEGORY_ERRORS: ReadonlyArray<readonly [string, string]> = [
    ['timeout', 'the request timed out'],
    ['network', 'network unreachable'],
    ['rpc', 'rpc endpoint refused the call'],
    ['proving', 'prover crashed'],
    ['storage', 'quota exceeded'],
    ['auth', 'wrong password'],
    ['validation', 'invalid amount'],
    ['unknown', 'something odd happened']
  ];

  it.each(BROAD_CATEGORY_ERRORS)('the broad category %s', async (kind, text) => {
    reportTransactionFailure({ type: 'send', stage: 'sending', error: new Error(text) });
    const reported = reportedIdentity(await reportedMessage());
    expect(reported).toBe(kind);
    expect(documentedIdentity(reported)).toBe(true);
  });

  it('the broad category unknown also documents the thrown class', async () => {
    reportTransactionFailure({ type: 'send', stage: 'sending', error: new Error('something odd happened') });
    const message = await reportedMessage();
    expect(message).toContain('; point pipeline; unknown; thrown error. authentication');
    expect(documentedIdentity(reportedIdentity(message))).toBe(true);
  });

  it('drives every broad category', () => {
    expect(BROAD_CATEGORY_ERRORS.map(([kind]) => kind).sort()).toEqual([...(TELEMETRY_ERROR_KINDS ?? [])].sort());
  });

  it.each([
    ['alone', () => new Error('assertion failed with error code: 15404814807981965102')],
    [
      'inside a Guardian 5xx',
      () =>
        Object.assign(guardianRefusal(500, 'Internal Server Error', null), {
          message:
            'GUARDIAN HTTP error 500: Internal Server Error - assertion failed with error code: 15404814807981965102'
        })
    ]
  ])('a published-code assertion %s reports an identity from the published table', async (_name, error) => {
    reportTransactionFailure({ type: 'send', stage: 'sending', error: error() });
    const message = await reportedMessage();
    const published = /(?:^|; )(ERR_[A-Z0-9_]+)\. authentication/.exec(message)?.[1];
    expect(Object.values(assertions)).toContain(published);
  });
});

it.each([
  ['a plain assertion', 'assertion failed with error code: 99887766554433221100'],
  [
    'a u32 assertion',
    'u32 assertion failed: u32assert2 requires both stack values to be valid 32-bit unsigned integers; error code: 7; invalid values: [1, 2]'
  ]
])('lists the identity it sends for %s with an unpublished code', async (_name, text) => {
  reportTransactionFailure({ type: 'send', error: new Error(`failed to execute transaction: ${text}`) });
  const identity = /; point pipeline; ([a-z0-9_]+)\. authentication/.exec(await reportedMessage())?.[1];
  expect(identity).toMatch(/_outside_shipped_sources$/);
  expect(REPORTED_IDENTITIES).toContain(identity);
});

it('the privacy policy states the Guardian HTTP status range and its fallback', () => {
  const sentence = /[^.]*\bHTTP status\b[^.]*\./.exec(crashReportPolicy())?.[0] ?? '';
  expect(sentence).toMatch(/\b100\b[^.]*\b599\b/);
  expect(sentence).toContain('`other`');
});

it('does not title a refused EVM deposit on a bridged receive as a proving failure', async () => {
  // A bridged receive is born Completed and never proves; its failure is an EVM-side refusal.
  reportTransactionFailure({
    type: 'bridged-receive',
    point: 'bridge_receive_settlement',
    error: 'The connected wallet did not approve Ethereum Sepolia. Reconnect the wallet to approve it.'
  });
  await settle();
  const error = jest.mocked(captureCrash).mock.calls[0]![0] as Error;
  expect(error.message).toContain('point bridge_receive_settlement; unknown; thrown string.');
});

it('never makes a telemetry failure escape into the transaction', async () => {
  jest.mocked(captureCrash).mockImplementationOnce(() => {
    throw new Error('Sentry unavailable');
  });
  expect(() => reportTransactionFailure({ type: 'swap' })).not.toThrow();
  await settle();
});

const nativeFailure: ReownNativeFailure = {
  nativeOrigin: 'wallet_error',
  walletResponseCode: 'internal_error',
  requestAge: '120_to_300s',
  published: 'confirmed',
  backgrounded: 'yes'
};
const nativeDiagnostics = {
  reownNativeOrigin: 'wallet_error',
  reownWalletResponseCode: 'internal_error',
  reownRequestAge: '120_to_300s',
  reownPublished: 'confirmed',
  reownBackgrounded: 'yes'
};

it('gatesNativeDiagnosticsToAndroidInboundBridgeCause', () => {
  const cause = new Error('opaque');
  markReownNativeFailure(cause, nativeFailure);
  annotateCrash(cause, { ...nativeDiagnostics, workerMode: 'disabled' });
  const bridgeReceive = { route: 'usdcx', step: 'wallet_approve', cause } satisfies NonNullable<
    TransactionFailure['bridgeReceive']
  >;
  const cases: ReadonlyArray<readonly ['android' | 'ios' | 'extension', boolean, TransactionFailure]> = [
    ['ios', false, { type: 'bridged-receive', error: cause, bridgeReceive }],
    ['extension', false, { type: 'bridged-receive', error: cause, bridgeReceive }],
    ['android', true, { type: 'bridged-receive', error: cause, bridgeReceive }],
    ['android', false, { type: 'send', error: cause, bridgeReceive }],
    ['android', false, { type: 'bridged-receive', error: cause }],
    ['android', false, { type: 'bridged-receive', error: cause, bridgeReceive: { route: 'usdcx' } }]
  ];
  for (const [platform, desktop, failure] of cases) {
    jest.mocked(resolveTelemetryContext).mockReturnValue({ platform, network: 'testnet', appVersion: '1.17.6' });
    jest.mocked(isDesktop).mockReturnValue(desktop);
    reportTransactionFailure(failure);
    const report = jest.mocked(captureCrash).mock.calls.at(-1)?.[0];
    expect(report).toBeInstanceOf(Error);
    expect(snapshotCrashDiagnostics(report)).toEqual({ workerMode: 'disabled' });
  }
  jest.mocked(isDesktop).mockReturnValue(false);
  reportTransactionFailure({ type: 'bridged-receive', bridgeReceive });
  expect(snapshotCrashDiagnostics(jest.mocked(captureCrash).mock.calls.at(-1)?.[0])).toEqual(nativeDiagnostics);
});

it('carriesNativeDiagnosticsForAFailedUsdcxDeposit', () => {
  jest
    .mocked(resolveTelemetryContext)
    .mockReturnValue({ platform: 'android', network: 'testnet', appVersion: '1.17.6' });
  jest.mocked(isDesktop).mockReturnValue(false);
  const cause = new Error('opaque');
  markReownNativeFailure(cause, nativeFailure);

  reportTransactionFailure({
    type: 'bridged-receive',
    bridgeReceive: { route: 'usdcx', step: 'wallet_deposit', cause }
  });

  expect(snapshotCrashDiagnostics(jest.mocked(captureCrash).mock.calls.at(-1)?.[0])).toEqual(nativeDiagnostics);
});

it('nativeDimensionsDoNotChangeTitleSeverityOrFingerprint', () => {
  jest
    .mocked(resolveTelemetryContext)
    .mockReturnValue({ platform: 'android', network: 'testnet', appVersion: '1.17.6' });
  const snapshots: ReownNativeFailure[] = [
    nativeFailure,
    { nativeOrigin: 'publish_error', requestAge: '120_to_300s', published: 'confirmed', backgrounded: 'yes' },
    { ...nativeFailure, walletResponseCode: 'user_rejected' },
    { ...nativeFailure, requestAge: 'unknown' },
    { ...nativeFailure, published: 'unobserved' },
    { ...nativeFailure, backgrounded: 'no' }
  ];
  for (const snapshot of snapshots) {
    const cause = new Error('opaque');
    markReownNativeFailure(cause, snapshot);
    reportTransactionFailure({
      type: 'bridged-receive',
      bridgeReceive: { route: 'usdcx', step: 'wallet_approve', cause }
    });
  }
  const firstReport = jest.mocked(captureCrash).mock.calls[0]?.[0];
  const firstCaptureOptions = jest.mocked(captureCrash).mock.calls[0]?.[2];
  expect(firstReport).toBeInstanceOf(Error);
  if (!(firstReport instanceof Error) || firstCaptureOptions === undefined) throw new Error('Missing first capture');
  for (const [secondReport, , secondCaptureOptions] of jest.mocked(captureCrash).mock.calls.slice(1)) {
    expect(secondReport).toBeInstanceOf(Error);
    if (!(secondReport instanceof Error) || secondCaptureOptions === undefined)
      throw new Error('Missing second capture');
    expect(firstReport.message).toBe(secondReport.message);
    expect(firstCaptureOptions.level).toBe(secondCaptureOptions.level);
    expect(firstCaptureOptions).not.toHaveProperty('fingerprint');
    expect(secondCaptureOptions).not.toHaveProperty('fingerprint');
    expect(secondReport.cause).toBeUndefined();
    expect(secondReport.stack).toBeUndefined();
  }
  reportTransactionFailure({
    type: 'bridged-receive',
    bridgeReceive: { route: 'usdcx', step: 'wallet_approve', cause: new Error('Invalid permissions for call.') }
  });
  expect(capturedMessage(snapshots.length)).toBe(
    firstReport.message.replace('evm error other', 'evm error invalid_permissions')
  );
});

it('refines the exact PartialBlockchain producer context without exporting the private suffix', async () => {
  reportTransactionFailure({
    type: 'execute',
    stage: 'executing',
    error: new Error(
      'failed to execute transaction: transaction execution failed: failed to fetch transaction inputs from the data store: error creating PartialBlockchain from internal data: private-chain-canary'
    )
  });
  const message = await reportedMessage();
  expect(message).toContain('cause partial_blockchain_build');
  expect(message).not.toContain('private-chain-canary');
});

it.each([
  'error creating partialBlockchain from internal data: private',
  'error creating PartialBlockchain from internal databases: private',
  'prefix error creating PartialBlockchain from internal data: private',
  'error creating PartialBlockchain from internal data private'
])('does not broaden PartialBlockchain context %s', async context => {
  reportTransactionFailure({
    type: 'execute',
    stage: 'executing',
    error: new Error(
      'failed to execute transaction: transaction execution failed: failed to fetch transaction inputs from the data store: ' +
        context
    )
  });
  expect(await reportedMessage()).toContain('cause fetch_inputs');
});

it('carriesIOSPerCallBridgeDiagnosticWithoutPrivateFields', () => {
  jest.mocked(resolveTelemetryContext).mockReturnValue({ platform: 'ios', network: 'testnet', appVersion: '1.17.8' });
  jest.mocked(isDesktop).mockReturnValue(false);
  const cause = new Error('private-topic 0x1234567890 9.84');
  markReownNativeFailure(cause, { nativeOrigin: 'unconfigured', requestAge: 'unknown', published: 'unobserved' });
  reportTransactionFailure({
    type: 'bridged-receive',
    bridgeReceive: { route: 'usdcx', step: 'wallet_deposit', cause }
  });
  const report = jest.mocked(captureCrash).mock.calls.at(-1)?.[0];
  expect(snapshotCrashDiagnostics(report)).toEqual({
    reownNativeOrigin: 'unconfigured',
    reownRequestAge: 'unknown',
    reownPublished: 'unobserved'
  });
  expect(JSON.stringify(snapshotCrashDiagnostics(report))).not.toContain('private-topic');
});
