import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildProbeManifest,
  createProbeController,
  createLocalProbeEffects,
  main,
  validatePreflight,
  validateOwnershipCheck
} from './feature-eligibility-staging-probe.mjs';

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
  let remote = options.remote;
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
      if (path === '/account') return envelope({ id: 'account-never-publish', name: 'metadata-never-publish' });
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
      if (suffix === '/script-settings') return envelope(remote.scriptSettings);
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
      remote = {
        bytes: files.get('/private/probe/staging-probe.mjs'),
        settings,
        scriptSettings: structuredClone({ observability: settings.observability, logpush: false, tail_consumers: [] })
      };
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
  const { preflight, ownershipCheck, ...verdict } = result;
  if (ownershipCheck) {
    assert.deepEqual(validateOwnershipCheck(ownershipCheck), ownershipCheck);
    assert.equal(result.cleanup, 'blocked');
    assert.equal(result.support, 'unknown');
  }
  if (preflight) {
    validatePreflight(preflight);
    assert.deepEqual(preflight.identity, identity);
  }
  assert.deepEqual(Object.keys(verdict).sort(), ['caller', 'cleanup', 'colo', 'counts', 'reason', 'support']);
  assert.doesNotMatch(
    JSON.stringify(verdict),
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
        if (path === '/account') return envelope({ secret: 'token-never-publish' }, code);
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
  assert.ok(f.events.some(event => event[2] === '/account'));
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
  assert.match(inputs, /options: \[probe, cleanup, inspect\]/);
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
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_API_TOKEN',
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
  const f = fixture({ api: path => (path === '/account' ? envelope({}, 403) : undefined) });
  const received = await createProbeController(f.effects).run(identity);
  assert.deepEqual(received.preflight, {
    identity,
    stage: 'authentication',
    manifest: 'absent',
    deployment: 'not_attempted',
    reason: 'auth'
  });
  assert.equal(
    f.events.some(event => event[0] === 'deploy'),
    false
  );
});
test('deployment failure retains attempted state and original deploy reason', async () => {
  const f = fixture();
  f.effects.deploy = async () => ({ exitCode: 1 });
  const received = await createProbeController(f.effects).run(identity);
  assert.deepEqual(received.preflight, {
    identity,
    stage: 'deployment',
    manifest: 'registered',
    deployment: 'attempted',
    reason: 'deploy_rejected'
  });
});

test('invalid credential settings retain only environment-stage evidence for trusted workflow context', async () => {
  const received = await main(['run'], {
    RUNNER_TEMP: '/private/probe',
    GITHUB_REPOSITORY: identity.repository,
    GITHUB_WORKFLOW_REF: `${identity.repository}/${identity.workflowPath}@refs/heads/main`,
    GITHUB_RUN_ID: identity.runId,
    GITHUB_RUN_ATTEMPT: identity.runAttempt,
    GITHUB_SHA: identity.sourceSha,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    CLOUDFLARE_ACCOUNT_ID: 'invalid-setting-never-publish',
    CLOUDFLARE_API_TOKEN: 'secret-never-publish'
  });
  assert.deepEqual(received.preflight, {
    identity,
    stage: 'environment',
    manifest: 'absent',
    deployment: 'not_attempted',
    reason: 'auth'
  });
  assertClosed(received);
});

test('account-scoped authorization supports run and cleanup when user introspection is forbidden', async () => {
  const f = fixture({ api: path => (path === '/user/tokens/verify' ? envelope({}, 403) : undefined) });
  const result = await createProbeController(f.effects).run(identity);
  assert.equal(result.support, 'supported');
  assert.equal(result.cleanup, 'removed');
  const cleanup = await createProbeController(f.effects).cleanup(manifest());
  assert.equal(cleanup.cleanup, 'absent');
  assert.ok(f.events.some(event => event[2] === '/account'));
  assert.ok(!f.events.some(event => event[2] === '/user/tokens/verify'));
  assertClosed(result);
});

for (const [label, response, reason] of [
  ['wrong-account', () => envelope({ id: 'foreign-never-publish' }), 'auth'],
  ['missing-id', () => envelope({ name: 'metadata-never-publish' }), 'auth'],
  ['null-result', () => envelope(null), 'auth'],
  ['malformed', () => Response.json(null), 'invalid_response'],
  ['error-envelope', () => Response.json({ success: false, errors: [], result: {} }), 'invalid_response'],
  ['auth', () => envelope({}, 403), 'auth'],
  ['quota', () => envelope({}, 429), 'quota'],
  [
    'network',
    () => {
      throw new Error('private-never-publish');
    },
    'network'
  ],
  ['redirect', () => new Response(null, { status: 302 }), 'network'],
  ['oversize', () => new Response('x'.repeat(2 * 1024 * 1024 + 1)), 'invalid_response']
])
  test(`account metadata ${label} blocks run and cleanup effects`, async () => {
    const f = fixture({ api: path => (path === '/account' ? response() : undefined) });
    const result = await createProbeController(f.effects).run(identity);
    assert.equal(result.support, 'unknown');
    assert.equal(result.reason, reason);
    assert.equal(result.preflight.stage, 'authentication');
    const cleanup = await createProbeController(f.effects).cleanup(manifest());
    assert.equal(cleanup.cleanup, 'blocked');
    assert.equal(cleanup.reason, 'cleanup_failed');
    assert.equal(deployed(f).length, 0);
    assert.equal(deleted(f).length, 0);
    assert.equal(f.calls.length, 0);
    assertClosed(result);
    assert.doesNotMatch(JSON.stringify(cleanup), /never-publish|account|metadata/);
  });

test('local account adapter binds exact configured URL and rejects credential-routing inputs', async t => {
  const calls = [];
  const timeouts = [];
  t.mock.method(AbortSignal, 'timeout', ms => {
    timeouts.push(ms);
    return new AbortController().signal;
  });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push([url, init]);
    return envelope({ id: 'a'.repeat(32) });
  });
  const effects = createLocalProbeEffects({
    RUNNER_TEMP: '/private',
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    CLOUDFLARE_API_TOKEN: 'private-token'
  });
  await effects.providerAPI('/account', { method: 'GET', redirect: 'follow' });
  assert.equal(calls[0][0], `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}`);
  assert.equal(calls[0][1].method, 'GET');
  assert.equal(calls[0][1].headers.Authorization, 'Bearer private-token');
  assert.equal(calls[0][1].redirect, 'error');
  assert.ok(calls[0][1].signal instanceof AbortSignal);
  for (const path of [
    '/user/tokens/verify',
    'https://host.invalid',
    '//host.invalid',
    '/account/../tokens/verify',
    '/workers/../../user/tokens/verify'
  ])
    await assert.rejects(async () => effects.providerAPI(path, { method: 'GET' }));
  await assert.rejects(async () => effects.providerAPI('/account', { method: 'DELETE' }));
  const hostile = createLocalProbeEffects({
    RUNNER_TEMP: '/private',
    CLOUDFLARE_ACCOUNT_ID: '../user',
    CLOUDFLARE_API_TOKEN: 'private-token'
  });
  await assert.rejects(async () => hostile.providerAPI('/account', { method: 'GET' }));
  assert.equal(calls.length, 1);
  assert.deepEqual(timeouts, [15000]);
  for (const [path, method] of [
    ['/workers/subdomain', 'GET'],
    ['/workers/scripts?page=1&per_page=100', 'GET'],
    ['/workers/scripts/example/settings', 'GET'],
    ['/workers/scripts/example/script-settings', 'GET'],
    ['/workers/scripts/example/subdomain', 'GET'],
    ['/workers/scripts/example/content/v2', 'GET'],
    ['/workers/scripts/example', 'DELETE']
  ]) {
    await effects.providerAPI(path, { method });
    assert.equal(calls.at(-1)[0], `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}${path}`);
    assert.equal(calls.at(-1)[1].method, method);
  }
});

async function ownershipFixture(options = {}) {
  let remote;
  const seed = fixture({
    mutateRemote: value => {
      remote = structuredClone(value);
    }
  });
  assert.equal((await createProbeController(seed.effects).run(identity)).support, 'supported');
  const f = fixture({ ...options, remote });
  options.mutate?.(f.remote().settings);
  return f;
}

const ownershipCases = [
  [
    'settings_bindings',
    'wrong_type',
    s => {
      s.bindings = {};
    }
  ],
  [
    'settings_binding_count',
    'different_value',
    s => {
      s.bindings.pop();
    }
  ],
  [
    'compatibility_date',
    'different_value',
    s => {
      s.compatibility_date = '2000-01-01';
    }
  ],
  [
    'compatibility_flags',
    'different_value',
    s => {
      s.compatibility_flags = ['private-canary'];
    }
  ],
  [
    'logpush',
    'missing',
    s => {
      delete s.logpush;
    }
  ],
  [
    'observability',
    'different_value',
    s => {
      s.observability.enabled = true;
    }
  ],
  [
    'observability_logs',
    'null',
    s => {
      s.observability.logs.enabled = null;
    }
  ],
  [
    'observability_invocations',
    'wrong_type',
    s => {
      s.observability.logs.invocation_logs = 'private-canary';
    }
  ],
  [
    'observability_traces',
    'null',
    s => {
      s.observability.traces.enabled = null;
    }
  ],
  [
    'tail_consumers',
    'different_value',
    s => {
      s.tail_consumers = [{ service: 'private-canary' }];
    }
  ],
  [
    'assets',
    'different_value',
    s => {
      s.assets = { private: 'private-canary' };
    }
  ],
  [
    'migration_tag',
    'different_value',
    s => {
      s.migration_tag = 'private-canary';
    }
  ],
  [
    'cache_enabled',
    'different_value',
    s => {
      s.cache_options = { enabled: true };
    }
  ],
  [
    'binding_record',
    'null',
    s => {
      s.bindings[0] = null;
    }
  ],
  [
    'binding_duplicate',
    'different_value',
    s => {
      s.bindings[1].name = s.bindings[0].name;
    }
  ],
  [
    'binding_unexpected',
    'different_value',
    s => {
      s.bindings[0].name = 'private-canary';
    }
  ],
  ...[
    ['PROBE_SOURCE', 'source'],
    ['PROBE_CONFIG_SHA', 'config'],
    ['PROBE_OWNER', 'owner']
  ].flatMap(([name, gate]) => [
    [
      `${gate}_type`,
      'different_value',
      s => {
        s.bindings.find(b => b.name === name).type = 'json';
      }
    ],
    [
      `${gate}_value`,
      'different_value',
      s => {
        s.bindings.find(b => b.name === name).text = 'private-canary';
      }
    ]
  ]),
  ...[
    ['PROBE_BEARER', 'bearer_type'],
    ['PROBE_HASH_SECRET', 'hash_secret_type']
  ].map(([name, gate]) => [
    gate,
    'different_value',
    s => {
      s.bindings.find(b => b.name === name).type = 'plain_text';
    }
  ]),
  ...[
    ['CALLER_PROBE', 'caller'],
    ['COLO_PROBE', 'colo']
  ].flatMap(([name, gate]) => [
    [
      `${gate}_type`,
      'different_value',
      s => {
        s.bindings.find(b => b.name === name).type = 'plain_text';
      }
    ],
    [
      `${gate}_namespace`,
      'wrong_type',
      s => {
        s.bindings.find(b => b.name === name).namespace_id = 123;
      }
    ],
    [
      `${gate}_simple`,
      'additional_fields',
      s => {
        s.bindings.find(b => b.name === name).simple.mitigation_timeout = 0;
      }
    ]
  ])
];
for (const [gate, form, mutate] of ownershipCases)
  test(`cleanup retains only closed ${gate}/${form} at its first failed predicate`, async () => {
    const f = await ownershipFixture({ mutate });
    const received = await createProbeController(f.effects).cleanup(manifest());
    assert.deepEqual(received, { cleanup: 'blocked', reason: 'ownership_mismatch', ownershipCheck: { gate, form } });
    assert.deepEqual(
      f.events.filter(e => e[0] === 'api').map(e => e[2]),
      ['/account', '/workers/scripts/miden-elig-probe-40265000001-1/settings']
    );
    assert.equal(deployed(f).length, 0);
    assert.equal(deleted(f).length, 0);
    assert.equal(f.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(received), /private-canary|never-publish|40265000001/);
  });

for (const [gate, api] of [
  [
    'subdomain_enabled',
    path => (path.endsWith('/subdomain') ? envelope({ enabled: false, previews_enabled: false }) : undefined)
  ],
  [
    'subdomain_previews',
    path => (path.endsWith('/subdomain') ? envelope({ enabled: true, previews_enabled: true }) : undefined)
  ],
  ['content_status', path => (path.endsWith('/content/v2') ? new Response('', { status: 403 }) : undefined)],
  [
    'content_type',
    path =>
      path.endsWith('/content/v2')
        ? new Response('private-canary', { headers: { 'content-type': 'text/plain' } })
        : undefined
  ],
  [
    'content_entrypoint',
    path =>
      path.endsWith('/content/v2')
        ? new Response(workerBytes, {
            headers: { 'content-type': 'application/javascript', 'cf-entrypoint': 'private-canary' }
          })
        : undefined
  ],
  [
    'content_hash',
    path =>
      path.endsWith('/content/v2')
        ? new Response('private-canary', {
            headers: { 'content-type': 'application/javascript', 'cf-entrypoint': 'staging-probe.mjs' }
          })
        : undefined
  ],
  [
    'multipart_count',
    path => {
      if (!path.endsWith('/content/v2')) return;
      const body = new FormData();
      body.append('staging-probe.mjs', 'private-canary');
      body.append('extra', 'private-canary');
      return new Response(body, { headers: { 'cf-entrypoint': 'staging-probe.mjs' } });
    }
  ],
  [
    'multipart_name',
    path => {
      if (!path.endsWith('/content/v2')) return;
      const body = new FormData();
      body.append('private-canary', 'private-canary');
      return new Response(body, { headers: { 'cf-entrypoint': 'staging-probe.mjs' } });
    }
  ]
])
  test(`cleanup identifies ${gate} without deleting or reading past its failed gate`, async () => {
    const f = await ownershipFixture({ api });
    const received = await createProbeController(f.effects).cleanup(manifest());
    assert.equal(received.reason, 'ownership_mismatch');
    assert.equal(received.cleanup, 'blocked');
    assert.equal(received.ownershipCheck?.gate, gate);
    assert.ok(
      ['missing', 'null', 'wrong_type', 'different_value', 'additional_fields', 'unavailable'].includes(
        received.ownershipCheck?.form
      )
    );
    assert.equal(deleted(f).length, 0);
    assert.equal(f.calls.length, 0);
    const paths = f.events.filter(e => e[0] === 'api').map(e => e[2]);
    assert.equal(paths.length, gate.startsWith('subdomain') ? 4 : 5);
    assert.doesNotMatch(JSON.stringify(received), /private-canary|never-publish/);
  });

test('only cleanup captures ownership diagnostics; prior verification preflight remains independent', async () => {
  const f = fixture({
    mutateRemote: r => {
      delete r.settings.logpush;
    }
  });
  const result = await createProbeController(f.effects).run(identity);
  assert.equal(result.preflight.stage, 'verification');
  assert.equal(result.preflight.reason, 'ownership_mismatch');
  assert.deepEqual(Object.keys(result.preflight).sort(), ['deployment', 'identity', 'manifest', 'reason', 'stage']);
  assert.deepEqual(result.ownershipCheck, { gate: 'logpush', form: 'missing' });
  assert.equal(result.counts.requests, 0);
  assert.equal(result.cleanup, 'blocked');
  assert.equal(deleted(f).length, 0);
});

test('ownership validator never invokes supplied getters or accepts inherited, symbolic or extra data', () => {
  let reads = 0;
  const accessor = Object.defineProperty({ form: 'missing' }, 'gate', {
    enumerable: true,
    get() {
      reads++;
      throw new Error('private-canary');
    }
  });
  for (const value of [
    accessor,
    Object.create({ gate: 'logpush', form: 'missing' }),
    { gate: 'logpush', form: 'missing', [Symbol('private-canary')]: true },
    new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('private-canary');
        }
      }
    )
  ])
    assert.throws(() => validateOwnershipCheck(value));
  assert.equal(reads, 0);
});

test('CLI exact-manifest cleanup retains the closed failure without exercising or deleting', async t => {
  const root = await mkdtemp(join(tmpdir(), 'probe-cli-owned-'));
  const account = 'a'.repeat(32);
  const paths = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    paths.push(new URL(url).pathname);
    assert.equal(init.method, 'GET');
    if (new URL(url).pathname === `/client/v4/accounts/${account}`) return envelope({ id: account });
    assert.equal(
      new URL(url).pathname,
      `/client/v4/accounts/${account}/workers/scripts/miden-elig-probe-40265000001-1/settings`
    );
    return envelope({ bindings: [] });
  });
  try {
    await mkdir(join(root, 'feature-eligibility-probe'));
    await writeFile(join(root, 'feature-eligibility-probe/manifest.json'), JSON.stringify(manifest()));
    const received = await main(['cleanup'], {
      RUNNER_TEMP: root,
      GITHUB_REPOSITORY: identity.repository,
      GITHUB_WORKFLOW_REF: `${identity.repository}/${identity.workflowPath}@refs/heads/main`,
      GITHUB_RUN_ID: identity.runId,
      GITHUB_RUN_ATTEMPT: identity.runAttempt,
      GITHUB_SHA: identity.sourceSha,
      GITHUB_REF: 'refs/heads/main',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      CLOUDFLARE_ACCOUNT_ID: account,
      CLOUDFLARE_API_TOKEN: 'private-canary'
    });
    assert.deepEqual(received.ownershipCheck, { gate: 'settings_binding_count', form: 'different_value' });
    assert.equal(received.cleanup, 'blocked');
    assert.equal(received.reason, 'ownership_mismatch');
    assert.equal(received.counts.requests, 0);
    assert.equal(paths.length, 2);
    assert.doesNotMatch(JSON.stringify(received), /private-canary|aaaaaaaa/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cleanup requires independent script-level switches when version readback omits observability', async () => {
  const f = await ownershipFixture({
    mutate: settings => {
      delete settings.observability;
    }
  });
  const result = await createProbeController(f.effects).cleanup(manifest());
  assert.equal(result.cleanup, 'removed');
  assert.equal(deleted(f).length, 1);
  const paths = f.events.filter(e => e[0] === 'api').map(e => e[2]);
  assert.ok(paths.includes('/workers/scripts/miden-elig-probe-40265000001-1/script-settings'));
});

for (const [gate, path] of [
  ['script_observability', ['enabled']],
  ['script_observability_logs', ['logs', 'enabled']],
  ['script_observability_invocations', ['logs', 'invocation_logs']],
  ['script_observability_traces', ['traces', 'enabled']]
])
  for (const [form, value] of [
    ['missing', undefined],
    ['null', null],
    ['wrong_type', 'private-authority-canary'],
    ['different_value', true]
  ]) {
    test(`authoritative ${gate}/${form} refuses despite version-level explicit false`, async () => {
      const f = await ownershipFixture();
      let target = f.remote().scriptSettings.observability;
      for (const key of path.slice(0, -1)) target = target[key];
      if (value === undefined) delete target[path.at(-1)];
      else target[path.at(-1)] = value;
      const result = await createProbeController(f.effects).cleanup(manifest());
      assert.deepEqual(result, { cleanup: 'blocked', reason: 'ownership_mismatch', ownershipCheck: { gate, form } });
      assert.equal(deleted(f).length, 0);
      assert.equal(f.calls.length, 0);
      assert.equal(
        f.events.filter(e => e[0] === 'api').at(-1)[2],
        '/workers/scripts/miden-elig-probe-40265000001-1/script-settings'
      );
      assert.doesNotMatch(JSON.stringify(result), /private-authority-canary/);
    });
  }

for (const [label, mutate, gate, form] of [
  [
    'object absent',
    s => {
      delete s.observability;
    },
    'script_observability',
    'missing'
  ],
  [
    'object null',
    s => {
      s.observability = null;
    },
    'script_observability',
    'null'
  ],
  [
    'logs null',
    s => {
      s.observability.logs = null;
    },
    'script_observability_logs',
    'null'
  ],
  [
    'traces array',
    s => {
      s.observability.traces = [];
    },
    'script_observability_traces',
    'wrong_type'
  ],
  [
    'logpush enabled',
    s => {
      s.logpush = true;
    },
    'script_logpush',
    'different_value'
  ],
  [
    'tail consumer',
    s => {
      s.tail_consumers = [{ service: 'private-tail-canary' }];
    },
    'script_tail_consumers',
    'different_value'
  ]
])
  test(`authoritative ${label} remains ambiguous or conflicting`, async () => {
    const f = await ownershipFixture();
    mutate(f.remote().scriptSettings);
    const result = await createProbeController(f.effects).cleanup(manifest());
    assert.deepEqual(result, { cleanup: 'blocked', reason: 'ownership_mismatch', ownershipCheck: { gate, form } });
    assert.equal(deleted(f).length, 0);
  });

for (const value of [null, [], 'private-version-canary', { enabled: true }, { logs: null }, { traces: [] }])
  test(`present malformed version observability refuses before authority read ${JSON.stringify(value)}`, async () => {
    const f = await ownershipFixture();
    f.remote().settings.observability = value;
    const result = await createProbeController(f.effects).cleanup(manifest());
    assert.equal(result.cleanup, 'blocked');
    assert.equal(deleted(f).length, 0);
    assert.ok(!f.events.some(e => e[0] === 'api' && e[2].endsWith('/script-settings')));
  });

test('authoritative all-false cannot bypass original content ownership', async () => {
  const f = await ownershipFixture({
    mutate: s => {
      delete s.observability;
    }
  });
  f.remote().bytes = 'private-content-canary';
  const result = await createProbeController(f.effects).cleanup(manifest());
  assert.equal(result.cleanup, 'blocked');
  assert.equal(deleted(f).length, 0);
});

for (const failure of ['auth', 'network', 'malformed', 'absent'])
  test(`script settings ${failure} is never ownership`, async () => {
    const f = await ownershipFixture();
    const api = f.effects.providerAPI;
    f.effects.providerAPI = async (path, init) => {
      if (!path.endsWith('/script-settings')) return api(path, init);
      if (failure === 'network') throw new Error('private-network-canary');
      if (failure === 'auth') return new Response('', { status: 403 });
      if (failure === 'absent') return absent();
      return Response.json({ success: true, errors: [], result: null });
    };
    const result = await createProbeController(f.effects).cleanup(manifest());
    assert.equal(result.cleanup, 'blocked');
    assert.equal(deleted(f).length, 0);
  });

for (const version of [{}, { enabled: false }, { logs: { enabled: false } }, { traces: {} }])
  test(`partial version observation defers only to explicit authoritative switches ${JSON.stringify(version)}`, async () => {
    const f = await ownershipFixture();
    f.remote().settings.observability = version;
    assert.equal((await createProbeController(f.effects).cleanup(manifest())).cleanup, 'removed');
    assert.equal(deleted(f).length, 1);
  });
for (const [field, value] of [
  ['logpush', null],
  ['logpush', 'private-global-canary'],
  ['tail_consumers', null],
  ['tail_consumers', {}]
])
  test(`malformed script-level ${field} refuses without merging`, async () => {
    const f = await ownershipFixture();
    f.remote().scriptSettings[field] = value;
    assert.equal((await createProbeController(f.effects).cleanup(manifest())).cleanup, 'blocked');
    assert.equal(deleted(f).length, 0);
  });

async function inspectionFixture(mutateRemote) {
  const f = fixture({
    mutateRemote,
    api(path, method) {
      if (method === 'DELETE') throw new Error('retained inspection fixture');
    }
  });
  await createProbeController(f.effects).run(identity);
  f.events.length = 0;
  f.calls.length = 0;
  return f;
}

test('inspection verifies the exact retained owner using five GETs without cleanup or exercise', async () => {
  const f = await inspectionFixture();
  const result = await createProbeController(f.effects).inspect(manifest(f));
  assert.deepEqual(result, { inspection: 'verified', reason: 'complete' });
  assert.equal(f.events.filter(event => event[0] === 'api').length, 5);
  assert.ok(f.events.filter(event => event[0] === 'api').every(event => event[1] === 'GET'));
  assert.equal(deployed(f).length, 0);
  assert.equal(f.calls.length, 0);
});

test('inspection keeps canonical null observability blocked with the original ownership diagnostic', async () => {
  const f = await inspectionFixture(remote => {
    remote.scriptSettings.observability = null;
  });
  const result = await createProbeController(f.effects).inspect(manifest(f));
  assert.equal(result.inspection, 'blocked');
  assert.equal(result.reason, 'ownership_mismatch');
  assert.deepEqual(result.ownershipCheck, { gate: 'script_observability', form: 'null' });
  assert.equal(deleted(f).length, 0);
});

test('inspection rejects untrusted provenance before any provider request', async () => {
  const f = fixture({ context: { ref: 'refs/heads/untrusted' } });
  const result = await createProbeController(f.effects).inspect(manifest(f));
  assert.deepEqual(result, { inspection: 'blocked', reason: 'ownership_mismatch' });
  assert.equal(f.events.length, 0);
});

for (const [name, mutateRemote] of [
  [
    'binding owner',
    remote => {
      remote.settings.bindings[0].text = 'different-owner';
    }
  ],
  [
    'worker content',
    remote => {
      remote.bytes = 'different-source';
    }
  ],
  [
    'enabled canonical logs',
    remote => {
      remote.scriptSettings.observability.logs.enabled = true;
    }
  ]
])
  test(`inspection blocks changed ${name} without cleanup or exercise`, async () => {
    const f = await inspectionFixture(mutateRemote);
    const result = await createProbeController(f.effects).inspect(manifest(f));
    assert.equal(result.inspection, 'blocked');
    assert.equal(result.reason, 'ownership_mismatch');
    assert.ok(result.ownershipCheck);
    assert.equal(deleted(f).length, 0);
    assert.equal(deployed(f).length, 0);
    assert.equal(f.calls.length, 0);
  });

test('inspection rejects the wrong configured account before reading script metadata', async () => {
  const f = await inspectionFixture();
  f.effects.environment.CLOUDFLARE_ACCOUNT_ID = 'other-account';
  const result = await createProbeController(f.effects).inspect(manifest(f));
  assert.deepEqual(result, { inspection: 'blocked', reason: 'auth' });
  assert.deepEqual(f.events, [['api', 'GET', '/account']]);
});
