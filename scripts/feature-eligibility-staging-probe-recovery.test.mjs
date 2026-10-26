import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildProbeManifest } from './feature-eligibility-staging-probe.mjs';
import { prepareRecovery, cleanupRecovery, sanitizeEvidence } from './feature-eligibility-staging-probe-recovery.mjs';

const identity = { repository: '0xMiden/wallet', workflowPath: '.github/workflows/probe-feature-eligibility.yml', runId: '10001', runAttempt: '2', sourceSha: 'a'.repeat(40) };
const workerBytes = readFileSync(new URL('../services/feature-eligibility/staging-probe.mjs', import.meta.url));
const current = { ...identity, runId: '20002', runAttempt: '1', sourceSha: 'b'.repeat(40), ref: 'refs/heads/main', eventName: 'workflow_dispatch' };
const manifest = () => buildProbeManifest(identity, workerBytes, []);
const result = () => ({ support: 'unknown', caller: 'unknown', colo: 'unknown', cleanup: 'absent', counts: { requests: 0, allowed: 0, limited: 0, unavailable: 0 }, reason: 'no_refusal' });
function fixture(change = {}) {
  const repo = { id: 42, full_name: '0xMiden/wallet', fork: false };
  const run = { id: 10001, run_attempt: 2, head_sha: identity.sourceSha, head_branch: 'main', event: 'workflow_dispatch', path: identity.workflowPath, workflow_id: 55, repository: repo, head_repository: repo, status: 'completed' };
  const artifact = { id: 777, name: 'eligibility-probe-10001-2', expired: false, size_in_bytes: 2000, workflow_run: { id: 10001, repository_id: 42, head_repository_id: 42, head_branch: 'main', head_sha: identity.sourceSha } };
  const calls = [];
  const effects = {
    context: { ...current },
    github: async path => {
      calls.push(path);
      if (path === '/actions/runs/10001') return { ...run, ...change.run };
      if (path === '/actions/runs/10001/attempts/2') return { ...run, ...change.attempt };
      if (path === '/actions/workflows/55') return { id: 55, path: identity.workflowPath, ...change.workflow };
      if (path === '/actions/runs/10001/artifacts?per_page=100&page=1') return { total_count: 1, artifacts: [{ ...artifact, ...change.artifact }], ...change.list };
      if (path === `/contents/services/feature-eligibility/staging-probe.mjs?ref=${identity.sourceSha}`) return { type: 'file', encoding: 'base64', content: workerBytes.toString('base64'), ...change.source };
      throw new Error('unexpected API path');
    }
  };
  return { effects, calls };
}

test('recovery prepares only exact completed trusted manual main attempt and exact artifact/source', async () => {
  const f = fixture();
  const prepared = await prepareRecovery({ runId: '10001', runAttempt: '2' }, f.effects);
  assert.deepEqual(prepared.identity, identity);
  assert.equal(prepared.artifactId, '777');
  assert.equal(prepared.workerBase64, workerBytes.toString('base64'));
  assert.equal(f.calls.length, 5);
});

for (const [name, change] of Object.entries({
  'foreign repository': { run: { repository: { id: 7, full_name: 'evil/wallet', fork: false } } },
  'fork head': { attempt: { head_repository: { id: 9, full_name: 'evil/wallet', fork: true } } },
  'branch run': { attempt: { head_branch: 'feature' } },
  'push event': { attempt: { event: 'push' } },
  'other workflow': { workflow: { path: '.github/workflows/other.yml' } },
  'wrong attempt': { attempt: { run_attempt: 1 } },
  'wrong source': { attempt: { head_sha: 'c'.repeat(40) } },
  'active run': { run: { status: 'in_progress' } },
  'expired artifact': { artifact: { expired: true } },
  'other attempt artifact': { artifact: { name: 'eligibility-probe-10001-1' } },
  'artifact foreign source': { artifact: { workflow_run: { id: 10001, repository_id: 42, head_repository_id: 42, head_branch: 'main', head_sha: 'c'.repeat(40) } } },
  'missing artifact': { list: { total_count: 0, artifacts: [] } },
  'ambiguous artifacts': { list: { total_count: 2, artifacts: [] } },
  'nonfile source': { source: { type: 'dir' } }
})) test(`recovery blocks ${name} before provider access`, async () => {
  const f = fixture(change);
  await assert.rejects(prepareRecovery({ runId: '10001', runAttempt: '2' }, f.effects));
});

test('recovery rejects current untrusted context and extra or malformed inputs before GitHub access', async () => {
  for (const input of [{ runId: '10001', runAttempt: '2', ref: 'main' }, { runId: '../1', runAttempt: '2' }, { runId: '10001', runAttempt: '0' }, { runId: '20002', runAttempt: '1' }]) {
    const f = fixture();
    await assert.rejects(prepareRecovery(input, f.effects));
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  f.effects.context.ref = 'refs/heads/feature';
  await assert.rejects(prepareRecovery({ runId: '10001', runAttempt: '2' }, f.effects));
  assert.equal(f.calls.length, 0);
});

test('recovery composes existing controller with prior bytes without rewriting current trusted context', async () => {
  const f = fixture();
  const prepared = await prepareRecovery({ runId: '10001', runAttempt: '2' }, f.effects);
  let called = false;
  const effects = { context: current };
  const outcome = await cleanupRecovery(prepared, manifest(), effects, composed => {
    called = true;
    assert.deepEqual(composed.context, current);
    assert.deepEqual(composed.workerBytes, workerBytes);
    assert.notEqual(composed.context.runId, identity.runId);
    return { cleanup: async received => {
      assert.deepEqual(received, manifest());
      assert.equal(await composed.verifyRecovery(identity), true);
      assert.equal(await composed.verifyRecovery({ ...identity, runAttempt: '3' }), false);
      return { cleanup: 'removed', reason: 'complete' };
    } };
  });
  assert.equal(called, true);
  assert.deepEqual(outcome, { cleanup: 'removed', reason: 'complete' });
});

for (const field of ['scriptName', 'workerSha256', 'configSha256', 'ownerMarker', 'callerNamespaceId', 'coloNamespaceId']) test(`recovery blocks altered manifest ${field}`, async () => {
  const f = fixture();
  const prepared = await prepareRecovery({ runId: '10001', runAttempt: '2' }, f.effects);
  let called = false;
  const outcome = await cleanupRecovery(prepared, { ...manifest(), [field]: 'wrong' }, { context: current }, () => { called = true; });
  assert.equal(called, false);
  assert.equal(outcome.cleanup, 'blocked');
});

test('evidence retains only exact deterministic manifest and closed result', () => {
  assert.deepEqual(sanitizeEvidence(manifest(), result(), workerBytes), { manifest: manifest(), result: result() });
  for (const changed of [{ ...manifest(), token: 'sensitive' }, { ...manifest(), identity: { ...identity, account: 'sensitive' } }]) assert.throws(() => sanitizeEvidence(changed, result(), workerBytes));
  for (const changed of [{ ...result(), url: 'sensitive' }, { ...result(), reason: 'raw body' }, { ...result(), counts: { ...result().counts, token: 'sensitive' } }, { ...result(), support: 'unsupported' }, { ...result(), counts: { requests: 121, allowed: 121, limited: 0, unavailable: 0 } }]) assert.throws(() => sanitizeEvidence(manifest(), changed, workerBytes));
});
