import { buildTopologyManifest, verifyTopologyManifest } from './staging-topology-manifest.mjs';
import {
  isTopologyTargetScript,
  parseWorkerSubdomainSettings,
  parseWorkersSubdomain
} from './staging-topology-api.mjs';
import {
  collectTopologyScriptInventory,
  collectTopologySettings,
  observeTopologyNamespaceAbsence,
  observeTopologyRelationships
} from './staging-topology-namespaces.mjs';

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const MAX_PROVIDER_READS = 500;
export const MAX_PHASE_READS = 250;
export const PROVIDER_DEADLINE_MS = 120_000;
export const PROVIDER_READ_TIMEOUT_MS = 5_000;

function mismatch(record, key, expected, gate) {
  if (!isRecord(record)) return { gate, form: record === null ? 'null' : 'unexpected_type' };
  if (!Object.hasOwn(record, key)) return { gate, form: 'missing' };
  const value = record[key];
  if (value === null) return { gate, form: 'null' };
  if (value !== expected)
    return { gate, form: typeof value === typeof expected ? 'different_value' : 'unexpected_type' };
  return null;
}

export function topologyScriptSettingsMismatch(script) {
  if (
    !isRecord(script) ||
    script.success !== true ||
    !Array.isArray(script.errors) ||
    script.errors.length ||
    !isRecord(script.result)
  )
    return { gate: 'script_settings_response', form: 'unavailable' };

  const { result } = script;
  if (!Object.hasOwn(result, 'tail_consumers')) return { gate: 'script_tail_consumers', form: 'missing' };
  if (!Array.isArray(result.tail_consumers)) return { gate: 'script_tail_consumers', form: 'unexpected_type' };
  if (result.tail_consumers.length) return { gate: 'script_tail_consumers', form: 'different_value' };
  const logpushMismatch = mismatch(result, 'logpush', false, 'script_logpush');
  if (logpushMismatch) return logpushMismatch;
  if (!Object.hasOwn(result, 'observability')) return { gate: 'script_observability', form: 'missing' };
  if (result.observability === null) return { gate: 'script_observability', form: 'null' };
  if (!isRecord(result.observability)) return { gate: 'script_observability', form: 'unexpected_type' };

  const observation = result.observability;
  const enabledMismatch = mismatch(observation, 'enabled', false, 'script_observability');
  if (enabledMismatch) return enabledMismatch;
  for (const [group, keys] of [
    ['logs', ['enabled', 'invocation_logs', 'persist']],
    ['traces', ['enabled', 'persist']],
    ['issues', ['enabled']]
  ]) {
    const value = observation[group];
    if (!Object.hasOwn(observation, group)) return { gate: `script_observability_${group}`, form: 'missing' };
    if (!isRecord(value))
      return { gate: `script_observability_${group}`, form: value === null ? 'null' : 'unexpected_type' };
    for (const key of keys) {
      const issue = mismatch(value, key, false, `script_observability_${group}`);
      if (issue) return issue;
    }
  }
  return null;
}

export function formatTopologyProviderReads({ preflight, cleanup, now: rawNow, preflightStartedAt, cleanupStartedAt }) {
  const now = Math.max(rawNow, preflightStartedAt, cleanupStartedAt ?? preflightStartedAt);
  return Object.freeze({
    preflight,
    cleanup,
    total: preflight + cleanup,
    elapsedMs: now - preflightStartedAt,
    preflightStartedAt,
    preflightDeadlineAt: preflightStartedAt + PROVIDER_DEADLINE_MS,
    cleanupStartedAt: cleanupStartedAt ?? null,
    cleanupDeadlineAt: cleanupStartedAt === undefined ? null : cleanupStartedAt + PROVIDER_DEADLINE_MS,
    preflightElapsedMs: now - preflightStartedAt,
    cleanupElapsedMs: cleanupStartedAt === undefined ? null : now - cleanupStartedAt
  });
}

export function createTopologyApiBudget(
  api,
  {
    now = () => performance.now(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    startedAt,
    cleanupStartedAt,
    initialCalls = { preflight: 0, cleanup: 0 },
    onRequest
  } = {}
) {
  if (typeof api !== 'function' || typeof now !== 'function' || (onRequest !== undefined && typeof onRequest !== 'function'))
    throw new TypeError('invalid provider API');
  const starts = { preflight: startedAt ?? now(), cleanup: cleanupStartedAt };
  const preflight = Object.getOwnPropertyDescriptor(initialCalls, 'preflight');
  const cleanup = Object.getOwnPropertyDescriptor(initialCalls, 'cleanup');
  if (
    !Number.isFinite(starts.preflight) ||
    (starts.cleanup !== undefined && !Number.isFinite(starts.cleanup)) ||
    !isRecord(initialCalls) ||
    Reflect.ownKeys(initialCalls).length !== 2 ||
    !preflight || !Object.hasOwn(preflight, 'value') ||
    !cleanup || !Object.hasOwn(cleanup, 'value') ||
    !Number.isSafeInteger(preflight.value) ||
    preflight.value < 0 ||
    preflight.value > MAX_PHASE_READS ||
    !Number.isSafeInteger(cleanup.value) ||
    cleanup.value < 0 ||
    cleanup.value > MAX_PHASE_READS ||
    preflight.value + cleanup.value > MAX_PROVIDER_READS
  )
    throw new TypeError('invalid provider budget state');
  const calls = { preflight: preflight.value, cleanup: cleanup.value };
  let lastNow = starts.preflight;
  const readNow = floor => {
    const value = now();
    if (!Number.isFinite(value)) return value;
    if (value > lastNow) lastNow = value;
    return Math.max(lastNow, floor);
  };
  const stats = () =>
    formatTopologyProviderReads({
      ...calls,
      now: readNow(Math.max(starts.preflight, starts.cleanup ?? starts.preflight)),
      preflightStartedAt: starts.preflight,
      cleanupStartedAt: starts.cleanup
    });
  const request = phase => async path => {
    if (calls[phase] >= MAX_PHASE_READS || calls.preflight + calls.cleanup >= MAX_PROVIDER_READS)
      throw new Error('provider read budget exhausted');
    const floor = () => Math.max(starts.preflight, starts[phase] ?? starts.preflight);
    if (starts[phase] === undefined) starts[phase] = readNow(floor());
    let remaining = starts[phase] + PROVIDER_DEADLINE_MS - readNow(floor());
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('provider read deadline exhausted');
    calls[phase]++;
    if (onRequest) await onRequest(stats());
    remaining = starts[phase] + PROVIDER_DEADLINE_MS - readNow(floor());
    if (!Number.isFinite(remaining) || remaining <= 0) {
      calls[phase]--;
      if (onRequest) await onRequest(stats());
      throw new Error('provider read deadline exhausted');
    }
    const controller = new AbortController();
    const timeoutMs = Math.min(PROVIDER_READ_TIMEOUT_MS, remaining);
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => api(path, { signal: controller.signal, phase })),
        new Promise((_, reject) => {
          timer = setTimeoutFn(() => {
            controller.abort();
            reject(new Error('provider read deadline exceeded'));
          }, timeoutMs);
        })
      ]);
    } finally {
      clearTimeoutFn(timer);
    }
  };
  return Object.freeze({
    preflight: request('preflight'),
    cleanup: request('cleanup'),
    stats
  });
}

async function checkTopologyOwnership({
  api,
  accountId,
  manifest,
  options,
  onMismatch,
  allowPrivacyMismatchForCleanup = false
} = {}) {
  if (typeof api !== 'function' || !/^[a-f0-9]{32}$/.test(accountId) || !verifyTopologyManifest(manifest, options))
    return null;
  const expected = buildTopologyManifest(options);
  if (!expected) return null;
  const phase = allowPrivacyMismatchForCleanup ? 'cleanup' : 'preflight';
  let readFailure;
  const read = async path => {
    try {
      return await api(path, { phase });
    } catch (error) {
      readFailure ??= { error };
      throw error;
    }
  };
  const checkAccount = async () => {
    const value = await read('/account');
    return (
      value?.success === true &&
      Array.isArray(value.errors) &&
      value.errors.length === 0 &&
      value.result?.id === accountId
    );
  };
  if (!(await checkAccount())) return null;
  const first = await readOwnershipTarget({ read, expected, allowPrivacyMismatchForCleanup, onMismatch });
  if (!first) return null;
  const relationships = await observeTopologyRelationships(read, {
    script: expected.scriptName,
    classes: expected.config.durable_objects.bindings.map(item => item.class_name),
    rateNamespaceIds: expected.config.ratelimits.map(item => item.namespace_id)
  });
  if (readFailure) throw readFailure.error;
  if (relationships?.status !== 'observed') return null;
  const second = await readOwnershipTarget({ read, expected, allowPrivacyMismatchForCleanup, onMismatch });
  if (!second || JSON.stringify(first) !== JSON.stringify(second) || !(await checkAccount())) return null;
  return true;
}

async function readOwnershipTarget({ read, expected, allowPrivacyMismatchForCleanup, onMismatch }) {
  const base = `/workers/scripts/${expected.scriptName}`;
  const settings = await read(`${base}/settings`);
  const script = await read(`${base}/script-settings`);
  const bindings = settings?.result?.bindings;
  if (
    settings?.success !== true ||
    !Array.isArray(settings.errors) ||
    settings.errors.length ||
    !Array.isArray(bindings)
  )
    return null;
  const named = new Map(bindings.map(binding => [binding.name, binding]));
  if (
    named.size !== bindings.length ||
    named.size !==
      Object.keys(expected.config.vars).length +
        expected.config.durable_objects.bindings.length +
        expected.config.ratelimits.length +
        1
  )
    return null;
  for (const [name, text] of Object.entries(expected.config.vars)) {
    if (named.get(name)?.type !== 'plain_text' || named.get(name)?.text !== text) return null;
  }
  if (named.get('TOPOLOGY_BEARER')?.type !== 'secret_text') return null;
  for (const rate of expected.config.ratelimits) {
    const actual = named.get(rate.name);
    if (
      actual?.type !== 'ratelimit' ||
      actual.namespace_id !== rate.namespace_id ||
      actual.simple?.limit !== rate.simple.limit ||
      actual.simple?.period !== rate.simple.period
    )
      return null;
  }
  for (const binding of expected.config.durable_objects.bindings) {
    if (
      named.get(binding.name)?.type !== 'durable_object_namespace' ||
      named.get(binding.name)?.class_name !== binding.class_name
    )
      return null;
  }
  const scriptMismatch = topologyScriptSettingsMismatch(script);
  const privacyMismatch =
    scriptMismatch &&
    (scriptMismatch.gate === 'script_logpush' || scriptMismatch.gate.startsWith('script_observability'));
  if (scriptMismatch && !(allowPrivacyMismatchForCleanup && privacyMismatch)) {
    if (typeof onMismatch === 'function') onMismatch(scriptMismatch);
    return null;
  }
  const content = await read(`${base}/content/v2`);
  if (content?.sha256 !== expected.bundleSha256) return null;
  return { settings, script, content };
}

// These independent reads are evidence only; cleanup repeats the checks inside its mutation path.
export async function observeTopologyOwnership({ api, accountId, manifest, options, onMismatch } = {}) {
  try {
    if (!(await checkTopologyOwnership({ api, accountId, manifest, options, onMismatch }))) return null;
    return Object.freeze({ status: 'observed', deploymentAuthorized: false, cleanupAuthorized: false });
  } catch {
    return null;
  }
}

export async function observeTopologyWorkerUrl({ api, scriptName } = {}) {
  try {
    if (typeof api !== 'function' || !isTopologyTargetScript(scriptName)) return null;
    const read = path => api(path, { phase: 'preflight' });
    const routePath = `/workers/scripts/${scriptName}/subdomain`;
    const accountSubdomain = parseWorkersSubdomain(await read('/workers/subdomain'), { strictKeys: true });
    const route = parseWorkerSubdomainSettings(await read(routePath), { strictKeys: true });
    if (!accountSubdomain || route?.enabled !== true || route.previews_enabled !== false) return null;
    if (parseWorkersSubdomain(await read('/workers/subdomain'), { strictKeys: true }) !== accountSubdomain) return null;
    const repeatedRoute = parseWorkerSubdomainSettings(await read(routePath), { strictKeys: true });
    if (JSON.stringify(repeatedRoute) !== JSON.stringify(route)) return null;
    return Object.freeze({
      status: 'observed',
      url: `https://${scriptName}.${accountSubdomain}.workers.dev`
    });
  } catch {
    return null;
  }
}

export function isTargetAbsent(value) {
  const body = value?.body;
  const errors = body?.errors;
  return (
    value?.status === 404 &&
    body?.success === false &&
    Array.isArray(errors) &&
    errors.length === 1 &&
    errors[0]?.code === 10007 &&
    Reflect.ownKeys(body).length === 2 &&
    Reflect.ownKeys(errors[0]).length === 1
  );
}

export async function cleanupTopologyWorker({ api, deleteScript, accountId, manifest, options, onMismatch } = {}) {
  try {
    if (
      typeof api !== 'function' ||
      typeof deleteScript !== 'function' ||
      !/^[a-f0-9]{32}$/.test(accountId) ||
      !verifyTopologyManifest(manifest, options)
    )
      return { cleanup: 'blocked', reason: 'ownership_mismatch' };
    const expected = buildTopologyManifest(options);
    const path = `/workers/scripts/${expected.scriptName}/settings`;
    const read = path => api(path, { phase: 'cleanup' });
    const before = await read(path);
    if (isTargetAbsent(before)) return { cleanup: 'absent', reason: 'complete' };
    if (before?.success !== true || !Array.isArray(before.errors) || before.errors.length)
      return { cleanup: 'blocked', reason: 'ownership_mismatch' };
    let ownershipDiagnostic;
    const owned = await checkTopologyOwnership({
      api: read,
      accountId,
      manifest,
      options,
      onMismatch: value => {
        ownershipDiagnostic = { gate: value.gate, form: value.form };
        if (typeof onMismatch === 'function') onMismatch(ownershipDiagnostic);
      },
      allowPrivacyMismatchForCleanup: true
    });
    if (!owned)
      return {
        cleanup: 'blocked',
        reason: 'ownership_mismatch',
        ...(ownershipDiagnostic ? { ownershipDiagnostic } : {})
      };
    if ((await deleteScript(expected.scriptName)) !== true) return { cleanup: 'blocked', reason: 'cleanup_failed' };
    if (!isTargetAbsent(await read(path))) return { cleanup: 'blocked', reason: 'cleanup_failed' };
    return { cleanup: 'removed', reason: 'complete' };
  } catch {
    return { cleanup: 'blocked', reason: 'cleanup_failed' };
  }
}

// Read-only preparation is not atomic and is never deployment or cleanup authorization.
export async function prepareTopologyInventory({ api, accountId, identity, bundle, now, expiresAt, maxRuns } = {}) {
  try {
    if (typeof api !== 'function' || typeof accountId !== 'string' || !/^[a-f0-9]{32}$/.test(accountId)) return null;
    const read = path => api(path, { phase: 'preflight' });
    const account = await read('/account');
    if (
      account?.success !== true ||
      !Array.isArray(account.errors) ||
      account.errors.length ||
      account.result?.id !== accountId
    )
      return null;
    const subdomain = parseWorkersSubdomain(await read('/workers/subdomain'), { strictKeys: true });
    if (!subdomain) return null;
    const scripts = await collectTopologyScriptInventory(read);
    if (scripts === null) return null;
    const manifest = buildTopologyManifest({
      identity,
      bundle,
      now,
      expiresAt,
      maxRuns,
      inventory: scripts.map(id => ({ id }))
    });
    if (manifest === null || !(await observeTopologyNamespaceAbsence(read, manifest.scriptName))) return null;
    const settings = await collectTopologySettings(read, scripts);
    if (settings === null) return null;
    const rateIds = new Set(manifest.config.ratelimits.map(rate => rate.namespace_id));
    if (
      settings.some(script =>
        script.bindings.some(binding => binding.type === 'ratelimit' && rateIds.has(binding.namespace_id))
      )
    )
      return null;
    const finalScripts = await collectTopologyScriptInventory(read);
    if (!finalScripts || JSON.stringify(finalScripts) !== JSON.stringify(scripts)) return null;
    const target = await read(`/workers/scripts/${manifest.scriptName}/settings`);
    if (!isTargetAbsent(target)) return null;
    return Object.freeze({
      status: 'inventory_observed',
      manifest,
      workersDevUrl: `https://${manifest.scriptName}.${subdomain}.workers.dev`,
      deploymentAuthorized: false
    });
  } catch {
    return null;
  }
}
