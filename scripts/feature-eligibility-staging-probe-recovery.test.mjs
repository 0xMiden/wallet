import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildProbeManifest } from './feature-eligibility-staging-probe.mjs';
import {
  prepareRecovery,
  cleanupRecovery,
  sanitizeEvidence,
  main
} from './feature-eligibility-staging-probe-recovery.mjs';

const identity = {
  repository: '0xMiden/wallet',
  workflowPath: '.github/workflows/probe-feature-eligibility.yml',
  runId: '10001',
  runAttempt: '2',
  sourceSha: 'a'.repeat(40)
};
const workerBytes = readFileSync(new URL('../services/feature-eligibility/staging-probe.mjs', import.meta.url));
const current = {
  ...identity,
  runId: '20002',
  runAttempt: '1',
  sourceSha: 'b'.repeat(40),
  ref: 'refs/heads/main',
  eventName: 'workflow_dispatch'
};
const manifest = () => buildProbeManifest(identity, workerBytes, []);
const result = () => ({
  support: 'unknown',
  caller: 'unknown',
  colo: 'unknown',
  cleanup: 'absent',
  counts: { requests: 0, allowed: 0, limited: 0, unavailable: 0 },
  reason: 'no_refusal'
});
function fixture(change = {}) {
  const repo = { id: 42, full_name: '0xMiden/wallet', fork: false };
  const run = {
    id: 10001,
    run_attempt: 2,
    head_sha: identity.sourceSha,
    head_branch: 'main',
    event: 'workflow_dispatch',
    path: identity.workflowPath,
    workflow_id: 55,
    repository: repo,
    head_repository: repo,
    status: 'completed'
  };
  const artifact = {
    id: 777,
    name: 'eligibility-probe-10001-2',
    expired: false,
    size_in_bytes: 2000,
    workflow_run: {
      id: 10001,
      repository_id: 42,
      head_repository_id: 42,
      head_branch: 'main',
      head_sha: identity.sourceSha
    }
  };
  const calls = [];
  const effects = {
    context: { ...current },
    github: async path => {
      calls.push(path);
      if (path === '/actions/runs/10001') return { ...run, ...change.run };
      if (path === '/actions/runs/10001/attempts/2') return { ...run, ...change.attempt };
      if (path === '/actions/workflows/55') return { id: 55, path: identity.workflowPath, ...change.workflow };
      if (path === '/actions/runs/10001/artifacts?per_page=100&page=1')
        return { total_count: 1, artifacts: [{ ...artifact, ...change.artifact }], ...change.list };
      if (path === `/contents/services/feature-eligibility/staging-probe.mjs?ref=${identity.sourceSha}`)
        return { type: 'file', encoding: 'base64', content: workerBytes.toString('base64'), ...change.source };
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
  'artifact foreign source': {
    artifact: {
      workflow_run: {
        id: 10001,
        repository_id: 42,
        head_repository_id: 42,
        head_branch: 'main',
        head_sha: 'c'.repeat(40)
      }
    }
  },
  'missing artifact': { list: { total_count: 0, artifacts: [] } },
  'ambiguous artifacts': { list: { total_count: 2, artifacts: [] } },
  'nonfile source': { source: { type: 'dir' } }
}))
  test(`recovery blocks ${name} before provider access`, async () => {
    const f = fixture(change);
    await assert.rejects(prepareRecovery({ runId: '10001', runAttempt: '2' }, f.effects));
  });

test('recovery rejects current untrusted context and extra or malformed inputs before GitHub access', async () => {
  for (const input of [
    { runId: '10001', runAttempt: '2', ref: 'main' },
    { runId: '../1', runAttempt: '2' },
    { runId: '10001', runAttempt: '0' },
    { runId: '20002', runAttempt: '1' }
  ]) {
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
    return {
      cleanup: async received => {
        assert.deepEqual(received, manifest());
        assert.equal(await composed.verifyRecovery(identity), true);
        assert.equal(await composed.verifyRecovery({ ...identity, runAttempt: '3' }), false);
        return { cleanup: 'removed', reason: 'complete' };
      }
    };
  });
  assert.equal(called, true);
  assert.deepEqual(outcome, { cleanup: 'removed', reason: 'complete' });
});

for (const field of [
  'scriptName',
  'workerSha256',
  'configSha256',
  'ownerMarker',
  'callerNamespaceId',
  'coloNamespaceId'
])
  test(`recovery blocks altered manifest ${field}`, async () => {
    const f = fixture();
    const prepared = await prepareRecovery({ runId: '10001', runAttempt: '2' }, f.effects);
    let called = false;
    const outcome = await cleanupRecovery(prepared, { ...manifest(), [field]: 'wrong' }, { context: current }, () => {
      called = true;
    });
    assert.equal(called, false);
    assert.equal(outcome.cleanup, 'blocked');
  });

test('evidence retains only exact deterministic manifest and closed result', () => {
  assert.deepEqual(sanitizeEvidence(manifest(), result(), workerBytes), { manifest: manifest(), result: result() });
  for (const changed of [
    { ...manifest(), token: 'sensitive' },
    { ...manifest(), identity: { ...identity, account: 'sensitive' } }
  ])
    assert.throws(() => sanitizeEvidence(changed, result(), workerBytes));
  for (const changed of [
    { ...result(), url: 'sensitive' },
    { ...result(), reason: 'raw body' },
    { ...result(), counts: { ...result().counts, token: 'sensitive' } },
    { ...result(), support: 'unsupported' },
    { ...result(), counts: { requests: 121, allowed: 121, limited: 0, unavailable: 0 } }
  ])
    assert.throws(() => sanitizeEvidence(manifest(), changed, workerBytes));
});

test('same controller enforces remote ownership after recovery provenance is accepted', async () => {
  const f = fixture();
  const prepared = await prepareRecovery({ runId: '10001', runAttempt: '2' }, f.effects);
  const calls = [];
  const effects = {
    context: current,
    environment: { CLOUDFLARE_ACCOUNT_ID: 'account-for-recovery' },
    providerAPI: async (path, init = {}) => {
      calls.push([path, init.method]);
      if (path === '/account')
        return Response.json({ success: true, errors: [], result: { id: 'account-for-recovery' } });
      return Response.json({ success: false, errors: [{ code: 10007 }], result: null }, { status: 404 });
    }
  };
  assert.deepEqual(await cleanupRecovery(prepared, manifest(), effects), { cleanup: 'absent', reason: 'complete' });
  assert.deepEqual(
    calls.map(call => call[0]),
    ['/account', '/workers/scripts/miden-elig-probe-10001-2/settings']
  );
  assert.ok(calls.every(call => call[1] === 'GET'));
  effects.providerAPI = async path =>
    path === '/account'
      ? Response.json({ success: true, errors: [], result: { id: 'account-for-recovery' } })
      : Response.json({ success: true, errors: [], result: { bindings: [] } });
  assert.equal((await cleanupRecovery(prepared, manifest(), effects)).cleanup, 'blocked');
});

test('evidence preserves a written current manifest after controller loss without a result and removes sensitive files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'probe-evidence-'));
  const currentManifest = buildProbeManifest(contextIdentityForTest(current), workerBytes, []);
  const privateDir = join(root, 'feature-eligibility-probe');
  try {
    await mkdir(privateDir, { mode: 0o700 });
    await writeFile(join(privateDir, 'manifest.json'), JSON.stringify(currentManifest), { mode: 0o600 });
    for (const file of ['secrets.json', 'wrangler.json', 'deploy.stdout', 'deploy.stderr'])
      await writeFile(join(privateDir, file), 'never-publish', { mode: 0o600 });
    const env = {
      RUNNER_TEMP: root,
      GITHUB_REPOSITORY: current.repository,
      GITHUB_WORKFLOW_REF: `${current.repository}/${current.workflowPath}@refs/heads/main`,
      GITHUB_RUN_ID: current.runId,
      GITHUB_RUN_ATTEMPT: current.runAttempt,
      GITHUB_SHA: current.sourceSha,
      GITHUB_REF: current.ref,
      GITHUB_EVENT_NAME: current.eventName,
      PROBE_OPERATION: 'probe'
    };
    const received = await main(['evidence'], env);
    assert.equal(received.support, 'unknown');
    assert.equal(received.cleanup, 'blocked');
    assert.deepEqual(JSON.parse(await readFile(join(root, 'probe-evidence/manifest.json'))), currentManifest);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'probe-evidence/result.json'))), received);
    assert.equal((await stat(join(root, 'probe-evidence'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, 'probe-evidence/manifest.json'))).mode & 0o777, 0o600);
    for (const file of ['secrets.json', 'wrangler.json', 'deploy.stdout', 'deploy.stderr'])
      await assert.rejects(stat(join(privateDir, file)), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
const contextIdentityForTest = context =>
  Object.fromEntries(
    ['repository', 'workflowPath', 'runId', 'runAttempt', 'sourceSha'].map(key => [key, context[key]])
  );

test('later idempotent cleanup records absence while preserving the failed original probe verdict', async () => {
  const root = await mkdtemp(join(tmpdir(), 'probe-cleanup-evidence-'));
  const privateDir = join(root, 'feature-eligibility-probe');
  try {
    await mkdir(privateDir, { mode: 0o700 });
    await writeFile(
      join(privateDir, 'manifest.json'),
      JSON.stringify(buildProbeManifest(contextIdentityForTest(current), workerBytes, []))
    );
    const failedProbe = {
      ...result(),
      caller: 'refused',
      colo: 'refused',
      cleanup: 'blocked',
      reason: 'cleanup_failed'
    };
    await writeFile(join(root, 'probe-result.json'), JSON.stringify(failedProbe));
    await writeFile(join(root, 'probe-cleanup-result.json'), JSON.stringify({ ...result(), reason: 'complete' }));
    const received = await main(['evidence'], {
      RUNNER_TEMP: root,
      GITHUB_REPOSITORY: current.repository,
      GITHUB_WORKFLOW_REF: `${current.repository}/${current.workflowPath}@refs/heads/main`,
      GITHUB_RUN_ID: current.runId,
      GITHUB_RUN_ATTEMPT: current.runAttempt,
      GITHUB_SHA: current.sourceSha,
      GITHUB_REF: current.ref,
      GITHUB_EVENT_NAME: current.eventName,
      PROBE_OPERATION: 'probe'
    });
    assert.equal(received.support, 'unknown');
    assert.equal(received.reason, 'cleanup_failed');
    assert.equal(received.cleanup, 'absent');
    assert.equal(received.caller, 'refused');
    assert.equal(received.colo, 'refused');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function diskEvidence(originalBytes, cleanupBytes) {
  const root = await mkdtemp(join(tmpdir(), 'probe-independent-evidence-'));
  const privateDir = join(root, 'feature-eligibility-probe');
  const currentManifest = buildProbeManifest(contextIdentityForTest(current), workerBytes, []);
  try {
    await mkdir(privateDir, { mode: 0o700 });
    await writeFile(join(privateDir, 'manifest.json'), JSON.stringify(currentManifest), { mode: 0o600 });
    if (originalBytes !== undefined) await writeFile(join(root, 'probe-result.json'), originalBytes, { mode: 0o600 });
    if (cleanupBytes !== undefined)
      await writeFile(join(root, 'probe-cleanup-result.json'), cleanupBytes, { mode: 0o600 });
    const received = await main(['evidence'], {
      RUNNER_TEMP: root,
      GITHUB_REPOSITORY: current.repository,
      GITHUB_WORKFLOW_REF: `${current.repository}/${current.workflowPath}@refs/heads/main`,
      GITHUB_RUN_ID: current.runId,
      GITHUB_RUN_ATTEMPT: current.runAttempt,
      GITHUB_SHA: current.sourceSha,
      GITHUB_REF: current.ref,
      GITHUB_EVENT_NAME: current.eventName,
      PROBE_OPERATION: 'probe'
    });
    assert.deepEqual(JSON.parse(await readFile(join(root, 'probe-evidence/manifest.json'))), currentManifest);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'probe-evidence/result.json'))), received);
    return received;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const [loss, original] of [
  ['missing', undefined],
  ['empty', ''],
  ['truncated', '{"support":']
]) {
  for (const cleanup of ['absent', 'removed']) {
    test(`independent ${cleanup} cleanup survives ${loss} original result without promoting support`, async () => {
      const received = await diskEvidence(original, JSON.stringify({ ...result(), cleanup, reason: 'complete' }));
      assert.equal(received.cleanup, cleanup);
      assert.equal(received.support, 'unknown');
      assert.equal(received.caller, 'unknown');
      assert.equal(received.colo, 'unknown');
      assert.notEqual(received.reason, 'complete');
      assert.deepEqual(received.counts, result().counts);
    });
  }
}

const supportedResult = { ...result(), support: 'supported', caller: 'refused', colo: 'refused', reason: 'complete' };
for (const [failure, cleanup] of [
  ['missing', undefined],
  ['empty', ''],
  ['truncated', '{"cleanup":'],
  ['blocked', JSON.stringify({ ...result(), cleanup: 'blocked', reason: 'complete' })],
  ['absent but unsuccessful', JSON.stringify({ ...result(), reason: 'network' })],
  ['removed but unsuccessful', JSON.stringify({ ...result(), cleanup: 'removed', reason: 'cleanup_failed' })],
  ['unknown extra field', JSON.stringify({ ...result(), reason: 'complete', raw: 'never-publish' })]
]) {
  for (const [originalState, original] of [
    ['lost', undefined],
    ['supported', JSON.stringify(supportedResult)]
  ]) {
    test(`${failure} cleanup stays blocked with ${originalState} original result`, async () => {
      const received = await diskEvidence(original, cleanup);
      assert.equal(received.cleanup, 'blocked');
      assert.equal(received.support, 'unknown');
      assert.notEqual(received.reason, 'complete');
      assert.doesNotMatch(JSON.stringify(received), /never-publish/);
    });
  }
}

async function preflightEvidence(receipt, original = {}, manifestBytes) {
  const root = await mkdtemp(join(tmpdir(), 'probe-preflight-evidence-'));
  try {
    if (manifestBytes !== undefined) {
      await mkdir(join(root, 'feature-eligibility-probe'));
      await writeFile(join(root, 'feature-eligibility-probe/manifest.json'), manifestBytes);
    }
    await writeFile(
      join(root, 'probe-result.json'),
      JSON.stringify({
        ...result(),
        reason: 'auth',
        cleanup: 'absent',
        ...original,
        preflight: receipt
      })
    );
    return await main(['evidence'], {
      RUNNER_TEMP: root,
      GITHUB_REPOSITORY: current.repository,
      GITHUB_WORKFLOW_REF: `${current.repository}/${current.workflowPath}@refs/heads/main`,
      GITHUB_RUN_ID: current.runId,
      GITHUB_RUN_ATTEMPT: current.runAttempt,
      GITHUB_SHA: current.sourceSha,
      GITHUB_REF: current.ref,
      GITHUB_EVENT_NAME: current.eventName,
      PROBE_OPERATION: 'probe'
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const preflightReceipt = () => ({
  identity: contextIdentityForTest(current),
  stage: 'authentication',
  manifest: 'absent',
  deployment: 'not_attempted',
  reason: 'auth'
});
test('preflight failure survives absent manifest and cleanup without claiming remote absence', async () => {
  const receipt = preflightReceipt();
  const received = await preflightEvidence(receipt);
  assert.equal(received.reason, 'auth');
  assert.equal(received.cleanup, 'blocked');
  assert.equal(received.support, 'unknown');
  assert.deepEqual(received.preflight, receipt);
});
for (const [name, patch] of [
  ['other run', { identity: { ...contextIdentityForTest(current), runId: '99999' } }],
  ['other source', { identity: { ...contextIdentityForTest(current), sourceSha: 'f'.repeat(40) } }],
  ['attempted', { deployment: 'attempted' }],
  ['registered', { manifest: 'registered' }],
  ['unknown stage', { stage: 'secret-never-publish' }],
  ['unknown reason', { reason: 'secret-never-publish' }],
  ['extra field', { raw: 'secret-never-publish' }]
])
  test(`untrusted or ambiguous ${name} receipt cannot retain a preflight verdict`, async () => {
    const received = await preflightEvidence({ ...preflightReceipt(), ...patch });
    assert.equal(received.cleanup, 'blocked');
    assert.equal(received.support, 'unknown');
    assert.notEqual(received.reason, 'auth');
    assert.doesNotMatch(JSON.stringify(received), /secret-never-publish/);
  });

test('malformed existing manifest cannot be treated as absent for preflight preservation', async () => {
  const received = await preflightEvidence(preflightReceipt(), {}, '{"deploymentState":"deploying"');
  assert.equal(received.cleanup, 'blocked');
  assert.equal(received.reason, 'cleanup_failed');
});

test('strict evidence permits a closed failed cleanup check but rejects partial, injected and unrelated pairs', () => {
  const failed = {
    ...result(),
    cleanup: 'blocked',
    reason: 'ownership_mismatch',
    ownershipCheck: { gate: 'observability_traces', form: 'missing' }
  };
  assert.deepEqual(sanitizeEvidence(manifest(), failed, workerBytes).result, failed);
  for (const ownershipCheck of [
    { gate: 'logpush' },
    { form: 'missing' },
    { gate: 'private-canary', form: 'missing' },
    { gate: 'logpush', form: 'private-canary' },
    { gate: 'logpush', form: 'missing', raw: 'private-canary' }
  ])
    assert.throws(() => sanitizeEvidence(manifest(), { ...failed, ownershipCheck }, workerBytes));
  assert.throws(() => sanitizeEvidence(manifest(), { ...failed, cleanup: 'removed' }, workerBytes));
  assert.throws(() => sanitizeEvidence(manifest(), { ...failed, reason: 'network' }, workerBytes));
});

test('failed exact recovery ownership check survives sanitizer and final retained evidence unchanged', async () => {
  const f = fixture();
  const prepared = await prepareRecovery({ runId: '10001', runAttempt: '2' }, f.effects);
  const calls = [];
  const outcome = await cleanupRecovery(prepared, manifest(), {
    context: current,
    environment: { CLOUDFLARE_ACCOUNT_ID: 'account-private-canary' },
    providerAPI: async path => {
      calls.push(path);
      if (path === '/account')
        return Response.json({ success: true, errors: [], result: { id: 'account-private-canary' } });
      return Response.json({ success: true, errors: [], result: { bindings: [] } });
    }
  });
  assert.deepEqual(outcome, {
    cleanup: 'blocked',
    reason: 'ownership_mismatch',
    ownershipCheck: { gate: 'settings_binding_count', form: 'different_value' }
  });
  assert.deepEqual(calls, ['/account', '/workers/scripts/miden-elig-probe-10001-2/settings']);
  const root = await mkdtemp(join(tmpdir(), 'probe-failed-recovery-'));
  try {
    await writeFile(join(root, 'probe-recovery.json'), JSON.stringify(prepared));
    await mkdir(join(root, 'probe-recovered'));
    await writeFile(join(root, 'probe-recovered/manifest.json'), JSON.stringify(manifest()));
    await writeFile(join(root, 'probe-result.json'), JSON.stringify({ ...result(), ...outcome }));
    const saved = await main(['evidence'], {
      RUNNER_TEMP: root,
      PROBE_OPERATION: 'cleanup',
      GITHUB_REPOSITORY: current.repository,
      GITHUB_WORKFLOW_REF: `${current.repository}/${current.workflowPath}@refs/heads/main`,
      GITHUB_RUN_ID: current.runId,
      GITHUB_RUN_ATTEMPT: current.runAttempt,
      GITHUB_SHA: current.sourceSha,
      GITHUB_REF: current.ref,
      GITHUB_EVENT_NAME: current.eventName
    });
    assert.deepEqual(saved.ownershipCheck, outcome.ownershipCheck);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'probe-evidence/manifest.json'))), manifest());
    const wire = await readFile(join(root, 'probe-evidence/result.json'), 'utf8');
    assert.deepEqual(JSON.parse(wire), saved);
    assert.doesNotMatch(wire, /account-private-canary|private-canary|workerBase64/);
    assert.equal((await stat(join(root, 'probe-evidence/result.json'))).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('authoritative script-level refusal survives exact recovery sanitizer and final retained evidence', async () => {
  const f = fixture();
  const prepared = await prepareRecovery({ runId: '10001', runAttempt: '2' }, f.effects);
  const calls = [];
  const outcome = await cleanupRecovery(prepared, manifest(), {
    context: current,
    environment: { CLOUDFLARE_ACCOUNT_ID: 'account-private-canary' },
    providerAPI: async path => {
      calls.push(path);
      if (path === '/account')
        return Response.json({ success: true, errors: [], result: { id: 'account-private-canary' } });
      const m = manifest();
      if (path.endsWith('/settings'))
        return Response.json({
          success: true,
          errors: [],
          result: {
            compatibility_date: '2026-01-01',
            compatibility_flags: [],
            logpush: false,
            tail_consumers: [],
            bindings: [
              { name: 'PROBE_SOURCE', type: 'plain_text', text: m.identity.sourceSha },
              { name: 'PROBE_CONFIG_SHA', type: 'plain_text', text: m.configSha256 },
              { name: 'PROBE_OWNER', type: 'plain_text', text: m.ownerMarker },
              { name: 'PROBE_BEARER', type: 'secret_text' },
              { name: 'PROBE_HASH_SECRET', type: 'secret_text' },
              {
                name: 'CALLER_PROBE',
                type: 'ratelimit',
                namespace_id: m.callerNamespaceId,
                simple: { limit: 4, period: 60 }
              },
              {
                name: 'COLO_PROBE',
                type: 'ratelimit',
                namespace_id: m.coloNamespaceId,
                simple: { limit: 4, period: 10 }
              }
            ]
          }
        });
      assert.ok(path.endsWith('/script-settings'));
      return Response.json({
        success: true,
        errors: [],
        result: { observability: { enabled: false, logs: { enabled: false, invocation_logs: false } } }
      });
    }
  });
  assert.deepEqual(outcome, {
    cleanup: 'blocked',
    reason: 'ownership_mismatch',
    ownershipCheck: { gate: 'script_observability_traces', form: 'missing' }
  });
  assert.deepEqual(calls, [
    '/account',
    '/workers/scripts/miden-elig-probe-10001-2/settings',
    '/workers/scripts/miden-elig-probe-10001-2/script-settings'
  ]);
  const root = await mkdtemp(join(tmpdir(), 'probe-failed-recovery-'));
  try {
    await writeFile(join(root, 'probe-recovery.json'), JSON.stringify(prepared));
    await mkdir(join(root, 'probe-recovered'));
    await writeFile(join(root, 'probe-recovered/manifest.json'), JSON.stringify(manifest()));
    await writeFile(join(root, 'probe-result.json'), JSON.stringify({ ...result(), ...outcome }));
    const saved = await main(['evidence'], {
      RUNNER_TEMP: root,
      PROBE_OPERATION: 'cleanup',
      GITHUB_REPOSITORY: current.repository,
      GITHUB_WORKFLOW_REF: `${current.repository}/${current.workflowPath}@refs/heads/main`,
      GITHUB_RUN_ID: current.runId,
      GITHUB_RUN_ATTEMPT: current.runAttempt,
      GITHUB_SHA: current.sourceSha,
      GITHUB_REF: current.ref,
      GITHUB_EVENT_NAME: current.eventName
    });
    assert.deepEqual(saved.ownershipCheck, outcome.ownershipCheck);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'probe-evidence/manifest.json'))), manifest());
    const wire = await readFile(join(root, 'probe-evidence/result.json'), 'utf8');
    assert.deepEqual(JSON.parse(wire), saved);
    assert.doesNotMatch(wire, /account-private-canary|private-canary|workerBase64/);
    assert.equal((await stat(join(root, 'probe-evidence/result.json'))).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('blocked always-cleanup check survives consolidation without changing original verification preflight', async () => {
  const root = await mkdtemp(join(tmpdir(), 'probe-first-gate-'));
  const bound = contextIdentityForTest(current);
  const preflight = {
    identity: bound,
    stage: 'verification',
    manifest: 'registered',
    deployment: 'attempted',
    reason: 'ownership_mismatch'
  };
  const check = { gate: 'observability_traces', form: 'missing' };
  try {
    await mkdir(join(root, 'feature-eligibility-probe'));
    await writeFile(
      join(root, 'feature-eligibility-probe/manifest.json'),
      JSON.stringify(buildProbeManifest(bound, workerBytes, []))
    );
    await writeFile(
      join(root, 'probe-result.json'),
      JSON.stringify({ ...result(), cleanup: 'blocked', reason: 'ownership_mismatch', preflight })
    );
    await writeFile(
      join(root, 'probe-cleanup-result.json'),
      JSON.stringify({ ...result(), cleanup: 'blocked', reason: 'ownership_mismatch', ownershipCheck: check })
    );
    const saved = await main(['evidence'], {
      RUNNER_TEMP: root,
      PROBE_OPERATION: 'probe',
      GITHUB_REPOSITORY: current.repository,
      GITHUB_WORKFLOW_REF: `${current.repository}/${current.workflowPath}@refs/heads/main`,
      GITHUB_RUN_ID: current.runId,
      GITHUB_RUN_ATTEMPT: current.runAttempt,
      GITHUB_SHA: current.sourceSha,
      GITHUB_REF: current.ref,
      GITHUB_EVENT_NAME: current.eventName
    });
    assert.deepEqual(saved.preflight, preflight);
    assert.deepEqual(saved.ownershipCheck, check);
    assert.equal(saved.reason, 'cleanup_failed');
    assert.equal(saved.support, 'unknown');
    assert.equal(saved.cleanup, 'blocked');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
