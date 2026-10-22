import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';

import { AGGLAYER_BRIDGE_ADDRESS, MOCK_USDC_ADDRESS } from '../ios/helpers/evm-doubles';
import { getUsdcxXReserveSource, USDCX_REMOTE_DOMAIN } from './usdcx-config';

/**
 * Serves the wallet's remote Epoch and Agglayer config document (`/<network>.json`, the shape
 * 0xMiden/wallet-config publishes) from the test, so a hermetic suite controls every value and
 * switch. E2E builds read it from `MIDEN_REMOTE_CONFIG_URL`, which the suites' workflows and
 * package.json scripts set to `FAKE_BRIDGE_CONFIG_URL`, so the port here is fixed.
 */
export const FAKE_BRIDGE_CONFIG_PORT = 8550;
export const FAKE_BRIDGE_CONFIG_URL = `http://127.0.0.1:${FAKE_BRIDGE_CONFIG_PORT}`;

/** Where wallets read the published documents (0xMiden/wallet-config, branch main). */
export const PUBLISHED_BRIDGE_CONFIG_URL = 'https://raw.githubusercontent.com/0xMiden/wallet-config/main';

/** The fake allocator (:8548) and positions service (:8549) every hermetic suite starts. */
const FAKE_ALLOCATOR_URL = 'http://127.0.0.1:8548';
const FAKE_POSITIONS_URL = 'http://127.0.0.1:8549';
const SEPOLIA_CHAIN_ID = 11155111;

export type BridgeConfigDocument = import('../../../src/lib/remote-config/schema').BridgeConfig;

/**
 * Earn and Guardian Fast bridge-out on the local node. No `midenUsdcFaucet`: each test creates its
 * collateral faucet and hands it over with `__TEST_SET_EARN_FAUCET__`. No `agglayer` section: the
 * local node's bridge account is not one the harness uses, so the Slow routes read "not configured".
 */
export function localnetEpochDocument(): BridgeConfigDocument {
  return {
    network: 'localnet',
    version: 1,
    'bridge-providers': {
      epoch: { allocatorUrl: FAKE_ALLOCATOR_URL, positionsUrl: FAKE_POSITIONS_URL },
      agglayer: {},
      usdcx: {}
    },
    supportedEvmChains: {
      sepolia: {
        chainId: SEPOLIA_CHAIN_ID,
        bridges: {
          epoch: {
            depositEnabled: true,
            withdrawalEnabled: true,
            tokens: { USDC: { contractAddress: MOCK_USDC_ADDRESS, outputs: [] } }
          }
        }
      }
    },
    features: { earn: true, nearIntents: false }
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function publishedText(published: Record<string, unknown>, section: string, field: string): string {
  const values = published[section];
  const value = isRecord(values) ? values[field] : undefined;
  if (typeof value !== 'string' || value === '') {
    throw new Error(`the published testnet document has no ${section}.${field}, which the bridge-in suite reads`);
  }
  return value;
}

/**
 * Bridge-in on iOS: the Miden leg is live testnet, so its bridge account, indexer and USDC faucet
 * come from the published `testnet.json`; the EVM leg is the local Anvil, whose mocks sit at the
 * bridge and USDC addresses this document names, and the allocator is the local fake.
 */
export function testnetBridgeInDocument(published: unknown): BridgeConfigDocument {
  if (!isRecord(published) || published.network !== 'testnet') {
    throw new Error('the published testnet document is not a testnet config object');
  }
  const providers = published['bridge-providers'];
  const chains = published.supportedEvmChains;
  const sepolia = isRecord(chains) ? chains.sepolia : undefined;
  const bridges = isRecord(sepolia) ? sepolia.bridges : undefined;
  const agglayer = isRecord(bridges) ? bridges.agglayer : undefined;
  const epoch = isRecord(providers) ? providers.epoch : undefined;
  const outputs = isRecord(epoch) ? epoch.outputs : undefined;
  const output = isRecord(outputs) ? outputs['usdc-testnet-output'] : undefined;
  const bridgeId =
    isRecord(agglayer) && typeof agglayer.midenBridgeId === 'string'
      ? agglayer.midenBridgeId
      : publishedText(published, 'agglayer', 'midenBridge');
  const indexerUrl = isRecord(providers)
    ? publishedText(providers, 'agglayer', 'indexerUrl')
    : publishedText(published, 'agglayer', 'indexerUrl');
  const faucetId =
    isRecord(output) && typeof output.faucetId === 'string'
      ? output.faucetId
      : publishedText(published, 'epoch', 'midenUsdcFaucet');
  const local = localnetEpochDocument();
  const circle = getUsdcxXReserveSource(SEPOLIA_CHAIN_ID);
  return {
    ...local,
    network: 'testnet',
    version: typeof published.version === 'number' ? published.version : 1,
    'bridge-providers': {
      ...local['bridge-providers'],
      epoch: { ...local['bridge-providers'].epoch, outputs: { 'usdc-testnet-output': { faucetId } } },
      agglayer: { indexerUrl },
      usdcx: {
        midenDomain: USDCX_REMOTE_DOMAIN,
        attestationUrl: circle.attestationApi,
        irisUrl: 'https://iris-api-sandbox.circle.com'
      }
    },
    supportedEvmChains: {
      sepolia: {
        chainId: SEPOLIA_CHAIN_ID,
        bridges: {
          epoch: {
            depositEnabled: true,
            withdrawalEnabled: true,
            tokens: { USDC: { contractAddress: MOCK_USDC_ADDRESS, outputs: ['usdc-testnet-output'] } }
          },
          usdcx: {
            depositEnabled: true,
            withdrawalEnabled: true,
            domain: circle.domain,
            tokens: { USDC: { contractAddress: circle.usdc } },
            deposit: { route: 'xreserve', xReserve: circle.xReserve }
          },
          agglayer: {
            depositEnabled: true,
            withdrawalEnabled: true,
            contractAddress: AGGLAYER_BRIDGE_ADDRESS,
            midenBridgeId: bridgeId
          }
        }
      }
    }
  };
}

/** The document wallets on `network` read today. */
export async function fetchPublishedDocument(network: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const url = `${PUBLISHED_BRIDGE_CONFIG_URL}/${network}.json`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return res.json();
}

export interface BridgeConfigRequestLog {
  method: string;
  path: string;
  receivedAt: number;
}

export class FakeBridgeConfig {
  private server?: Server;
  private readonly documents = new Map<string, BridgeConfigDocument>();
  /** Every request served, for assertions. */
  readonly requests: BridgeConfigRequestLog[] = [];

  constructor(private readonly port: number = FAKE_BRIDGE_CONFIG_PORT) {}

  get baseUrl(): string {
    const address = this.server?.address();
    const port = address && typeof address === 'object' ? address.port : this.port;
    return `http://127.0.0.1:${port}`;
  }

  /**
   * Serve `document` as `/<document.network>.json`. A wallet accepts a replacement only above the
   * version it already holds (at that version, only the same document), so a test that changes a
   * document mid-run raises its version.
   */
  setDocument(document: BridgeConfigDocument): void {
    this.documents.set(document.network, structuredClone(document));
  }

  removeDocument(network: string): void {
    this.documents.delete(network);
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => resolve());
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const method = req.method ?? 'GET';
    const path = (req.url ?? '').split('?')[0] ?? '';
    this.requests.push({ method, path, receivedAt: Date.now() });
    // The extension pages run cross-origin isolated, and the service worker fetches too.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    const match = /^\/([a-z]+)\.json$/.exec(path);
    const document = method === 'GET' && match?.[1] ? this.documents.get(match[1]) : undefined;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (!document) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: `no document at ${path}` }));
      return;
    }
    res.statusCode = 200;
    res.end(JSON.stringify(document));
  }
}
