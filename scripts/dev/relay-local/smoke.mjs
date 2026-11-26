// Smoke check of the local relay setup: the Worker (`wrangler dev`) and the config server (`serve-config.mjs`) must
// run. It sends no relay and signs nothing. Its output has no secret: addresses, states and balances only.
//
// Checks:
//   1. GET <worker>/healthz answers 200 with ok: true.
//   2. With --origin, the Worker allows that origin (the extension origin, chrome-extension://<id>).
//   3. The served document parses with the wallet's own parser and has the relay on.
//   4. GET <worker>/v1/account for --address (default: a throwaway address) on the relay chain answers, and its
//      executor is the executor of the document. It prints the mode, needsAuthorization, the authorization nonce, the
//      sequence and the balances of the native coin and of the Agglayer and Epoch tokens of the chain.
//
// Usage:
//   node scripts/dev/relay-local/smoke.mjs [--worker http://127.0.0.1:8788] [--config http://127.0.0.1:8551]
//        [--network testnet] [--chain-id 11155111] [--address 0x<40 hex>] [--origin chrome-extension://<id>]
import { parseArgs } from 'node:util';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';

import { DEFAULT_CONFIG_PORT, DEFAULT_WORKER_URL, ZERO_ADDRESS, getJson, loadWalletParser } from './lib.mjs';

const { values } = parseArgs({
  options: {
    worker: { type: 'string', default: process.env.RELAY_WORKER_URL ?? DEFAULT_WORKER_URL },
    config: { type: 'string', default: process.env.RELAY_CONFIG_URL ?? `http://127.0.0.1:${DEFAULT_CONFIG_PORT}` },
    network: { type: 'string', default: process.env.RELAY_LOCAL_NETWORK ?? 'testnet' },
    'chain-id': { type: 'string' },
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

// 1. Health.
const health = await reach(`${worker}/healthz`, () => getJson(`${worker}/healthz`));
if (health !== null) {
  if (health.status === 200 && health.body?.ok === true) pass(`/healthz ok, revision ${health.body.revision}`);
  else
    failed(
      `/healthz ${health.status} ${JSON.stringify(health.body)}: check the key, RPC_URL_<chainId> and RELAY_CONFIG ` +
        'in services/evm-relay/.dev.vars'
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
const served = await reach(`${configBase}/${values.network}.json`, () =>
  getJson(`${configBase}/${values.network}.json`)
);
let relayChain = null;
let documentChain = null;
if (served !== null) {
  const parseBridgeConfig = await loadWalletParser();
  const parsed = served.body === null ? null : parseBridgeConfig(served.body, values.network, { allowLocalHttp: true });
  if (parsed === null) failed(`the wallet parser refuses ${values.network}.json (status ${served.status})`);
  else if (parsed.features.relayDeposit !== true || parsed.relay === undefined) failed('the document has no relay');
  else {
    const wanted = values['chain-id'] === undefined ? parsed.relay.chains[0].chainId : Number(values['chain-id']);
    relayChain = parsed.relay.chains.find(chain => chain.chainId === wanted) ?? null;
    if (relayChain === null) failed(`the document's relay does not serve chain ${wanted}`);
    else {
      documentChain = served.body.supportedEvmChains[relayChain.key];
      pass(
        `${values.network}.json version ${parsed.version} parses; relay chain ${relayChain.key} (${relayChain.chainId}), ` +
          `executor ${relayChain.executor}, Calibur ${relayChain.calibur.address}`
      );
    }
  }
}

// 4. The account read.
if (relayChain !== null && health !== null) {
  const tokens = new Map([[ZERO_ADDRESS, 'native']]);
  for (const route of ['agglayer', 'epoch']) {
    for (const [symbol, token] of Object.entries(documentChain?.bridges?.[route]?.tokens ?? {})) {
      const address = token?.contractAddress?.toLowerCase();
      if (address === undefined) continue;
      const label = tokens.get(address);
      tokens.set(address, label === undefined ? `${symbol} (${route})` : label.replace(')', `, ${route})`));
    }
  }
  const address = (values.address ?? privateKeyToAddress(generatePrivateKey())).toLowerCase();
  const query = new URLSearchParams({
    chainId: String(relayChain.chainId),
    address,
    tokens: [...tokens.keys()].join(',')
  });
  const account = await reach('/v1/account', () => getJson(`${worker}/v1/account?${query}`));
  if (account !== null) {
    const body = account.body;
    if (account.status !== 200) failed(`/v1/account ${account.status} ${JSON.stringify(body)}`);
    else {
      pass(`/v1/account answers for ${address}${values.address === undefined ? ' (a throwaway address)' : ''}`);
      if (body.executor === relayChain.executor) pass(`the Worker executor ${body.executor} is the document executor`);
      else failed(`the Worker executor ${body.executor} is not the document executor ${relayChain.executor}`);
      if (body.mode === 'sponsor' && body.feeRecipient === null) pass('mode sponsor');
      else failed(`mode ${body.mode}: the deposit flow takes only sponsor`);
      console.log(`     needsAuthorization ${body.needsAuthorization}, authorizationNonce ${body.authorizationNonce}`);
      console.log(`     sequence ${body.sequence}, allowedTargets ${JSON.stringify(body.allowedTargets)}`);
      for (const { token, balance } of body.balances)
        console.log(`     balance ${tokens.get(token) ?? token}: ${balance}`);
    }
  }
}

console.log(failures === 0 ? 'Smoke check passed.' : `Smoke check failed: ${failures} check(s).`);
process.exit(failures === 0 ? 0 : 1);
