export function buildProbeManifest(identity) {
  return {
    schema: 1,
    identity,
    scriptName: 'inactive-probe',
    workerSha256: '0'.repeat(64),
    configSha256: '0'.repeat(64),
    ownerMarker: '0'.repeat(64),
    callerNamespaceId: '1',
    coloNamespaceId: '2',
    limits: { requests: 120, concurrency: 4, startsPerSecond: 8, durationMs: 60000 },
    deploymentState: 'prepared'
  };
}

export function createProbeController() {
  return {
    async run() {
      return {
        support: 'unknown', caller: 'unknown', colo: 'unknown', cleanup: 'absent',
        counts: { requests: 0, allowed: 0, limited: 0, unavailable: 0 }, reason: 'no_refusal'
      };
    },
    async cleanup() { return { cleanup: 'blocked', reason: 'ownership_mismatch' }; }
  };
}
