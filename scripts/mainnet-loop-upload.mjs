import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function boundedFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 65_536)
    throw new Error('Invalid mainnet authorization file');
  const bytes = readFileSync(path);
  if (bytes.length !== stat.size) throw new Error('Mainnet authorization file changed while reading');
  return bytes;
}

function readyDigest(gate) {
  const ready = boundedFile(`${gate}.ready`).toString('utf8');
  if (!/^[0-9a-f]{64}\n$/.test(ready)) throw new Error('Invalid mainnet readiness digest');
  return ready;
}

const digest = bytes => `${createHash('sha256').update(bytes).digest('hex')}\n`;

export function snapshotMainnetLoopAuthorization(checkpoint, gate, directory) {
  const ready = readyDigest(gate);
  const bytes = boundedFile(checkpoint);
  if (digest(bytes) !== ready) throw new Error('Mainnet checkpoint differs from its ready authorization');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'roundtrip.json');
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  return path;
}

export function releaseMainnetLoopUpload(input) {
  const artifact = input.artifact;
  if (!Number.isSafeInteger(input.artifactId) || input.artifactId <= 0 ||
      !Number.isSafeInteger(input.runId) || input.runId <= 0 || !/^[0-9a-f]{40}$/.test(input.headSha) ||
      typeof input.artifactName !== 'string' || !input.artifactName ||
      artifact?.id !== input.artifactId || artifact?.name !== input.artifactName || artifact?.expired !== false ||
      !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes <= 0 || artifact.size_in_bytes > 1_048_576 ||
      artifact.workflow_run?.id !== input.runId || artifact.workflow_run?.head_sha !== input.headSha)
    throw new Error('Mainnet artifact does not belong to this exact workflow run and source');
  const ready = readyDigest(input.gate);
  for (const path of [input.checkpoint, input.snapshot, input.downloaded]) {
    if (digest(boundedFile(path)) !== ready)
      throw new Error('Mainnet uploaded, snapshot or live authorization bytes differ');
  }
  writeFileSync(input.gate, ready, { flag: 'wx', mode: 0o600 });
}
