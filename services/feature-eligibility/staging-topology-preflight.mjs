import { buildTopologyManifest, verifyTopologyManifest } from './staging-topology-manifest.mjs';
import {
  collectTopologyScriptInventory,
  observeTopologyNamespaceAbsence,
  observeTopologyRelationships
} from './staging-topology-namespaces.mjs';

// These independent reads are non-atomic and cannot authorize deployment or cleanup.
export async function observeTopologyOwnership({ api, accountId, manifest, options } = {}) {
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
      const content = await api(`${base}/content/v2`);
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
      const observation = script?.result?.observability;
      if (
        script?.success !== true ||
        !Array.isArray(script.errors) ||
        script.errors.length ||
        script.result?.logpush !== false ||
        !Array.isArray(script.result.tail_consumers) ||
        script.result.tail_consumers.length ||
        observation?.enabled !== false ||
        observation.logs?.enabled !== false ||
        observation.logs?.invocation_logs !== false ||
        observation.logs?.persist !== false ||
        observation.traces?.enabled !== false ||
        observation.traces?.persist !== false ||
        observation.issues?.enabled !== false ||
        content?.sha256 !== expected.bundleSha256
      )
        return null;
      return { settings, script, content };
    };
    if (!(await checkAccount())) return null;
    const first = await readTarget();
    if (!first) return null;
    const relationships = await observeTopologyRelationships(api, {
      script: expected.scriptName,
      classes: expected.config.durable_objects.bindings.map(item => item.class_name)
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
