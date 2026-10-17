import { GUARDIAN_ERROR_CODES } from '@openzeppelin/guardian-client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { OperationAbortedError } from 'lib/miden/back/offscreen-codec';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';
import { isIOS } from 'lib/platform';
import { signHotDigest } from 'lib/secure-hot-key';
import { HotKey } from 'lib/secure-hot-key/hotKeyPlugin';
import { signHotDigest as fallbackSignHotDigest } from 'lib/secure-hot-key/jsFallback';

import { captureCrash } from './crash';
import {
  EXECUTION_CAUSES,
  FAILURE_REASONS,
  HOT_KEY_CODES,
  NEVER_COMMITTED_RULES,
  PIPELINE_KILLS,
  REPORTED_IDENTITIES,
  reportTransactionFailure,
  SIGNING_STEPS,
  SUBMIT_GRPC_STATUSES,
  SUBMIT_HIDDEN_ANSWERS
} from './transaction-failure';
// The shipped class, past the stub jest maps the package to, so the fields the report reads are the ones it sets.
import { GuardianHttpError } from '../../../node_modules/@openzeppelin/guardian-client/dist/http.js';

jest.mock('./crash', () => ({ captureCrash: jest.fn() }));
jest.mock('lib/platform', () => ({ ...jest.requireActual('lib/platform'), isIOS: jest.fn(() => false) }));
jest.mock('lib/secure-hot-key/hotKeyPlugin', () => ({ HotKey: { signWithHotKey: jest.fn() } }));
jest.mock('lib/secure-hot-key/jsFallback', () => ({ signHotDigest: jest.fn() }));

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

const reportedMessage = async (): Promise<string> => {
  await settle();
  return (jest.mocked(captureCrash).mock.calls[0]![0] as Error).message;
};

const REPO_ROOT = join(__dirname, '..', '..', '..');

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
  expect(options).toEqual({ initializeIfNeeded: true, level: 'error' });
  expect(source).toBe('manual');
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
  expect(text).toContain('kernel_assertion_unknown');
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
  ['assertion failed with error code: 1', '; kernel_assertion_unknown'],
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
  ['an unknown code', 'claim failed', '9876543210123', 'kernel_assertion_unknown'],
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
const submitOutcomeUnknown = (kind: string) =>
  new Error(
    `failed to submit proven transaction: submission of transaction ${TX_ID} came back without a definite outcome, ` +
      'so the node may or may not have accepted it; nothing was recorded locally: grpc request failed for ' +
      `submit_proven_transaction: ${kind}`
  );

describe('an unknown submit outcome', () => {
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
      `; point pipeline; submit_outcome_unknown; grpc ${status}; app hidden during submit no. authentication`
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
    expect(message).toContain(`; submit_outcome_unknown; grpc unavailable; app hidden during submit ${answer}. `);
    expectNoTransactionData(message);
  });
});

describe('a pipeline killed from outside', () => {
  const sync = (cause: unknown) => new Error(`pre-flight sync for ${ACCOUNT} failed`, { cause });

  it.each([
    ['deadline', 'offscreen_aborted_deadline'],
    ['deadline-no-kill', 'offscreen_aborted_deadline_no_kill'],
    ['doc-closed', 'offscreen_aborted_doc_closed'],
    ['transport', 'offscreen_aborted_transport'],
    [`stalled on ${ACCOUNT_HEX}`, 'offscreen_aborted_other']
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
    expect(aborted).toContain('; point pipeline; offscreen_aborted_other. ');
    expectNoTransactionData(`${evicted} ${aborted}`);
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
    ['an unknown code', '7', 'kernel_u32_assertion_unknown']
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
      expect(message).toContain(`; point node_verdict; never_committed; rule ${rule}. authentication`);
      expect(message).not.toContain('; network.');
    }
  );

  it('names a verdict with no rule by its reason alone, and a rule outside the list as other', async () => {
    reportTransactionFailure({ point: 'guardian_node_verdict', type: 'switch-guardian', reason: 'never_committed' });
    reportTransactionFailure({
      point: 'node_verdict',
      type: 'send',
      reason: 'never_committed',
      neverCommittedRule: ACCOUNT_HEX
    } as never);
    await settle();
    const [guardian, poisoned] = jest.mocked(captureCrash).mock.calls.map(([error]) => (error as Error).message);
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

it.each([...FAILURE_REASONS, ...GUARDIAN_ERROR_CODES, ...HOT_KEY_CODES, 'other', 'none'])(
  'the privacy policy lists the reportable value %s',
  value => {
    expect(crashReportPolicy()).toContain(`\`${value}\``);
  }
);

// Read inside the test, so a list the reporter does not export yet fails here rather than at collection.
it.each([
  ['never-committed rule', () => NEVER_COMMITTED_RULES],
  ['submit gRPC status', () => SUBMIT_GRPC_STATUSES],
  ['hidden-during-submit answer', () => SUBMIT_HIDDEN_ANSWERS],
  ['pipeline kill', () => PIPELINE_KILLS],
  ['execution cause', () => EXECUTION_CAUSES],
  ['signing step', () => SIGNING_STEPS],
  ['reported identity', () => REPORTED_IDENTITIES]
])('the privacy policy lists every reportable %s', (_name, values) => {
  const listed: readonly string[] | undefined = values();
  expect(listed).toEqual(expect.arrayContaining([expect.any(String)]));
  expect((listed ?? []).filter(value => !crashReportPolicy().includes(`\`${value}\``))).toEqual([]);
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
  expect(identity).toMatch(/_unknown$/);
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
  expect(error.message).toContain('point bridge_receive_settlement; unknown.');
});

it('never makes a telemetry failure escape into the transaction', async () => {
  jest.mocked(captureCrash).mockImplementationOnce(() => {
    throw new Error('Sentry unavailable');
  });
  expect(() => reportTransactionFailure({ type: 'swap' })).not.toThrow();
  await settle();
});
