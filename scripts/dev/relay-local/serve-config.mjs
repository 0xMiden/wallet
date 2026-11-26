// Serves the published wallet-config document of one network with the deposit relay switched on, on a loopback port,
// for a wallet build that reads `MIDEN_REMOTE_CONFIG_URL` (an E2E build, see README.md in this folder).
//
// The script:
//   1. fetches `<source>/<network>.json` (default: the published 0xMiden/wallet-config document);
//   2. sets `features.relayDeposit: true` and writes a `relay` section. The chains, the Calibur pin and the fee values
//      come from `RELAY_CONFIG` of the Worker's `.dev.vars`, so the wallet and the Worker use the same pin. The
//      executor is the address of `RELAYER_PRIVATE_KEY` in that file (the key itself is never printed), or `--executor`;
//   3. checks the result with the wallet's own parser (`parseBridgeConfig`, bundled by esbuild) and stops on a refusal;
//   4. serves `/<network>.json` and proxies `/icons/<file>` (the Earn vault logos, which the wallet reads relative to
//      the document's base URL) to the source.
// Every other field of the document stays as published.
//
// Usage:
//   node scripts/dev/relay-local/serve-config.mjs [--network testnet] [--port 8551] [--dev-vars <path>]
//        [--executor 0x<40 hex>] [--base-url https://...] [--version <n>] [--source <base URL>] [--check]
// Env fallbacks: RELAY_LOCAL_NETWORK, RELAY_LOCAL_CONFIG_PORT, RELAY_DEV_VARS, RELAY_EXECUTOR, RELAY_DOCUMENT_BASE_URL,
// RELAY_DOCUMENT_VERSION, RELAY_CONFIG_SOURCE.
// Without a `.dev.vars` file: --chain <document chain key> (default sepolia) and --calibur 0x<address>=0x<hash>
// (default: the Uniswap Calibur of lib.mjs), with --executor.
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

import {
  CANONICAL_CALIBUR,
  DEFAULT_CONFIG_PORT,
  DEFAULT_DEV_VARS,
  PUBLISHED_BASE_URL,
  getJson,
  loadWalletParser,
  portOf,
  readDevVars,
  relayerAddressOf
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
    chain: { type: 'string', multiple: true },
    calibur: { type: 'string' },
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

/** The Worker's chains as `{ chainId, calibur, feeRecipient?, fees? }`, from `.dev.vars` or from the CLI. */
function workerChains(devVars, document) {
  if (devVars?.RELAY_CONFIG !== undefined) {
    let config;
    try {
      config = JSON.parse(devVars.RELAY_CONFIG);
    } catch {
      return fail(`RELAY_CONFIG in ${devVarsPath} is not JSON`);
    }
    const chains = Object.entries(config?.chains ?? {});
    if (chains.length === 0) fail(`RELAY_CONFIG in ${devVarsPath} names no chain`);
    return chains.map(([chainId, chain]) => ({ chainId: Number(chainId), ...chain }));
  }
  const [address, runtimeHash] = (
    values.calibur ?? `${CANONICAL_CALIBUR.address}=${CANONICAL_CALIBUR.runtimeHash}`
  ).split('=');
  const calibur = { ...CANONICAL_CALIBUR, address, runtimeHash };
  return (values.chain ?? ['sepolia']).map(key => {
    const chainId = document.supportedEvmChains?.[key]?.chainId;
    if (typeof chainId !== 'number') fail(`the document has no chain "${key}"`);
    return { chainId, calibur };
  });
}

/** The `relay` section of the document, keyed by the document's chain keys. */
function relaySection(document, chains, executor) {
  const keyOf = new Map(Object.entries(document.supportedEvmChains ?? {}).map(([key, chain]) => [chain.chainId, key]));
  const entries = chains.map(chain => {
    const key = keyOf.get(chain.chainId);
    if (key === undefined) fail(`chain ${chain.chainId} is not in supportedEvmChains of ${network}.json`);
    const entry = {
      executor,
      calibur: {
        address: chain.calibur.address,
        runtimeHash: chain.calibur.runtimeHash,
        domainName: chain.calibur.domainName,
        domainVersion: chain.calibur.domainVersion
      },
      // The fee ceilings of the wallet. In `sponsor` mode the Worker asks for no fee, so the map can stay empty. In
      // `deduct` mode the configured fee of each token is the ceiling.
      maxFee: chain.fees ?? {}
    };
    if (chain.feeRecipient !== undefined) entry.feeRecipient = chain.feeRecipient;
    return [key, entry];
  });
  return { baseUrl, chains: Object.fromEntries(entries) };
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
if (devVars !== null && devVars.GAS_MODE !== undefined && devVars.GAS_MODE !== 'sponsor') {
  console.warn(`serve-config: GAS_MODE is "${devVars.GAS_MODE}"; the deposit flow takes only "sponsor" now.`);
}

const document = {
  ...published,
  ...(versionOverride === undefined ? {} : { version: Number(versionOverride) }),
  features: { ...published.features, relayDeposit: true },
  relay: relaySection(published, workerChains(devVars, published), executor)
};
const body = JSON.stringify(document, null, 2);
if (Buffer.byteLength(body) > MAX_DOCUMENT_BYTES) fail(`the document is over ${MAX_DOCUMENT_BYTES} bytes`);

// The wallet's E2E build reads a loopback document with `allowLocalHttp` (src/lib/remote-config/source.ts).
const parseBridgeConfig = await loadWalletParser();
const parsed = parseBridgeConfig(JSON.parse(body), network, { allowLocalHttp: true });
if (parsed === null) fail('the wallet parser refuses the document (parseBridgeConfig gave null)');
if (parsed.features.relayDeposit !== true || parsed.relay === undefined) fail('the parsed document has no relay');
const knownChains = new Set(Object.values(parsed.supportedEvmChains).map(chain => chain.chainId));
for (const chain of parsed.relay.chains) {
  // selectRelayChain (values.ts) gives null for a chain that this build does not know.
  if (!knownChains.has(chain.chainId)) fail(`this wallet build does not know relay chain ${chain.chainId}`);
}

console.log(`Document ${network}.json version ${document.version} from ${source}`);
console.log(`  features.relayDeposit: true, relay.baseUrl: ${parsed.relay.baseUrl}`);
for (const chain of parsed.relay.chains) {
  console.log(
    `  relay chain ${chain.key} (${chain.chainId}): executor ${chain.executor}, Calibur ${chain.calibur.address} ` +
      `${chain.calibur.runtimeHash}, fee recipient ${chain.feeRecipient ?? 'none'}`
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
