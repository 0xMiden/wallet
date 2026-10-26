import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildProbeManifest, createProbeController, main } from './feature-eligibility-staging-probe.mjs';

const identity = {
  repository: '0xMiden/wallet',
  workflowPath: '.github/workflows/probe-feature-eligibility.yml',
  runId: '40265000001',
  runAttempt: '1',
  sourceSha: '1234567890abcdef1234567890abcdef12345678'
};
const workerBytes = readFileSync(new URL('../services/feature-eligibility/staging-probe.mjs', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const envelope = (result, status = 200, result_info) =>
  Response.json({ success: status < 400, errors: [], result, ...(result_info && { result_info }) }, { status });
const absent = () =>
  Response.json({ success: false, errors: [{ code: 10007, message: 'not found' }], result: null }, { status: 404 });

function fixture(options = {}) {
  let time = 0;
  let remote;
  let active = 0;
  let maxActive = 0;
  let timerId = 0;
  const timers = new Map();
  const events = [];
  const files = new Map();
  const calls = [];
  const context = { ...identity, ref: 'refs/heads/main', eventName: 'workflow_dispatch', ...options.context };
  const advance = ms => {
    time += ms;
    for (const [id, timer] of timers) {
      if (timer.at <= time) {
        timers.delete(id);
        timer.fn();
      }
    }
  };
  const effects = {
    context,
    workerBytes,
    signal: options.signal,
    now: () => time,
    sleep: async ms => {
      advance(ms);
    },
    setTimeout: (fn, ms) => {
      const id = ++timerId;
      timers.set(id, { fn, at: time + ms });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    randomSecret: () => 'ephemeral-secret-never-publish',
    environment: {
      PATH: '/safe/bin',
      CLOUDFLARE_API_TOKEN: 'token-never-publish',
      CLOUDFLARE_ACCOUNT_ID: 'account-never-publish',
      MAXMIND_LICENSE_KEY: 'production-secret'
    },
    privateFiles: {
      createDirectory: async mode => {
        events.push(['mkdir', mode]);
        return '/private/probe';
      },
      write: async (path, data, mode) => {
        files.set(path, String(data));
        events.push(['write', path, mode, String(data)]);
      },
      remove: async path => {
        events.push(['remove', path]);
        files.delete(path);
      }
    },
    verifyRecovery: async received => {
      events.push(['provenance', received]);
      return options.recovery === true;
    },
    providerAPI: async (path, init = {}) => {
      const method = init.method || 'GET';
      events.push(['api', method, path]);
      const overridden = await options.api?.(path, method, { remote, files });
      if (overridden) return overridden;
      if (path === '/user/tokens/verify') return envelope({ status: 'active' });
      if (path.startsWith('/workers/scripts?')) {
        const page = Number(new URL(`https://api.invalid${path}`).searchParams.get('page') || 1);
        const pages = options.pages || [[]];
        return envelope(pages[page - 1] || [], 200, {
          page,
          per_page: 100,
          total_pages: pages.length,
          count: pages[page - 1]?.length || 0,
          total_count: pages.flat().length
        });
      }
      if (path === '/workers/subdomain') return envelope({ subdomain: 'isolated-test' });
      const script = /^\/workers\/scripts\/([^/?]+)(.*)$/.exec(path);
      if (!script) throw new Error('unexpected fixture API');
      const [, name, suffix] = script;
      if (method === 'DELETE') {
        assert.equal(name, 'miden-elig-probe-40265000001-1');
        remote = undefined;
        return envelope({});
      }
      if (name !== 'miden-elig-probe-40265000001-1') return envelope({ bindings: [] });
      if (!remote) return absent();
      if (suffix === '/settings') return envelope(remote.settings);
      if (suffix === '/subdomain') return envelope({ enabled: true, previews_enabled: false });
      if (suffix === '/content/v2') {
        const body = new FormData();
        body.append(
          'staging-probe.mjs',
          new Blob([remote.bytes], { type: 'application/javascript+module' }),
          'staging-probe.mjs'
        );
        return new Response(body, { headers: { 'cf-entrypoint': 'staging-probe.mjs' } });
      }
      throw new Error('unexpected fixture suffix');
    },
    deploy: async spec => {
      events.push(['deploy', spec]);
      const config = JSON.parse(files.get('/private/probe/wrangler.json'));
      const settings = {
        compatibility_date: config.compatibility_date,
        compatibility_flags: [],
        logpush: false,
        observability: { enabled: false, logs: { enabled: false, invocation_logs: false }, traces: { enabled: false } },
        tail_consumers: [],
        bindings: [
          ...Object.entries(config.vars).map(([name, text]) => ({ name, text, type: 'plain_text' })),
          ...config.ratelimits.map(({ name, namespace_id, simple }) => ({
            name,
            namespace_id,
            simple,
            type: 'ratelimit'
          })),
          { name: 'PROBE_BEARER', type: 'secret_text' },
          { name: 'PROBE_HASH_SECRET', type: 'secret_text' }
        ]
      };
      remote = { bytes: files.get('/private/probe/staging-probe.mjs'), settings };
      options.mutateRemote?.(remote);
      if (options.deployError) throw options.deployError;
      return { exitCode: 0 };
    },
    fetch: async (url, init) => {
      const route = new URL(url).pathname;
      active++;
      maxActive = Math.max(active, maxActive);
      calls.push({ route, at: time, init });
      try {
        if (options.fetch) return await options.fetch(url, init, { advance, calls });
        if (route === '/health')
          return init.headers.Authorization === 'Bearer invalid-probe-bearer'
            ? Response.json({ error: 'forbidden' }, { status: 403 })
            : Response.json({ status: 'health_ok' });
        return options.noRefusal === route
          ? Response.json({ result: 'stub_allowed' })
          : Response.json({ result: 'limited' }, { status: 429 });
      } finally {
        active--;
      }
    }
  };
  return { effects, events, files, calls, advance, maxActive: () => maxActive, remote: () => remote };
}

function manifest(f = fixture()) {
  return buildProbeManifest(identity, workerBytes, []);
}
const deployed = f => f.events.filter(event => event[0] === 'deploy');
const deleted = f => f.events.filter(event => event[0] === 'api' && event[1] === 'DELETE');

function assertClosed(result) {
  assert.deepEqual(Object.keys(result).sort(), ['caller', 'cleanup', 'colo', 'counts', 'reason', 'support']);
  assert.doesNotMatch(
    JSON.stringify(result),
    /never-publish|production-secret|isolated-test|workers\.dev|1234567890abcdef|40265000001/
  );
}

test('manifest generates exact run name, distinct positive namespaces and source/config ownership hashes', () => {
  const value = manifest();
  assert.equal(value.schema, 1);
  assert.equal(value.scriptName, 'miden-elig-probe-40265000001-1');
  assert.equal(value.workerSha256, hash(workerBytes));
  assert.match(value.configSha256, /^[a-f0-9]{64}$/);
  assert.match(value.ownerMarker, /^[a-f0-9]{64}$/);
  assert.match(value.callerNamespaceId, /^[1-9][0-9]*$/);
  assert.match(value.coloNamespaceId, /^[1-9][0-9]*$/);
  assert.notEqual(value.callerNamespaceId, value.coloNamespaceId);
  const second = buildProbeManifest({ ...identity, runAttempt: '2' }, workerBytes, []);
  assert.notEqual(second.callerNamespaceId, value.callerNamespaceId);
  assert.notEqual(second.coloNamespaceId, value.coloNamespaceId);
  assert.notEqual(second.ownerMarker, value.ownerMarker);
  assert.deepEqual(value.limits, { requests: 120, concurrency: 4, startsPerSecond: 8, durationMs: 60000 });
});

for (const patch of [
  { repository: 'other/wallet' },
  { workflowPath: '.github/workflows/deploy-feature-eligibility.yml' },
  { runId: '01' },
  { runId: '../1' },
  { runAttempt: '0' },
  { sourceSha: 'main' },
  { scriptName: 'miden-feature-eligibility' },
  { limits: { requests: 1000 } }
])
  test(`manifest rejects caller-controlled identity ${JSON.stringify(patch)}`, () => {
    assert.throws(() => buildProbeManifest({ ...identity, ...patch }, workerBytes, []));
  });

for (const patch of [
  { ref: 'refs/tags/v1' },
  { eventName: 'pull_request' },
  { repository: 'fork/wallet' },
  { sourceSha: 'a'.repeat(40) }
]) {
  test(`run refuses untrusted context ${JSON.stringify(patch)} before any effect`, async () => {
    const f = fixture({ context: patch });
    const result = await createProbeController(f.effects).run(identity);
    assert.equal(result.reason, 'auth');
    assert.equal(f.events.length, 0);
    assert.equal(f.calls.length, 0);
  });
}

test('run deploys once from private files and records both binding refusals before verified cleanup', async () => {
  const f = fixture();
  const result = await createProbeController(f.effects).run(identity);
  assert.deepEqual(result, {
    support: 'supported',
    caller: 'refused',
    colo: 'refused',
    cleanup: 'removed',
    counts: { requests: 34, allowed: 0, limited: 32, unavailable: 0 },
    reason: 'complete'
  });
  assert.equal(deployed(f).length, 1);
  assert.equal(deleted(f).length, 1);
  assert.equal(f.remote(), undefined);
  assert.equal(f.events.find(event => event[0] === 'mkdir')[1], 0o700);
  const writes = f.events.filter(event => event[0] === 'write');
  assert.ok(writes.length >= 5);
  assert.ok(writes.every(event => event[2] === 0o600));
  const firstManifest = writes.find(event => event[1].endsWith('/manifest.json'));
  assert.equal(JSON.parse(firstManifest[3]).deploymentState, 'prepared');
  const deploying = writes.find(
    event => event[1].endsWith('/manifest.json') && JSON.parse(event[3]).deploymentState === 'deploying'
  );
  assert.ok(f.events.indexOf(deploying) < f.events.indexOf(deployed(f)[0]));
  const spec = deployed(f)[0][1];
  assert.deepEqual(spec.args, [
    '--yes',
    'wrangler@4.151.3',
    'deploy',
    '--no-bundle',
    '--config',
    '/private/probe/wrangler.json',
    '--secrets-file',
    '/private/probe/secrets.json'
  ]);
  assert.equal(spec.command, 'npx');
  assert.equal(spec.cwd, '/private/probe');
  assert.equal(spec.env.MAXMIND_LICENSE_KEY, undefined);
  assert.doesNotMatch(JSON.stringify(spec.args), /never-publish/);
  const config = JSON.parse(writes.find(event => event[1].endsWith('/wrangler.json'))[3]);
  assert.equal(config.name, 'miden-elig-probe-40265000001-1');
  assert.equal(config.workers_dev, true);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.routes, []);
  assert.deepEqual(config.observability, {
    enabled: false,
    logs: { enabled: false, invocation_logs: false },
    traces: { enabled: false }
  });
  assert.deepEqual(
    config.ratelimits.map(binding => binding.simple),
    [
      { limit: 4, period: 60 },
      { limit: 4, period: 10 }
    ]
  );
  for (const forbidden of ['durable_objects', 'migrations', 'kv_namespaces', 'env', 'account_id'])
    assert.equal(config[forbidden], undefined);
  const serialized = structuredClone(config);
  delete serialized.vars.PROBE_OWNER;
  delete serialized.vars.PROBE_CONFIG_SHA;
  function canonical(value) {
    return JSON.stringify(value, (_, entry) =>
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
        : entry
    );
  }
  assert.equal(config.vars.PROBE_CONFIG_SHA, hash(canonical(serialized)));
  assert.doesNotMatch(firstManifest[3], /never-publish|production-secret|account_id/);
  assert.ok(!f.files.has('/private/probe/secrets.json'));
  assert.ok(!f.files.has('/private/probe/wrangler.json'));
  assertClosed(result);
});

test('all 34 health/auth/exercise starts share sliding-second pacing and fixed sequential phases', async () => {
  const f = fixture();
  await createProbeController(f.effects).run(identity);
  assert.equal(f.calls.length, 34);
  assert.deepEqual(
    f.calls.map(call => call.route),
    ['/health', '/health', ...Array(16).fill('/probe/caller'), ...Array(16).fill('/probe/colo')]
  );
  for (const start of f.calls)
    assert.ok(f.calls.filter(call => call.at >= start.at && call.at < start.at + 1000).length <= 8);
  assert.ok(f.maxActive() <= 4);
  assert.ok(f.calls.every(call => call.init.redirect === 'error' && call.init.signal instanceof AbortSignal));
});

for (const route of ['/probe/caller', '/probe/colo'])
  test(`absence of ${route} refusal stays unknown without traffic expansion`, async () => {
    const f = fixture({ noRefusal: route });
    const result = await createProbeController(f.effects).run(identity);
    assert.equal(result.support, 'unknown');
    assert.equal(result.reason, 'no_refusal');
    assert.equal(result[route.endsWith('caller') ? 'caller' : 'colo'], 'unknown');
    assert.equal(result[route.endsWith('caller') ? 'colo' : 'caller'], 'refused');
    assert.equal(f.calls.length, 34);
    assert.equal(deployed(f).length, 1);
    assert.equal(result.cleanup, 'removed');
  });

for (const variant of [
  'wrong-owner',
  'wrong-source',
  'wrong-config',
  'missing-marker',
  'extra-binding',
  'wrong-namespace',
  'wrong-limit',
  'wrong-content',
  'extra-module',
  'logging',
  'preview'
]) {
  test(`ownership readback ${variant} blocks exercise and deletion`, async () => {
    const f = fixture({
      mutateRemote(remote) {
        const bindings = remote.settings.bindings;
        if (variant.startsWith('wrong-') && ['wrong-owner', 'wrong-source', 'wrong-config'].includes(variant))
          bindings.find(
            b =>
              b.name ===
              { 'wrong-owner': 'PROBE_OWNER', 'wrong-source': 'PROBE_SOURCE', 'wrong-config': 'PROBE_CONFIG_SHA' }[
                variant
              ]
          ).text = 'foreign';
        if (variant === 'missing-marker')
          bindings.splice(
            bindings.findIndex(b => b.name === 'PROBE_OWNER'),
            1
          );
        if (variant === 'extra-binding')
          bindings.push({ type: 'durable_object_namespace', name: 'ELIGIBILITY_GUARD', namespace_id: 'production' });
        if (variant === 'wrong-namespace') bindings.find(b => b.name === 'CALLER_PROBE').namespace_id = '9';
        if (variant === 'wrong-limit') bindings.find(b => b.name === 'CALLER_PROBE').simple.limit = 60;
        if (variant === 'wrong-content') remote.bytes += '\n// changed';
        if (variant === 'logging') remote.settings.observability.enabled = true;
      },
      api(path, method, { remote }) {
        if (remote && variant === 'preview' && path.endsWith('/subdomain'))
          return envelope({ enabled: true, previews_enabled: true });
        if (remote && variant === 'extra-module' && path.endsWith('/content/v2')) {
          const body = new FormData();
          body.append('staging-probe.mjs', new Blob([remote.bytes]), 'staging-probe.mjs');
          body.append('foreign.mjs', new Blob(['export default {}']), 'foreign.mjs');
          return new Response(body, { headers: { 'cf-entrypoint': 'staging-probe.mjs' } });
        }
      }
    });
    const result = await createProbeController(f.effects).run(identity);
    assert.equal(result.cleanup, 'blocked');
    assert.equal(result.reason, 'ownership_mismatch');
    assert.equal(f.calls.length, 0);
    assert.equal(deleted(f).length, 0);
    assertClosed(result);
  });
}

test('paginated inventory catches a late rate-namespace collision before deployment', async () => {
  const value = manifest();
  const f = fixture({
    pages: [[{ id: 'existing-one' }], [{ id: 'existing-two' }]],
    api(path) {
      if (path === '/workers/scripts/existing-two/settings')
        return envelope({
          bindings: [{ type: 'ratelimit', name: 'PRODUCTION', namespace_id: value.callerNamespaceId }]
        });
    }
  });
  const result = await createProbeController(f.effects).run(identity);
  assert.equal(result.reason, 'ownership_mismatch');
  assert.equal(deployed(f).length, 0);
  assert.equal(deleted(f).length, 0);
  assert.ok(f.events.some(event => event[2]?.includes('page=2')));
});

test('exact existing script name is never overwritten or deleted', async () => {
  const f = fixture({ pages: [[{ id: 'miden-elig-probe-40265000001-1' }]] });
  const result = await createProbeController(f.effects).run(identity);
  assert.equal(result.reason, 'ownership_mismatch');
  assert.equal(deployed(f).length, 0);
  assert.equal(deleted(f).length, 0);
});

for (const target of ['inventory', 'settings', 'missing-bindings', 'pagination'])
  test(`unreadable ${target} fails closed before deployment`, async () => {
    const f = fixture({
      pages: [[{ id: 'production-worker' }]],
      api(path) {
        if (target === 'inventory' && path.startsWith('/workers/scripts?')) return envelope(null, 403);
        if (target === 'settings' && path.includes('production-worker/settings')) return envelope(null, 403);
        if (target === 'missing-bindings' && path.includes('production-worker/settings')) return envelope({});
        if (target === 'pagination' && path.startsWith('/workers/scripts?'))
          return envelope([], 200, { page: 1, total_pages: 2 });
      }
    });
    const result = await createProbeController(f.effects).run(identity);
    assert.equal(result.support, 'unknown');
    assert.equal(result.reason, 'inventory_incomplete');
    assert.equal(deployed(f).length, 0);
    assert.equal(deleted(f).length, 0);
  });

for (const code of [401, 403, 429, 500])
  test(`provider ${code} is unknown and never inferred unsupported`, async () => {
    const f = fixture({
      api(path) {
        if (path === '/user/tokens/verify') return envelope({ secret: 'token-never-publish' }, code);
      }
    });
    const result = await createProbeController(f.effects).run(identity);
    assert.equal(result.support, 'unknown');
    assert.equal(result.reason, code === 429 ? 'quota' : code === 500 ? 'network' : 'auth');
    assert.equal(deployed(f).length, 0);
    assertClosed(result);
  });

test('deploy timeout after remote creation reconciles ownership and removes only that resource', async () => {
  const f = fixture({ deployError: Object.assign(new Error('token-never-publish'), { name: 'TimeoutError' }) });
  const result = await createProbeController(f.effects).run(identity);
  assert.equal(deployed(f).length, 1);
  assert.equal(result.support, 'unknown');
  assert.equal(result.reason, 'deploy_rejected');
  assert.equal(result.cleanup, 'removed');
  assert.equal(deleted(f).length, 1);
  assert.equal(f.calls.length, 0);
  assertClosed(result);
});

for (const target of ['delete', 'readback', 'ownership-read'])
  test(`cleanup ${target} failure remains blocked`, async () => {
    let deletes = 0;
    const f = fixture({
      api(path, method, { remote }) {
        if (method === 'DELETE') {
          deletes++;
          if (target === 'delete') return envelope(null, 503);
        }
        if (target === 'readback' && deletes && path.endsWith('/settings')) return envelope({ bindings: [] });
        if (target === 'ownership-read' && remote && path.endsWith('/settings')) return envelope(null, 403);
      }
    });
    const result = await createProbeController(f.effects).run(identity);
    assert.equal(result.cleanup, 'blocked');
    assert.equal(result.support, 'unknown');
    if (target === 'ownership-read') assert.equal(deleted(f).length, 0);
  });

test('idempotent absent cleanup authenticates exact trusted manifest without deploying', async () => {
  const f = fixture();
  const result = await createProbeController(f.effects).cleanup(manifest());
  assert.equal(result.cleanup, 'absent');
  assert.equal(deployed(f).length, 0);
  assert.equal(deleted(f).length, 0);
  assert.equal(f.calls.length, 0);
  assert.ok(f.events.some(event => event[2] === '/user/tokens/verify'));
});

for (const patch of [
  { scriptName: 'miden-feature-eligibility' },
  { ownerMarker: '0'.repeat(64) },
  { configSha256: '0'.repeat(64) },
  { callerNamespaceId: '7' },
  { workerSha256: '0'.repeat(64) },
  { token: 'hostile' }
])
  test(`cleanup rejects forged manifest ${Object.keys(patch)[0]} before provider calls`, async () => {
    const f = fixture();
    const result = await createProbeController(f.effects).cleanup({ ...manifest(), ...patch });
    assert.equal(result.cleanup, 'blocked');
    assert.equal(f.events.length, 0);
  });

test('prior-run recovery fails closed without authenticated provenance', async () => {
  const f = fixture({ context: { runId: '40265000002' } });
  const result = await createProbeController(f.effects).cleanup(manifest());
  assert.equal(result.cleanup, 'blocked');
  assert.equal(deleted(f).length, 0);
  assert.ok(f.events.some(event => event[0] === 'provenance'));
});

for (const variant of ['network', 'hostile-json', 'redirect', 'auth', 'quota', 'location'])
  test(`exercise ${variant} never becomes support or retries`, async () => {
    const f = fixture({
      fetch(url, init, { calls }) {
        if (calls.length <= 2)
          return new URL(url).pathname === '/health' && init.headers.Authorization === 'Bearer invalid-probe-bearer'
            ? Response.json({ error: 'forbidden' }, { status: 403 })
            : Response.json({ status: 'health_ok' });
        if (variant === 'network') throw new Error('token-never-publish');
        if (variant === 'hostile-json')
          return Response.json({ result: 'limited', secret: 'token-never-publish' }, { status: 429 });
        if (variant === 'redirect')
          return new Response('', { status: 302, headers: { Location: 'https://foreign.invalid' } });
        if (variant === 'auth') return Response.json({ error: 'forbidden' }, { status: 403 });
        if (variant === 'quota') return Response.json({ error: 'provider quota' }, { status: 429 });
        return Response.json(
          { result: 'limited' },
          { status: 429, headers: { 'cf-ray': calls.length % 2 ? 'abc-LHR' : 'abc-DFW' } }
        );
      }
    });
    const result = await createProbeController(f.effects).run(identity);
    assert.equal(result.support, 'unknown');
    assert.equal(deployed(f).length, 1);
    assert.equal(result.cleanup, 'removed');
    assert.ok(f.calls.length <= 34);
    assertClosed(result);
  });

test('absolute deadline aborts stalled fetch and drains it before cleanup', async () => {
  let start;
  const started = new Promise(resolve => {
    start = resolve;
  });
  const f = fixture({
    fetch(url, init) {
      start();
      return new Promise((resolve, reject) =>
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      );
    }
  });
  const pending = createProbeController(f.effects).run(identity);
  await Promise.race([started, pending]);
  assert.equal(f.calls.length, 1);
  f.advance(60000);
  const result = await pending;
  assert.equal(result.reason, 'bounds_reached');
  assert.equal(result.cleanup, 'removed');
  assert.equal(f.calls.length, 1);
  assert.equal(f.maxActive(), 1);
});

test('cancellation aborts exercise and still performs authenticated exact cleanup', async () => {
  const aborter = new AbortController();
  const f = fixture({
    signal: aborter.signal,
    fetch(url, init) {
      aborter.abort();
      throw new DOMException('aborted', 'AbortError');
    }
  });
  const result = await createProbeController(f.effects).run(identity);
  assert.equal(result.support, 'unknown');
  assert.equal(result.cleanup, 'removed');
  assert.equal(f.calls.length, 1);
  assert.equal(deleted(f).length, 1);
});

test('documented multipart string module hashes its content rather than rejecting MIME representation', async () => {
  const f = fixture({
    api(path, method, { remote }) {
      if (remote && path.endsWith('/content/v2')) {
        const boundary = 'provider-content-fixture';
        const body = `--${boundary}\r\nContent-Disposition: form-data; name="staging-probe.mjs"\r\nContent-Type: application/javascript+module\r\n\r\n${remote.bytes}\r\n--${boundary}--\r\n`;
        return new Response(body, {
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'cf-entrypoint': 'staging-probe.mjs' }
        });
      }
    }
  });
  const result = await createProbeController(f.effects).run(identity);
  assert.equal(result.support, 'supported');
  assert.equal(result.cleanup, 'removed');
  assert.equal(f.calls.length, 34);
});

test('structured deploy rejection persists only HTTP status and numeric provider code, never labels unsupported', async () => {
  const f = fixture({
    deployError: Object.assign(new Error('token-never-publish'), { httpStatus: 403, providerCode: 10042 })
  });
  const result = await createProbeController(f.effects).run(identity);
  const evidence = f.events.find(event => event[0] === 'write' && event[1].endsWith('/deploy-evidence.json'));
  assert.ok(evidence);
  assert.deepEqual(JSON.parse(evidence[3]), { httpStatus: 403, providerCode: 10042 });
  assert.equal(result.support, 'unknown');
  assert.equal(result.reason, 'deploy_rejected');
  assertClosed(result);
});

test('a failed deployment with a foreign marker never inherits deletion permission from preflight absence', async () => {
  const f = fixture({
    deployError: new Error('timeout'),
    mutateRemote(remote) {
      remote.settings.bindings.find(binding => binding.name === 'PROBE_OWNER').text = 'different-owner';
    }
  });
  const result = await createProbeController(f.effects).run(identity);
  assert.equal(result.cleanup, 'blocked');
  assert.equal(deleted(f).length, 0);
  assert.equal(f.calls.length, 0);
});

test('cleanup can use a separately authenticated prior-run identity and trusted source', async () => {
  const f = fixture({ context: { runId: '40265000002' }, recovery: true });
  const result = await createProbeController(f.effects).cleanup(manifest());
  assert.equal(result.cleanup, 'absent');
  assert.equal(deployed(f).length, 0);
  assert.equal(f.calls.length, 0);
  assert.ok(f.events.some(event => event[0] === 'provenance'));
});

test('an already cancelled run creates no private files and never deploys', async () => {
  const aborter = new AbortController();
  aborter.abort();
  const f = fixture({ signal: aborter.signal });
  const result = await createProbeController(f.effects).run(identity);
  assert.equal(result.reason, 'bounds_reached');
  assert.equal(deployed(f).length, 0);
  assert.equal(f.events.filter(event => event[0] === 'mkdir').length, 0);
});

for (const patch of [{ runId: 40265000001 }, { runAttempt: 1 }])
  test(`identity requires string ${Object.keys(patch)[0]}`, () => {
    assert.throws(() => buildProbeManifest({ ...identity, ...patch }, workerBytes, []));
  });

for (const binding of [
  { type: 'ratelimit', name: 'production' },
  { type: 'ratelimit', name: 'production', namespace_id: 'unknown' },
  { name: 'production' }
])
  test(`incomplete inventory binding ${JSON.stringify(binding)} cannot authorize deploy`, async () => {
    const f = fixture({
      pages: [[{ id: 'production-worker' }]],
      api(path) {
        if (path.endsWith('/production-worker/settings')) return envelope({ bindings: [binding] });
      }
    });
    const result = await createProbeController(f.effects).run(identity);
    assert.equal(result.reason, 'inventory_incomplete');
    assert.equal(deployed(f).length, 0);
  });

test('arbitrary thrown reason values never escape the closed result taxonomy', async () => {
  const f = fixture({
    fetch() {
      throw Object.assign(new Error('secret'), { reason: 'token-never-publish' });
    }
  });
  const result = await createProbeController(f.effects).run(identity);
  assert.equal(result.reason, 'network');
  assertClosed(result);
});

for (const args of [
  ['cleanup', '--name', 'production'],
  ['cleanup', '1'],
  ['cleanup', '--config', 'foreign']
])
  test(`CLI rejects arbitrary cleanup arguments ${JSON.stringify(args)}`, async () => {
    const result = await main(args, {});
    assert.equal(result.reason, 'auth');
    assert.equal(result.cleanup, 'blocked');
  });

const probeWorkflow = () =>
  readFileSync(new URL('../.github/workflows/probe-feature-eligibility.yml', import.meta.url), 'utf8');
const section = (text, start, end) => text.split(start)[1]?.split(end)[0] ?? '';

test('manual staging workflow gates its credential job to trusted repository main dispatch only', () => {
  const workflow = probeWorkflow();
  assert.deepEqual(
    [...section(workflow, '\non:\n', '\npermissions:').matchAll(/^  ([a-z_]+):/gm)].map(match => match[1]),
    ['workflow_dispatch']
  );
  assert.match(workflow, /github\.repository == '0xMiden\/wallet'/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow, /github\.event\.repository\.fork == false/);
  assert.match(workflow, /environment: feature-eligibility-production/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /node-version: 22/);
  assert.match(workflow, /timeout-minutes: 10/);
});

test('staging workflow exposes only fixed operation and prior-run coordinates with read permissions', () => {
  const workflow = probeWorkflow();
  const inputs = section(workflow, '    inputs:\n', '\npermissions:');
  assert.deepEqual(
    [...inputs.matchAll(/^      ([a-z_]+):/gm)].map(match => match[1]),
    ['operation', 'cleanup_run_id', 'cleanup_attempt']
  );
  assert.match(inputs, /options: \[probe, cleanup\]/);
  assert.equal(section(workflow, '\npermissions:\n', '\nconcurrency:'), '  contents: read\n  actions: read\n');
  assert.match(workflow, /group: feature-eligibility-staging-probe/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(
    workflow,
    /MAXMIND|CALLER_HASH_SECRET|wrangler\.jsonc|deploy-feature-eligibility|release-wallet|wallet-config/
  );
  assert.deepEqual([...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map(match => match[1]).sort(), [
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_API_TOKEN'
  ]);
});

test('staging workflow always attempts current cleanup and publishes only sanitized short-lived evidence', () => {
  const workflow = probeWorkflow();
  const cleanup = section(workflow, '      - name: Always clean current probe\n', '      - name:');
  assert.match(cleanup, /if: always\(\) && inputs\.operation == 'probe'/);
  assert.match(cleanup, /test -f .*manifest\.json/);
  assert.match(cleanup, /feature-eligibility-staging-probe\.mjs cleanup/);
  const upload = section(workflow, '      - name: Retain sanitized evidence\n', '      - name:');
  assert.match(upload, /if: always\(\)/);
  assert.match(upload, /retention-days: 3/);
  assert.match(
    upload,
    /path: \|\n            \$\{\{ runner\.temp \}\}\/probe-evidence\/manifest\.json\n            \$\{\{ runner\.temp \}\}\/probe-evidence\/result\.json/
  );
  assert.doesNotMatch(upload, /\*|config|stdout|stderr|secrets/);
  assert.match(workflow, /artifact-ids: \$\{\{ steps\.recovery\.outputs\.artifact_id \}\}/);
  assert.match(workflow, /run-id: \$\{\{ inputs\.cleanup_run_id \}\}/);
  assert.match(workflow, /feature-eligibility-staging-probe-recovery\.mjs prepare/);
  assert.match(workflow, /feature-eligibility-staging-probe-recovery\.mjs cleanup/);
});

test('authentication failure records source-bound preflight without deployment', async () => {
  const f = fixture({ api: path => path === '/user/tokens/verify' ? envelope({}, 403) : undefined });
  const received = await createProbeController(f.effects).run(identity);
  assert.deepEqual(received.preflight, {
    identity, stage: 'authentication', manifest: 'absent', deployment: 'not_attempted', reason: 'auth'
  });
  assert.equal(f.events.some(event => event[0] === 'deploy'), false);
});
test('deployment failure retains attempted state and original deploy reason', async () => {
  const f = fixture();
  f.effects.deploy = async () => ({ exitCode: 1 });
  const received = await createProbeController(f.effects).run(identity);
  assert.deepEqual(received.preflight, {
    identity, stage: 'deployment', manifest: 'registered', deployment: 'attempted', reason: 'deploy_rejected'
  });
});
