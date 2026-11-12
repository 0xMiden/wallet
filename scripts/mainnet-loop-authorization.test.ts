/** @jest-environment node */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { awaitMainnetLoopAuthorization } from '../playwright/e2e/helpers/mainnet-loop-authorization';

let directory: string;
let controller: AbortController;
let checkpoint: string;
let gate: string;
const digest = () => createHash('sha256').update(readFileSync(checkpoint)).digest('hex');
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mainnet-loop-authorization-'));
  controller = new AbortController();
  checkpoint = join(directory, 'roundtrip.json');
  gate = join(directory, 'uploaded');
  writeFileSync(checkpoint, '{"phase":"forward-authorized"}\n');
});
afterEach(() => {
  controller.abort();
  jest.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});
function wait() {
  const pending = awaitMainnetLoopAuthorization(checkpoint, gate, controller.signal);
  void pending.catch(() => undefined);
  return pending;
}
it('holds the live browser flow until the exact persisted authorization was uploaded and released', async () => {
  let finished = false;
  const pending = wait();
  void pending.then(
    () => {
      finished = true;
    },
    () => undefined
  );
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(readFileSync(`${gate}.ready`, 'utf8')).toBe(`${digest()}\n`);
  writeFileSync(gate, `${digest()}\n`);
  await pending;
  expect(finished).toBe(true);
});
it('rejects a release marker that existed before the current live authorization', async () => {
  writeFileSync(gate, `${digest()}\n`);
  await expect(wait()).rejects.toThrow();
});
it('rejects a stale ready marker instead of reusing an old signing handshake', async () => {
  writeFileSync(`${gate}.ready`, `${digest()}\n`);
  await expect(wait()).rejects.toThrow();
});
it('refuses a different uploaded authorization digest', async () => {
  const pending = wait();
  writeFileSync(gate, `${'0'.repeat(64)}\n`);
  await expect(pending).rejects.toThrow(/digest|authorization/i);
});
it('refuses checkpoint mutation between readiness and uploaded release', async () => {
  const original = digest();
  const pending = wait();
  writeFileSync(checkpoint, '{"phase":"changed"}\n');
  writeFileSync(gate, `${original}\n`);
  await expect(pending).rejects.toThrow(/changed|authorization/i);
});
it('does not create readiness for an already aborted request', async () => {
  controller.abort();
  await expect(wait()).rejects.toThrow(/abort/i);
  expect(existsSync(`${gate}.ready`)).toBe(false);
});
it('refuses cancellation while awaiting the upload without permitting signing', async () => {
  const pending = wait();
  controller.abort();
  await expect(pending).rejects.toThrow(/abort/i);
});
it('fails closed if upload acknowledgement never arrives', async () => {
  jest.useFakeTimers();
  const result = expect(wait()).rejects.toThrow(/timed out/i);
  jest.advanceTimersByTime(240_001);
  await result;
});
it('refuses oversized authorization files', async () => {
  writeFileSync(checkpoint, 'x'.repeat(65_537));
  await expect(wait()).rejects.toThrow(/size|large|authorization/i);
});
