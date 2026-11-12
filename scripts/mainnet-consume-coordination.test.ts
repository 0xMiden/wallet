/** @jest-environment node */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { armMainnetConsumeAuthorization, releaseMainnetConsumeAuthorization, type MainnetConsumeAuthority }
  from '../playwright/e2e/helpers/mainnet-consume-authorization';
import { awaitMainnetLoopAuthorization } from '../playwright/e2e/helpers/mainnet-loop-authorization';
import { TEST_CONSUME_AUTHORIZATION_KEY as KEY } from '../src/lib/miden/sdk/test-consume-authorization';

jest.mock('../playwright/e2e/helpers/mainnet-loop-authorization', () => ({ awaitMainnetLoopAuthorization: jest.fn() }));
const scope = { accountId: `0x${'11'.repeat(15)}`, noteId: `0x${'22'.repeat(32)}`, canonicalSha256: '3'.repeat(64) };
const handle = { ...scope, nonce: '11111111-1111-4111-8111-111111111111' };
const authority = { nonce: handle.nonce, sha256: '4'.repeat(64), canonicalSha256: scope.canonicalSha256 };
const waitingPolicy = () => ({ ...handle, sha256: authority.sha256, status: 'waiting' });
const page = { evaluate: jest.fn(async (fn, argument) => fn(argument)) } as unknown as Page;
let data: Record<string, unknown>; let directory: string; let controller: AbortController;
const oldChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
let uploadStarted: Promise<void>; let started: () => void; let finish: () => void;
const persist = jest.fn(); const events: string[] = [];
const options = () => ({ checkpointPath: join(directory, 'authorization.json'), gatePath: join(directory, 'upload'),
  signal: controller.signal, persist });
beforeEach(() => {
  jest.clearAllMocks(); data = {}; events.length = 0; controller = new AbortController();
  directory = mkdtempSync(join(tmpdir(), 'mainnet-consume-coordinator-'));
  uploadStarted = new Promise(resolve => { started = resolve; });
  persist.mockImplementation(async (value: MainnetConsumeAuthority) => {
    events.push('persist'); writeFileSync(options().checkpointPath, JSON.stringify({ consumeAuthority: value }));
  });
  jest.mocked(awaitMainnetLoopAuthorization).mockImplementation(async () => {
    events.push('upload'); started(); await new Promise<void>(resolve => { finish = resolve; });
  });
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { storage: { local: {
    get: async () => structuredClone(data),
    set: async (patch: Record<string, unknown>) => {
      Object.assign(data, structuredClone(patch));
      if ((data[KEY] as { status: string }).status === 'released') events.push('release');
    }
  } } } });
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  if (oldChrome) Object.defineProperty(globalThis, 'chrome', oldChrome); else Reflect.deleteProperty(globalThis, 'chrome');
});
const release = () => releaseMainnetConsumeAuthorization(page, handle, options());
it('arms one actual account/note/canonical-byte scope with a fresh nonce and no private bytes', async () => {
  const armed = await armMainnetConsumeAuthorization(page, scope);
  expect(armed).toEqual({ ...scope, nonce: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  expect(data[KEY]).toEqual({ ...armed, status: 'armed' });
});
for (const status of ['armed', 'waiting', 'spent']) it(`does not replace ${status} authority and accidentally retry a funded claim`, async () => {
  data[KEY] = { ...handle, status };
  await expect(armMainnetConsumeAuthorization(page, scope)).rejects.toThrow(/unresolved|existing|authorization/i);
  expect(data[KEY]).toEqual({ ...handle, status });
});
it('persists exact actual request fingerprints BEFORE upload and releases only after upload acknowledgement', async () => {
  data[KEY] = waitingPolicy(); const promise = release();
  expect(await Promise.race([uploadStarted.then(() => true), promise.then(() => false, () => false)])).toBe(true);
  expect(persist).toHaveBeenCalledWith(authority);
  expect(JSON.parse(readFileSync(options().checkpointPath, 'utf8'))).toEqual({ consumeAuthority: authority });
  expect(data[KEY]).toMatchObject({ status: 'waiting' });
  expect(awaitMainnetLoopAuthorization).toHaveBeenCalledWith(options().checkpointPath, options().gatePath, controller.signal);
  finish(); await promise;
  expect(events).toEqual(['persist', 'upload', 'release']);
  expect(data[KEY]).toEqual({ ...waitingPolicy(), status: 'released' });
});
it('refuses a different actual SDK request scope before persisting or asking for upload', async () => {
  data[KEY] = { ...waitingPolicy(), canonicalSha256: '5'.repeat(64) };
  await expect(release()).rejects.toThrow(/scope|changed|request|authorization/i);
  expect(persist).not.toHaveBeenCalled(); expect(awaitMainnetLoopAuthorization).not.toHaveBeenCalled();
});
it('does not release when durable authorization persistence fails', async () => {
  data[KEY] = waitingPolicy(); persist.mockRejectedValue(new Error('write failed'));
  await expect(release()).rejects.toThrow('write failed');
  expect(awaitMainnetLoopAuthorization).not.toHaveBeenCalled(); expect(data[KEY]).toMatchObject({ status: 'waiting' });
});
it('does not release when the exact artifact upload fails', async () => {
  data[KEY] = waitingPolicy(); jest.mocked(awaitMainnetLoopAuthorization).mockRejectedValue(new Error('artifact upload failed'));
  await expect(release()).rejects.toThrow('artifact upload failed'); expect(data[KEY]).toMatchObject({ status: 'waiting' });
});
it('refuses native scope replacement during the artifact upload', async () => {
  data[KEY] = waitingPolicy(); jest.mocked(awaitMainnetLoopAuthorization).mockImplementation(async () => {
    data[KEY] = { ...waitingPolicy(), nonce: '22222222-2222-4222-8222-222222222222' };
  });
  await expect(release()).rejects.toThrow(/scope|changed|authorization/i);
  expect(data[KEY]).toMatchObject({ status: 'waiting' });
});
it('does not release if the run is cancelled while uploading authorization', async () => {
  data[KEY] = waitingPolicy(); jest.mocked(awaitMainnetLoopAuthorization).mockImplementation(async () => { controller.abort(); });
  await expect(release()).rejects.toThrow(/abort|cancel/i); expect(data[KEY]).toMatchObject({ status: 'waiting' });
});
