import { createHash } from 'node:crypto';

const classes = ['TopologyControl', 'EligibilityGuard', 'CallerEligibilityGuard', 'RestartProof'];
const digest = value => createHash('sha256').update(value).digest('hex');
const encode = value => JSON.stringify(value);
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

// This builds a local identity only. It neither proves inventory completeness nor authorizes a deployment.
export function buildTopologyManifest({ identity, bundle, now, expiresAt, maxRuns, inventory } = {}) {
  try {
    if (
      !identity ||
      Object.keys(identity).sort().join(',') !== 'repository,runAttempt,runId,sourceSha,workflowPath' ||
      identity.repository !== '0xMiden/wallet' ||
      identity.workflowPath !== '.github/workflows/feature-eligibility-topology.yml' ||
      typeof identity.runId !== 'string' ||
      !/^[1-9][0-9]{0,17}$/.test(identity.runId) ||
      typeof identity.runAttempt !== 'string' ||
      !/^[1-9][0-9]{0,5}$/.test(identity.runAttempt) ||
      typeof identity.sourceSha !== 'string' ||
      !/^[a-f0-9]{40}$/.test(identity.sourceSha) ||
      !(bundle instanceof Uint8Array) ||
      bundle.length < 1 ||
      bundle.length > 10_000_000 ||
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now ||
      expiresAt > now + 900_000 ||
      !Number.isSafeInteger(maxRuns) ||
      maxRuns < 1 ||
      maxRuns > 20 ||
      !Array.isArray(inventory)
    )
      return null;
    const scriptName = `miden-elig-topology-${identity.runId}-${identity.runAttempt}`;
    const seen = new Set();
    for (const item of inventory) {
      if (
        !item ||
        typeof item.id !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,63}$/.test(item.id) ||
        seen.has(item.id) ||
        item.id === scriptName
      )
        return null;
      seen.add(item.id);
    }
    const identityCopy = Object.fromEntries(
      ['repository', 'runAttempt', 'runId', 'sourceSha', 'workflowPath'].map(key => [key, identity[key]])
    );
    const config = {
      name: scriptName,
      main: 'staging-topology-worker.mjs',
      compatibility_date: '2026-10-20',
      workers_dev: true,
      preview_urls: false,
      routes: [],
      logpush: false,
      observability: { enabled: false, logs: { enabled: false, invocation_logs: false }, traces: { enabled: false } },
      vars: {
        TOPOLOGY_RUN_UNTIL: String(expiresAt),
        TOPOLOGY_RUN_MAX: String(maxRuns),
        TOPOLOGY_SOURCE: identity.sourceSha
      },
      durable_objects: {
        bindings: classes.map(name => ({
          name:
            name === 'TopologyControl'
              ? 'TOPOLOGY_CONTROL'
              : name === 'RestartProof'
                ? 'RESTART_PROOF'
                : name === 'EligibilityGuard'
                  ? 'ELIGIBILITY_GUARD'
                  : 'CALLER_GUARD',
          class_name: name
        }))
      },
      migrations: [{ tag: 'v1', new_sqlite_classes: classes }]
    };
    const bundleSha256 = digest(bundle);
    const configSha256 = digest(encode(config));
    const ownerMarker = digest(encode({ identity: identityCopy, bundleSha256, configSha256 }));
    return freeze({
      schema: 1,
      identity: identityCopy,
      scriptName,
      bundleSha256,
      configSha256,
      ownerMarker,
      expiresAt,
      maxRuns,
      config
    });
  } catch {
    return null;
  }
}
