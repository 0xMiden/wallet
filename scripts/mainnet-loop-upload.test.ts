/** @jest-environment node */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotMainnetLoopAuthorization, releaseMainnetLoopUpload } from './mainnet-loop-upload.mjs';

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'mainnet-loop-upload-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const bytes = Buffer.from('{"version":1,"network":"mainnet","phase":"reverse-authorized","sourceRunId":"100"}\n');
  const checkpoint = join(directory, 'roundtrip.json'); const gate = join(directory, 'reverse.evm-1');
  const snapshot = join(directory, 'snapshot.json'); const downloaded = join(directory, 'downloaded.json');
  const digest = createHash('sha256').update(bytes).digest('hex');
  for (const path of [checkpoint, snapshot, downloaded]) writeFileSync(path, bytes);
  writeFileSync(`${gate}.ready`, `${digest}\n`);
  return { checkpoint, gate, snapshot, downloaded, artifactId: 9, runId: 200, headSha: 'a'.repeat(40),
    artifactName: 'mainnet-epoch-reverse-signed-1-200', artifact: { id: 9, name: 'mainnet-epoch-reverse-signed-1-200',
      expired: false, size_in_bytes: 512, workflow_run: { id: 200, head_sha: 'a'.repeat(40) } } };
}
it('copies exactly the ready checkpoint into an exclusive immutable artifact snapshot', () => {
  const input = fixture(); const target = join(directory, 'upload'); mkdirSync(target);
  const snapshot = snapshotMainnetLoopAuthorization(input.checkpoint, input.gate, target);
  expect(readFileSync(snapshot)).toEqual(readFileSync(input.checkpoint));
  expect(() => snapshotMainnetLoopAuthorization(input.checkpoint, input.gate, target)).toThrow();
});
it('releases only the exact current-run artifact downloaded back from durable storage', () => {
  const input = fixture();
  releaseMainnetLoopUpload(input);
  expect(readFileSync(input.gate, 'utf8')).toBe(readFileSync(`${input.gate}.ready`, 'utf8'));
  expect(() => releaseMainnetLoopUpload(input)).toThrow();
});
const byteFields: ('checkpoint' | 'snapshot' | 'downloaded')[] = ['checkpoint', 'snapshot', 'downloaded'];
it.each(byteFields)('never releases if the %s bytes differ from the ready authority', field => {
  const input = fixture(); writeFileSync(input[field], '{"changed":true}');
  expect(() => releaseMainnetLoopUpload(input)).toThrow(); expect(existsSync(input.gate)).toBe(false);
});
it('does not snapshot a changed readiness digest', () => {
  const input = fixture(); writeFileSync(`${input.gate}.ready`, `${'b'.repeat(64)}\n`);
  expect(() => snapshotMainnetLoopAuthorization(input.checkpoint, input.gate, join(directory, 'upload'))).toThrow();
});
it.each(['expired', 'wrong id', 'wrong run', 'wrong head', 'wrong name', 'empty artifact'])('blocks %s artifact metadata without a release', kind => {
  const input = fixture();
  if (kind === 'expired') input.artifact.expired = true;
  if (kind === 'wrong id') input.artifact.id = 8;
  if (kind === 'wrong run') input.artifact.workflow_run.id = 199;
  if (kind === 'wrong head') input.artifact.workflow_run.head_sha = 'b'.repeat(40);
  if (kind === 'wrong name') input.artifact.name = 'mainnet-epoch-forward-authorized-200';
  if (kind === 'empty artifact') input.artifact.size_in_bytes = 0;
  expect(() => releaseMainnetLoopUpload(input)).toThrow(); expect(existsSync(input.gate)).toBe(false);
});
