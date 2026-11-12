/** @jest-environment node */
import { createHash, webcrypto } from 'node:crypto';
import { isRecord } from '../src/lib/update/guards';
import { canonicalRequestBytes } from './canonical-request-bytes.mjs';
import {
  awaitTestConsumeAuthorization,
  TEST_CONSUME_AUTHORIZATION_KEY as KEY
} from '../src/lib/miden/sdk/test-consume-authorization';

const account = `0x${'11'.repeat(15)}`;
const note = `0x${'22'.repeat(32)}`;
const nonce = '11111111-1111-4111-8111-111111111111';
const bytes = new Uint8Array(200);
new DataView(bytes.buffer).setBigUint64(0, 2n, true);
bytes.fill(1, 8, 40);
bytes.fill(2, 104, 136);
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const policy = () => ({
  nonce,
  accountId: account,
  noteId: note,
  canonicalSha256: digest(canonicalRequestBytes(bytes)),
  status: 'armed'
});
let data: Record<string, unknown>;
let observed: Promise<void>;
let waiting: () => void;
const get = jest.fn();
const set = jest.fn();
const serialize = jest.fn();
const oldEnvironment = process.env.MIDEN_E2E_TEST;
const oldChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
const oldCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
beforeEach(() => {
  jest.useFakeTimers();
  process.env.MIDEN_E2E_TEST = 'true';
  jest.clearAllMocks();
  data = { [KEY]: policy() };
  observed = new Promise(resolve => {
    waiting = resolve;
  });
  get.mockImplementation(async () => structuredClone(data));
  set.mockImplementation(async patch => {
    Object.assign(data, structuredClone(patch));
    if (Reflect.get(data[KEY] as object, 'status') === 'waiting') waiting();
  });
  serialize.mockImplementation(() => Uint8Array.from(bytes));
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { storage: { local: { get, set } } } });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});
afterEach(() => {
  jest.useRealTimers();
  if (oldEnvironment === undefined) delete process.env.MIDEN_E2E_TEST;
  else process.env.MIDEN_E2E_TEST = oldEnvironment;
  if (oldChrome) Object.defineProperty(globalThis, 'chrome', oldChrome);
  else Reflect.deleteProperty(globalThis, 'chrome');
  if (oldCrypto) Object.defineProperty(globalThis, 'crypto', oldCrypto);
  else Reflect.deleteProperty(globalThis, 'crypto');
});
const run = (actor = account, ids = [note]) => awaitTestConsumeAuthorization(actor, ids, { serialize });
async function waitForHeld(promise: Promise<unknown>): Promise<void> {
  expect(
    await Promise.race([
      observed.then(() => true),
      promise.then(
        () => false,
        () => false
      )
    ])
  ).toBe(true);
}
it('does not read storage or request bytes in production', async () => {
  process.env.MIDEN_E2E_TEST = 'false';
  await run();
  expect(get).not.toHaveBeenCalled();
  expect(serialize).not.toHaveBeenCalled();
});
it('preserves ordinary E2E consumes when no mainnet claim gate is armed', async () => {
  data = {};
  await run();
  expect(serialize).not.toHaveBeenCalled();
  expect(set).not.toHaveBeenCalled();
});
for (const invalid of [
  null,
  { ...policy(), nonce: '' },
  { ...policy(), accountId: '' },
  { ...policy(), noteId: 'wrong' },
  { ...policy(), canonicalSha256: 'wrong' },
  { ...policy(), status: 'released' },
  { ...policy(), status: 'spent' }
])
  it('refuses malformed or already released authority', async () => {
    data[KEY] = invalid;
    await expect(run()).rejects.toThrow(/authorization|scope|armed|spent|used/i);
    expect(serialize).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
it('does not touch the request when authorization storage is unavailable', async () => {
  get.mockRejectedValue(new Error('storage unavailable'));
  await expect(run()).rejects.toThrow('storage unavailable');
  expect(serialize).not.toHaveBeenCalled();
});
it('never executes after an asynchronously suspended final spent-state write exceeds the original hold', async () => {
  const promise = run();
  await waitForHeld(promise);
  const outcome = promise.then(
    () => 'released',
    () => 'blocked'
  );
  set.mockImplementation(async value => {
    Object.assign(data, structuredClone(value));
    const current = data[KEY];
    if (isRecord(current) && current.status === 'spent') jest.setSystemTime(Date.now() + 240_001);
  });
  const current = data[KEY];
  if (!isRecord(current)) throw new Error('Missing unit held policy');
  data[KEY] = { ...current, status: 'released' };
  await jest.advanceTimersByTimeAsync(500);
  expect(await outcome).toBe('blocked');
});
it('never overwrites a replacement consume authority installed during initial asynchronous request inspection', async () => {
  const replacement = { ...policy(), nonce: '22222222-2222-4222-8222-222222222222' };
  serialize.mockImplementationOnce(() => {
    data[KEY] = replacement;
    return Uint8Array.from(bytes);
  });
  const promise = run();
  const outcome = promise.then(
    () => 'released',
    () => 'blocked'
  );
  await Promise.race([observed, outcome]);
  const current = data[KEY];
  if (isRecord(current) && current.status === 'waiting') data[KEY] = { ...current, status: 'released' };
  await jest.advanceTimersByTimeAsync(500);
  expect(await outcome).toBe('blocked');
  expect(data[KEY]).toEqual(replacement);
});
it('never overwrites a replacement consume authority installed during asynchronous final byte verification', async () => {
  const promise = run();
  await waitForHeld(promise);
  const outcome = promise.then(
    () => 'released',
    () => 'blocked'
  );
  const replacement = { ...policy(), nonce: '22222222-2222-4222-8222-222222222222' };
  serialize.mockImplementation(() => {
    data[KEY] = replacement;
    return Uint8Array.from(bytes);
  });
  const current = data[KEY];
  if (!isRecord(current)) throw new Error('Missing unit held policy');
  data[KEY] = { ...current, status: 'released' };
  await jest.advanceTimersByTimeAsync(500);
  expect(await outcome).toBe('blocked');
  expect(data[KEY]).toEqual(replacement);
});
it('holds the actual request and publishes ONLY digests until its exact release, then consumes authority once', async () => {
  let finished = false;
  const promise = run().then(() => {
    finished = true;
  });
  await waitForHeld(promise);
  expect(finished).toBe(false);
  expect(data[KEY]).toEqual({ ...policy(), status: 'waiting', sha256: digest(bytes) });
  expect(JSON.stringify(data)).not.toContain(Array.from(bytes).join(','));
  data[KEY] = { ...(data[KEY] as object), status: 'released' };
  await jest.advanceTimersByTimeAsync(500);
  await promise;
  expect(finished).toBe(true);
  expect(data[KEY]).toMatchObject({ status: 'spent', sha256: digest(bytes) });
  await expect(run()).rejects.toThrow(/spent|used|armed|authorization/i);
});
for (const [name, actor, ids] of [
  ['another actor', `0x${'33'.repeat(15)}`, [note]],
  ['another note', account, [`0x${'44'.repeat(32)}`]],
  ['an extra input', account, [note, `0x${'44'.repeat(32)}`]]
] as const)
  it(`blocks ${name} before publishing a request`, async () => {
    await expect(run(actor, [...ids])).rejects.toThrow(/actor|note|scope|authorization/i);
    expect(set).not.toHaveBeenCalled();
  });
it('rejects different actual canonical bytes before asking for release', async () => {
  serialize.mockImplementation(() => {
    const changed = Uint8Array.from(bytes);
    changed[8] = 9;
    return changed;
  });
  await expect(run()).rejects.toThrow(/request|digest|canonical/i);
  expect(set).not.toHaveBeenCalled();
});
it('does not use a replacement release policy while the original request is held', async () => {
  const promise = run();
  await waitForHeld(promise);
  const rejected = expect(promise).rejects.toThrow(/changed|authorization|scope/i);
  data[KEY] = { ...(data[KEY] as object), nonce: '22222222-2222-4222-8222-222222222222', status: 'released' };
  await jest.advanceTimersByTimeAsync(500);
  await rejected;
});
it('blocks request mutation during the uploaded-authorization hold', async () => {
  const promise = run();
  await waitForHeld(promise);
  const rejected = expect(promise).rejects.toThrow(/changed|request|digest/i);
  serialize.mockImplementation(() => {
    const changed = Uint8Array.from(bytes);
    changed[8] = 9;
    return changed;
  });
  data[KEY] = { ...(data[KEY] as object), status: 'released' };
  await jest.advanceTimersByTimeAsync(500);
  await rejected;
});
it('rechecks the deadline after an asynchronous release read instead of signing after a suspended hold', async () => {
  const promise = run();
  await waitForHeld(promise);
  const outcome = promise.then(
    () => 'released',
    error => error.message
  );
  data[KEY] = { ...(data[KEY] as object), status: 'released' };
  get.mockImplementationOnce(async () => {
    jest.setSystemTime(Date.now() + 240_001);
    return structuredClone(data);
  });
  await jest.advanceTimersByTimeAsync(500);
  expect(await outcome).toMatch(/timeout|timed out/i);
  expect(data[KEY]).not.toMatchObject({ status: 'spent' });
});
it('times out closed without consuming release authority', async () => {
  const promise = run();
  await waitForHeld(promise);
  const rejected = expect(promise).rejects.toThrow(/timeout|timed out/i);
  await jest.advanceTimersByTimeAsync(240_001);
  await rejected;
  expect(data[KEY]).not.toMatchObject({ status: 'spent' });
});
