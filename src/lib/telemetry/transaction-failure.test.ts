import { GUARDIAN_ERROR_CODES } from '@openzeppelin/guardian-client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { signHotDigest } from 'lib/secure-hot-key';
import { signHotDigest as fallbackSignHotDigest } from 'lib/secure-hot-key/jsFallback';
import { signHotDigest as nativeSignHotDigest } from 'lib/secure-hot-key/nativePlugin';

import { captureCrash } from './crash';
import { reportTransactionFailure } from './transaction-failure';

jest.mock('./crash', () => ({ captureCrash: jest.fn() }));
jest.mock('lib/secure-hot-key/nativePlugin', () => ({ signHotDigest: jest.fn() }));
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
  jest
    .mocked(nativeSignHotDigest)
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
  expect(options).toEqual({ initializeIfNeeded: true });
  expect(source).toBe('manual');
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

it.each([...GUARDIAN_ERROR_CODES])('reports the published Guardian code %s', async code => {
  reportTransactionFailure({ type: 'send', error: guardianRefusal(400, 'Bad Request', code) });
  expect(await reportedMessage()).toContain(`; guardian_http_400; guardian code ${code}. `);
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
  'failed to execute transaction',
  'assertion failed with error code: 1',
  'advice stack read failed',
  'WebClient terminated'
])('reports a Guardian refusal whose text says "%s" by its status and code', async text => {
  const refusal = Object.assign(guardianRefusal(409, 'Conflict', 'conflict_pending_delta'), {
    message: `GUARDIAN HTTP error 409: Conflict - ${text}`
  });
  reportTransactionFailure({ type: 'consume', error: new Error(`claim failed: ${text}`, { cause: refusal }) });
  expect(await reportedMessage()).toContain(
    '; point pipeline; guardian_http_409; guardian code conflict_pending_delta. '
  );
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

it('never makes a telemetry failure escape into the transaction', async () => {
  jest.mocked(captureCrash).mockImplementationOnce(() => {
    throw new Error('Sentry unavailable');
  });
  expect(() => reportTransactionFailure({ type: 'swap' })).not.toThrow();
  await settle();
});
