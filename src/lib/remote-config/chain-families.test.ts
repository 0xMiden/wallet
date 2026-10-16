import { listUsdcxDestinations, usdcxDestinations } from 'lib/usdcx/constant';
import { sendBridgeNetworks } from 'screens/send-flow/bridge-networks';

import { featureAvailability } from './availability';
import { getBridgeConfigSnapshot } from './runtime';
import { parseBridgeConfig } from './schema';
import document from './testing/chain-families.json';

jest.mock('./runtime', () => ({ getBridgeConfigSnapshot: jest.fn() }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => 'testnet' }));

function snapshot(enabled: boolean) {
  const chains = Object.fromEntries(
    Object.entries(document.chains).map(([slug, chain]) => [
      slug,
      {
        ...chain,
        bridges: { ...chain.bridges, usdcx: { ...chain.bridges.usdcx, withdrawalEnabled: enabled } }
      }
    ])
  );
  const config = parseBridgeConfig({ ...document, chains }, 'testnet');
  if (!config) throw new Error('Invalid test document');
  return { network: 'testnet', status: 'ready', config, derived: null, lastFetch: null } satisfies ReturnType<
    typeof getBridgeConfigSnapshot
  >;
}

it('reads all ten routes from chains and preserves Circle domain zero', () => {
  const state = snapshot(true);
  jest.mocked(getBridgeConfigSnapshot).mockReturnValue(state);
  expect(state.config.supportedEvmChains.sepolia?.bridges.usdcx?.domain).toBe(0);
  expect(listUsdcxDestinations().map(entry => [entry.chain.id, entry.domain])).toEqual([
    [5042002, 26],
    [11155111, 0],
    [84532, 6],
    [421614, 3],
    [43113, 1],
    [11155420, 2],
    [80002, 7],
    [10143, 15],
    [998, 19],
    ['solana-devnet', 5]
  ]);
  expect(sendBridgeNetworks(true)).toHaveLength(10);
  expect(featureAvailability('usdcxWithdrawal', state, undefined, 'solana-devnet')).toEqual({ state: 'available' });
  expect(featureAvailability('fastBridgeOut', state, undefined, 'solana-devnet').state).toBe('unavailable');
});

it('keeps disabled routes for history but does not offer them', () => {
  const state = snapshot(false);
  jest.mocked(getBridgeConfigSnapshot).mockReturnValue(state);
  expect(listUsdcxDestinations()).toEqual([]);
  expect(usdcxDestinations().size).toBe(10);
  expect(featureAvailability('usdcxWithdrawal', state, undefined, 'solana-devnet')).toMatchObject({
    state: 'unavailable',
    reason: 'off'
  });
});

it('does not fall back to legacy routes when chains is empty', () => {
  expect(parseBridgeConfig({ ...document, chains: {} }, 'testnet')?.supportedEvmChains).toEqual({});
});

it.each([
  { cluster: 'mainnet-beta' },
  { chainId: 5 },
  { bridges: { usdcx: { ...document.chains['solana-devnet'].bridges.usdcx, domain: 6 } } },
  { bridges: { usdcx: { ...document.chains['solana-devnet'].bridges.usdcx, depositEnabled: true } } },
  {
    bridges: {
      usdcx: { ...document.chains['solana-devnet'].bridges.usdcx, tokens: { USDC: { mintAddress: 'wrong' } } }
    }
  }
])('rejects a Solana route with invalid metadata', patch => {
  const chains = { ...document.chains, 'solana-devnet': { ...document.chains['solana-devnet'], ...patch } };
  expect(parseBridgeConfig({ ...document, chains }, 'testnet')).toBeNull();
});
