import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

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

if (basename(process.argv[1] ?? '') === 'mainnet-loop-upload.mjs') {
  try {
    const args = process.argv.slice(2);
    if (args[0] === 'snapshot' && args.length === 4) {
      if (!process.env.GITHUB_OUTPUT) throw new Error('Missing workflow output');
      const path = snapshotMainnetLoopAuthorization(args[1], args[2], args[3]);
      if (/[\r\n]/.test(path)) throw new Error('Invalid snapshot path');
      appendFileSync(process.env.GITHUB_OUTPUT, `snapshot=${path}\n`);
    } else if (args[0] === 'release' && args.length === 8) {
      if (!/^[1-9]\d*$/.test(args[6]) || !/^[1-9]\d*$/.test(process.env.GITHUB_RUN_ID ?? ''))
        throw new Error('Invalid workflow artifact identity');
      releaseMainnetLoopUpload({ checkpoint: args[1], gate: args[2], snapshot: args[3], downloaded: args[4],
        artifact: JSON.parse(boundedFile(args[5]).toString('utf8')), artifactId: Number(args[6]),
        artifactName: args[7], runId: Number(process.env.GITHUB_RUN_ID), headSha: process.env.GITHUB_SHA });
    } else throw new Error('Invalid mainnet upload command');
  } catch {
    console.error('Mainnet loop upload verification failed; request remains blocked.');
    process.exitCode = 1;
  }
}
