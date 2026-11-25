// Release check and release config of the evm-relay Worker. The deploy workflow runs it before `wrangler deploy`.
// It checks the release values, then it writes two files to RUNNER_TEMP: a release copy of wrangler.jsonc with the
// real variables, and the secrets file for `wrangler deploy --secrets-file`. The committed wrangler.jsonc does not
// change. A message names the setting that fails, and never the value of a secret.
//
// The Worker's own config parse (src/config.ts) and key check (src/secrets.ts) run on the values too: esbuild bundles
// them in memory and the script imports the bundle. So the deploy refuses a config that the live Worker would refuse.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateEndpoint, validateOrigins } from './check-deployment.mjs';

const SERVICE = dirname(fileURLToPath(import.meta.url));
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const CHAIN_ID = /^[1-9][0-9]{0,15}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The workflow settings, by environment name. The step sets each one from a secret or a variable. */
export const REQUIRED_SETTINGS = [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'EVM_RELAY_RELAYER_PRIVATE_KEY',
  'EVM_RELAY_RPC_URLS',
  'EVM_RELAY_ALLOWED_ORIGINS',
  'EVM_RELAY_GAS_MODE',
  'EVM_RELAY_CONFIG',
  'EVM_RELAY_URL',
  'DEPLOYMENT_REVISION'
];

/** Bundle the Worker's config parse and key check, and import them. */
export async function loadWorkerChecks() {
  const { build } = await import('esbuild');
  const result = await build({
    stdin: {
      contents: "export { parseConfig } from './src/config.ts';\nexport { relayerAddress } from './src/secrets.ts';\n",
      resolveDir: SERVICE,
      sourcefile: 'release-checks.ts',
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'silent'
  });
  const [output] = result.outputFiles;
  return import(`data:text/javascript;base64,${Buffer.from(output.text).toString('base64')}`);
}

function parseVariable(text, name) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${name} must be JSON`);
  }
}

export function checkGasMode(value) {
  switch (value) {
    case 'sponsor':
    case 'deduct':
      return value;
    default:
      throw new Error('EVM_RELAY_GAS_MODE must be sponsor or deduct');
  }
}

/** The decimal chain ids of RELAY_CONFIG. It must name at least one chain. */
export function configChainIds(relayConfig) {
  const value = parseVariable(relayConfig, 'EVM_RELAY_CONFIG');
  if (!record(value) || !record(value.chains)) throw new Error('EVM_RELAY_CONFIG must be an object with chains');
  const chainIds = Object.keys(value.chains);
  if (!chainIds.length) throw new Error('EVM_RELAY_CONFIG must name at least one chain');
  return chainIds;
}

/** True for an `https:` URL with a host. */
function isHttpsUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * The `RPC_URL_<chainId>` secrets from the JSON object `{ "<chainId>": "<url>" }`. Every config chain needs an https
 * URL, and every URL needs a config chain. A message names a chain id at most, never a URL or a key that is not a
 * chain id.
 */
export function rpcSecrets(rpcUrls, chainIds) {
  let value;
  try {
    value = JSON.parse(rpcUrls);
  } catch {
    // The parse error quotes the input, so it must not leave this function.
    throw new Error('EVM_RELAY_RPC_URLS must be a JSON object of chain id to URL');
  }
  if (!record(value)) throw new Error('EVM_RELAY_RPC_URLS must be a JSON object of chain id to URL');
  const configured = new Set(chainIds);
  for (const key of Object.keys(value)) {
    if (!CHAIN_ID.test(key)) throw new Error('EVM_RELAY_RPC_URLS has a key that is not a decimal chain id');
    if (!configured.has(key)) {
      throw new Error(`EVM_RELAY_RPC_URLS has a URL for chain ${key}, which EVM_RELAY_CONFIG does not name`);
    }
  }
  const secrets = {};
  for (const chainId of chainIds) {
    if (!Object.hasOwn(value, chainId)) throw new Error(`EVM_RELAY_RPC_URLS has no URL for chain ${chainId}`);
    if (!isHttpsUrl(value[chainId])) throw new Error(`EVM_RELAY_RPC_URLS must give an https URL for chain ${chainId}`);
    secrets[`RPC_URL_${chainId}`] = value[chainId];
  }
  return secrets;
}

/**
 * Check every release value. `worker` is the result of loadWorkerChecks. Returns the Worker variables, the Worker
 * secrets and the relayer address (public).
 */
export function validateRelease(env, worker) {
  for (const key of REQUIRED_SETTINGS) {
    if (!env[key]) throw new Error(`Missing production setting: ${key}`);
  }
  const gasMode = checkGasMode(env.EVM_RELAY_GAS_MODE);
  if (!PRIVATE_KEY.test(env.EVM_RELAY_RELAYER_PRIVATE_KEY)) {
    throw new Error('EVM_RELAY_RELAYER_PRIVATE_KEY must be 0x and 64 hex characters');
  }
  try {
    validateOrigins(parseVariable(env.EVM_RELAY_ALLOWED_ORIGINS, 'EVM_RELAY_ALLOWED_ORIGINS'));
  } catch {
    throw new Error('EVM_RELAY_ALLOWED_ORIGINS must be a nonempty JSON array of exact wallet origins');
  }
  try {
    validateEndpoint(env.EVM_RELAY_URL);
  } catch {
    throw new Error('EVM_RELAY_URL must be an https URL with no credentials, query, fragment or trailing slash');
  }
  if (!REVISION.test(env.DEPLOYMENT_REVISION)) throw new Error('DEPLOYMENT_REVISION must be a full commit SHA');
  const chainIds = configChainIds(env.EVM_RELAY_CONFIG);

  const vars = {
    ALLOWED_ORIGINS: env.EVM_RELAY_ALLOWED_ORIGINS,
    DEPLOYMENT_REVISION: env.DEPLOYMENT_REVISION,
    GAS_MODE: gasMode,
    RELAY_CONFIG: env.EVM_RELAY_CONFIG
  };
  try {
    worker.parseConfig(vars);
  } catch (error) {
    // The Worker's messages name a variable path and a rule. No variable is a secret.
    const reason = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`The Worker refuses the release config: ${reason}`);
  }
  const executor = worker.relayerAddress({ RELAYER_PRIVATE_KEY: env.EVM_RELAY_RELAYER_PRIVATE_KEY });
  if (executor === null) throw new Error('EVM_RELAY_RELAYER_PRIVATE_KEY is not a valid secp256k1 private key');
  const secrets = {
    RELAYER_PRIVATE_KEY: env.EVM_RELAY_RELAYER_PRIVATE_KEY,
    ...rpcSecrets(env.EVM_RELAY_RPC_URLS, chainIds)
  };
  return { vars, secrets, executor, chainIds };
}

/** Read wrangler.jsonc. Its comments are whole lines. */
export function readWranglerConfig(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\s*\/\/.*$/gm, ''));
}

/** The release copy of the committed config: the same bindings, an absolute `main` and the release variables. */
export function renderRelease(config, vars, service = SERVICE) {
  const readLimit = config.ratelimits?.find(binding => binding.name === 'READ_RATE_LIMIT');
  const relayLimit = config.ratelimits?.find(binding => binding.name === 'RELAY_RATE_LIMIT');
  if (
    readLimit?.simple?.limit !== 60 ||
    readLimit.simple.period !== 60 ||
    relayLimit?.simple?.limit !== 10 ||
    relayLimit.simple.period !== 60 ||
    !readLimit.namespace_id ||
    readLimit.namespace_id === relayLimit.namespace_id
  ) {
    throw new Error('Missing or invalid evm-relay rate limit bindings');
  }
  const sender = config.durable_objects?.bindings?.some(
    binding => binding.name === 'RELAY_SENDER' && binding.class_name === 'RelaySenderObject' && !binding.script_name
  );
  const migrated = config.migrations?.some(migration => migration.new_sqlite_classes?.includes('RelaySenderObject'));
  if (!sender || !migrated) {
    throw new Error('wrangler.jsonc must bind RELAY_SENDER to RelaySenderObject and migrate it as a SQLite class');
  }
  // The rendered copy lives outside the service folder, so the entry path is absolute.
  return { ...config, main: resolve(service, config.main), vars: { ...vars } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    if (!process.env.RUNNER_TEMP) throw new Error('Set RUNNER_TEMP to the folder for the release files');
    const release = validateRelease(process.env, await loadWorkerChecks());
    const config = renderRelease(readWranglerConfig(join(SERVICE, 'wrangler.jsonc')), release.vars);
    writeFileSync(join(process.env.RUNNER_TEMP, 'evm-relay-release.json'), JSON.stringify(config), { mode: 0o600 });
    writeFileSync(join(process.env.RUNNER_TEMP, 'evm-relay-secrets.json'), JSON.stringify(release.secrets), {
      mode: 0o600
    });
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `executor=${release.executor}\n`);
    console.log(`Release values pass for chains ${release.chainIds.join(', ')}`);
    console.log(`Relayer address (executor): ${release.executor}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'The release check failed');
    process.exitCode = 1;
  }
}
