/** @jest-environment node */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { isRecord } from '../src/lib/update/guards';
import { snapshotMainnetLoopAuthorization, releaseMainnetLoopUpload } from './mainnet-loop-upload.mjs';
import { logTailReport, sanitizedTail } from './mainnet-log-tail.mjs';

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
function actionScript(kind: 'snapshot' | 'download' = 'snapshot'): string {
  const document: unknown = YAML.parse(
    readFileSync(join(process.cwd(), '.github/actions/mainnet-loop-upload/action.yml'), 'utf8')
  );
  const runs = isRecord(document) ? document.runs : undefined;
  const steps = isRecord(runs) ? runs.steps : undefined;
  const snapshot = Array.isArray(steps)
    ? steps.find(
        step =>
          isRecord(step) &&
          (kind === 'snapshot'
            ? step.id === 'snapshot'
            : typeof step.run === 'string' && step.run.includes('node scripts/mainnet-loop-upload.mjs release'))
      )
    : undefined;
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
it('names the exited process and prints a sanitized log tail before failing', () => {
  const input = fixture();
  rmSync(`${input.gate}.ready`);
  const pid = join(directory, 'near-recover.pid');
  writeFileSync(pid, '2147483647\n');
  writeFileSync(join(directory, 'near-recover.exit'), '1\n');
  writeFileSync(
    join(directory, 'near-recover.log'),
    `Error: Original native NEAR principal is unresolved\nkey=${'ab'.repeat(32)} phrase hunter2-secret-value\n`
  );
  const result = runAction(input, { PID_FILE: pid, E2E_MAINNET_PLAIN_SEED: 'hunter2-secret-value' });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('::error::near-recover exited (code 1) before');
  expect(result.stdout).toContain('Original native NEAR principal is unresolved');
  expect(result.stdout).not.toContain('hunter2-secret-value');
  expect(result.stdout).not.toContain('ab'.repeat(32));
});
it('bounds the log tail and reports a missing log', () => {
  const log = join(directory, 'big.log');
  writeFileSync(log, Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n'));
  const report = logTailReport([log, join(directory, 'absent.log')], {});
  expect(report).toContain('line 499');
  expect(report).not.toContain('line 100\n');
  expect(report).toContain('No log was written.');
});
const words = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
const keyPair = JSON.stringify({ publicKey: 'pk-abcdef12', secretKey: 'sk-ghijkl34mnop' });
describe('sanitizedTail redaction', () => {
  it.each([
    ['a bearer token', 'Authorization: Bearer abc123tokenvalue', 'abc123tokenvalue', {}],
    ['a basic credential', 'authorization=Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA', {}],
    ['a bare bearer token', 'sent Bearer eyJhbGciOi.payload.sig', 'eyJhbGciOi', {}],
    ['an underscored label', 'access_token=zzTopSecret99', 'zzTopSecret99', {}],
    ['hex after an underscore', `acct_${'ab'.repeat(32)}`, 'ab'.repeat(32), {}],
    ['hex before an underscore', `${'cd'.repeat(32)}_acct`, 'cd'.repeat(32), {}],
    [
      'a base58 address',
      'to DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK now',
      'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
      {}
    ],
    [
      'a bech32 address',
      'pay bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
      'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
      {}
    ],
    ['a named NEAR account', 'deposit to deposit-xyz9.near please', 'deposit-xyz9', {}],
    ['an unlabeled mnemonic', `phrase ${words}`, 'absorb', {}],
    ['a mnemonic with doubled spaces', `x ${words.replace(/ /g, '  ')}`, 'absorb', { E2E_MAINNET_MNEMONIC: words }],
    ['a mnemonic wrapped across lines', `x ${words.replace(/ /g, '\n')}`, 'absorb', { E2E_MAINNET_MNEMONIC: words }],
    [
      'a padded secret',
      'value padded-secret-value end',
      'padded-secret-value',
      { E2E_MAINNET_X: ' padded-secret-value\n' }
    ],
    [
      'a JSON-escaped key pair',
      `bad ${JSON.stringify(keyPair)}`,
      'sk-ghijkl34mnop',
      { E2E_MAINNET_GUARDIAN_KEY_PAIR: keyPair }
    ],
    [
      'a URL-encoded secret',
      `GET /?k=${encodeURIComponent('pass phrase&v=9/xyz')}`,
      'phrase',
      { E2E_MAINNET_X: 'pass phrase&v=9/xyz' }
    ],
    [
      'a form-encoded secret',
      `k=${encodeURIComponent('pass phrase&v=9/xyz').replace(/%20/g, '+')}`,
      'phrase',
      { E2E_MAINNET_X: 'pass phrase&v=9/xyz' }
    ],
    ['a stack frame argument', '    at transfer (to=0xabc key=hunter2value)', 'hunter2value', {}],
    ['a stack frame argument before trailing text', '    at async send (key=hunter2value) extra', 'hunter2value', {}],
    [
      'a pretty-printed key pair',
      JSON.stringify(JSON.parse(keyPair), null, 2),
      'sk-ghijkl34mnop',
      { E2E_MAINNET_GUARDIAN_KEY_PAIR: keyPair }
    ],
    ['a comma-joined mnemonic', `x ${words.replace(/ /g, ',')}`, 'absorb', { E2E_MAINNET_MNEMONIC: words }],
    [
      'a JSON array mnemonic',
      `x ${JSON.stringify(words.split(' '))}`,
      'absorb',
      { E2E_MAINNET_MNEMONIC: words }
    ],
    ['an uppercased mnemonic', `x ${words.toUpperCase()}`, 'ABSORB', { E2E_MAINNET_MNEMONIC: words }],
    [
      'a mnemonic split by log prefixes',
      `x ${words.replace(/ /g, '\n[log] ')}`,
      'absorb',
      { E2E_MAINNET_MNEMONIC: words }
    ],
    ['a comma-joined unlabeled mnemonic', `x ${words.replace(/ /g, ', ')}`, 'absorb', {}],
    ['a camelCase secretKey label', '"secretKey": "shortval1"', 'shortval1', {}],
    ['a privateKey label', 'privateKey=shortval2', 'shortval2', {}],
    ['a private_key label', 'private_key: shortval3', 'shortval3', {}],
    ['a password with no colon', 'password hunter2', 'hunter2', {}],
    ['a session label', 'Cookie: session=shortval4', 'shortval4', {}]
  ])('removes %s', (_name, line, secret, env) => {
    const report = logTailReport([writeLog(`KeptLine\n${line}\n`)], env);
    expect(report).not.toContain(secret);
    expect(report).toContain('KeptLine');
  });
  it('keeps ordinary error text and stack frames with a location', () => {
    const text = 'Error: Native NEAR return blocked\n    at send (/app/helper.ts:12:5)\n    at async <anonymous>';
    expect(sanitizedTail(text, [])).toBe(text);
  });
  it('stays fast on a long dotted line', () => {
    const start = Date.now();
    sanitizedTail('a.'.repeat(32_768), []);
    expect(Date.now() - start).toBeLessThan(500);
  });
  it('ignores an empty or short env value', () => {
    expect(sanitizedTail('plain text', ['', 'short'])).toBe('plain text');
  });
});
function writeLog(text: string) {
  const path = join(directory, 'redact.log');
  writeFileSync(path, text);
  return path;
}
describe('action log tail scope', () => {
  const dead = (name: string) => {
    const input = fixture();
    rmSync(`${input.gate}.ready`);
    writeFileSync(join(directory, `${name}.pid`), '2147483647\n');
    writeFileSync(join(directory, `${name}.exit`), '1\n');
    writeFileSync(join(directory, `${name}.log`), 'private process line\n');
    return runAction(input, { PID_FILE: join(directory, `${name}.pid`) });
  };
  it.each(['swap-forward', 'epoch-reverse'])('does not print the private log of %s', name => {
    const result = dead(name);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`${name} exited (code 1)`);
    expect(result.stdout).not.toContain('private process line');
  });
  it('prints the sanitized tail of a native NEAR process', () => {
    expect(dead('near-forward').stdout).toContain('private process line');
  });
});
function runDownload(input: ReturnType<typeof fixture>, failedEndpoint: string, permanent = false) {
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/bash
set -eu
endpoint="\${@: -1}"
kind=metadata
[[ "$endpoint" == */zip ]] && kind=zip
count=0
file="$COUNTS/$kind"
if [ -f "$file" ]; then read -r count < "$file"; fi
count=$((count+1)); printf '%s\\n' "$count" > "$file"
if [ "$kind" = "$FAILED_ENDPOINT" ] && { [ "$PERMANENT" = true ] || [ "$count" = 1 ]; }; then
  printf 'metadata service unavailable (HTTP 502)\\n' >&2; exit 1
fi
if [ "$kind" = zip ]; then printf '%s' "$FIXTURE_BYTES"; else printf '%s' "$FIXTURE_METADATA"; fi
`,
    { mode: 0o700 }
  );
  writeFileSync(join(bin, 'unzip'), '#!/bin/sh\nprintf \'%s\' "$FIXTURE_BYTES"\n', { mode: 0o700 });
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  return spawnSync('bash', ['-c', actionScript('download')], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      COUNTS: directory,
      FAILED_ENDPOINT: failedEndpoint,
      PERMANENT: String(permanent),
      FIXTURE_BYTES: readFileSync(input.snapshot, 'utf8'),
      FIXTURE_METADATA: JSON.stringify(input.artifact),
      GITHUB_REPOSITORY: '0xMiden/wallet',
      GITHUB_RUN_ID: String(input.runId),
      GITHUB_SHA: input.headSha,
      GH_TOKEN: 'test-only-metadata-token',
      ARTIFACT_ID: String(input.artifactId),
      ARTIFACT_NAME: input.artifactName,
      CHECKPOINT: input.checkpoint,
      GATE: input.gate,
      SNAPSHOT: input.snapshot,
      SNAPSHOT_DIRECTORY: directory
    }
  });
}
it.each(['metadata', 'zip'])('retries only the read-only %s download before a real byte-verified ACK', endpoint => {
  const input = fixture();
  const result = runDownload(input, endpoint);
  expect(result.status).toBe(0);
  expect(readFileSync(join(directory, endpoint), 'utf8')).toBe('2\n');
  expect(readFileSync(input.gate, 'utf8')).toBe(
    `${createHash('sha256').update(readFileSync(input.snapshot)).digest('hex')}\n`
  );
});
it('bounds unavailable metadata reads and leaves the request held without an ACK', () => {
  const input = fixture();
  const result = runDownload(input, 'metadata', true);
  expect(result.status).not.toBe(0);
  expect(readFileSync(join(directory, 'metadata'), 'utf8')).toBe('3\n');
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
