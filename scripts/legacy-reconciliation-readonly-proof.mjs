import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chooseSwapCheckpoint } from './mainnet-swap-artifacts.mjs';

const token = process.env.GH_TOKEN;
assert.ok(token);
const base = 'https://api.github.com/repos/0xMiden/wallet/';
async function get(path, binary = false) {
  const response = await fetch(base + path, {
    method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30000)
  });
  assert.ok(response.ok, `GitHub read HTTP ${response.status}`);
  if (!binary) return response.json();
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length > 0 && bytes.length < 10 * 1024 * 1024);
  return bytes;
}
const original = await get('actions/runs/43562192705');
const current = await get('actions/runs/43592097632');
const anchor = await get('actions/runs/42966766471');
assert.equal(original.workflow_id, current.workflow_id);
assert.equal(anchor.workflow_id, current.workflow_id);
assert.equal(anchor.head_sha, '96a3228a181d050395241d00071c5863a1815ab5');
assert.equal(anchor.conclusion, 'success');
assert.equal(original.head_sha, '46d7fcf8ac612ca48997753574b53b308e365070');
const report = await get('actions/artifacts/14100963457');
const zip = await get('actions/artifacts/14100963457/zip', true);
const digest = 'sha256:' + createHash('sha256').update(zip).digest('hex');
assert.equal(digest, report.digest);
assert.equal(digest, 'sha256:dbf7bc5943653fc30cb53f633fc9db1e059f6ab06b17f850e9cfe5135cbcaedb');
const runs = [];
for (let page = 1; page <= 10; page++) {
  const result = await get(`actions/workflows/${current.workflow_id}/runs?per_page=100&page=${page}`);
  assert.ok(Array.isArray(result.workflow_runs));
  runs.push(...result.workflow_runs.filter(run => run.id < Number(process.env.GITHUB_RUN_ID)));
  if (result.workflow_runs.some(run => run.id <= anchor.id) || result.workflow_runs.length < 100) break;
}
const selected = await chooseSwapCheckpoint(runs,
  id => get(`actions/runs/${id}/artifacts?per_page=100`),
  id => get(`actions/runs/${id}/jobs?per_page=100`));
assert.deepEqual(selected, {runId:43527071078,name:'mainnet-swap-final-43527071078',bootstrap:false});
console.log(JSON.stringify({
  purpose:'read-only legacy reconciliation and live official workflow discovery; no signing or execution',
  sourceRunId:original.id, sourceSha:original.head_sha, artifactId:report.id, immutableArchiveDigest:digest,
  originalFailure:'first indexer read at reviewed source line117 before deposit',
  selectedFundedCheckpoint:selected, baselineUnchanged:true, originalRunRemainsFailed:original.conclusion==='failure',
  grantPersisted:false, sdkAuthorityIssued:false
}));
