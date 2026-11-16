import { deserialize, serialize } from 'v8';

import type { BridgeRoute } from '../core/routes';
import type { DerivedBridgeConfig, DerivedChainConfig } from 'lib/remote-config/derive';
import { parseStoredDerived } from 'lib/remote-config/derived-snapshot';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { parseBridgeConfig, type EvmAddress } from 'lib/remote-config/schema';

import connections from './portal-connections.json';
import mainnet from './portal-mainnet.json';
import testnet from './portal-testnet.json';

// jsdom omits the browser's structured-clone API; preserve its bigint semantics at the platform boundary.
const cloneDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'structuredClone');
beforeAll(() =>
  Object.defineProperty(globalThis, 'structuredClone', {
    configurable: true,
    value: <T>(value: T): T => deserialize(serialize(value))
  })
);
afterAll(() => {
  if (cloneDescriptor) Object.defineProperty(globalThis, 'structuredClone', cloneDescriptor);
  else Reflect.deleteProperty(globalThis, 'structuredClone');
});

export { connections };
export const now = 1_800_000_000_000;
export const accounts = {
  midenAccount: '0x387149ae66116cf114eebd60bb7381',
  evmAddress: '0x1111111111111111111111111111111111111111'
};
export const native = {
  faucetId: testnet.derived.usdcxFaucetId,
  symbol: 'USDCx',
  decimals: 6,
  scope: 'test-rpc|testnet',
  revision: 1
};

function address(value: string): EvmAddress {
  if (!/^0x[\da-f]{40}$/i.test(value)) throw new Error('Invalid reference address');
  return `0x${value.slice(2).toLowerCase()}`;
}

// Models acceptance of the portal rollout ONLY in tests. Runtime never loads this fixture or overrides a gate.
export function referenceSnapshot(network: 'mainnet' | 'testnet'): BridgeConfigSnapshot {
  const reference = network === 'mainnet' ? mainnet : testnet;
  const document: typeof reference.document = deserialize(serialize(reference.document));
  document.features.fastBridge = true;
  const config = parseBridgeConfig(document, network);
  if (!config) throw new Error('Invalid pinned reference document');
  config.features.fastBridge = true;
  if (network === 'mainnet') config['bridge-providers'].epoch.allocatorUrl = 'https://mainnet-api.epochprotocol.xyz';
  config['bridge-providers'].epoch.positionsUrl = 'https://positions.example';
  config.limits = { bridgeInMaxBalanceUsd: 1232.462 };
  const chains: Record<number, DerivedChainConfig> = {};
  for (const connection of connections[network]) {
    if (connection.disabled || (connection.provider === 'epoch' && !connection.routes.receive)) continue;
    const slug = connection.evm.network;
    const chainIds: Record<string, number> = {
      ethereum: 1,
      base: 8453,
      arbitrum: 42161,
      polygon: 137,
      robinhood: 4663,
      arc: 5042,
      sepolia: 11155111,
      'arc-testnet': 5042002,
      'base-sepolia': 84532,
      'arbitrum-sepolia': 421614
    };
    const chainId = chainIds[slug];
    const chain = config.supportedEvmChains[slug] ?? { chainId, bridges: {} };
    config.supportedEvmChains[slug] = chain;
    const reads =
      chains[chainId] ??
      ({
        agglayer: {
          rollupId: { state: 'ok', value: reference.derived.rollupId },
          tokens: { state: 'ok', value: [] },
          evmNetworkId: { state: 'ok', value: 0 },
          l1BridgeCode: { state: 'ok', value: true },
          depositTokens: { state: 'ok', value: [] }
        },
        epoch: { tokens: {} }
      } satisfies DerivedChainConfig);
    chains[chainId] = reads;
    if (connection.provider === 'epoch') {
      const epoch = chain.bridges.epoch ?? { depositEnabled: true, withdrawalEnabled: true, tokens: {} };
      chain.bridges.epoch = epoch;
      config['bridge-providers'].epoch.outputs = {
        ...config['bridge-providers'].epoch.outputs,
        [connection.miden.symbol]: { faucetId: connection.miden.faucetId }
      };
      epoch.tokens[connection.evm.symbol] = {
        contractAddress: address('address' in connection.evm ? connection.evm.address : `0x${'0'.repeat(40)}`),
        outputs: [connection.miden.symbol]
      };
      reads.epoch.tokens[connection.evm.symbol] = {
        state: 'ok',
        value: {
          symbol: connection.evm.symbol,
          decimals: connection.evm.decimals,
          midenFaucetId: connection.miden.faucetId,
          midenSymbol: connection.miden.symbol,
          midenDecimals: connection.miden.decimals
        }
      };
    }
    if (connection.provider === 'agglayer') {
      const originToken = address('address' in connection.evm ? connection.evm.address : `0x${'0'.repeat(40)}`);
      const scale = connection.evm.decimals - connection.miden.decimals;
      if (reads.agglayer.tokens.state === 'ok')
        reads.agglayer.tokens.value.push({
          midenFaucetId: connection.miden.faucetId,
          originToken,
          originNetwork: 0,
          scale
        });
      if ('address' in connection.evm && reads.agglayer.depositTokens.state === 'ok') {
        const bridge = chain.bridges.agglayer;
        if (!bridge) throw new Error('Missing reference AggLayer deployment');
        bridge.tokens = { ...bridge.tokens, [connection.evm.symbol]: { contractAddress: originToken } };
        reads.agglayer.depositTokens.value.push({
          symbol: connection.evm.symbol,
          contractAddress: originToken,
          decimals: connection.evm.decimals,
          midenFaucetId: connection.miden.faucetId,
          scale
        });
      }
    }
  }
  const derived: DerivedBridgeConfig = {
    network,
    version: config.version,
    derivedAt: now,
    chains,
    agglayer: { indexer: { state: 'ok', value: true } },
    swap: { pairs: { state: 'skipped' } },
    epoch: {
      allocator: { state: 'ok', value: true },
      allocatorAccount: { state: 'ok', value: { accountId: accounts.midenAccount } },
      market: { state: 'skipped' },
      midenUsdcFaucet: { state: 'skipped' },
      vaults: { state: 'skipped' }
    }
  };
  const accepted = parseBridgeConfig(config, network);
  const acceptedDerived = parseStoredDerived(derived, network, config.version);
  expect(accepted).toEqual(config);
  expect(acceptedDerived).toEqual(derived);
  if (!accepted || !acceptedDerived) throw new Error('Reference fixture cannot be accepted');
  return { network, status: 'ready', config: accepted, derived: acceptedDerived, lastFetch: null };
}

export function testRoute(mode: 'receive' | 'send' = 'receive'): BridgeRoute {
  const snapshot = referenceSnapshot('testnet');
  if (!snapshot.config || !snapshot.derived) throw new Error('Missing test configuration');
  const evm = { kind: 'native', network: 'sepolia', symbol: 'ETH', decimals: 18 } satisfies BridgeRoute['source'];
  const miden = {
    kind: 'miden',
    network: 'miden-testnet',
    symbol: 'ETH',
    decimals: 8,
    faucetId: testnet.derived.eth.faucetId
  } satisfies BridgeRoute['source'];
  return {
    id: `test:agglayer:${mode}`,
    provider: 'agglayer',
    mode,
    source: mode === 'receive' ? evm : miden,
    destination: mode === 'receive' ? miden : evm,
    recovery: { network: 'testnet', config: snapshot.config, derived: snapshot.derived }
  };
}
