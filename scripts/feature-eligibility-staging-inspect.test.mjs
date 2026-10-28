import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ORIGINAL,
  createInspectionTransport,
  inspectOriginal,
  validateReceipt,
  main
} from './feature-eligibility-staging-inspect.mjs';
import { buildProbeManifest } from './feature-eligibility-staging-probe.mjs';

const context = {
  ...ORIGINAL,
  runId: '40400000000',
  sourceSha: 'a'.repeat(40),
  ref: 'refs/heads/main',
  eventName: 'workflow_dispatch'
};
const identity = Object.fromEntries(Object.keys(ORIGINAL).map(key => [key, context[key]]));
const environment = { CLOUDFLARE_ACCOUNT_ID: '1'.repeat(32), CLOUDFLARE_API_TOKEN: 'secret-never-publish' };
const script = `/workers/scripts/miden-elig-probe-${ORIGINAL.runId}-${ORIGINAL.runAttempt}`;
const prior = {
  support: 'unknown',
  caller: 'unknown',
  colo: 'unknown',
  cleanup: 'blocked',
  counts: { requests: 0, allowed: 0, limited: 0, unavailable: 0 },
  reason: 'ownership_mismatch'
};
const bytes = Buffer.from('original worker fixture');
const prepared = { identity: ORIGINAL, artifactId: '12644191250', workerBase64: bytes.toString('base64') };
const manifest = buildProbeManifest(ORIGINAL, bytes, []);
const receipt = {
  schema: 1,
  identity,
  original: ORIGINAL,
  artifactId: '12644191250',
  inspection: 'blocked',
  reason: 'ownership_mismatch',
  requests: 0
};

test('transport accepts only the exact account and original script GETs with a shared abort signal', async () => {
  const calls = [];
  const transport = createInspectionTransport(environment, {
    request: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ success: true, errors: [], result: {} });
    }
  });
  try {
    for (const path of [
      '/account',
      ...['settings', 'script-settings', 'subdomain', 'content/v2'].map(suffix => `${script}/${suffix}`)
    ])
      await transport.providerAPI(path, { method: 'GET' });
    assert.equal(calls.length, 5);
    assert.ok(
      calls.every(
        ({ url, init }) =>
          url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${environment.CLOUDFLARE_ACCOUNT_ID}`) &&
          init.method === 'GET' &&
          init.redirect === 'error' &&
          init.signal === calls[0].init.signal
      )
    );
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${environment.CLOUDFLARE_API_TOKEN}`);
    await assert.rejects(transport.providerAPI('/account', { method: 'GET' }));
    assert.equal(calls.length, 5);
  } finally {
    transport.close();
  }
  assert.equal(calls[0].init.signal.aborted, true);
});

for (const [path, init] of [
  ['/account', { method: 'DELETE' }],
  ['/account', { method: 'POST' }],
  [`${script}/settings`, { method: 'PATCH' }],
  ['/workers/scripts/other/settings', { method: 'GET' }],
  [`${script}/settings?x=1`, { method: 'GET' }],
  ['/account', { method: 'GET', body: 'secret' }],
  ['https://foreign.invalid', { method: 'GET' }],
  ['/account', {}]
])
  test(`transport rejects noncanonical request ${path} ${init.method || 'missing'}`, async () => {
    let calls = 0;
    const transport = createInspectionTransport(environment, {
      request: async () => {
        calls++;
      }
    });
    try {
      await assert.rejects(transport.providerAPI(path, init));
      assert.equal(calls, 0);
    } finally {
      transport.close();
    }
  });

test('absolute deadline refuses later requests without resetting for each request', async () => {
  let now = 0;
  let calls = 0;
  const transport = createInspectionTransport(environment, {
    now: () => now,
    request: async () => {
      calls++;
      return new Response('');
    }
  });
  try {
    await transport.providerAPI('/account', { method: 'GET' });
    now = 30000;
    await assert.rejects(transport.providerAPI(`${script}/settings`, { method: 'GET' }));
    assert.equal(calls, 1);
    assert.equal(transport.expired(), true);
  } finally {
    transport.close();
  }
});

test('original inspection authenticates account then reports documented absence without mutation', async () => {
  const calls = [];
  const result = await inspectOriginal(prepared, manifest, prior, {
    context,
    environment,
    count: () => calls.length,
    expired: () => false,
    providerAPI: async (path, init) => {
      calls.push([path, init]);
      return path === '/account'
        ? Response.json({ success: true, errors: [], result: { id: environment.CLOUDFLARE_ACCOUNT_ID } })
        : Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 });
    }
  });
  assert.equal(result.inspection, 'absent');
  assert.equal(result.reason, 'complete');
  assert.deepEqual(calls, [
    ['/account', { method: 'GET' }],
    [`${script}/settings`, { method: 'GET' }]
  ]);
  assert.doesNotMatch(JSON.stringify(result), /secret-never-publish|11111111111111111111111111111111/);
});

for (const change of [
  { artifactId: '999' },
  { identity: { ...ORIGINAL, runId: '40309563507' } },
  { workerBase64: '!' },
  { workerBase64: bytes.toString('base64'), extra: true }
])
  test(`original provenance mismatch blocks before credentials are used ${JSON.stringify(change)}`, async () => {
    let calls = 0;
    const result = await inspectOriginal({ ...prepared, ...change }, manifest, prior, {
      context,
      environment,
      providerAPI: async () => {
        calls++;
      },
      count: () => calls,
      expired: () => false
    });
    assert.equal(result.inspection, 'blocked');
    assert.equal(result.reason, 'ownership_mismatch');
    assert.equal(calls, 0);
  });

test('canonical receipt rejects raw payload, credentials and unsupported success claims', () => {
  assert.deepEqual(validateReceipt(receipt), receipt);
  for (const change of [
    { payload: {} },
    { token: 'secret' },
    { inspection: 'verified' },
    { inspection: 'absent', reason: 'complete', requests: 0 },
    { reason: 'raw provider message' },
    { requests: 6 },
    { identity: { ...identity, account: 'secret' } },
    { ownershipCheck: { gate: 'script_observability', form: 'raw secret' } }
  ])
    assert.throws(() => validateReceipt({ ...receipt, ...change }));
});

test('CLI rejects caller-selected target inputs before I/O', async () => {
  await assert.rejects(main(['prepare'], { RUNNER_TEMP: '/not-used', CLEANUP_RUN_ID: '999' }));
  await assert.rejects(main(['cleanup'], { RUNNER_TEMP: '/not-used' }));
});

test('protected workflow keeps original provenance and credentials separate from inspection', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/probe-feature-eligibility.yml', import.meta.url),
    'utf8'
  );
  assert.match(workflow, /options: \[probe, cleanup, inspect\]/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment: feature-eligibility-production/);
  assert.match(workflow, /run-id: '40309563506'/);
  assert.match(workflow, /artifact-ids: \$\{\{ steps\.inspection\.outputs\.artifact_id \}\}/);
  assert.match(workflow, /if: always\(\) && inputs\.operation == 'probe'/);
  assert.match(workflow, /feature-eligibility-staging-inspect\.mjs inspect/);
  assert.match(workflow, /feature-eligibility-staging-inspect\.mjs evidence/);
});

for (const [status, reason] of [
  [403, 'auth'],
  [429, 'quota'],
  [500, 'network'],
  [404, 'network']
])
  test(`provider status ${status} remains a closed blocked inspection`, async () => {
    let count = 0;
    const result = await inspectOriginal(prepared, manifest, prior, {
      context,
      environment,
      count: () => count,
      expired: () => false,
      providerAPI: async () => {
        count++;
        return Response.json({ raw: 'secret-never-publish' }, { status });
      }
    });
    assert.equal(result.inspection, 'blocked');
    assert.equal(result.reason, reason);
    assert.doesNotMatch(JSON.stringify(result), /secret-never-publish|raw/);
  });

test('expired final read cannot produce a successful absence receipt', async () => {
  let count = 0;
  const result = await inspectOriginal(prepared, manifest, prior, {
    context,
    environment,
    count: () => count,
    expired: () => true,
    providerAPI: async path => {
      count++;
      return path === '/account'
        ? Response.json({ success: true, errors: [], result: { id: environment.CLOUDFLARE_ACCOUNT_ID } })
        : Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 });
    }
  });
  assert.equal(result.inspection, 'blocked');
  assert.equal(result.reason, 'bounds_reached');
});

test('CLI retains sanitized blocked evidence when the original artifact is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eligibility-inspection-'));
  const env = {
    ...environment,
    RUNNER_TEMP: root,
    GITHUB_REPOSITORY: context.repository,
    GITHUB_WORKFLOW_REF: `${context.repository}/${context.workflowPath}@refs/heads/main`,
    GITHUB_RUN_ID: context.runId,
    GITHUB_RUN_ATTEMPT: context.runAttempt,
    GITHUB_SHA: context.sourceSha,
    GITHUB_REF: context.ref,
    GITHUB_EVENT_NAME: context.eventName
  };
  try {
    await writeFile(join(root, 'probe-recovery.json'), 'private preparation');
    const result = await main(['inspect'], env);
    assert.equal(result.inspection, 'blocked');
    assert.equal(result.reason, 'invalid_response');
    assert.equal(result.requests, 0);
    await main(['evidence'], env);
    assert.deepEqual(await readdir(join(root, 'probe-inspection-evidence')), ['inspection.json']);
    const output = await readFile(join(root, 'probe-inspection-evidence/inspection.json'), 'utf8');
    assert.deepEqual(JSON.parse(output), result);
    assert.doesNotMatch(output, /private preparation|secret-never-publish|11111111111111111111111111111111/);
    assert.ok(!(await readdir(root)).includes('probe-recovery.json'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
