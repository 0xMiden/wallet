import { createHash } from 'node:crypto';

const classes = ['TopologyControl', 'EligibilityGuard', 'CallerEligibilityGuard', 'RestartProof'];
const digest = value => createHash('sha256').update(value).digest('hex');
const encode = value => JSON.stringify(value);
const dataRecord = (value, keys) => {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    return null;
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
    result[key] = descriptor.value;
  }
  return result;
};
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

// This builds a local identity only. It neither proves inventory completeness nor authorizes a deployment.
export function buildTopologyManifest(options = {}) {
  try {
    const input = dataRecord(options, ['identity', 'bundle', 'now', 'expiresAt', 'maxRuns', 'inventory']);
    if (input === null) return null;
    const { bundle, now, expiresAt, maxRuns, inventory } = input;
    const identity = dataRecord(input.identity, ['repository', 'runAttempt', 'runId', 'sourceSha', 'workflowPath']);
    if (
      !identity ||
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
    const lengthDescriptor = Object.getOwnPropertyDescriptor(inventory, 'length');
    const inventoryLength =
      lengthDescriptor && Object.hasOwn(lengthDescriptor, 'value') ? lengthDescriptor.value : null;
    if (!Number.isSafeInteger(inventoryLength) || inventoryLength < 0 || inventoryLength > 10000) return null;
    for (let index = 0; index < inventoryLength; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(inventory, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
      const item = dataRecord(descriptor.value, ['id']);
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

// Verification checks data identity only; it does not establish current provider ownership.
export function verifyTopologyManifest(manifest, options) {
  try {
    const expected = buildTopologyManifest(options);
    if (expected === null) return false;
    const same = (actual, reference) => {
      if (reference === null || typeof reference !== 'object') return Object.is(actual, reference);
      if (!actual || typeof actual !== 'object' || Array.isArray(actual) !== Array.isArray(reference)) return false;
      const prototype = Object.getPrototypeOf(actual);
      if (Array.isArray(reference) ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype))
        return false;
      const actualKeys = Reflect.ownKeys(actual);
      const expectedKeys = Reflect.ownKeys(reference);
      if (actualKeys.length !== expectedKeys.length || actualKeys.some(key => !expectedKeys.includes(key)))
        return false;
      for (const key of expectedKeys) {
        const descriptor = Object.getOwnPropertyDescriptor(actual, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !same(descriptor.value, reference[key])) return false;
      }
      return true;
    };
    return same(manifest, expected);
  } catch {
    return false;
  }
}
