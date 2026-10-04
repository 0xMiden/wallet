/**
 * @jest-environment node
 */
import { parseBridgeConfig } from 'lib/remote-config/schema';

import {
  FakeBridgeConfig,
  fetchPublishedDocument,
  localnetEpochDocument,
  PUBLISHED_BRIDGE_CONFIG_URL,
  testnetBridgeInDocument
} from './fake-bridge-config';

const PUBLISHED_TESTNET = {
  network: 'testnet',
  version: 4,
  evm: { chainId: 11155111 },
  agglayer: {
    l1Bridge: '0x1348947e282138d8f377b467f7d9c2eb0f335d1f',
    midenBridge: '0x3b66e20b5088f25133b69216484652',
    indexerUrl: 'https://miden-testnet-bridge.dev.eu-north-3.gateway.fm/api'
  },
  epoch: {
    allocatorUrl: 'https://testnet-dev.epochprotocol.xyz',
    positionsUrl: 'https://positions-testnet-dev.epochprotocol.xyz',
    midenUsdcFaucet: '0x537c15a622074e91188aa894456c52',
    evmUsdc: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69',
    earnProtocol: 'dummy-lending'
  },
  features: { earn: false, fastBridge: false, bridgeIn: false, bridgeOut: false }
};

describe('served documents', () => {
  // The wallet's own parser, as an E2E build runs it: a document it refuses would leave every
  // feature "not configured" and each suite timing out on a greyed-out control.
  it('the localnet Epoch document passes the wallet parser with Earn and Fast on', () => {
    const config = parseBridgeConfig(localnetEpochDocument(), 'localnet', { allowLocalHttp: true });
    expect(config?.features).toEqual({ earn: true, fastBridge: true, bridgeIn: false, bridgeOut: false });
    expect(config?.epoch.allocatorUrl).toBe('http://127.0.0.1:8548');
    expect(config?.epoch.positionsUrl).toBe('http://127.0.0.1:8549');
    expect(config?.epoch.midenUsdcFaucet).toBeUndefined();
    expect(config?.agglayer).toEqual({});
  });

  it('the bridge-in document takes the Miden side from the published one and the EVM side from Anvil', () => {
    const document = testnetBridgeInDocument(PUBLISHED_TESTNET);
    const config = parseBridgeConfig(document, 'testnet', { allowLocalHttp: true });
    expect(config?.agglayer.midenBridge).toBe('0x3b66e20b5088f25133b69216484652');
    expect(config?.agglayer.indexerUrl).toBe('https://miden-testnet-bridge.dev.eu-north-3.gateway.fm/api');
    expect(config?.epoch.midenUsdcFaucet).toBe('0x537c15a622074e91188aa894456c52');
    expect(config?.epoch.allocatorUrl).toBe('http://127.0.0.1:8548');
    expect(config?.features).toEqual({ earn: true, fastBridge: true, bridgeIn: true, bridgeOut: true });
    expect(document.version).toBe(4);
  });

  it('refuses a published document that lacks a value the bridge-in suite reads', () => {
    const published = { ...PUBLISHED_TESTNET, agglayer: { indexerUrl: PUBLISHED_TESTNET.agglayer.indexerUrl } };
    expect(() => testnetBridgeInDocument(published)).toThrow('has no agglayer.midenBridge');
    expect(() => testnetBridgeInDocument({ ...PUBLISHED_TESTNET, network: 'devnet' })).toThrow('not a testnet');
  });
});

describe('fetchPublishedDocument', () => {
  it('reads <network>.json from the published repo', async () => {
    const fetchImpl = jest.fn(async () => Response.json(PUBLISHED_TESTNET));
    await expect(fetchPublishedDocument('testnet', fetchImpl)).resolves.toEqual(PUBLISHED_TESTNET);
    expect(fetchImpl).toHaveBeenCalledWith(`${PUBLISHED_BRIDGE_CONFIG_URL}/testnet.json`, expect.anything());
  });

  it('fails on an HTTP error instead of serving nothing', async () => {
    await expect(fetchPublishedDocument('testnet', async () => new Response('nope', { status: 404 }))).rejects.toThrow(
      'HTTP 404'
    );
  });
});

describe('FakeBridgeConfig', () => {
  const server = new FakeBridgeConfig(0);

  beforeAll(() => server.start());
  afterAll(() => server.stop());

  it('serves a document at /<network>.json with CORS', async () => {
    server.setDocument(localnetEpochDocument());
    const res = await fetch(`${server.baseUrl}/localnet.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    await expect(res.json()).resolves.toEqual(localnetEpochDocument());
  });

  it('answers 404 for a network it does not serve, like the published repo', async () => {
    server.removeDocument('localnet');
    const res = await fetch(`${server.baseUrl}/localnet.json`);
    expect(res.status).toBe(404);
  });

  it('serves a copy, so a test editing its object does not change what was served', async () => {
    const document = localnetEpochDocument();
    server.setDocument(document);
    document.features.earn = false;
    const res = await fetch(`${server.baseUrl}/localnet.json`);
    await expect(res.json()).resolves.toMatchObject({ features: { earn: true } });
  });

  it('answers a preflight', async () => {
    const res = await fetch(`${server.baseUrl}/localnet.json`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
  });
});
