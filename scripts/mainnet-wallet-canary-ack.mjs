import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const REQUEST_LIMIT = 65_536;
const ARCHIVE_LIMIT = 4_096;
const REPOSITORY_ID = 853430876;
export const CANARY_ACK_FILENAME = 'authorization.sha256';

function readBoundedFile(path, limit) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size < 1 || stat.size > limit) throw new Error('Invalid wallet canary authorization file');
  const bytes = readFileSync(path);
  if (bytes.length !== stat.size) throw new Error('Wallet canary authorization file changed while reading');
  return bytes;
}

function checkpointDigest(checkpoint, gate) {
  const ready = readBoundedFile(`${gate}.ready`, 65).toString('utf8');
  const actual = createHash('sha256').update(readBoundedFile(checkpoint, REQUEST_LIMIT)).digest('hex');
  if (ready !== `${actual}\n`) throw new Error('Ready digest differs from the private checkpoint');
  return ready;
}

export function snapshotWalletCanaryAuthorization(checkpoint, gate, directory) {
  const digest = checkpointDigest(checkpoint, gate);
  mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, CANARY_ACK_FILENAME);
  writeFileSync(path, digest, { flag: 'wx', mode: 0o600 });
  return path;
}

export function acknowledgeWalletCanaryAuthorization({
  checkpoint,
  gate,
  snapshot,
  downloaded,
  artifact,
  artifactId,
  runId,
  runAttempt,
  headSha,
  stage
}) {
  if (
    !Number.isSafeInteger(artifactId) ||
    artifactId <= 0 ||
    !Number.isSafeInteger(runId) ||
    runId <= 0 ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt <= 0 ||
    typeof headSha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(headSha) ||
    !['send', 'claim'].includes(stage) ||
    artifact?.id !== artifactId ||
    artifact?.name !== `wallet-canary-${stage}-ack-${runId}-${runAttempt}` ||
    artifact?.expired !== false ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes <= 0 ||
    artifact.size_in_bytes > ARCHIVE_LIMIT ||
    artifact.workflow_run?.id !== runId ||
    artifact.workflow_run?.repository_id !== REPOSITORY_ID ||
    artifact.workflow_run?.head_repository_id !== REPOSITORY_ID ||
    artifact.workflow_run?.head_branch !== 'main' ||
    artifact.workflow_run?.head_sha !== headSha
  )
    throw new Error('Canary acknowledgment does not belong to the original workflow attempt and source');
  const digest = checkpointDigest(checkpoint, gate);
  for (const path of [snapshot, downloaded]) {
    if (readBoundedFile(path, 65).toString('utf8') !== digest)
      throw new Error('Uploaded digest differs from the private checkpoint');
  }
  writeFileSync(gate, digest, { flag: 'wx', mode: 0o600 });
}

if (basename(process.argv[1] ?? '') === 'mainnet-wallet-canary-ack.mjs') {
  try {
    const [operation, checkpoint, gate, ...args] = process.argv.slice(2);
    if (operation === 'snapshot' && args.length === 1 && process.env.GITHUB_OUTPUT) {
      const path = snapshotWalletCanaryAuthorization(checkpoint, gate, args[0]);
      if (/[\r\n]/.test(path)) throw new Error('Invalid wallet canary digest path');
      appendFileSync(process.env.GITHUB_OUTPUT, `path=${path}\n`);
    } else if (operation === 'acknowledge' && args.length === 5) {
      const [snapshot, downloaded, metadata, artifactId, stage] = args;
      acknowledgeWalletCanaryAuthorization({
        checkpoint,
        gate,
        snapshot,
        downloaded,
        artifact: JSON.parse(readBoundedFile(metadata, REQUEST_LIMIT).toString('utf8')),
        artifactId: Number(artifactId),
        runId: Number(process.env.GITHUB_RUN_ID),
        runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
        headSha: process.env.GITHUB_SHA,
        stage
      });
    } else throw new Error('Invalid wallet canary acknowledgment command');
  } catch {
    console.error('Wallet canary acknowledgment failed. The request remains held.');
    process.exitCode = 1;
  }
}
