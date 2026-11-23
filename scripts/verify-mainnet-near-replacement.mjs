// Read-only GitHub provenance check. On-chain and provider checks belong to the recovery worker.
import { readFileSync } from 'node:fs';
import {
  matchesExpiredNearReturnProvenance,
  matchesNearRetentionSteps,
  verifyNearReturnCheckpointBytes
} from './mainnet-near-return-provenance.mjs';

const repository = '0xMiden/wallet';
const workflow = 391951744;
const original = 44844609625;
const frontier = 44871541172;
const token = process.env.GH_TOKEN;
const current = Number(process.env.GITHUB_RUN_ID);
const fail = () => { throw new Error('NEAR replacement provenance did not match'); };
async function github(path) {
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    redirect: 'error', signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) fail();
  return response.json();
}
try {
  if (!token || process.env.GITHUB_REPOSITORY !== repository || process.env.GITHUB_REF !== 'refs/heads/main' ||
    process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || process.env.GITHUB_RUN_ATTEMPT !== '1' ||
    !Number.isSafeInteger(current) || current <= frontier || process.env.MAINNET_LOOP_LOSS_BUDGET_USD_MICROS !== '1712349') fail();
  const [history, run, jobs, artifacts, retained, retainedJobs, retainedArtifacts] = await Promise.all([
    github(`workflows/${workflow}/runs?per_page=2`), github(`runs/${original}`),
    github(`runs/${original}/jobs?per_page=100`), github(`runs/${original}/artifacts?per_page=100`),
    github(`runs/${frontier}`), github(`runs/${frontier}/jobs?per_page=100`),
    github(`runs/${frontier}/artifacts?per_page=100`)
  ]);
  if (history.workflow_runs?.length !== 2 || history.workflow_runs[0].id !== current ||
      history.workflow_runs[0].head_sha !== process.env.GITHUB_SHA || history.workflow_runs[1].id !== frontier ||
      !matchesExpiredNearReturnProvenance({ run, jobs, artifacts }) || !matchesNearRetentionSteps(retainedJobs) ||
      retained.id !== frontier || retained.repository?.id !== 853430876 || retained.workflow_id !== workflow ||
      retained.head_sha !== '1c93c1c5e154aa0b109014c9d9b751050d0d3dc0' || retained.head_branch !== 'main' ||
      retained.event !== 'schedule' || retained.run_attempt !== 1 || retained.status !== 'completed' ||
      retained.conclusion !== 'failure') fail();
  const matching = retainedArtifacts.artifacts?.filter(a => a.name.startsWith('mainnet-1click-'));
  if (matching?.length !== 1 || matching[0].id !== 14694460888 || matching[0].expired !== false ||
      matching[0].name !== `mainnet-1click-final-${frontier}` ||
      matching[0].digest !== 'sha256:55e22c8a7fb31e77b345848714fdd7264a8bc2d68f4a863ed73884846f18f738') fail();
  verifyNearReturnCheckpointBytes(
    readFileSync(process.argv[2]),
    readFileSync('test-results/mainnet-1click-state/roundtrip.json')
  );
  console.log('Original and retained NEAR return provenance verified');
} catch {
  console.error('NEAR replacement provenance did not match');
  process.exitCode = 1;
}
