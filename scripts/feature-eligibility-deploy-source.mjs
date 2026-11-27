import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function validTag(tag) {
  return typeof tag === 'string' && tag.length >= 1 && tag.length <= 255 && !/[\r\n]/.test(tag);
}

export function resolveDeploymentSource({
  eventName,
  ref,
  source = 'published-release',
  releaseTag = '',
  sha = '',
  label = 'Wallet eligibility'
}) {
  if (source === 'main') {
    if (eventName !== 'workflow_dispatch' || ref !== 'refs/heads/main') {
      throw new Error('Main deployment requires manual dispatch from refs/heads/main');
    }
    if (releaseTag) throw new Error('Main deployment does not accept a release tag');
    if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('Main deployment requires the workflow commit SHA');
    return {
      mode: 'main',
      ref: sha,
      message: `${label} main ${sha}`
    };
  }

  if (source !== 'published-release') throw new Error('Unknown deployment source');
  if (!validTag(releaseTag)) throw new Error('A valid published release tag is required');
  return {
    mode: 'published-release',
    ref: `refs/tags/${releaseTag}`,
    message: `Wallet release ${releaseTag}`
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const resolved = resolveDeploymentSource({
    eventName: process.env.DEPLOY_EVENT_NAME,
    ref: process.env.DEPLOY_WORKFLOW_REF,
    source: process.env.DEPLOYMENT_SOURCE || 'published-release',
    releaseTag: process.env.RELEASE_TAG || '',
    sha: process.env.DEPLOY_WORKFLOW_SHA || '',
    label: process.env.DEPLOYMENT_LABEL || 'Wallet eligibility'
  });

  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(resolved)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n'
  );
}
