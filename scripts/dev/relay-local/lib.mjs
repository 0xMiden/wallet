// Shared helpers of the local relay scripts. No function here prints or returns a private key.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { privateKeyToAddress } from 'viem/accounts';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const DEFAULT_DEV_VARS = join(REPO_ROOT, 'services/evm-relay/.dev.vars');
export const PUBLISHED_BASE_URL = 'https://raw.githubusercontent.com/0xMiden/wallet-config/main';
export const DEFAULT_CONFIG_PORT = 8551;
export const DEFAULT_WORKER_URL = 'http://127.0.0.1:8788';
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * The Uniswap Calibur deployment at the same address on Sepolia, Base Sepolia and Arbitrum Sepolia (checked with
 * `probe-chains.mjs`). The keccak256 of its runtime code was read from those chains.
 */
export const CANONICAL_CALIBUR = {
  address: '0x000000009b1d0af20d8c6d0a44e162d11f9b8f00',
  runtimeHash: '0x7fa1bd2edb51499cb83a324acd9d0f35b31774cf8894e26fc13ac0474f4f57a4',
  domainName: 'Calibur',
  domainVersion: '1.0.0'
};

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

/**
 * The entries of a `.dev.vars` file (the dotenv format that Wrangler reads): `NAME=value`, with an optional pair of
 * single or double quotes around the value. Comments and blank lines are skipped. Null when the file does not exist.
 */
export function readDevVars(path) {
  if (!existsSync(path)) return null;
  const entries = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    entries[match[1]] = value;
  }
  return entries;
}

/** The relayer address (the executor) of `RELAYER_PRIVATE_KEY` in the entries, lower case. Never the key. */
export function relayerAddressOf(entries) {
  const key = entries?.RELAYER_PRIVATE_KEY;
  if (typeof key !== 'string' || !PRIVATE_KEY.test(key)) return null;
  try {
    return privateKeyToAddress(key).toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The wallet's own parser of the remote config (`parseBridgeConfig` of `src/lib/remote-config/schema.ts`). esbuild
 * bundles it once into `node_modules/.cache/relay-local/schema.mjs`, with viem left as an import, so a script checks a
 * document exactly as the wallet does.
 */
export async function loadWalletParser() {
  const { build } = await import('esbuild');
  const outfile = join(REPO_ROOT, 'node_modules/.cache/relay-local/schema.mjs');
  const result = await build({
    entryPoints: [join(REPO_ROOT, 'src/lib/remote-config/schema.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    tsconfig: join(REPO_ROOT, 'tsconfig.json'),
    external: ['viem', 'viem/*'],
    logLevel: 'error'
  });
  mkdirSync(dirname(outfile), { recursive: true });
  writeFileSync(outfile, result.outputFiles[0].text);
  const module = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  return module.parseBridgeConfig;
}

/** Parse a CLI value or an environment value as a TCP port. */
export function portOf(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${name} must be a TCP port`);
  return port;
}

/** A fetch with a time limit that returns the status and the parsed JSON body (null when the body is not JSON). */
export async function getJson(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, headers: response.headers, body };
}
