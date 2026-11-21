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
  return Boolean(final && grant && final.id !== grant.id && final.expired === false && grant.expired === false &&
    /^sha256:[0-9a-f]{64}$/.test(final.digest) && final.digest === grant.digest);
}
