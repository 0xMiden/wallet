/** @jest-environment node */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { isRecord } from '../src/lib/update/guards';
import { snapshotMainnetLoopAuthorization, releaseMainnetLoopUpload } from './mainnet-loop-upload.mjs';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mainnet-loop-upload-'));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const bytes = Buffer.from('{"version":1,"network":"mainnet","phase":"reverse-authorized","sourceRunId":"100"}\n');
  const checkpoint = join(directory, 'roundtrip.json');
  const gate = join(directory, 'reverse.evm-1');
  const snapshot = join(directory, 'snapshot.json');
  const downloaded = join(directory, 'downloaded.json');
  const digest = createHash('sha256').update(bytes).digest('hex');
  for (const path of [checkpoint, snapshot, downloaded]) writeFileSync(path, bytes);
  writeFileSync(`${gate}.ready`, `${digest}\n`);
  return {
    checkpoint,
    gate,
    snapshot,
    downloaded,
    artifactId: 9,
    runId: 200,
    headSha: 'a'.repeat(40),
    artifactName: 'mainnet-epoch-reverse-signed-1-200',
    artifact: {
      id: 9,
      name: 'mainnet-epoch-reverse-signed-1-200',
      expired: false,
      size_in_bytes: 512,
      workflow_run: { id: 200, head_sha: 'a'.repeat(40) }
    }
  };
}
function actionScript(): string {
  const document: unknown = YAML.parse(
    readFileSync(join(process.cwd(), '.github/actions/mainnet-loop-upload/action.yml'), 'utf8')
  );
  const runs = isRecord(document) ? document.runs : undefined;
  const steps = isRecord(runs) ? runs.steps : undefined;
  const snapshot = Array.isArray(steps) ? steps.find(step => isRecord(step) && step.id === 'snapshot') : undefined;
  if (!isRecord(snapshot) || typeof snapshot.run !== 'string') throw new Error('Missing executable snapshot step');
  return snapshot.run;
}
function runAction(input: ReturnType<typeof fixture>, extra: NodeJS.ProcessEnv = {}) {
  const output = join(directory, 'action-outputs');
  const pid = join(directory, 'runner.pid');
  writeFileSync(pid, `${process.pid}\n`);
  const result = spawnSync('bash', ['-c', actionScript()], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      CHECKPOINT: input.checkpoint,
      GATE: input.gate,
      PID_FILE: pid,
      SNAPSHOT_DIRECTORY: join(directory, 'action-snapshot'),
      GITHUB_OUTPUT: output,
      SKIP_AFTER_DEPOSIT: 'false',
      ALTERNATIVE_GATES: '',
      ...extra
    }
  });
  return { ...result, output };
}
it('executes the real composite snapshot script against the held request', () => {
  const input = fixture();
  const bytes = Buffer.from('{"transactions":[{"kind":"deposit"}]}');
  writeFileSync(input.checkpoint, bytes);
  writeFileSync(`${input.gate}.ready`, `${createHash('sha256').update(bytes).digest('hex')}\n`);
  const result = runAction(input);
  expect(result.status).toBe(0);
  expect(existsSync(result.output)).toBe(true);
  expect(readFileSync(result.output, 'utf8')).toContain('envelope_kind=deposit\n');
  expect(readFileSync(join(directory, 'action-snapshot/roundtrip.json'))).toEqual(readFileSync(input.checkpoint));
  expect(existsSync(input.gate)).toBe(false);
});
it('never skips a current deposit merely because persistence preceded its ready marker', () => {
  const input = fixture();
  rmSync(`${input.gate}.ready`);
  writeFileSync(input.checkpoint, JSON.stringify({ transactions: [{ kind: 'deposit' }] }));
  const pid = join(directory, 'dead.pid');
  writeFileSync(pid, '2147483647\n');
  const result = runAction(input, { SKIP_AFTER_DEPOSIT: 'true', PID_FILE: pid });
  expect(result.status).not.toBe(0);
  expect(existsSync(input.gate)).toBe(false);
  expect(existsSync(join(directory, 'action-snapshot'))).toBe(false);
});
it('skips an unused recovery branch when its other exact gate is ready', () => {
  const input = fixture();
  rmSync(`${input.gate}.ready`);
  const alternate = join(directory, 'refund');
  writeFileSync(`${alternate}.ready`, `${'a'.repeat(64)}\n`);
  const result = runAction(input, { ALTERNATIVE_GATES: alternate });
  expect(result.status).toBe(0);
  expect(readFileSync(result.output, 'utf8')).toBe(`skipped=true\nalternative_gate=${alternate}\n`);
  expect(existsSync(input.gate)).toBe(false);
});
it('does not wait or release when the held request process is already gone', () => {
  const input = fixture();
  rmSync(`${input.gate}.ready`);
  const pid = join(directory, 'dead.pid');
  writeFileSync(pid, '2147483647\n');
  const result = runAction(input, { PID_FILE: pid });
  expect(result.status).not.toBe(0);
  expect(existsSync(input.gate)).toBe(false);
});
function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [join(process.cwd(), 'scripts/mainnet-loop-upload.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 10_000
  });
}
it('prepares the actual workflow snapshot through the executable CLI', () => {
  const input = fixture();
  const output = join(directory, 'outputs');
  const target = join(directory, 'upload');
  const result = cli(['snapshot', input.checkpoint, input.gate, target], { GITHUB_OUTPUT: output });
  expect(result.status).toBe(0);
  expect(existsSync(output)).toBe(true);
  expect(readFileSync(output, 'utf8')).toBe(`snapshot=${join(target, 'roundtrip.json')}\n`);
  expect(readFileSync(join(target, 'roundtrip.json'))).toEqual(readFileSync(input.checkpoint));
});
it('releases through the executable CLI only for the current workflow environment', () => {
  const input = fixture();
  const metadata = join(directory, 'metadata.json');
  writeFileSync(metadata, JSON.stringify(input.artifact));
  const result = cli(
    [
      'release',
      input.checkpoint,
      input.gate,
      input.snapshot,
      input.downloaded,
      metadata,
      String(input.artifactId),
      input.artifactName
    ],
    { GITHUB_RUN_ID: String(input.runId), GITHUB_SHA: input.headSha }
  );
  expect(result.status).toBe(0);
  expect(existsSync(input.gate)).toBe(true);
  expect(readFileSync(input.gate, 'utf8')).toBe(readFileSync(`${input.gate}.ready`, 'utf8'));
});
it('fails the actual release CLI without logging untrusted artifact data', () => {
  const input = fixture();
  const metadata = join(directory, 'metadata.json');
  const marker = 'PRIVATE_DATA_MUST_NOT_BE_LOGGED';
  writeFileSync(metadata, JSON.stringify({ ...input.artifact, name: marker }));
  const result = cli(
    [
      'release',
      input.checkpoint,
      input.gate,
      input.snapshot,
      input.downloaded,
      metadata,
      String(input.artifactId),
      input.artifactName
    ],
    { GITHUB_RUN_ID: String(input.runId), GITHUB_SHA: input.headSha }
  );
  expect(result.status).not.toBe(0);
  expect(existsSync(input.gate)).toBe(false);
  expect(`${result.stdout}${result.stderr}`).not.toContain(marker);
});
it('refuses an unknown CLI command instead of silently reporting success', () => {
  expect(cli(['unknown']).status).not.toBe(0);
});
it('copies exactly the ready checkpoint into an exclusive immutable artifact snapshot', () => {
  const input = fixture();
  const target = join(directory, 'upload');
  mkdirSync(target);
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
  const input = fixture();
  writeFileSync(input[field], '{"changed":true}');
  expect(() => releaseMainnetLoopUpload(input)).toThrow();
  expect(existsSync(input.gate)).toBe(false);
});
it('does not snapshot a changed readiness digest', () => {
  const input = fixture();
  writeFileSync(`${input.gate}.ready`, `${'b'.repeat(64)}\n`);
  expect(() => snapshotMainnetLoopAuthorization(input.checkpoint, input.gate, join(directory, 'upload'))).toThrow();
});
it.each(['expired', 'wrong id', 'wrong run', 'wrong head', 'wrong name', 'empty artifact'])(
  'blocks %s artifact metadata without a release',
  kind => {
    const input = fixture();
    if (kind === 'expired') input.artifact.expired = true;
    if (kind === 'wrong id') input.artifact.id = 8;
    if (kind === 'wrong run') input.artifact.workflow_run.id = 199;
    if (kind === 'wrong head') input.artifact.workflow_run.head_sha = 'b'.repeat(40);
    if (kind === 'wrong name') input.artifact.name = 'mainnet-epoch-forward-authorized-200';
    if (kind === 'empty artifact') input.artifact.size_in_bytes = 0;
    expect(() => releaseMainnetLoopUpload(input)).toThrow();
    expect(existsSync(input.gate)).toBe(false);
  }
);
