// Serves the published wallet-config document of one network with the deposit relay switched on, on a loopback port,
// for a wallet build that reads `MIDEN_REMOTE_CONFIG_URL` (an E2E build, see README.md in this folder).
//
// The script:
//   1. fetches `<source>/<network>.json` (default: the published 0xMiden/wallet-config document);
//   2. sets `features.relayDeposit: true` and writes the `relay` section, which applies to every chain of the
//      document's `supportedEvmChains`. The Calibur pin and the fee recipient come from the `RELAY_CONFIG` that the
//      local Worker runs with: the value in `.dev.vars` when the developer sets one, else the default in
//      `services/evm-relay/wrangler.jsonc`. So the wallet and the Worker use the same pin. The executor is the address
//      of `RELAYER_PRIVATE_KEY` in `.dev.vars` (the key itself is never printed), or `--executor`;
//   3. checks the result with the wallet's own parser (`parseBridgeConfig`, bundled by esbuild) and stops on a refusal;
//   4. prints the chains that the local Worker serves (each `RPC_URL_<chainId>` of `.dev.vars`), and stops when the
//      document does not list one of them;
//   5. serves `/<network>.json` and proxies `/icons/<file>` (the Earn vault logos, which the wallet reads relative to
//      the document's base URL) to the source.
// Every other field of the document stays as published.
//
// Usage:
//   node scripts/dev/relay-local/serve-config.mjs [--network testnet] [--port 8551] [--dev-vars <path>]
//        [--executor 0x<40 hex>] [--base-url https://...] [--version <n>] [--source <base URL>] [--check]
// Env fallbacks: RELAY_LOCAL_NETWORK, RELAY_LOCAL_CONFIG_PORT, RELAY_DEV_VARS, RELAY_EXECUTOR, RELAY_DOCUMENT_BASE_URL,
// RELAY_DOCUMENT_VERSION, RELAY_CONFIG_SOURCE.
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

import {
  DEFAULT_CONFIG_PORT,
  DEFAULT_DEV_VARS,
  PUBLISHED_BASE_URL,
  getJson,
  loadWalletCode,
  portOf,
  readDevVars,
  relayChainOf,
  relayerAddressOf,
  servedChainIds,
  workerGasMode,
  workerRelayConfig
} from './lib.mjs';

// The wallet refuses a `relay.baseUrl` that is not `https:`. A loopback Worker reaches the wallet only through the
// `MIDEN_EVM_RELAY_URL` build define, which goes first (src/lib/evm-relay/base-url.ts). This reserved name makes a
// build without that define fail loudly instead of calling a real host.
const PLACEHOLDER_BASE_URL = 'https://evm-relay.invalid';
// The wallet reads at most 32 KiB of the document (src/lib/remote-config/source.ts).
const MAX_DOCUMENT_BYTES = 32 * 1_024;
// The logo path rule of an Earn vault (EARN_VAULT_LOGO in src/lib/remote-config/schema.ts).
const ICON_PATH = /^\/icons\/[a-z0-9]+(-[a-z0-9]+)*\.(svg|png)$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const { values } = parseArgs({
  options: {
    network: { type: 'string' },
    port: { type: 'string' },
    'dev-vars': { type: 'string' },
    executor: { type: 'string' },
    'base-url': { type: 'string' },
    version: { type: 'string' },
    source: { type: 'string' },
    check: { type: 'boolean', default: false }
  }
});

const env = process.env;
const network = values.network ?? env.RELAY_LOCAL_NETWORK ?? 'testnet';
const port = portOf(values.port ?? env.RELAY_LOCAL_CONFIG_PORT ?? DEFAULT_CONFIG_PORT, '--port');
const devVarsPath = values['dev-vars'] ?? env.RELAY_DEV_VARS ?? DEFAULT_DEV_VARS;
const source = (values.source ?? env.RELAY_CONFIG_SOURCE ?? PUBLISHED_BASE_URL).replace(/\/+$/, '');
const baseUrl = values['base-url'] ?? env.RELAY_DOCUMENT_BASE_URL ?? PLACEHOLDER_BASE_URL;
const versionOverride = values.version ?? env.RELAY_DOCUMENT_VERSION;

function fail(message) {
  console.error(`serve-config: ${message}`);
  process.exit(1);
}

/**
 * The fee ceilings of the wallet (`relay.maxFee`): for each token, the highest fee that a `chains` entry of the
 * Worker's `RELAY_CONFIG` names. In `sponsor` mode the Worker asks for no fee, so the map is empty.
 */
function maxFeeOf(chains) {
  const maxFee = {};
  for (const entry of Object.values(chains)) {
    for (const [token, fee] of Object.entries(entry?.fees ?? {})) {
      const key = token.toLowerCase();
      if (maxFee[key] === undefined || BigInt(fee) > BigInt(maxFee[key])) maxFee[key] = String(fee);
    }
  }
  return maxFee;
}

const fetched = await getJson(`${source}/${network}.json`);
if (fetched.status !== 200 || fetched.body === null)
  fail(`the read of ${source}/${network}.json failed (${fetched.status})`);
const published = fetched.body;

const devVars = readDevVars(devVarsPath);
const executor = (values.executor ?? env.RELAY_EXECUTOR ?? relayerAddressOf(devVars) ?? '').toLowerCase();
if (!EVM_ADDRESS.test(executor)) {
  fail(`no executor: set RELAYER_PRIVATE_KEY in ${devVarsPath}, or pass --executor 0x<relayer address>`);
}
const gasMode = workerGasMode(devVars);
const deduct = gasMode === 'deduct';
if (gasMode !== 'sponsor')
  console.warn(`serve-config: GAS_MODE is "${gasMode}"; the deposit flow takes only "sponsor".`);

let worker;
let chainIds;
try {
  worker = workerRelayConfig(devVars);
  chainIds = servedChainIds(devVars);
} catch (error) {
  fail(error.message);
}

const relay = {
  baseUrl,
  executor,
  calibur: worker.calibur,
  maxFee: deduct ? maxFeeOf(worker.chains) : {},
  ...(deduct && worker.feeRecipient !== undefined ? { feeRecipient: worker.feeRecipient } : {})
};
const document = {
  ...published,
  ...(versionOverride === undefined ? {} : { version: Number(versionOverride) }),
  features: { ...published.features, relayDeposit: true },
  relay
};
const body = JSON.stringify(document, null, 2);
if (Buffer.byteLength(body) > MAX_DOCUMENT_BYTES) fail(`the document is over ${MAX_DOCUMENT_BYTES} bytes`);

// The wallet's E2E build reads a loopback document with `allowLocalHttp` (src/lib/remote-config/source.ts).
const { parseBridgeConfig } = await loadWalletCode();
const parsed = parseBridgeConfig(JSON.parse(body), network, { allowLocalHttp: true });
if (parsed === null) fail('the wallet parser refuses the document (parseBridgeConfig gave null)');
if (parsed.features.relayDeposit !== true || parsed.relay === undefined) fail('the parsed document has no relay');

console.log(`Document ${network}.json version ${document.version} from ${source}`);
console.log(`  features.relayDeposit: true, relay.baseUrl: ${parsed.relay.baseUrl}`);
console.log(`  executor ${parsed.relay.executor}`);
console.log(
  `  Calibur ${parsed.relay.calibur.address} ${parsed.relay.calibur.runtimeHash} ` +
    `(${parsed.relay.calibur.domainName} ${parsed.relay.calibur.domainVersion}), from RELAY_CONFIG in ${worker.source}`
);
console.log(`  fee recipient ${parsed.relay.feeRecipient ?? 'none'}, maxFee ${JSON.stringify(parsed.relay.maxFee)}`);
if (chainIds.length === 0) {
  console.warn(`  no RPC_URL_<chainId> in ${devVarsPath}: the local Worker serves no chain`);
}
for (const chainId of chainIds) {
  const chain = relayChainOf(parsed, chainId);
  if (chain === null) fail(`the Worker serves chain ${chainId}, but ${network}.json does not list it`);
  console.log(`  Worker chain ${chain.key} (${chainId}): the wallet reads its relay values`);
}
const unserved = Object.entries(parsed.supportedEvmChains).filter(([, chain]) => !chainIds.includes(chain.chainId));
for (const [key, chain] of unserved) {
  console.log(
    `  document chain ${key} (${chain.chainId}): no RPC_URL_${chain.chainId}, the Worker answers unsupported_chain`
  );
}
console.log('  the wallet parser accepts the document');
if (values.check) process.exit(0);

const server = createServer(async (request, response) => {
  const path = (request.url ?? '/').split('?')[0];
  // The extension pages are cross-origin isolated, and the service worker and the offscreen document fetch too.
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  response.setHeader('Cache-Control', 'no-store');
  if (request.method === 'OPTIONS') {
    response.writeHead(204).end();
    return;
  }
  // Node sends no body for a HEAD request.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD, OPTIONS' }).end();
    return;
  }
  if (path === `/${network}.json`) {
    console.log(`GET ${path} 200`);
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
    return;
  }
  if (ICON_PATH.test(path)) {
    try {
      const icon = await fetch(`${source}${path}`, { signal: AbortSignal.timeout(15_000) });
      const bytes = Buffer.from(await icon.arrayBuffer());
      console.log(`GET ${path} ${icon.status} (from the source)`);
      response
        .writeHead(icon.status, { 'Content-Type': path.endsWith('.svg') ? 'image/svg+xml' : 'image/png' })
        .end(icon.ok ? bytes : undefined);
    } catch {
      console.log(`GET ${path} 502 (the source did not answer)`);
      response.writeHead(502).end();
    }
    return;
  }
  console.log(`GET ${path} 404`);
  response.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'not_found' }));
});

server.on('error', error => fail(`cannot listen on 127.0.0.1:${port}: ${error.message}`));
server.listen(port, '127.0.0.1', () => {
  console.log(`Serving http://127.0.0.1:${port}/${network}.json (Ctrl-C stops it)`);
  console.log(`Build the wallet with MIDEN_REMOTE_CONFIG_URL=http://127.0.0.1:${port}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
