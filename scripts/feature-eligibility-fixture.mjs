import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const PUBLISHED_SOURCE = 'https://raw.githubusercontent.com/0xMiden/wallet-config/main';
const NETWORKS = new Set(['mainnet', 'testnet', 'devnet', 'localnet']);
const MODES = new Set(['allowed', 'restricted', 'unavailable', 'loading']);
const HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'cache-control': 'no-store',
  'content-type': 'application/json',
  'cross-origin-resource-policy': 'cross-origin'
};

const localnetDocument = () => ({
  network: 'localnet',
  version: 1,
  'bridge-providers': { epoch: {}, agglayer: {}, usdcx: {} },
  supportedEvmChains: {},
  features: { earn: false },
  geo: { wallet: {} }
});

function enrich(document, network) {
  if (!document || document.network !== network || !Number.isSafeInteger(document.version) || document.version < 1) {
    throw new Error('invalid fixture policy');
  }
  return { ...document, geo: { ...document.geo, wallet: document.geo?.wallet ?? {} } };
}

/** Real HTTP decisions for explicitly compiled E2E builds, shared by page and background realms. */
export async function createEligibilityFixture({
  networks = ['mainnet', 'testnet', 'devnet'],
  source = PUBLISHED_SOURCE,
  lazySource = false,
  fetchImpl = fetch,
  onRequestWaiting
} = {}) {
  if (!networks.length || networks.some(network => !NETWORKS.has(network))) throw new Error('invalid fixture networks');
  const selected = new Set(networks);
  const documents = new Map();
  const waiting = new Set();
  let mode = 'allowed';
  const readSource = async network => {
    const response = await fetchImpl(`${source.replace(/\/$/, '')}/${network}.json`, {
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error('fixture policy source failed');
    return enrich(await response.json(), network);
  };
  if (!lazySource) {
    await Promise.all(
      networks.map(async network => {
        documents.set(network, network === 'localnet' ? localnetDocument() : await readSource(network));
      })
    );
  }
  const read = async network => documents.get(network) ?? (lazySource ? readSource(network) : undefined);
  const send = (response, status, body) => {
    response.writeHead(status, HEADERS);
    response.end(JSON.stringify(body));
  };
  const readBody = async request => {
    let bytes = 0;
    const chunks = [];
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 256 * 1024) throw new Error('fixture body too large');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  const answer = async (response, network) => {
    if (response.destroyed) return;
    if (mode === 'loading') {
      const pending = { response, network };
      waiting.add(pending);
      onRequestWaiting?.();
      response.once('close', () => waiting.delete(pending));
      return;
    }
    if (mode === 'unavailable') return send(response, 503, { error: 'eligibility_unavailable' });
    try {
      const document = await read(network);
      const wallet = mode === 'allowed';
      send(response, 200, {
        network,
        version: document.version,
        allowed: {
          wallet,
          earn: wallet && document.features?.earn === true,
          swap: wallet && typeof document.swap?.etaUrl === 'string' && document.swap.etaUrl.length > 0
        }
      });
    } catch {
      send(response, 503, { error: 'eligibility_unavailable' });
    }
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    try {
      if (request.method === 'OPTIONS') return send(response, 204, undefined);
      if (request.method === 'GET' && url.pathname === '/healthz') return send(response, 200, { ready: true });
      if (request.method === 'POST' && url.pathname === '/_fixture/response') {
        const { state } = await readBody(request);
        if (!MODES.has(state)) return send(response, 400, { error: 'invalid_state' });
        mode = state;
        send(response, 200, { state });
        const pending = [...waiting];
        waiting.clear();
        pending.forEach(({ response, network }) => void answer(response, network));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/_fixture/config') {
        const document = await readBody(request);
        if (!selected.has(document.network)) return send(response, 400, { error: 'invalid_network' });
        documents.set(document.network, enrich(document, document.network));
        return send(response, 200, { network: document.network, version: document.version });
      }
      const configNetwork = /^\/(mainnet|testnet|devnet|localnet)\.json$/.exec(url.pathname)?.[1];
      if (request.method === 'GET' && configNetwork && selected.has(configNetwork)) {
        return send(response, 200, await read(configNetwork));
      }
      if (request.method === 'GET' && url.pathname === '/v1/eligibility') {
        const network = url.searchParams.get('network');
        if (!selected.has(network) || [...url.searchParams.keys()].length !== 1) {
          return send(response, 400, { error: 'invalid_request' });
        }
        return await answer(response, network);
      }
      send(response, 404, { error: 'not_found' });
    } catch {
      send(response, 400, { error: 'invalid_fixture_request' });
    }
  });
  return {
    get url() {
      return `http://127.0.0.1:${server.address().port}`;
    },
    listen: port =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      }),
    close: () =>
      new Promise((resolve, reject) => {
        waiting.forEach(({ response }) => response.destroy());
        server.close(error => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      })
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = key => args[args.indexOf(key) + 1];
  const fixture = await createEligibilityFixture({
    networks: args.includes('--networks') ? value('--networks').split(',') : undefined,
    source: args.includes('--source') ? value('--source') : undefined,
    lazySource: args.includes('--lazy-source')
  });
  await fixture.listen(args.includes('--port') ? Number(value('--port')) : 8551);
  process.stdout.write(`Eligibility fixture listening at ${fixture.url}\n`);
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => void fixture.close().then(() => process.exit(0)));
}
