import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { compileFunction } from 'node:vm';
import test from 'node:test';
import { inspectAuth, takePrf, sameBytes } from './probe-core.mjs';

const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const challenge = new Uint8Array(32).fill(7);
const context = { origin, challenge, type: 'webauthn.get' };
function fixture(flags = 5, change = {}) {
  const data = new Uint8Array(37);
  data.set(createHash('sha256').update(origin).digest());
  data[32] = flags;
  const client = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', origin, challenge: Buffer.from(challenge).toString('base64url'), crossOrigin: false, ...change }));
  return { data, client };
}

test('accepts native UP+UV and hashes the full extension origin, not just its ID', async () => {
  const { data, client } = fixture(13);
  assert.deepEqual(await inspectAuth(data, client, context), { uv: true, backupEligible: true });
});
for (const flags of [0, 1, 4, 8]) {
  test(`rejects authenticator flags ${flags} without both UP and UV`, async () => {
    const { data, client } = fixture(flags);
    await assert.rejects(inspectAuth(data, client, context));
  });
}
test('rejects another RP hash', async () => {
  const { data, client } = fixture();
  data[0] ^= 1;
  await assert.rejects(inspectAuth(data, client, context));
});
test('rejects truncated authenticator data', async () => {
  const { data, client } = fixture();
  await assert.rejects(inspectAuth(data.slice(0, 36), client, context));
});
for (const change of [{ origin: 'https://example.invalid' }, { challenge: 'wrong' }, { type: 'webauthn.create' }, { crossOrigin: true }]) {
  test(`rejects mismatched client binding ${Object.keys(change)[0]}`, async () => {
    const { data, client } = fixture(5, change);
    await assert.rejects(inspectAuth(data, client, context));
  });
}
test('accepts omitted crossOrigin but rejects malformed client JSON', async () => {
  const { data, client } = fixture(5, { crossOrigin: undefined });
  assert.equal((await inspectAuth(data, client, context)).uv, true);
  await assert.rejects(inspectAuth(data, new TextEncoder().encode('{'), context));
});
test('requires an actual 32-byte PRF result, never the enabled flag alone', () => {
  assert.throws(() => takePrf({ prf: { enabled: true } }));
  for (const size of [0, 16, 31, 33, 64]) {
    assert.throws(() => takePrf({ prf: { results: { first: new ArrayBuffer(size) } } }));
  }
  assert.throws(() => takePrf({ prf: { results: { first: new Uint8Array(32) } } }));
});
test('returns a zeroable view of the result, not a retained secret copy', () => {
  const buffer = new Uint8Array(32).fill(91).buffer;
  const view = takePrf({ prf: { results: { first: buffer } } });
  assert.equal(view.byteLength, 32);
  assert.equal(view[0], 91);
  view.fill(0);
  assert.equal(new Uint8Array(buffer).every(v => v === 0), true);
});
test('validates registration client binding as well as assertion binding', async () => {
  const { data, client } = fixture(5, { type: 'webauthn.create' });
  assert.equal((await inspectAuth(data, client, { ...context, type: 'webauthn.create' })).uv, true);
});
test('clears an invalid-size PRF buffer before reporting it unavailable', () => {
  const bytes = new Uint8Array(16).fill(33);
  assert.throws(() => takePrf({ prf: { results: { first: bytes.buffer } } }));
  assert.equal(bytes.every(v => v === 0), true);
});
test('browser entry module parses before delivery', () => {
  const source = readFileSync(new URL('./probe.mjs', import.meta.url), 'utf8');
  compileFunction(source.replace(/^import[^\n]*;\n/, ''));
});
test('compares all 32 bytes for repeat-salt and changed-salt checks', () => {
  const a = new Uint8Array(32).fill(2);
  assert.equal(sameBytes(a, a.slice()), true);
  const b = a.slice(); b[31] ^= 1;
  assert.equal(sameBytes(a, b), false);
  assert.throws(() => sameBytes(a, b.slice(0, 31)));
});
