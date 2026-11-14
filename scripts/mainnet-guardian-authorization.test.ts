/** @jest-environment node */
import { createHash, webcrypto } from 'node:crypto';
import * as guardian from '../src/lib/miden/sdk/test-guardian-authorization';
import { isRecord } from '../src/lib/update/guards';
import { canonicalRequestBytes } from './canonical-request-bytes.mjs';

let mockStore: Record<string, unknown>;
jest.mock('../src/lib/miden/sdk/test-authorization-storage', () => ({
  getTestAuthorizationStorage: jest.fn(async () => structuredClone(mockStore))
}));
jest.mock('../src/lib/miden/sdk/helpers', () => ({
  walletAccountIdToSdk: (id: string) => ({ toString: () => id })
}));
const actor = `0x${'11'.repeat(15)}`;
const bytes = new Uint8Array(200);
new DataView(bytes.buffer).setBigUint64(0, 2n, true);
bytes.fill(1, 8, 40);
bytes.fill(2, 104, 136);
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const request = { serialize: () => Uint8Array.from(bytes) };
const kinds: readonly ('send' | 'consume')[] = ['send', 'consume'];
const key = (kind: 'send' | 'consume') => `e2e_mainnet_${kind}_authorization`;
const originalEnvironment = process.env.MIDEN_E2E_TEST;
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

async function verify(kind: 'send' | 'consume' | undefined, input = request, account = actor): Promise<void> {
  const check: unknown = Reflect.get(guardian, 'assertTestGuardianRequestAuthorization');
  if (typeof check !== 'function') throw new Error('Missing final Guardian request authorization check');
  await check(account, input, kind);
}
function spent(kind: 'send' | 'consume') {
  const name = key(kind);
  mockStore[name] = {
    accountId: actor,
    nonce: 'original-guardian-authority',
    status: 'spent',
    sha256: digest(bytes),
    canonicalSha256: kind === 'send' ? digest(canonicalRequestBytes(bytes)) : '33'.repeat(32),
    ...(kind === 'consume' ? { requestCanonicalSha256: digest(canonicalRequestBytes(bytes)) } : {}),
    expiresAt: Date.now() + 60_000
  };
  mockStore[`${name}_required`] = { accountId: actor, nonce: 'original-guardian-authority' };
}
function patch(kind: 'send' | 'consume', change: Record<string, unknown>) {
  const value = mockStore[key(kind)];
  if (!isRecord(value)) throw new Error('Missing unit authorization fixture');
  mockStore[key(kind)] = { ...value, ...change };
}
beforeEach(() => {
  process.env.MIDEN_E2E_TEST = 'true';
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  mockStore = {};
});
afterEach(() => {
  if (originalEnvironment === undefined) delete process.env.MIDEN_E2E_TEST;
  else process.env.MIDEN_E2E_TEST = originalEnvironment;
  if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
  else Reflect.deleteProperty(globalThis, 'crypto');
});

it.each(kinds)('accepts only the exact spent %s request after immutable upload', async kind => {
  spent(kind);
  await expect(verify(kind)).resolves.toBeUndefined();
});
it.each(kinds)('rejects modified signed %s bytes immediately before execution', async kind => {
  spent(kind);
  const changed = Uint8Array.from(bytes);
  changed[8] = 3;
  await expect(verify(kind, { serialize: () => changed })).rejects.toThrow();
});
it.each(kinds)('rejects an expired %s authority after async stage work', async kind => {
  spent(kind);
  patch(kind, { expiresAt: Date.now() - 1 });
  await expect(verify(kind)).rejects.toThrow();
});
it.each(['armed', 'waiting', 'released'])('does not execute an authority still %s', async status => {
  spent('send');
  patch('send', { status });
  await expect(verify('send')).rejects.toThrow();
});
it('refuses a missing policy when the original required marker remains', async () => {
  spent('send');
  delete mockStore[key('send')];
  await expect(verify('send')).rejects.toThrow();
});
it('refuses a replaced required nonce or another actor', async () => {
  spent('send');
  mockStore[`${key('send')}_required`] = { accountId: actor, nonce: 'replacement' };
  await expect(verify('send')).rejects.toThrow();
  spent('send');
  await expect(verify('send', request, `0x${'22'.repeat(15)}`)).rejects.toThrow();
});
it('rejects lost operation routing while an explicit authority exists', async () => {
  spent('send');
  await expect(verify(undefined)).rejects.toThrow();
});
it('preserves never-armed E2E behavior and independent consume policy scope', async () => {
  await expect(verify('send')).resolves.toBeUndefined();
  spent('send');
  await expect(verify('consume')).resolves.toBeUndefined();
});
it('keeps production untouched even when test storage contains an authority', async () => {
  spent('send');
  process.env.MIDEN_E2E_TEST = 'false';
  await expect(verify('send')).resolves.toBeUndefined();
});
