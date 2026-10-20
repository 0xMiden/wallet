import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NETWORKS = new Set(['testnet', 'devnet']);
const CONFIG_BASE = 'https://raw.githubusercontent.com/0xMiden/wallet-config/main';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value, keys) =>
  record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const noStore = response => /(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('Cache-Control') ?? '');

export function validateEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Set a public HTTPS feature eligibility URL ending /v1/eligibility');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/v1/eligibility' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Feature eligibility URL must use HTTPS with no credentials, query or fragment and end /v1/eligibility'
    );
  }
  return url;
}

export async function checkDeployment({
  endpoint,
  networks = ['testnet', 'devnet'],
  origins,
  revision,
  fetchImpl = fetch,
  healthAttempts = 1
}) {
  const target = validateEndpoint(endpoint);
  if (!Array.isArray(networks) || !networks.length || networks.some(network => !NETWORKS.has(network))) {
    throw new Error('Choose testnet, devnet or both for the deployment check');
  }
  if (
    !Array.isArray(origins) ||
    !origins.length ||
    origins.some(origin => typeof origin !== 'string' || !origin || origin.includes('*'))
  ) {
    throw new Error('Configure exact wallet origins before checking the service');
  }
  if (!Number.isInteger(healthAttempts) || healthAttempts < 1 || healthAttempts > 10)
    throw new Error('Invalid health retry limit');

  async function read(url, label, headers = {}) {
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        cache: 'no-store',
        redirect: 'error',
        credentials: 'omit',
        headers,
        signal: AbortSignal.timeout(20_000)
      });
      if (!response.ok) throw new Error('Request failed');
      return { response, body: await response.json() };
    } catch {
      throw new Error(`${label} did not return a successful JSON response`);
    }
  }

  for (let attempt = 1; ; attempt += 1) {
    try {
      const { response, body } = await read(new URL('/healthz', target), 'Deployment health');
      if (!record(body) || body.ready !== true || !noStore(response) || (revision && body.revision !== revision)) {
        throw new Error('Deployed service is not ready at the requested release revision');
      }
      break;
    } catch (error) {
      if (attempt >= healthAttempts) throw error;
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }
  }

  for (const network of networks) {
    const { body: policy } = await read(`${CONFIG_BASE}/${network}.json`, `Published ${network} policy`);
    if (!record(policy) || policy.network !== network || !Number.isSafeInteger(policy.version) || policy.version <= 0) {
      throw new Error(`Published ${network} policy has an invalid identity`);
    }
    const url = new URL(target);
    url.searchParams.set('network', network);
    const { response, body } = await read(url, `${network} eligibility`, { Origin: origins[0] });
    if (
      !onlyKeys(body, ['network', 'version', 'allowed']) ||
      body.network !== network ||
      body.version !== policy.version ||
      !onlyKeys(body.allowed, ['earn', 'swap']) ||
      typeof body.allowed.earn !== 'boolean' ||
      typeof body.allowed.swap !== 'boolean'
    ) {
      throw new Error(`${network} eligibility did not match the current private decision contract`);
    }
    const variesByOrigin = (response.headers.get('Vary') ?? '')
      .split(',')
      .some(value => value.trim().toLowerCase() === 'origin');
    if (!noStore(response) || response.headers.get('Access-Control-Allow-Origin') !== origins[0] || !variesByOrigin) {
      throw new Error(`${network} eligibility is not private or accessible to the configured wallet origin`);
    }
  }
  return { endpoint: target.href, networks: [...networks] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = await checkDeployment({
      endpoint: process.env.FEATURE_ELIGIBILITY_URL,
      networks: JSON.parse(process.env.FEATURE_ELIGIBILITY_NETWORKS ?? '["testnet","devnet"]'),
      origins: JSON.parse(process.env.FEATURE_ELIGIBILITY_ALLOWED_ORIGINS ?? '[]'),
      revision: process.env.FEATURE_ELIGIBILITY_REVISION,
      healthAttempts: 5
    });
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `endpoint=${result.endpoint}\n`);
    console.log(`Feature eligibility ready for ${result.networks.join(', ')}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Feature eligibility readiness failed');
    process.exitCode = 1;
  }
}
