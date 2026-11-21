import { isDeepStrictEqual } from 'node:util';

export function hasUnchangedNearReturnAuthority(original, retained) {
  if (original?.phase !== 'reverse-authorized' || retained?.phase !== 'recovery-required' ||
      !(Date.parse(retained.updatedAt) > Date.parse(original.updatedAt))) return false;
  const { phase: _originalPhase, updatedAt: _originalTime, ...before } = original;
  const { phase: _retainedPhase, updatedAt: _retainedTime, ...after } = retained;
  return isDeepStrictEqual(before, after);
}

export function matchesNearRetentionSteps(jobs) {
  if (!Array.isArray(jobs?.jobs)) return false;
  const roundTrips = jobs.jobs.filter(job => job?.name === 'Chrome mainnet round trip');
  if (roundTrips.length !== 1 || !Array.isArray(roundTrips[0].steps)) return false;
  const steps = roundTrips[0].steps;
  const results = name => steps.filter(step => step?.name === name).map(step => step.conclusion);
  const authorization = results('Authorize original NEAR reverse');
  return authorization.length === 1 && authorization[0] === 'failure' && [
    'Upload mainnet near signed EVM 1',
    'Upload mainnet near native return claim',
    'Prepare mainnet solver swap'
  ].every(name => {
    const found = results(name);
    return found.length > 0 && found.every(result => result === 'skipped');
  });
}

// This scheduled run retained the original grant, changing only phase and updatedAt.
export function matchesRetainedNearReturn(evidence) {
  return evidence?.runId === 44871541172 &&
    evidence.artifactId === 14694460888 &&
    evidence.archiveDigest === 'sha256:55e22c8a7fb31e77b345848714fdd7264a8bc2d68f4a863ed73884846f18f738' &&
    evidence.checkpointDigest === 'd3f5e34cfe19c980f173972e8e28763e4a59bd6040cfee84df5acf307f615fda' &&
    evidence.originalDigest === 'fe8dcc6aaae3df3c6c5a9d8a32b465a3d200ca981510eef346ebff237b685d28';
}

// Identifies a historical CI result only; does not establish on-chain absence or authorize spending.
export function matchesExpiredNearReturnProvenance({ run, jobs, artifacts } = {}) {
  const id = 44844609625;
  if (run?.id !== id || run.repository?.id !== 853430876 || run.workflow_id !== 391951744 ||
      run.head_sha !== '71287e0742a62e29a5bc06c4f398eee8978336ab' || run.head_branch !== 'main' ||
      run.event !== 'workflow_dispatch' || run.run_attempt !== 1 || run.status !== 'completed' ||
      run.conclusion !== 'failure') return false;
  const roundTrips = jobs?.jobs?.filter(job => job.name === 'Chrome mainnet round trip');
  if (roundTrips?.length !== 1 || !Array.isArray(roundTrips[0].steps)) return false;
  const steps = roundTrips[0].steps;
  const matches = (name, result) => {
    const found = steps.filter(step => step.name === name);
    return found.filter(step => step.conclusion === result).length === 1 &&
      found.every(step => step.conclusion === result || step.conclusion === 'skipped');
  };
  if (!matches('Authorize original NEAR reverse', 'success') ||
      !matches('Upload mainnet near signed EVM 1', 'failure') ||
      !steps.some(step => step.name === 'Upload mainnet near native return claim') ||
      !steps.filter(step => step.name === 'Upload mainnet near native return claim').every(step => step.conclusion === 'skipped') ||
      !matches('Prepare mainnet solver swap', 'skipped')) return false;
  const retained = artifacts?.artifacts?.filter(artifact => artifact.name.startsWith('mainnet-1click-'));
  if (retained?.length !== 2) return false;
  const final = retained.find(artifact => artifact.name === `mainnet-1click-final-${id}`);
  const grant = retained.find(artifact => artifact.name === `mainnet-1click-reverse-authorized-${id}`);
  return Boolean(final?.id === 14681873349 && grant?.id === 14681848612 &&
    final.expired === false && grant.expired === false &&
    final.digest === 'sha256:6a8cf4b067cd5809cf39800521158e666ec747de39d673f6615a0470299117f7' && final.digest === grant.digest);
}
