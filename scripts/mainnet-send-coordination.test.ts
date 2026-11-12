/** @jest-environment node */
import type { Page } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRecord } from '../src/lib/update/guards';
import { armMainnetSendAuthorization, releaseMainnetSendAuthorization, type MainnetSendAuthority }
  from '../playwright/e2e/helpers/mainnet-send-authorization';
import { awaitMainnetLoopAuthorization } from '../playwright/e2e/helpers/mainnet-loop-authorization';
jest.mock('../playwright/e2e/helpers/mainnet-loop-authorization', () => ({ awaitMainnetLoopAuthorization: jest.fn() }));
jest.mock('../src/lib/miden/sdk/test-send-authorization', () => ({ TEST_SEND_AUTHORIZATION_KEY: 'e2e_mainnet_send_authorization' }));
const KEY = 'e2e_mainnet_send_authorization';
const scope = { accountId: `0x${'11'.repeat(15)}`, recipientId: `0x${'33'.repeat(15)}`,
  faucetId: '0xe69e6ca6e39df1b10c1e5399399feb', amount: '1010000', expiresAt: Date.now() + 60_000 };
const handle = { ...scope, nonce: '11111111-1111-4111-8111-111111111111' };
const authority = { nonce: handle.nonce, noteId: `0x${'22'.repeat(32)}`, sha256: '4'.repeat(64), canonicalSha256: '5'.repeat(64) };
const waitingPolicy = () => ({ ...handle, ...authority, status: 'waiting' });
const evaluate = jest.fn(); const page: Pick<Page, 'evaluate'> = { evaluate };
let data: Record<string, unknown>; let directory: string; let controller: AbortController;
let uploaded: Promise<void>; let started: () => void; let finish: () => void;
const persist = jest.fn(); const events: string[] = [];
const oldChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
const options = () => ({ checkpointPath: join(directory, 'authorization.json'), gatePath: join(directory, 'upload'),
  signal: controller.signal, persist });
beforeEach(() => {
  jest.clearAllMocks(); data = {}; events.length = 0; controller = new AbortController();
  directory = mkdtempSync(join(tmpdir(), 'mainnet-send-coordinator-'));
  evaluate.mockImplementation(async (callback, argument) => callback(argument));
  uploaded = new Promise(resolve => { started = resolve; });
  persist.mockImplementation(async (value: MainnetSendAuthority) => {
    events.push('persist'); writeFileSync(options().checkpointPath, JSON.stringify({ sendAuthority: value }));
  });
  jest.mocked(awaitMainnetLoopAuthorization).mockImplementation(async () => {
    events.push('upload'); started(); await new Promise<void>(resolve => { finish = resolve; });
  });
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { storage: { local: {
    get: async () => structuredClone(data),
    set: async (value: Record<string, unknown>) => {
      Object.assign(data, structuredClone(value)); const current = data[KEY];
      if (isRecord(current) && current.status === 'released') events.push('release');
    }
  } } } });
});
afterEach(() => {
  jest.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
  if (oldChrome) Object.defineProperty(globalThis, 'chrome', oldChrome); else Reflect.deleteProperty(globalThis, 'chrome');
});
const release = () => releaseMainnetSendAuthorization(page, handle, options());
it('arms exactly the existing payer and signed native route with a fresh nonce', async () => {
  const actual = await armMainnetSendAuthorization(page, scope);
  expect(actual).toEqual({ ...scope, nonce: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  expect(data[KEY]).toEqual({ ...actual, status: 'armed' });
});
for (const status of ['armed', 'waiting', 'spent']) it(`never replaces an existing ${status} send authority`, async () => {
  data[KEY] = { ...handle, status };
  await expect(armMainnetSendAuthorization(page, scope)).rejects.toThrow(); expect(data[KEY]).toEqual({ ...handle, status });
});
it('never releases a native request whose original quote expired while its exact checkpoint was uploading', async () => {
  jest.useFakeTimers().setSystemTime(scope.expiresAt - 1000);
  data[KEY] = waitingPolicy(); const promise = release(); await uploaded;
  jest.setSystemTime(scope.expiresAt + 1); finish(); await expect(promise).rejects.toThrow();
  expect(data[KEY]).toMatchObject({ status: 'waiting', expiresAt: scope.expiresAt });
});
it('persists only exact actual note identity and fingerprints before uploading, then releases once', async () => {
  data[KEY] = waitingPolicy(); const promise = release();
  expect(await Promise.race([uploaded.then(() => true), promise.then(() => false, () => false)])).toBe(true);
  expect(JSON.parse(readFileSync(options().checkpointPath, 'utf8'))).toEqual({ sendAuthority: authority });
  expect(data[KEY]).toMatchObject({ status: 'waiting' }); finish(); expect(await promise).toEqual(authority);
  expect(events).toEqual(['persist', 'upload', 'release']); expect(data[KEY]).toEqual({ ...waitingPolicy(), status: 'released' });
});
it('rejects changed SDK route scope before persisting any authority', async () => {
  data[KEY] = { ...waitingPolicy(), amount: '1010001' }; await expect(release()).rejects.toThrow();
  expect(persist).not.toHaveBeenCalled(); expect(awaitMainnetLoopAuthorization).not.toHaveBeenCalled();
});
it('rejects malformed actual request fingerprints before uploading', async () => {
  data[KEY] = { ...waitingPolicy(), noteId: 'bad', sha256: 'bad' }; await expect(release()).rejects.toThrow();
  expect(persist).not.toHaveBeenCalled(); expect(awaitMainnetLoopAuthorization).not.toHaveBeenCalled();
});
it('does not release after checkpoint persistence fails', async () => {
  data[KEY] = waitingPolicy(); persist.mockRejectedValue(new Error('write failed'));
  await expect(release()).rejects.toThrow('write failed'); expect(awaitMainnetLoopAuthorization).not.toHaveBeenCalled();
  expect(data[KEY]).toMatchObject({ status: 'waiting' });
});
it('does not release if the exact artifact upload failed', async () => {
  data[KEY] = waitingPolicy(); jest.mocked(awaitMainnetLoopAuthorization).mockRejectedValue(new Error('upload failed'));
  await expect(release()).rejects.toThrow('upload failed'); expect(data[KEY]).toMatchObject({ status: 'waiting' });
});
it('refuses policy replacement during the actual upload', async () => {
  data[KEY] = waitingPolicy(); jest.mocked(awaitMainnetLoopAuthorization).mockImplementation(async () => {
    data[KEY] = { ...waitingPolicy(), canonicalSha256: '6'.repeat(64) };
  });
  await expect(release()).rejects.toThrow(); expect(data[KEY]).toMatchObject({ status: 'waiting' });
});
it('never releases if the run was cancelled during the upload', async () => {
  data[KEY] = waitingPolicy(); jest.mocked(awaitMainnetLoopAuthorization).mockImplementation(async () => { controller.abort(); });
  await expect(release()).rejects.toThrow(); expect(data[KEY]).toMatchObject({ status: 'waiting' });
});
