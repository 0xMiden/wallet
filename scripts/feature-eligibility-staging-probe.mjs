import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** @typedef {{repository:string, workflowPath:string, runId:string, runAttempt:string, sourceSha:string}} ProbeIdentity */
/** @typedef {{schema:1, identity:ProbeIdentity, scriptName:string, workerSha256:string, configSha256:string, ownerMarker:string, callerNamespaceId:string, coloNamespaceId:string, limits:object, deploymentState:string}} ProbeManifest */
/** @typedef {{support:string, caller:string, colo:string, cleanup:string, counts:{requests:number,allowed:number,limited:number,unavailable:number}, reason:string}} ProbeResult */

const WORKFLOW = '.github/workflows/probe-feature-eligibility.yml';
const LIMITS = { requests: 120, concurrency: 4, startsPerSecond: 8, durationMs: 60000 };
const PREFLIGHT_STAGES = [
  'environment',
  'identity',
  'authentication',
  'inventory',
  'absence',
  'subdomain',
  'preparation',
  'deployment',
  'verification',
  'exercise'
];
const STATES = ['prepared', 'deploying', 'deployed', 'uncertain', 'cleaned', 'cleanup_blocked'];
const START_INTERVAL_MS = 126;
const REASONS = [
  'complete',
  'deploy_rejected',
  'auth',
  'quota',
  'network',
  'no_refusal',
  'invalid_response',
  'ownership_mismatch',
  'cleanup_failed',
  'inventory_incomplete',
  'bounds_reached'
];

const OWNERSHIP_GATES = Object.freeze([
  'settings_bindings',
  'settings_binding_count',
  'compatibility_date',
  'compatibility_flags',
  'logpush',
  'observability',
  'observability_logs',
  'observability_invocations',
  'observability_traces',
  'script_observability',
  'script_observability_logs',
  'script_observability_invocations',
  'script_observability_traces',
  'script_logpush',
  'script_tail_consumers',
  'tail_consumers',
  'assets',
  'migration_tag',
  'cache_enabled',
  'binding_record',
  'binding_duplicate',
  'binding_unexpected',
  'source_type',
  'source_value',
  'config_type',
  'config_value',
  'owner_type',
  'owner_value',
  'bearer_type',
  'hash_secret_type',
  'caller_type',
  'caller_namespace',
  'caller_simple',
  'colo_type',
  'colo_namespace',
  'colo_simple',
  'binding_names',
  'subdomain_enabled',
  'subdomain_previews',
  'content_status',
  'multipart_count',
  'multipart_name',
  'content_entrypoint',
  'content_type',
  'content_hash'
]);
const OWNERSHIP_FORMS = Object.freeze([
  'missing',
  'null',
  'wrong_type',
  'different_value',
  'additional_fields',
  'unavailable'
]);
const UNAVAILABLE = Symbol('unavailable');

function ownershipData(value, ...path) {
  try {
    for (const key of path) {
      if (value === null || value === undefined) return value;
      if (typeof value !== 'object') return UNAVAILABLE;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) return undefined;
      if (!Object.hasOwn(descriptor, 'value')) return UNAVAILABLE;
      value = descriptor.value;
    }
    return value;
  } catch {
    return UNAVAILABLE;
  }
}

function ownershipForm(read, expected) {
  try {
    const value = read();
    if (value === UNAVAILABLE) return 'unavailable';
    if (value === undefined) return 'missing';
    if (value === null) return 'null';
    if (
      expected !== undefined &&
      (typeof value !== typeof expected || Array.isArray(value) !== Array.isArray(expected))
    )
      return 'wrong_type';
    if (
      expected &&
      typeof expected === 'object' &&
      !Array.isArray(expected) &&
      Reflect.ownKeys(value).some(key => !Object.hasOwn(expected, key))
    )
      return 'additional_fields';
    return 'different_value';
  } catch {
    return 'unavailable';
  }
}

export function validateOwnershipCheck(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_response');
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes('gate') || !keys.includes('form')) fail('invalid_response');
    const gate = ownershipData(value, 'gate'),
      form = ownershipData(value, 'form');
    if (!OWNERSHIP_GATES.includes(gate) || !OWNERSHIP_FORMS.includes(form)) fail('invalid_response');
    return { gate, form };
  } catch {
    fail('invalid_response');
  }
}

const reasonOf = error => (REASONS.includes(error?.reason) ? error.reason : 'network');
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value =>
  JSON.stringify(value, (_, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry
  );
const same = (a, b) => canonical(a) === canonical(b);
const fail = reason => {
  throw Object.assign(new Error(reason), { reason });
};

function validateIdentity(identity) {
  if (
    !identity ||
    !same(Object.keys(identity).sort(), ['repository', 'runAttempt', 'runId', 'sourceSha', 'workflowPath'])
  )
    fail('auth');
  if (Object.values(identity).some(value => typeof value !== 'string')) fail('auth');
  if (
    identity.repository !== '0xMiden/wallet' ||
    identity.workflowPath !== WORKFLOW ||
    !/^[1-9][0-9]{0,17}$/.test(identity.runId) ||
    !/^[1-9][0-9]{0,5}$/.test(identity.runAttempt) ||
    !/^[a-f0-9]{40}$/.test(identity.sourceSha)
  )
    fail('auth');
}

export function validatePreflight(receipt) {
  if (!receipt || !same(Object.keys(receipt).sort(), ['deployment', 'identity', 'manifest', 'reason', 'stage']))
    fail('invalid_response');
  validateIdentity(receipt.identity);
  if (
    !PREFLIGHT_STAGES.includes(receipt.stage) ||
    !REASONS.includes(receipt.reason) ||
    !['absent', 'registered'].includes(receipt.manifest) ||
    !['not_attempted', 'attempted'].includes(receipt.deployment) ||
    (receipt.deployment === 'attempted' &&
      (receipt.manifest !== 'registered' || !['deployment', 'verification', 'exercise'].includes(receipt.stage))) ||
    (['deployment', 'verification', 'exercise'].includes(receipt.stage) && receipt.deployment !== 'attempted')
  )
    fail('invalid_response');
  return receipt;
}

function trustedContext(context) {
  if (!context || context.ref !== 'refs/heads/main' || context.eventName !== 'workflow_dispatch') return false;
  try {
    validateIdentity(contextIdentity(context));
    return true;
  } catch {
    return false;
  }
}

function contextIdentity(context) {
  return Object.fromEntries(
    ['repository', 'workflowPath', 'runId', 'runAttempt', 'sourceSha'].map(key => [key, context[key]])
  );
}

function validInventoryBinding(binding) {
  return (
    binding &&
    typeof binding.name === 'string' &&
    typeof binding.type === 'string' &&
    (binding.type !== 'ratelimit' ||
      (typeof binding.namespace_id === 'string' && /^[1-9][0-9]*$/.test(binding.namespace_id)))
  );
}

function configFor(manifest, markers = true) {
  return {
    name: manifest.scriptName,
    main: 'staging-probe.mjs',
    compatibility_date: '2026-01-01',
    workers_dev: true,
    preview_urls: false,
    routes: [],
    logpush: false,
    observability: { enabled: false, logs: { enabled: false, invocation_logs: false }, traces: { enabled: false } },
    vars: {
      PROBE_SOURCE: manifest.identity.sourceSha,
      ...(markers && { PROBE_CONFIG_SHA: manifest.configSha256, PROBE_OWNER: manifest.ownerMarker })
    },
    ratelimits: [
      { name: 'CALLER_PROBE', namespace_id: manifest.callerNamespaceId, simple: { limit: 4, period: 60 } },
      { name: 'COLO_PROBE', namespace_id: manifest.coloNamespaceId, simple: { limit: 4, period: 10 } }
    ]
  };
}

/** Build only deterministic, nonsecret resources; inventory must be complete before deployment. */
export function buildProbeManifest(identity, workerBytes, inventory) {
  validateIdentity(identity);
  if (!(workerBytes instanceof Uint8Array) || !workerBytes.length || !Array.isArray(inventory))
    fail('inventory_incomplete');
  const namespace = binding => (BigInt(`0x${hash(canonical({ identity, binding })).slice(0, 13)}`) + 1n).toString();
  const manifest = {
    schema: 1,
    identity: { ...identity },
    scriptName: `miden-elig-probe-${identity.runId}-${identity.runAttempt}`,
    workerSha256: hash(workerBytes),
    configSha256: '',
    ownerMarker: '',
    callerNamespaceId: namespace('CALLER_PROBE'),
    coloNamespaceId: namespace('COLO_PROBE'),
    limits: { ...LIMITS },
    deploymentState: 'prepared'
  };
  if (manifest.callerNamespaceId === manifest.coloNamespaceId) fail('ownership_mismatch');
  for (const script of inventory) {
    if (
      !script ||
      typeof script.id !== 'string' ||
      !Array.isArray(script.bindings) ||
      !script.bindings.every(validInventoryBinding)
    )
      fail('inventory_incomplete');
    if (
      script.id === manifest.scriptName ||
      script.bindings.some(
        binding =>
          binding.type === 'ratelimit' &&
          [manifest.callerNamespaceId, manifest.coloNamespaceId].includes(binding.namespace_id)
      )
    )
      fail('ownership_mismatch');
  }
  manifest.configSha256 = hash(canonical(configFor(manifest, false)));
  manifest.ownerMarker = hash(
    canonical({ identity, workerSha256: manifest.workerSha256, configSha256: manifest.configSha256 })
  );
  return manifest;
}

function emptyResult(reason = 'no_refusal') {
  return {
    support: 'unknown',
    caller: 'unknown',
    colo: 'unknown',
    cleanup: 'absent',
    counts: { requests: 0, allowed: 0, limited: 0, unavailable: 0 },
    reason
  };
}

async function jsonBody(response) {
  const bytes = await boundedBytes(response, 2 * 1024 * 1024);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail('invalid_response');
  }
}

async function boundedBytes(response, maximum) {
  if (!response.body) fail('invalid_response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) {
        await reader.cancel();
        fail('invalid_response');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/** Effects own authenticated transport, trusted source/provenance, clocks and private I/O. Import performs no work. */
export function createProbeController(effects) {
  const workerBytes = Buffer.from(effects.workerBytes);
  const api = async (path, method = 'GET', absentAllowed = false) => {
    let response;
    try {
      response = await effects.providerAPI(path, { method });
    } catch {
      fail('network');
    }
    if (response.status === 404 && absentAllowed) {
      const body = await jsonBody(response);
      if (body.success !== false || !Array.isArray(body.errors) || !body.errors.some(error => error.code === 10007))
        fail('invalid_response');
      return null;
    }
    if (response.status === 401 || response.status === 403) fail('auth');
    if (response.status === 429) fail('quota');
    if (!response.ok) fail('network');
    const body = await jsonBody(response);
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      body.success !== true ||
      !Array.isArray(body.errors) ||
      body.errors.length
    )
      fail('invalid_response');
    return body;
  };
  const authenticate = async () => {
    const accountId = effects.environment?.CLOUDFLARE_ACCOUNT_ID;
    const result = (await api('/account')).result;
    if (typeof accountId !== 'string' || !accountId || result?.id !== accountId) fail('auth');
  };
  const inventory = async expectedName => {
    const scripts = [];
    const seen = new Set();
    let totalPages = 1;
    let totalCount;
    for (let page = 1; page <= totalPages; page++) {
      const body = await api(`/workers/scripts?page=${page}&per_page=100`);
      if (!Array.isArray(body.result)) fail('inventory_incomplete');
      const info = body.result_info;
      if (info !== undefined) {
        if (
          info.page !== page ||
          info.per_page !== 100 ||
          !Number.isSafeInteger(info.total_pages) ||
          info.total_pages < 1 ||
          info.total_pages > 100 ||
          !Number.isSafeInteger(info.total_count) ||
          info.total_count < 0 ||
          info.count !== body.result.length ||
          (page > 1 && (totalPages !== info.total_pages || totalCount !== info.total_count))
        )
          fail('inventory_incomplete');
        totalPages = info.total_pages;
        totalCount = info.total_count;
      } else if (page !== 1) fail('inventory_incomplete');
      for (const script of body.result) {
        if (typeof script?.id !== 'string' || !/^[a-zA-Z0-9_-]{1,63}$/.test(script.id) || seen.has(script.id))
          fail('inventory_incomplete');
        if (script.id === expectedName) fail('ownership_mismatch');
        seen.add(script.id);
        const settings = (await api(`/workers/scripts/${script.id}/settings`)).result;
        if (!Array.isArray(settings?.bindings) || !settings.bindings.every(validInventoryBinding))
          fail('inventory_incomplete');
        scripts.push({ id: script.id, bindings: settings.bindings });
      }
    }
    if (totalCount !== undefined && scripts.length !== totalCount) fail('inventory_incomplete');
    return scripts;
  };
  const owned = async (manifest, onMismatch) => {
    const mismatch = (gate, read = () => UNAVAILABLE, expected) => {
      try {
        onMismatch?.({ gate, form: ownershipForm(read, expected) });
      } catch {}
      fail('ownership_mismatch');
    };
    const prefix = `/workers/scripts/${manifest.scriptName}`;
    const response = await api(`${prefix}/settings`, 'GET', true);
    if (response === null) return false;
    const settings = response.result;
    const config = configFor(manifest);
    const bindings = settings?.bindings;
    if (!Array.isArray(bindings)) mismatch('settings_bindings', () => ownershipData(settings, 'bindings'), []);
    if (bindings.length !== 7) mismatch('settings_binding_count', () => ownershipData(bindings, 'length'), 7);
    if (settings.compatibility_date !== config.compatibility_date)
      mismatch('compatibility_date', () => ownershipData(settings, 'compatibility_date'), config.compatibility_date);
    if ((settings.compatibility_flags?.length || 0) !== 0)
      mismatch('compatibility_flags', () => ownershipData(settings, 'compatibility_flags'), []);
    if (settings.logpush !== false) mismatch('logpush', () => ownershipData(settings, 'logpush'), false);
    const observationSwitches = [
      ['observability', ['observability', 'enabled']],
      ['observability_logs', ['observability', 'logs', 'enabled']],
      ['observability_invocations', ['observability', 'logs', 'invocation_logs']],
      ['observability_traces', ['observability', 'traces', 'enabled']]
    ];
    const checkSwitch = (source, path, gate, required) => {
      let value = source;
      for (const key of path) {
        if (value === undefined && !required) return;
        if (value === null || typeof value !== 'object' || Array.isArray(value))
          mismatch(gate, () => value, value === undefined || value === null ? false : {});
        value = ownershipData(value, key);
      }
      if (value !== false && (required || value !== undefined)) mismatch(gate, () => value, false);
    };
    for (const [gate, path] of observationSwitches) checkSwitch(settings, path, gate, false);
    if ((settings.tail_consumers?.length || 0) !== 0)
      mismatch('tail_consumers', () => ownershipData(settings, 'tail_consumers'), []);
    if (settings.assets) mismatch('assets', () => ownershipData(settings, 'assets'));
    if (settings.migration_tag) mismatch('migration_tag', () => ownershipData(settings, 'migration_tag'));
    if (settings.cache_options?.enabled)
      mismatch('cache_enabled', () => ownershipData(settings, 'cache_options', 'enabled'), false);
    const names = new Set();
    for (const binding of bindings) {
      if (!binding) mismatch('binding_record', () => binding, {});
      if (names.has(binding.name)) mismatch('binding_duplicate', () => ownershipData(binding, 'name'));
      names.add(binding.name);
      if (['PROBE_BEARER', 'PROBE_HASH_SECRET'].includes(binding.name)) {
        if (binding.type !== 'secret_text')
          mismatch(
            binding.name === 'PROBE_BEARER' ? 'bearer_type' : 'hash_secret_type',
            () => ownershipData(binding, 'type'),
            'secret_text'
          );
      } else if (Object.hasOwn(config.vars, binding.name)) {
        const gates = {
          PROBE_SOURCE: ['source_type', 'source_value'],
          PROBE_CONFIG_SHA: ['config_type', 'config_value'],
          PROBE_OWNER: ['owner_type', 'owner_value']
        }[binding.name];
        if (binding.type !== 'plain_text') mismatch(gates[0], () => ownershipData(binding, 'type'), 'plain_text');
        if (binding.text !== config.vars[binding.name])
          mismatch(gates[1], () => ownershipData(binding, 'text'), config.vars[binding.name]);
      } else {
        const expected = config.ratelimits.find(candidate => candidate.name === binding.name);
        if (!expected) mismatch('binding_unexpected', () => ownershipData(binding, 'name'));
        const gates =
          expected.name === 'CALLER_PROBE'
            ? ['caller_type', 'caller_namespace', 'caller_simple']
            : ['colo_type', 'colo_namespace', 'colo_simple'];
        if (binding.type !== 'ratelimit') mismatch(gates[0], () => ownershipData(binding, 'type'), 'ratelimit');
        if (binding.namespace_id !== expected.namespace_id)
          mismatch(gates[1], () => ownershipData(binding, 'namespace_id'), expected.namespace_id);
        if (!same(binding.simple, expected.simple))
          mismatch(gates[2], () => ownershipData(binding, 'simple'), expected.simple);
      }
    }
    if (
      !same([...names].sort(), [
        'CALLER_PROBE',
        'COLO_PROBE',
        'PROBE_BEARER',
        'PROBE_CONFIG_SHA',
        'PROBE_HASH_SECRET',
        'PROBE_OWNER',
        'PROBE_SOURCE'
      ])
    )
      mismatch('binding_names');
    const scriptSettings = (await api(`${prefix}/script-settings`)).result;
    for (const [gate, path] of observationSwitches) checkSwitch(scriptSettings, path, `script_${gate}`, true);
    if (scriptSettings.logpush !== undefined && scriptSettings.logpush !== false)
      mismatch('script_logpush', () => ownershipData(scriptSettings, 'logpush'), false);
    if (
      scriptSettings.tail_consumers !== undefined &&
      (!Array.isArray(scriptSettings.tail_consumers) || scriptSettings.tail_consumers.length !== 0)
    )
      mismatch('script_tail_consumers', () => ownershipData(scriptSettings, 'tail_consumers'), []);
    const subdomain = (await api(`${prefix}/subdomain`)).result;
    if (subdomain?.enabled !== true) mismatch('subdomain_enabled', () => ownershipData(subdomain, 'enabled'), true);
    if (subdomain.previews_enabled !== false)
      mismatch('subdomain_previews', () => ownershipData(subdomain, 'previews_enabled'), false);
    const content = await effects.providerAPI(`${prefix}/content/v2`, { method: 'GET' });
    if (!content.ok) mismatch('content_status');
    const bytes = await boundedBytes(content, 256 * 1024);
    let moduleBytes;
    if (content.headers.get('content-type')?.startsWith('multipart/form-data;')) {
      const form = await new Response(bytes, {
        headers: { 'content-type': content.headers.get('content-type') }
      }).formData();
      const parts = [...form.entries()];
      if (parts.length !== 1) mismatch('multipart_count', () => parts.length, 1);
      if (parts[0][0] !== 'staging-probe.mjs') mismatch('multipart_name');
      if (content.headers.get('cf-entrypoint') !== 'staging-probe.mjs') mismatch('content_entrypoint');
      moduleBytes =
        typeof parts[0][1] === 'string' ? Buffer.from(parts[0][1]) : Buffer.from(await parts[0][1].arrayBuffer());
    } else {
      if (!/^application\/(javascript|javascript\+module)(;|$)/.test(content.headers.get('content-type') || ''))
        mismatch('content_type');
      if (content.headers.get('cf-entrypoint') !== 'staging-probe.mjs') mismatch('content_entrypoint');
      moduleBytes = bytes;
    }
    if (hash(moduleBytes) !== manifest.workerSha256) mismatch('content_hash');
    return true;
  };
  const validManifest = async manifest => {
    if (!manifest || !STATES.includes(manifest.deploymentState)) fail('ownership_mismatch');
    const expected = buildProbeManifest(manifest.identity, workerBytes, []);
    expected.deploymentState = manifest.deploymentState;
    if (!same(manifest, expected) || !trustedContext(effects.context)) fail('ownership_mismatch');
    if (
      !same(manifest.identity, contextIdentity(effects.context)) &&
      (await effects.verifyRecovery?.(manifest.identity)) !== true
    )
      fail('ownership_mismatch');
  };
  const cleanup = async manifest => {
    let ownershipCheck;
    try {
      await validManifest(manifest);
      await authenticate();
      if (
        !(await owned(manifest, check => {
          ownershipCheck = check;
        }))
      )
        return { cleanup: 'absent', reason: 'complete' };
      await api(`/workers/scripts/${manifest.scriptName}`, 'DELETE');
      if ((await api(`/workers/scripts/${manifest.scriptName}/settings`, 'GET', true)) !== null) fail('cleanup_failed');
      return { cleanup: 'removed', reason: 'complete' };
    } catch (error) {
      return {
        cleanup: 'blocked',
        reason: error?.reason === 'ownership_mismatch' ? 'ownership_mismatch' : 'cleanup_failed',
        ...(ownershipCheck ? { ownershipCheck } : {})
      };
    }
  };
  const exercise = async (manifest, subdomain, bearer, result) => {
    const aborter = new AbortController();
    const deadline = effects.now() + LIMITS.durationMs;
    const cancel = () => aborter.abort();
    effects.signal?.addEventListener('abort', cancel, { once: true });
    if (effects.signal?.aborted) cancel();
    const timer = effects.setTimeout(cancel, LIMITS.durationMs);
    let lastStart = -Infinity;
    let location;
    try {
      for (const route of [
        '/health',
        '/health',
        ...Array(16).fill('/probe/caller'),
        ...Array(16).fill('/probe/colo')
      ]) {
        const pause = lastStart + START_INTERVAL_MS - effects.now();
        if (pause > 0) await effects.sleep(pause, aborter.signal);
        if (aborter.signal.aborted || effects.now() >= deadline || result.counts.requests >= LIMITS.requests)
          fail('bounds_reached');
        lastStart = effects.now();
        const invalidAuth = result.counts.requests === 1;
        result.counts.requests++;
        let response;
        try {
          response = await effects.fetch(`https://${manifest.scriptName}.${subdomain}.workers.dev${route}`, {
            method: 'GET',
            redirect: 'error',
            signal: aborter.signal,
            headers: { Authorization: `Bearer ${invalidAuth ? 'invalid-probe-bearer' : bearer}` }
          });
          if (aborter.signal.aborted || effects.now() >= deadline) fail('bounds_reached');
          const ray = response.headers.get('cf-ray');
          if (ray) {
            const colo = /^[a-f0-9]+-([A-Z]{3})$/i.exec(ray)?.[1]?.toUpperCase();
            if (!colo || (location && location !== colo)) fail('invalid_response');
            location = colo;
          }
          const body = await jsonBody(response);
          if (aborter.signal.aborted || effects.now() >= deadline) fail('bounds_reached');
          if (route === '/health') {
            if (
              invalidAuth
                ? response.status !== 403 || !same(body, { error: 'forbidden' })
                : response.status !== 200 || !same(body, { status: 'health_ok' })
            )
              fail('invalid_response');
          } else if (response.status === 200 && same(body, { result: 'stub_allowed' })) result.counts.allowed++;
          else if (response.status === 429 && same(body, { result: 'limited' })) {
            result.counts.limited++;
            result[route.endsWith('caller') ? 'caller' : 'colo'] = 'refused';
          } else {
            result.counts.unavailable++;
            fail(response.status === 403 || response.status === 401 ? 'auth' : 'invalid_response');
          }
        } catch (error) {
          if (aborter.signal.aborted) fail('bounds_reached');
          fail(reasonOf(error));
        }
      }
      if (result.caller === 'refused' && result.colo === 'refused') {
        result.support = 'supported';
        result.reason = 'complete';
      }
    } finally {
      aborter.abort();
      effects.clearTimeout(timer);
      effects.signal?.removeEventListener('abort', cancel);
    }
  };
  const run = async identity => {
    const result = emptyResult();
    let manifest;
    let directory;
    let attempted = false;
    let registered = false;
    let stage = 'identity';
    const save = async () => effects.privateFiles.write(join(directory, 'manifest.json'), canonical(manifest), 0o600);
    try {
      validateIdentity(identity);
      if (!trustedContext(effects.context) || !same(identity, contextIdentity(effects.context))) fail('auth');
      stage = 'authentication';
      await authenticate();
      stage = 'inventory';
      let resources;
      try {
        resources = await inventory(`miden-elig-probe-${identity.runId}-${identity.runAttempt}`);
      } catch (error) {
        fail(error?.reason === 'ownership_mismatch' ? 'ownership_mismatch' : 'inventory_incomplete');
      }
      manifest = buildProbeManifest(identity, workerBytes, resources);
      stage = 'absence';
      if ((await api(`/workers/scripts/${manifest.scriptName}/settings`, 'GET', true)) !== null)
        fail('ownership_mismatch');
      stage = 'subdomain';
      const subdomain = (await api('/workers/subdomain')).result?.subdomain;
      if (typeof subdomain !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain))
        fail('inventory_incomplete');
      if (effects.signal?.aborted) fail('bounds_reached');
      stage = 'preparation';
      directory = await effects.privateFiles.createDirectory(0o700);
      await save();
      registered = true;
      await effects.privateFiles.write(join(directory, 'staging-probe.mjs'), workerBytes, 0o600);
      await effects.privateFiles.write(join(directory, 'wrangler.json'), canonical(configFor(manifest)), 0o600);
      const bearer = effects.randomSecret();
      const hashSecret = effects.randomSecret();
      if (typeof bearer !== 'string' || !bearer || typeof hashSecret !== 'string' || !hashSecret) fail('auth');
      await effects.privateFiles.write(
        join(directory, 'secrets.json'),
        canonical({ PROBE_BEARER: bearer, PROBE_HASH_SECRET: hashSecret }),
        0o600
      );
      manifest.deploymentState = 'deploying';
      await save();
      stage = 'deployment';
      attempted = true;
      const env = Object.fromEntries(
        ['PATH', 'HOME', 'TMPDIR', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']
          .filter(key => typeof effects.environment?.[key] === 'string')
          .map(key => [key, effects.environment[key]])
      );
      env.CI = 'true';
      env.WRANGLER_SEND_METRICS = 'false';
      try {
        const deployment = await effects.deploy({
          command: 'npx',
          args: [
            '--yes',
            'wrangler@4.151.3',
            'deploy',
            '--no-bundle',
            '--config',
            join(directory, 'wrangler.json'),
            '--secrets-file',
            join(directory, 'secrets.json')
          ],
          cwd: directory,
          env,
          signal: effects.signal
        });
        if (deployment?.exitCode !== 0) fail('deploy_rejected');
      } catch (error) {
        manifest.deploymentState = 'uncertain';
        await save();
        await effects.privateFiles.write(
          join(directory, 'deploy-evidence.json'),
          canonical({
            httpStatus:
              Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599
                ? error.httpStatus
                : null,
            providerCode:
              Number.isSafeInteger(error?.providerCode) && error.providerCode >= 0 ? error.providerCode : null
          }),
          0o600
        );
        fail('deploy_rejected');
      }
      manifest.deploymentState = 'deployed';
      await save();
      stage = 'verification';
      if (!(await owned(manifest))) fail('ownership_mismatch');
      stage = 'exercise';
      await exercise(manifest, subdomain, bearer, result);
    } catch (error) {
      result.support = 'unknown';
      result.reason = reasonOf(error);
      if (trustedContext(effects.context) && same(identity, contextIdentity(effects.context)))
        result.preflight = validatePreflight({
          identity: { ...identity },
          stage,
          manifest: registered ? 'registered' : 'absent',
          deployment: attempted ? 'attempted' : 'not_attempted',
          reason: result.reason
        });
    } finally {
      if (directory) {
        if (attempted) {
          const outcome = await cleanup(manifest);
          result.cleanup = outcome.cleanup;
          if (outcome.ownershipCheck) result.ownershipCheck = outcome.ownershipCheck;
          manifest.deploymentState = outcome.cleanup === 'blocked' ? 'cleanup_blocked' : 'cleaned';
          if (outcome.cleanup === 'blocked') {
            result.support = 'unknown';
            result.reason = outcome.reason;
          }
          try {
            await save();
          } catch {
            result.support = 'unknown';
            result.cleanup = 'blocked';
            result.reason = 'cleanup_failed';
          }
        }
        for (const name of ['secrets.json', 'wrangler.json', 'deploy.stdout', 'deploy.stderr']) {
          try {
            await effects.privateFiles.remove(join(directory, name));
          } catch {
            result.support = 'unknown';
            result.reason = 'cleanup_failed';
          }
        }
      }
    }
    return result;
  };
  const inspect = async manifest => {
    let ownershipCheck;
    try {
      await validManifest(manifest);
      await authenticate();
      const present = await owned(manifest, check => {
        ownershipCheck = check;
      });
      return { inspection: present ? 'verified' : 'absent', reason: 'complete' };
    } catch (error) {
      return {
        inspection: 'blocked',
        reason: reasonOf(error),
        ...(ownershipCheck ? { ownershipCheck } : {})
      };
    }
  };
  return { run, cleanup, inspect };
}

export function createLocalProbeEffects(env) {
  const directory = join(env.RUNNER_TEMP, 'feature-eligibility-probe');
  const identity = {
    repository: env.GITHUB_REPOSITORY,
    workflowPath: env.GITHUB_WORKFLOW_REF?.split('@')[0]?.replace(`${env.GITHUB_REPOSITORY}/`, ''),
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    sourceSha: env.GITHUB_SHA
  };
  const request = (url, init) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) });
  return {
    context: { ...identity, ref: env.GITHUB_REF, eventName: env.GITHUB_EVENT_NAME },
    environment: env,
    workerBytes: undefined,
    now: () => performance.now(),
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        const done = () => {
          signal?.removeEventListener('abort', abort);
          resolve();
        };
        const timer = setTimeout(done, ms);
        const abort = () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      }),
    setTimeout,
    clearTimeout,
    randomSecret: () => randomBytes(32).toString('hex'),
    fetch,
    providerAPI: (path, init) => {
      if (!/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID || '')) fail('auth');
      const method = init?.method || 'GET';
      const account = path === '/account' && method === 'GET';
      const read =
        method === 'GET' &&
        (path === '/workers/subdomain' ||
          /^\/workers\/scripts\?page=[1-9][0-9]*&per_page=100$/.test(path) ||
          /^\/workers\/scripts\/[a-zA-Z0-9_-]{1,63}\/(settings|script-settings|subdomain|content\/v2)$/.test(path));
      const remove = method === 'DELETE' && /^\/workers\/scripts\/[a-zA-Z0-9_-]{1,63}$/.test(path);
      if (!account && !read && !remove) fail('auth');
      const endpoint = `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}${account ? '' : path}`;
      return request(`https://api.cloudflare.com/client/v4${endpoint}`, {
        ...init,
        headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }
      });
    },
    verifyRecovery: async () => false,
    privateFiles: {
      createDirectory: async mode => {
        await mkdir(directory, { mode });
        await chmod(directory, mode);
        return directory;
      },
      write: async (path, data, mode) => {
        await writeFile(path, data, { mode });
        await chmod(path, mode);
      },
      remove: async path => {
        try {
          await unlink(path);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    },
    deploy: spec =>
      new Promise((resolve, reject) => {
        if (spec.signal?.aborted) {
          reject(new DOMException('aborted', 'AbortError'));
          return;
        }
        const child = spawn(spec.command, spec.args, {
          cwd: spec.cwd,
          env: spec.env,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        const stdout = [];
        const stderr = [];
        let bytes = 0;
        let error;
        let killing;
        const terminate = () => {
          if (!child.pid || killing) return;
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {}
          killing = setTimeout(() => {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {}
          }, 5000);
        };
        const timer = setTimeout(terminate, 120000);
        spec.signal?.addEventListener('abort', terminate, { once: true });
        const collect = target => chunk => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) terminate();
          else target.push(chunk);
        };
        child.stdout.on('data', collect(stdout));
        child.stderr.on('data', collect(stderr));
        child.once('error', caught => {
          error = caught;
        });
        child.once('close', async code => {
          clearTimeout(timer);
          clearTimeout(killing);
          spec.signal?.removeEventListener('abort', terminate);
          try {
            await writeFile(join(directory, 'deploy.stdout'), Buffer.concat(stdout), { mode: 0o600 });
            await writeFile(join(directory, 'deploy.stderr'), Buffer.concat(stderr), { mode: 0o600 });
            if (error) reject(error);
            else resolve({ exitCode: killing ? null : code });
          } catch (caught) {
            reject(caught);
          }
        });
      })
  };
}

export async function main(args, env = process.env) {
  let result = emptyResult('auth');
  if (
    args.length !== 1 ||
    !['run', 'cleanup'].includes(args[0]) ||
    !env.RUNNER_TEMP ||
    !/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID || '') ||
    !env.CLOUDFLARE_API_TOKEN
  ) {
    if (args[0] === 'cleanup') return { ...result, cleanup: 'blocked' };
    if (env.RUNNER_TEMP && trustedContext(createLocalProbeEffects(env).context))
      result.preflight = validatePreflight({
        identity: contextIdentity(createLocalProbeEffects(env).context),
        stage: 'environment',
        manifest: 'absent',
        deployment: 'not_attempted',
        reason: 'auth'
      });
    return result;
  }
  const effects = createLocalProbeEffects(env);
  effects.workerBytes = await readFile(new URL('../services/feature-eligibility/staging-probe.mjs', import.meta.url));
  const aborter = new AbortController();
  const cancel = () => aborter.abort();
  effects.signal = aborter.signal;
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const controller = createProbeController(effects);
  try {
    if (args[0] === 'run') result = await controller.run(contextIdentity(effects.context));
    else {
      try {
        const manifest = JSON.parse(
          await readFile(join(env.RUNNER_TEMP, 'feature-eligibility-probe/manifest.json'), 'utf8')
        );
        const outcome = await controller.cleanup(manifest);
        result = {
          ...emptyResult(outcome.reason),
          cleanup: outcome.cleanup,
          ...(outcome.ownershipCheck ? { ownershipCheck: outcome.ownershipCheck } : {})
        };
      } catch {
        result = { ...emptyResult('cleanup_failed'), cleanup: 'blocked' };
      }
    }
    return result;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then(result => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode =
        result.support === 'supported' ||
        (process.argv[2] === 'cleanup' && result.cleanup !== 'blocked' && result.reason === 'complete')
          ? 0
          : 1;
    })
    .catch(() => {
      process.stdout.write(`${JSON.stringify(emptyResult('network'))}\n`);
      process.exitCode = 1;
    });
}
