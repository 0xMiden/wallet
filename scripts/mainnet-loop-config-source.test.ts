/** @jest-environment node */
import {
  loadMainnetOneClickSetup,
  MAINNET_WALLET_CONFIG_URL
} from '../playwright/e2e/helpers/mainnet-one-click-config';
import testnet from '../src/lib/remote-config/testing/testnet.json';
import { readMainnetFaucetMetadata } from '../playwright/e2e/helpers/mainnet-miden-read';

jest.mock('../playwright/e2e/helpers/mainnet-miden-read', () => ({ readMainnetFaucetMetadata: jest.fn() }));

const originalNetwork = process.env.E2E_NETWORK;
const originalUrl = process.env.MIDEN_REMOTE_CONFIG_URL;
afterEach(() => {
  if (originalNetwork === undefined) delete process.env.E2E_NETWORK;
  else process.env.E2E_NETWORK = originalNetwork;
  if (originalUrl === undefined) delete process.env.MIDEN_REMOTE_CONFIG_URL;
  else process.env.MIDEN_REMOTE_CONFIG_URL = originalUrl;
  jest.clearAllMocks();
});
const fetcher = () =>
  jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ ...testnet, network: 'mainnet', features: { ...testnet.features, nearIntents: false } })
  });

it('uses the same loopback snapshot as the E2E build, without enabling the published wallet config', async () => {
  process.env.E2E_NETWORK = 'mainnet';
  process.env.MIDEN_REMOTE_CONFIG_URL = 'http://127.0.0.1:8557/';
  const read = fetcher();
  await expect(loadMainnetOneClickSetup(read)).resolves.toBeUndefined();
  expect(read).toHaveBeenCalledWith('http://127.0.0.1:8557/mainnet.json', { headers: { Accept: 'application/json' } });
});
it('retains the published source when no qualification override exists', async () => {
  delete process.env.MIDEN_REMOTE_CONFIG_URL;
  const read = fetcher();
  await loadMainnetOneClickSetup(read);
  expect(read).toHaveBeenCalledWith(MAINNET_WALLET_CONFIG_URL, { headers: { Accept: 'application/json' } });
});
it.each(['http://evil.example', 'http://127.0.0.1:8557/?token=x', 'http://user@127.0.0.1:8557'])(
  'refuses an unowned or credential-bearing qualification source: %s',
  async url => {
    process.env.E2E_NETWORK = 'mainnet';
    process.env.MIDEN_REMOTE_CONFIG_URL = url;
    const read = fetcher();
    await expect(loadMainnetOneClickSetup(read)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  }
);
it.each([true, false])('uses native Node faucet metadata, refusing unavailable public state (%s)', async available => {
  process.env.E2E_NETWORK = 'mainnet';
  delete process.env.MIDEN_REMOTE_CONFIG_URL;
  const faucetId = '0xe69e6ca6e39df1b10c1e5399399feb';
  const usdc = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
  const metadata = jest.mocked(readMainnetFaucetMetadata);
  if (available) metadata.mockResolvedValue({ symbol: 'USDCX', decimals: 6 });
  else metadata.mockRejectedValue(new Error('Public faucet state unavailable'));
  const read = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      ...testnet,
      network: 'mainnet',
      features: { ...testnet.features, nearIntents: true },
      nearIntents: {
        serviceUrl: 'https://one-click.example',
        midenAssets: { usdcx: { assetId: 'miden:usdcx', faucetId, decimals: 6 } },
        chains: {
          arb: {
            name: 'Arbitrum',
            addressKind: 'evm',
            tokens: { USDC: { assetId: 'arb:usdc', decimals: 6, contractAddress: usdc, miden: ['usdcx'] } }
          }
        }
      }
    })
  });
  const catalog = jest.fn().mockResolvedValue(
    new Response(
      JSON.stringify([
        { assetId: 'miden:usdcx', blockchain: 'miden', symbol: 'USDCX', decimals: 6 },
        { assetId: 'arb:usdc', blockchain: 'arb', symbol: 'USDC', decimals: 6, contractAddress: usdc }
      ])
    )
  );
  const setup = await loadMainnetOneClickSetup(read, catalog);
  expect(metadata).toHaveBeenCalledWith(faucetId, 'https://rpc.mainnet.miden.io');
  if (available) {
    expect(setup?.assets).toEqual([
      expect.objectContaining({ assetId: 'arb:usdc', chainId: 42161, contractAddress: usdc }),
      expect.objectContaining({ faucetId, symbol: 'USDCX', decimals: 6 })
    ]);
    expect(setup?.catalog.chains.map(chain => chain.id)).toEqual(['arb']);
  } else expect(setup).toBeUndefined();
});
it('refuses a mainnet qualification override in another network', async () => {
  process.env.E2E_NETWORK = 'testnet';
  process.env.MIDEN_REMOTE_CONFIG_URL = 'http://127.0.0.1:8557';
  await expect(loadMainnetOneClickSetup(fetcher())).rejects.toThrow();
});
