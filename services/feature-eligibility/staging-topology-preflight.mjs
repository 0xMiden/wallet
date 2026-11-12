import { buildTopologyManifest, verifyTopologyManifest } from './staging-topology-manifest.mjs';
import {
  collectTopologyScriptInventory,
  collectTopologySettings,
  observeTopologyNamespaceAbsence,
  observeTopologyRelationships
} from './staging-topology-namespaces.mjs';

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

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
  const logpushMismatch = mismatch(result, 'logpush', false, 'script_logpush');
  if (logpushMismatch) return logpushMismatch;
  if (!Object.hasOwn(result, 'tail_consumers')) return { gate: 'script_tail_consumers', form: 'missing' };
  if (!Array.isArray(result.tail_consumers)) return { gate: 'script_tail_consumers', form: 'unexpected_type' };
  if (result.tail_consumers.length) return { gate: 'script_tail_consumers', form: 'different_value' };
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

// These independent reads are non-atomic and cannot authorize deployment or cleanup.
export async function observeTopologyOwnership({ api, accountId, manifest, options, onMismatch } = {}) {
  try {
    if (typeof api !== 'function' || !/^[a-f0-9]{32}$/.test(accountId) || !verifyTopologyManifest(manifest, options))
      return null;
    const expected = buildTopologyManifest(options);
    if (!expected) return null;
    const checkAccount = async () => {
      const value = await api('/account');
      return (
        value?.success === true &&
        Array.isArray(value.errors) &&
        value.errors.length === 0 &&
        value.result?.id === accountId
      );
    };
    const readTarget = async () => {
      const base = `/workers/scripts/${expected.scriptName}`;
      const settings = await api(`${base}/settings`);
      const script = await api(`${base}/script-settings`);
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
      if (scriptMismatch) {
        if (typeof onMismatch === 'function') onMismatch(scriptMismatch);
        return null;
      }
      const content = await api(`${base}/content/v2`);
      if (content?.sha256 !== expected.bundleSha256) return null;
      return { settings, script, content };
    };
    if (!(await checkAccount())) return null;
    const first = await readTarget();
    if (!first) return null;
    const relationships = await observeTopologyRelationships(api, {
      script: expected.scriptName,
      classes: expected.config.durable_objects.bindings.map(item => item.class_name),
      rateNamespaceIds: expected.config.ratelimits.map(item => item.namespace_id)
    });
    if (relationships?.status !== 'observed') return null;
    const second = await readTarget();
    if (!second || JSON.stringify(first) !== JSON.stringify(second) || !(await checkAccount())) return null;
    return Object.freeze({ status: 'observed', deploymentAuthorized: false, cleanupAuthorized: false });
  } catch {
    return null;
  }
}

// Read-only preparation is not atomic and is never deployment or cleanup authorization.
export async function prepareTopologyInventory({ api, accountId, identity, bundle, now, expiresAt, maxRuns } = {}) {
  try {
    if (typeof api !== 'function' || typeof accountId !== 'string' || !/^[a-f0-9]{32}$/.test(accountId)) return null;
    const account = await api('/account');
    if (
      account?.success !== true ||
      !Array.isArray(account.errors) ||
      account.errors.length ||
      account.result?.id !== accountId
    )
      return null;
    const scripts = await collectTopologyScriptInventory(api);
    if (scripts === null) return null;
    const manifest = buildTopologyManifest({
      identity,
      bundle,
      now,
      expiresAt,
      maxRuns,
      inventory: scripts.map(id => ({ id }))
    });
    if (manifest === null || !(await observeTopologyNamespaceAbsence(api, manifest.scriptName))) return null;
    const settings = await collectTopologySettings(api, scripts);
    if (settings === null) return null;
    const rateIds = new Set(manifest.config.ratelimits.map(rate => rate.namespace_id));
    if (
      settings.some(script =>
        script.bindings.some(binding => binding.type === 'ratelimit' && rateIds.has(binding.namespace_id))
      )
    )
      return null;
    const finalScripts = await collectTopologyScriptInventory(api);
    if (!finalScripts || JSON.stringify(finalScripts) !== JSON.stringify(scripts)) return null;
    const target = await api(`/workers/scripts/${manifest.scriptName}/settings`);
    if (
      target?.status !== 404 ||
      target.body?.success !== false ||
      !Array.isArray(target.body.errors) ||
      target.body.errors.length !== 1 ||
      target.body.errors[0]?.code !== 10007
    )
      return null;
    return Object.freeze({ status: 'inventory_observed', manifest, deploymentAuthorized: false });
  } catch {
    return null;
  }
}
