import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';

import { qualifyMainnetLoopConfig, startMainnetLoopConfigServer } from '../node_modules/.cache/nightly-loop-config.mjs';

assert.equal(process.env.E2E_NETWORK, 'mainnet', 'Nightly config startup requires mainnet');
assert.ok(process.env.GITHUB_ENV, 'Nightly config startup requires a workflow environment file');
assert.match(
  process.env.GITHUB_RUN_ID ?? '',
  /^\d{1,20}$/,
  'Nightly config startup requires a numeric workflow identity'
);

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json' } });
  assert.ok(response.ok, `Public mainnet qualification read failed (${response.status})`);
  return response.json();
}

const document = await json('https://raw.githubusercontent.com/0xMiden/wallet-config/main/mainnet.json');
const service = document?.swap?.oneClick?.serviceUrl ?? 'https://1click.chaindefuser.com';
assert.equal(typeof service, 'string', 'Invalid public 1Click service');
const url = new URL(service);
assert.ok(
  url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash,
  'Qualification requires a real public HTTPS provider'
);
const [catalog, tokenList] = await Promise.all([
  json(`${service.replace(/\/+$/, '')}/v0/tokens`),
  json('https://raw.githubusercontent.com/0xMiden/token-list/main/mainnet.json')
]);
const snapshot = qualifyMainnetLoopConfig(document, catalog, tokenList);
const server = await startMainnetLoopConfigServer(snapshot);
const address = server.address();
assert.ok(address && typeof address !== 'string', 'Missing owned loopback listener');
const source = `http://127.0.0.1:${address.port}`;
appendFileSync(process.env.GITHUB_ENV, `MIDEN_REMOTE_CONFIG_URL=${source}\n`);
process.once('SIGTERM', () => server.close());
console.log(`Nightly mainnet snapshot ready at ${source}`);
