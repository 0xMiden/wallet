/** @jest-environment node */
import { createHash, webcrypto } from 'node:crypto';
import { isRecord } from '../src/lib/update/guards';
import { canonicalRequestBytes } from './canonical-request-bytes.mjs';
const mockInspect = jest.fn();
const mockInspectSwap = jest.fn();
jest.mock('../src/lib/miden/sdk/test-send-request', () => ({
  inspectTestMainnetSendRequest: (...args: unknown[]) => mockInspect(...args),
  inspectTestMainnetSwapRequest: (...args: unknown[]) => mockInspectSwap(...args)
}));
import {
  awaitTestSendAuthorization,
  TEST_SEND_AUTHORIZATION_KEY as KEY
} from '../src/lib/miden/sdk/test-send-authorization';

const account = `0x${'11'.repeat(15)}`;
const noteId = `0x${'22'.repeat(32)}`;
const scope = {
  nonce: '11111111-1111-4111-8111-111111111111',
  accountId: account,
  recipientId: `0x${'33'.repeat(15)}`,
  faucetId: '0xe69e6ca6e39df1b10c1e5399399feb',
  amount: '1010000',
  expiresAt: Date.now() + 60_000
};
const bytes = new Uint8Array(200);
new DataView(bytes.buffer).setBigUint64(0, 2n, true);
bytes.fill(1, 8, 40);
bytes.fill(2, 104, 136);
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
let data: Record<string, unknown>;
let observed: Promise<void>;
let waiting: () => void;
const get = jest.fn();
const set = jest.fn();
const serialize = jest.fn();
const oldEnvironment = process.env.MIDEN_E2E_TEST;
const oldChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
const oldCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
function patch(value: Record<string, unknown>) {
  const current = data[KEY];
  if (!isRecord(current)) throw new Error('Missing test scope');
  data[KEY] = { ...current, ...value };
}
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  process.env.MIDEN_E2E_TEST = 'true';
  data = { [KEY]: { ...scope, status: 'armed' } };
  observed = new Promise(resolve => {
    waiting = resolve;
  });
  get.mockImplementation(async () => structuredClone(data));
  set.mockImplementation(async value => {
    Object.assign(data, structuredClone(value));
    const current = data[KEY];
    if (isRecord(current) && current.status === 'waiting') waiting();
  });
  serialize.mockImplementation(() => Uint8Array.from(bytes));
  mockInspect.mockReturnValue(noteId);
  mockInspectSwap.mockReturnValue({ noteId, orderId: '42' });
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
function offscreenStorage() {
  const relay = jest.fn(async (message: unknown): Promise<unknown> => {
    if (!isRecord(message)) throw new Error('Invalid unit relay message');
    if (message.operation === 'get') return { ok: true, value: await get() };
    if (message.operation === 'set') {
      await set(message.items);
      return { ok: true };
    }
    throw new Error('Unsupported unit relay operation');
  });
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { runtime: { sendMessage: relay } } });
  return relay;
}
const run = (actor = account) => awaitTestSendAuthorization(actor, { serialize });
async function held(promise: Promise<void>) {
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
it('is a no-op before reading storage or request bytes in production', async () => {
  process.env.MIDEN_E2E_TEST = 'false';
  await run();
  expect(get).not.toHaveBeenCalled();
  expect(serialize).not.toHaveBeenCalled();
});
it('preserves unarmed legacy E2E sends', async () => {
  data = {};
  await run();
  expect(serialize).not.toHaveBeenCalled();
  expect(set).not.toHaveBeenCalled();
});
it('preserves unarmed E2E sends in the real offscreen API shape without chrome.storage', async () => {
  data = {};
  const relay = offscreenStorage();
  await run();
  expect(relay).toHaveBeenCalledWith(expect.objectContaining({ target: 'sw', operation: 'get' }));
  expect(serialize).not.toHaveBeenCalled();
});
it('retains the funded byte hold through the offscreen service-worker storage relay', async () => {
  const relay = offscreenStorage();
  const promise = run();
  await held(promise);
  patch({ status: 'released' });
  await jest.advanceTimersByTimeAsync(500);
  await promise;
  expect(data[KEY]).toMatchObject({ nonce: scope.nonce, status: 'spent' });
  expect(relay).toHaveBeenCalledWith(expect.objectContaining({ target: 'sw', operation: 'set' }));
});
it.each([undefined, { ok: false }, { ok: true, value: null }])(
  'refuses a missing or invalid storage relay response: %j',
  async response => {
    const relay = offscreenStorage();
    relay.mockImplementation(async () => response);
    await expect(run()).rejects.toThrow(/storage|relay/i);
    expect(serialize).not.toHaveBeenCalled();
  }
);
it('fails closed before inspecting bytes when an explicitly armed policy disappeared', async () => {
  data = { [`${KEY}_required`]: { accountId: account, nonce: scope.nonce } };
  await expect(run()).rejects.toThrow(/missing|authorization/i);
  expect(serialize).not.toHaveBeenCalled();
  expect(set).not.toHaveBeenCalled();
});
it.each([null, { accountId: account, nonce: 'foreign' }, { accountId: 'foreign', nonce: scope.nonce }])(
  'rejects a policy detached from its original required scope: %j',
  async required => {
    data[`${KEY}_required`] = required;
    const outcome = run().then(
      () => 'released',
      () => 'blocked'
    );
    expect(await Promise.race([outcome, observed.then(() => 'waiting')])).toBe('blocked');
    expect(serialize).not.toHaveBeenCalled();
  }
);
it('holds exact PSWAP bytes and their actual serial-derived order, without reinterpreting them as a native send', async () => {
  const swap = {
    nonce: scope.nonce,
    accountId: account,
    faucetId: scope.faucetId,
    amount: scope.amount,
    kind: 'swap',
    requestedFaucetId: '0x5cb79d29507d3ad17bb6dc60279e89',
    requestedAmount: '1001000',
    expiresAt: scope.expiresAt
  };
  data[KEY] = { ...swap, status: 'armed' };
  data[`${KEY}_required`] = { accountId: account, nonce: swap.nonce };
  const promise = awaitTestSendAuthorization(account, { serialize }, 'swap');
  await held(promise);
  expect(mockInspectSwap).toHaveBeenCalledWith(swap, bytes);
  expect(mockInspect).not.toHaveBeenCalled();
  expect(data[KEY]).toMatchObject({ ...swap, noteId, orderId: '42', status: 'waiting' });
  patch({ status: 'released' });
  await jest.advanceTimersByTimeAsync(500);
  await promise;
  expect(data[KEY]).toMatchObject({ orderId: '42', status: 'spent' });
});
it('never uses a native send policy to authorize a PSWAP call', async () => {
  const outcome = awaitTestSendAuthorization(account, { serialize }, 'swap').then(
    () => 'released',
    () => 'blocked'
  );
  expect(await Promise.race([outcome, observed.then(() => 'waiting')])).toBe('blocked');
  expect(serialize).not.toHaveBeenCalled();
  expect(mockInspect).not.toHaveBeenCalled();
});
it('holds exact inspected send bytes, exposes only public fingerprints, then spends the original authority once', async () => {
  data[`${KEY}_required`] = { accountId: account, nonce: scope.nonce };
  let finished = false;
  const promise = run().then(() => {
    finished = true;
  });
  await held(promise);
  expect(finished).toBe(false);
  expect(data[KEY]).toEqual({
    ...scope,
    noteId,
    canonicalSha256: digest(canonicalRequestBytes(bytes)),
    sha256: digest(bytes),
    status: 'waiting'
  });
  expect(JSON.stringify(data)).not.toContain(Array.from(bytes).join(','));
  patch({ status: 'released' });
  await jest.advanceTimersByTimeAsync(500);
  await promise;
  expect(finished).toBe(true);
  expect(data[KEY]).toMatchObject({ status: 'spent', noteId });
  await expect(run()).rejects.toThrow();
});
it('rejects a different SDK payer before inspecting or publishing a request', async () => {
  await expect(run(`0x${'44'.repeat(15)}`)).rejects.toThrow();
  expect(mockInspect).not.toHaveBeenCalled();
  expect(set).not.toHaveBeenCalled();
});
for (const invalid of [
  null,
  { ...scope, nonce: '', status: 'armed' },
  { ...scope, amount: '0', status: 'armed' },
  { ...scope, status: 'waiting' },
  { ...scope, status: 'spent' }
])
  it('rejects malformed, reused or already waiting authority', async () => {
    data[KEY] = invalid;
    await expect(run()).rejects.toThrow();
    expect(serialize).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
it('does not publish a request rejected by actual SDK byte inspection', async () => {
  mockInspect.mockImplementation(() => {
    throw new Error('scope mismatch');
  });
  await expect(run()).rejects.toThrow();
  expect(set).not.toHaveBeenCalled();
});
it('never overwrites a replacement authority installed while request inspection was running', async () => {
  const replacement = { ...scope, nonce: '22222222-2222-4222-8222-222222222222', status: 'armed' };
  mockInspect.mockImplementation(() => {
    data[KEY] = replacement;
    return noteId;
  });
  await expect(run()).rejects.toThrow();
  expect(data[KEY]).toEqual(replacement);
  expect(set).not.toHaveBeenCalled();
});
it('blocks a replacement scope while the original request waits for upload', async () => {
  const promise = run();
  await held(promise);
  const rejected = expect(promise).rejects.toThrow();
  patch({ recipientId: account, status: 'released' });
  await jest.advanceTimersByTimeAsync(500);
  await rejected;
});
it('blocks request mutation during the actual artifact upload', async () => {
  const promise = run();
  await held(promise);
  const rejected = expect(promise).rejects.toThrow();
  serialize.mockImplementation(() => {
    const changed = Uint8Array.from(bytes);
    changed[8] = 9;
    return changed;
  });
  patch({ status: 'released' });
  await jest.advanceTimersByTimeAsync(500);
  await rejected;
});
it('refuses a release after an asynchronously suspended deadline', async () => {
  const promise = run();
  await held(promise);
  const outcome = promise.then(
    () => 'released',
    () => 'blocked'
  );
  patch({ status: 'released' });
  get.mockImplementation(async () => {
    jest.setSystemTime(Date.now() + 240_001);
    return structuredClone(data);
  });
  await jest.advanceTimersByTimeAsync(500);
  expect(await outcome).toBe('blocked');
});
it('rejects release after the original quote deadline even inside its local upload hold', async () => {
  const promise = run();
  await held(promise);
  const outcome = promise.then(
    () => 'released',
    () => 'blocked'
  );
  patch({ status: 'released' });
  jest.setSystemTime(scope.expiresAt + 1);
  await jest.advanceTimersByTimeAsync(500);
  expect(await outcome).toBe('blocked');
});
it('never executes after a suspended final spent-state write exceeds its original deadline', async () => {
  const promise = run();
  await held(promise);
  const outcome = promise.then(
    () => 'released',
    () => 'blocked'
  );
  set.mockImplementation(async value => {
    Object.assign(data, structuredClone(value));
    const current = data[KEY];
    if (isRecord(current) && current.status === 'spent') jest.setSystemTime(Date.now() + 240_001);
  });
  patch({ status: 'released' });
  await jest.advanceTimersByTimeAsync(500);
  expect(await outcome).toBe('blocked');
});
it('does not inspect or execute when storage is unavailable', async () => {
  get.mockRejectedValue(new Error('storage unavailable'));
  await expect(run()).rejects.toThrow();
  expect(mockInspect).not.toHaveBeenCalled();
  expect(serialize).not.toHaveBeenCalled();
});
