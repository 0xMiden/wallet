import { buildTopologyManifest } from './staging-topology-manifest.mjs';
import { collectTopologyScriptInventory } from './staging-topology-namespaces.mjs';

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
    if (manifest === null) return null;
    return Object.freeze({ status: 'inventory_observed', manifest, deploymentAuthorized: false });
  } catch {
    return null;
  }
}
