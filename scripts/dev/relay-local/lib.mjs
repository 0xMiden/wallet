// Shared helpers of the local relay scripts. No function here prints or returns a private key or an RPC URL.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { privateKeyToAddress } from 'viem/accounts';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const DEFAULT_DEV_VARS = join(REPO_ROOT, 'services/evm-relay/.dev.vars');
export const WRANGLER_CONFIG = join(REPO_ROOT, 'services/evm-relay/wrangler.jsonc');
export const PUBLISHED_BASE_URL = 'https://raw.githubusercontent.com/0xMiden/wallet-config/main';
export const DEFAULT_CONFIG_PORT = 8551;
export const DEFAULT_WORKER_URL = 'http://127.0.0.1:8788';
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
// The key of the Worker secret that holds the RPC URL of a chain (`servedChainIds` in
// services/evm-relay/src/config.ts).
const RPC_URL_KEY = /^RPC_URL_(.*)$/;
const CHAIN_ID = /^[1-9][0-9]*$/;

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
 * JSON with comments as plain JSON: removes `//` and block comments outside strings, and a comma before `}` or `]`
 * outside strings. A string keeps every character, so a URL in a string stays whole.
 */
function stripJsonc(text) {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const start = index;
      index += 1;
      while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
      index += 1;
      out += text.slice(start, index);
    } else if (text.startsWith('//', index)) {
      while (index < text.length && text[index] !== '\n') index += 1;
    } else if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? text.length : end + 2;
    } else if (char === ',' && /^\s*[}\]]/.test(text.slice(index + 1))) {
      // A trailing comma. A comment between the comma and the bracket keeps the comma; Wrangler's files have none.
      index += 1;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}

/** The `vars` of the committed `services/evm-relay/wrangler.jsonc` (JSON with comments). */
export function readWranglerVars() {
  let config;
  try {
    config = JSON.parse(stripJsonc(readFileSync(WRANGLER_CONFIG, 'utf8')));
  } catch {
    throw new Error(`${WRANGLER_CONFIG} does not parse`);
  }
  if (typeof config?.vars !== 'object' || config.vars === null) throw new Error(`${WRANGLER_CONFIG} has no vars`);
  return config.vars;
}

/**
 * The `RELAY_CONFIG` that a local Worker runs with, parsed: the `.dev.vars` value when the file sets one (Wrangler
 * lets a `.dev.vars` value replace a `vars` value), else the default of `wrangler.jsonc`. `source` names the place.
 * The Worker parses the same text strictly (`parseRelayConfig` in services/evm-relay/src/config.ts); this function
 * reads only the fields that the wallet document copies, and leaves the strict check to the Worker's `/healthz`.
 */
export function workerRelayConfig(devVars) {
  const fromDevVars = devVars?.RELAY_CONFIG;
  const source = fromDevVars === undefined ? 'wrangler.jsonc' : '.dev.vars';
  const text = fromDevVars ?? readWranglerVars().RELAY_CONFIG;
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error(`RELAY_CONFIG in ${source} is not JSON`);
  }
  const calibur = config?.calibur;
  if (typeof calibur?.address !== 'string' || typeof calibur?.runtimeHash !== 'string') {
    throw new Error(`RELAY_CONFIG in ${source} has no calibur pin`);
  }
  return {
    source,
    calibur: {
      address: calibur.address.toLowerCase(),
      runtimeHash: calibur.runtimeHash.toLowerCase(),
      domainName: calibur.domainName,
      domainVersion: calibur.domainVersion
    },
    feeRecipient: typeof config.feeRecipient === 'string' ? config.feeRecipient.toLowerCase() : undefined,
    chains: typeof config.chains === 'object' && config.chains !== null ? config.chains : {}
  };
}

/** The gas mode that a local Worker runs with: the `.dev.vars` value, else the default of `wrangler.jsonc`. */
export function workerGasMode(devVars) {
  return devVars?.GAS_MODE ?? readWranglerVars().GAS_MODE;
}

/**
 * The chains that a local Worker serves: the chain id of each `RPC_URL_<chainId>` entry of `.dev.vars`, in ascending
 * order (as `servedChainIds` of the Worker). A key with another suffix throws, as it does in the Worker.
 */
export function servedChainIds(devVars) {
  const chainIds = [];
  for (const key of Object.keys(devVars ?? {})) {
    const match = RPC_URL_KEY.exec(key);
    if (!match) continue;
    if (!CHAIN_ID.test(match[1])) throw new Error(`${key}: an RPC_URL_ key must end in a positive decimal chain id`);
    chainIds.push(Number(match[1]));
  }
  return chainIds.sort((left, right) => left - right);
}

/**
 * The relay values of one chain as the wallet reads them: the same object that `selectRelayChain`
 * (src/lib/remote-config/values.ts) builds from a parsed document. Null when the document has no relay or does not
 * list the chain in `supportedEvmChains`.
 */
export function relayChainOf(parsed, chainId) {
  if (parsed?.features?.relayDeposit !== true || parsed.relay === undefined) return null;
  const entry = Object.entries(parsed.supportedEvmChains).find(([, chain]) => chain.chainId === chainId);
  if (entry === undefined) return null;
  const relay = parsed.relay;
  return {
    key: entry[0],
    chainId,
    executor: relay.executor,
    calibur: relay.calibur,
    maxFee: relay.maxFee,
    ...(relay.feeRecipient === undefined ? {} : { feeRecipient: relay.feeRecipient })
  };
}

/**
 * The wallet's own code that a script checks with: `parseBridgeConfig` (src/lib/remote-config/schema.ts), and the
 * account read checks `parseRelayAccount` (src/lib/evm-relay/parse.ts) and `assertRelayAccountMatches`
 * (src/lib/evm-relay/guards.ts). esbuild bundles them into `node_modules/.cache/relay-local/wallet.mjs`, with viem
 * left as an import, so a script checks exactly as the wallet does.
 */
export async function loadWalletCode() {
  const { build } = await import('esbuild');
  const outfile = join(REPO_ROOT, 'node_modules/.cache/relay-local/wallet.mjs');
  const result = await build({
    stdin: {
      contents: [
        "export { parseBridgeConfig } from 'lib/remote-config/schema';",
        "export { parseRelayAccount } from 'lib/evm-relay/parse';",
        "export { assertRelayAccountMatches } from 'lib/evm-relay/guards';"
      ].join('\n'),
      resolveDir: join(REPO_ROOT, 'src'),
      loader: 'ts'
    },
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
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
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
