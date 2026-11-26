// Smoke check of the local relay setup: the Worker (`wrangler dev`) and the config server (`serve-config.mjs`) must
// run. It sends no relay and signs nothing. Its output has no secret: addresses, states and balances only.
//
// Checks:
//   1. GET <worker>/healthz answers 200 with ok: true.
//   2. With --origin, the Worker allows that origin (the extension origin, chrome-extension://<id>).
//   3. The served document parses with the wallet's own parser and has the relay on. Its Calibur pin is the pin of
//      the `RELAY_CONFIG` that the local Worker runs with (`.dev.vars`, else `wrangler.jsonc`).
//   4. For each chain that the Worker serves (each `RPC_URL_<chainId>` of `.dev.vars`, or each --chain-id): the
//      document lists the chain, and GET <worker>/v1/account for --address (default: a throwaway address) answers and
//      passes the wallet's own checks (`parseRelayAccount`, `assertRelayAccountMatches`: the executor and the gas
//      mode). The salt of the answer names the document's Calibur. It prints needsAuthorization, the authorization
//      nonce, the sequence and the balances of the native coin and of the Agglayer and Epoch tokens of the chain.
//
// Usage:
//   node scripts/dev/relay-local/smoke.mjs [--worker http://127.0.0.1:8788] [--config http://127.0.0.1:8551]
//        [--network testnet] [--dev-vars <path>] [--chain-id <id>]... [--address 0x<40 hex>]
//        [--origin chrome-extension://<id>]
import { parseArgs } from 'node:util';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';

import {
  DEFAULT_CONFIG_PORT,
  DEFAULT_DEV_VARS,
  DEFAULT_WORKER_URL,
  ZERO_ADDRESS,
  getJson,
  loadWalletCode,
  readDevVars,
  relayChainOf,
  servedChainIds,
  workerRelayConfig
} from './lib.mjs';

const { values } = parseArgs({
  options: {
    worker: { type: 'string', default: process.env.RELAY_WORKER_URL ?? DEFAULT_WORKER_URL },
    config: { type: 'string', default: process.env.RELAY_CONFIG_URL ?? `http://127.0.0.1:${DEFAULT_CONFIG_PORT}` },
    network: { type: 'string', default: process.env.RELAY_LOCAL_NETWORK ?? 'testnet' },
    'dev-vars': { type: 'string', default: process.env.RELAY_DEV_VARS ?? DEFAULT_DEV_VARS },
    'chain-id': { type: 'string', multiple: true },
    address: { type: 'string' },
    origin: { type: 'string' }
  }
});
const worker = values.worker.replace(/\/+$/, '');
const configBase = values.config.replace(/\/+$/, '');
let failures = 0;

function pass(message) {
  console.log(`PASS ${message}`);
}

function failed(message) {
  failures += 1;
  console.log(`FAIL ${message}`);
}

async function reach(label, read) {
  try {
    return await read();
  } catch (error) {
    failed(`${label}: no answer (${error?.cause?.code ?? error?.name ?? 'error'})`);
    return null;
  }
}

const devVars = readDevVars(values['dev-vars']);
let localPin = null;
let chainIds = [];
try {
  localPin = workerRelayConfig(devVars);
  chainIds = values['chain-id'] === undefined ? servedChainIds(devVars) : values['chain-id'].map(Number);
} catch (error) {
  failed(error.message);
}
if (chainIds.length === 0)
  failed(`no chain to check: set RPC_URL_<chainId> in ${values['dev-vars']} or pass --chain-id`);

// 1. Health.
const health = await reach(`${worker}/healthz`, () => getJson(`${worker}/healthz`));
if (health !== null) {
  if (health.status === 200 && health.body?.ok === true) pass(`/healthz ok, revision ${health.body.revision}`);
  else
    failed(
      `/healthz ${health.status} ${JSON.stringify(health.body)}: check RELAYER_PRIVATE_KEY, each RPC_URL_<chainId> ` +
        'and RELAY_CONFIG (when set) in services/evm-relay/.dev.vars'
    );
}

// 2. The extension origin.
if (values.origin !== undefined) {
  const gate = await reach('the origin check', () =>
    getJson(`${worker}/healthz`, { headers: { Origin: values.origin } })
  );
  if (gate !== null) {
    const allowed = gate.headers.get('access-control-allow-origin');
    if (gate.status !== 403 && allowed === values.origin) pass(`the Worker allows the origin ${values.origin}`);
    else failed(`the Worker refuses the origin ${values.origin} (${gate.status}): add it to ALLOWED_ORIGINS`);
  }
}

// 3. The document.
const wallet = await loadWalletCode();
const served = await reach(`${configBase}/${values.network}.json`, () =>
  getJson(`${configBase}/${values.network}.json`)
);
let parsed = null;
if (served !== null) {
  parsed =
    served.body === null ? null : wallet.parseBridgeConfig(served.body, values.network, { allowLocalHttp: true });
  if (parsed === null) failed(`the wallet parser refuses ${values.network}.json (status ${served.status})`);
  else if (parsed.features.relayDeposit !== true || parsed.relay === undefined) {
    failed('the document has no relay');
    parsed = null;
  } else {
    pass(
      `${values.network}.json version ${parsed.version} parses; executor ${parsed.relay.executor}, ` +
        `Calibur ${parsed.relay.calibur.address}`
    );
    const pin = parsed.relay.calibur;
    if (
      localPin !== null &&
      pin.address === localPin.calibur.address &&
      pin.runtimeHash === localPin.calibur.runtimeHash &&
      pin.domainName === localPin.calibur.domainName &&
      pin.domainVersion === localPin.calibur.domainVersion
    ) {
      pass(`the document's Calibur pin is the Worker's (RELAY_CONFIG in ${localPin.source})`);
    } else if (localPin !== null) {
      failed(
        `the document's Calibur pin is not the Worker's (RELAY_CONFIG in ${localPin.source}): restart serve-config`
      );
    }
  }
}

/** The tokens to read on a chain: the native coin, then the Agglayer and Epoch tokens that the document names. */
function tokensOf(chainKey) {
  const documentChain = served?.body?.supportedEvmChains?.[chainKey];
  const tokens = new Map([[ZERO_ADDRESS, 'native']]);
  for (const route of ['agglayer', 'epoch']) {
    for (const [symbol, token] of Object.entries(documentChain?.bridges?.[route]?.tokens ?? {})) {
      const address = token?.contractAddress?.toLowerCase();
      if (address === undefined) continue;
      const label = tokens.get(address);
      tokens.set(address, label === undefined ? `${symbol} (${route})` : label.replace(')', `, ${route})`));
    }
  }
  return tokens;
}

// 4. The account read on each chain that the Worker serves.
const address = (values.address ?? privateKeyToAddress(generatePrivateKey())).toLowerCase();
for (const chainId of parsed === null || health === null ? [] : chainIds) {
  const chain = relayChainOf(parsed, chainId);
  if (chain === null) {
    failed(`chain ${chainId}: ${values.network}.json does not list it in supportedEvmChains`);
    continue;
  }
  const label = `${chain.key} (${chainId})`;
  const tokens = tokensOf(chain.key);
  const query = new URLSearchParams({ chainId: String(chainId), address, tokens: [...tokens.keys()].join(',') });
  const answer = await reach(`${label} /v1/account`, () => getJson(`${worker}/v1/account?${query}`));
  if (answer === null) continue;
  if (answer.status !== 200) {
    failed(`${label} /v1/account ${answer.status} ${JSON.stringify(answer.body)}`);
    continue;
  }
  let account;
  try {
    account = wallet.parseRelayAccount(answer.body, [...tokens.keys()]);
    wallet.assertRelayAccountMatches(account, chain, address);
  } catch (error) {
    failed(`${label} the wallet refuses the account answer: ${error.message}`);
    continue;
  }
  pass(
    `${label} /v1/account passes the wallet's checks for ${address}` +
      `${values.address === undefined ? ' (a throwaway address)' : ''}: executor ${account.executor}, mode ${account.mode}`
  );
  if (account.mode !== 'sponsor') failed(`${label} mode ${account.mode}: the deposit flow takes only sponsor`);
  if (account.salt.slice(-40) === chain.calibur.address.slice(2))
    pass(`${label} the salt names the document's Calibur`);
  else failed(`${label} the salt does not name the document's Calibur ${chain.calibur.address}`);
  console.log(
    `     needsAuthorization ${account.needsAuthorization}, authorizationNonce ${account.authorizationNonce}`
  );
  console.log(`     sequence ${account.sequence}, allowedTargets ${JSON.stringify(account.allowedTargets)}`);
  for (const { token, balance } of account.balances)
    console.log(`     balance ${tokens.get(token) ?? token}: ${balance}`);
}

console.log(failures === 0 ? 'Smoke check passed.' : `Smoke check failed: ${failures} check(s).`);
process.exit(failures === 0 ? 0 : 1);
