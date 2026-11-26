import { TEST_BRIDGE_CONFIG, TEST_BRIDGE_CONFIG_SNAPSHOT } from 'lib/epoch/testing/bridge-config';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import type { BridgeNetwork } from 'screens/send-flow/bridge-networks';

import { depositSourceNetworks, relayTokenChoiceId, relayTokenChoices } from './relay-token-choices';

const AGGLAYER_CHAIN = 1;
const EPOCH_ONLY_CHAIN = 8453;
const LINK = '0x00000000000000000000000000000000000000d0';

jest.mock('lib/remote-config/token-labels', () => ({ evmUsdcLabel: () => 'Test Epoch USDC' }));
jest.mock('lib/remote-config/values', () => ({
  selectAgglayerChain: (_snapshot: unknown, chainId: number) => (chainId === 1 ? { chainId } : null),
  selectNativeEthFaucet: (_snapshot: unknown, chainId: number) => (chainId === 1 ? 'eth-faucet' : null),
  selectAgglayerDepositTokens: () => [
    { symbol: 'USDC', contractAddress: '0x00000000000000000000000000000000000000c0', midenFaucetId: 'agg-usdc' },
    { symbol: 'LINK', contractAddress: '0x00000000000000000000000000000000000000d0', midenFaucetId: 'link-faucet' }
  ],
  // Chains 42 (Circle only) and 999 (nothing) have no Epoch route.
  selectEpochDepositTokens: (_snapshot: unknown, chainId: number) =>
    chainId === 42 || chainId === 999 ? [] : mockEpochTokens(chainId)
}));

function mockEpochTokens(chainId: number) {
  return [
    {
      key: 'ETH',
      address: '0x0000000000000000000000000000000000000000',
      symbol: 'ETH',
      midenSymbol: 'ETH',
      midenFaucetId: 'epoch-eth'
    },
    {
      key: 'USDC',
      address: '0x00000000000000000000000000000000000000C0',
      symbol: 'USDC',
      midenSymbol: chainId === 1 ? 'USDCx' : 'USDC',
      midenFaucetId: 'usdcx'
    }
  ];
}

// Circle takes deposits on a chain only when a case turns it on: its USDC is the contract of the Epoch USDC on chain 1.
let mockCircleChains: number[] = [];
jest.mock('lib/usdcx/constant', () => ({
  CIRCLE_USDC_SYMBOL: 'USDC',
  USDCX_SYMBOL: 'USDCx',
  usdcxSourceChains: () =>
    new Map([
      [1, { usdc: '0x00000000000000000000000000000000000000C0' }],
      [8453, { usdc: '0x00000000000000000000000000000000000000e0' }]
    ]),
  isUsdcxRouteEnabled: (chainId: number) => mockCircleChains.includes(chainId),
  listUsdcxSourceChains: () => [{ chain: { id: 42 } }]
}));

// The relay serves Ethereum and the Circle-only chain, not Base.
jest.mock('lib/evm-relay/source', () => ({
  relayServesChain: (chainId: number) => chainId === 1 || chainId === 42
}));

jest.mock('screens/send-flow/bridge-networks', () => ({
  getBridgeNetworkByChainId: (chainId: number) =>
    [
      { id: 'ethereum', name: 'Ethereum', chainId: 1 },
      { id: 'base', name: 'Base', chainId: 8453 },
      { id: 'arc', name: 'Arc', chainId: 42 },
      { id: 'nothing', name: 'Nothing', chainId: 999 }
    ].find(network => network.chainId === chainId)
}));

beforeEach(() => {
  mockCircleChains = [];
});

const SNAPSHOT: BridgeConfigSnapshot = {
  network: 'testnet',
  status: 'ready',
  config: null,
  derived: null,
  lastFetch: null
};
const NETWORKS: BridgeNetwork[] = [
  { id: 'ethereum', name: 'Ethereum', chainId: AGGLAYER_CHAIN },
  { id: 'base', name: 'Base', chainId: EPOCH_ONLY_CHAIN }
];

describe('relayTokenChoices', () => {
  it('offers ETH, the Epoch tokens and the other ERC-20s of each chain, in order', () => {
    const choices = relayTokenChoices(SNAPSHOT, NETWORKS);

    expect(choices.map(choice => choice.option.id)).toEqual([
      '1:ETH',
      '1:EPOCH_USDC',
      `1:ERC20_${LINK}`,
      '8453:EPOCH_ETH',
      '8453:EPOCH_USDC'
    ]);
    expect(choices[0]).toEqual({
      chainId: AGGLAYER_CHAIN,
      token: 'ETH',
      address: '0x0000000000000000000000000000000000000000',
      // The Epoch route lists the native coin on this chain too.
      routes: ['agglayer', 'epoch'],
      option: {
        id: '1:ETH',
        symbol: 'ETH',
        receivedSymbol: 'ETH',
        logoFaucetId: 'eth-faucet',
        network: { id: 'ethereum', name: 'Ethereum' }
      }
    });
    expect(choices[1]?.option).toMatchObject({
      symbol: 'Test Epoch USDC',
      receivedSymbol: 'USDCx',
      logoFaucetId: 'usdcx'
    });
    // The Epoch USDC also takes the AggLayer route of its chain; the address is in lower case.
    expect(choices[1]).toMatchObject({
      address: '0x00000000000000000000000000000000000000c0',
      routes: ['agglayer', 'epoch']
    });
    expect(choices[2]?.token).toEqual({ kind: 'erc20', contractAddress: LINK });
    expect(choices[2]?.routes).toEqual(['agglayer']);
    expect(choices[3]?.option.network).toEqual({ id: 'base', name: 'Base' });
    // No AggLayer route on Base: its Epoch tokens take Epoch alone.
    expect(choices[3]?.routes).toEqual(['epoch']);
    expect(choices[4]?.routes).toEqual(['epoch']);
  });

  it('offers Circle USDC first where the Circle route takes deposits, as the row of the Epoch token at its contract', () => {
    mockCircleChains = [1, 8453];
    const choices = relayTokenChoices(SNAPSHOT, NETWORKS, 'usdcx-faucet');

    expect(choices.map(choice => choice.option.id)).toEqual([
      '1:CIRCLE_USDC',
      '1:ETH',
      `1:ERC20_${LINK}`,
      '8453:CIRCLE_USDC',
      '8453:EPOCH_ETH',
      '8453:EPOCH_USDC'
    ]);
    expect(choices[0]).toEqual({
      chainId: AGGLAYER_CHAIN,
      token: 'CIRCLE_USDC',
      address: '0x00000000000000000000000000000000000000c0',
      // The Epoch USDC is at Circle's contract: Circle USDC takes Circle and Epoch.
      routes: ['usdcx', 'epoch'],
      option: {
        id: '1:CIRCLE_USDC',
        symbol: 'USDC',
        receivedSymbol: 'USDCx',
        logoFaucetId: 'usdcx-faucet',
        network: { id: 'ethereum', name: 'Ethereum' }
      }
    });
    // On Base no Epoch token is at Circle's contract: Circle alone.
    expect(choices[3]?.routes).toEqual(['usdcx']);
  });

  it('names a token on a chain by its key', () => {
    expect(relayTokenChoiceId(1, 'ETH')).toBe('1:ETH');
  });
});

describe('depositSourceNetworks', () => {
  const snapshot: BridgeConfigSnapshot = {
    ...TEST_BRIDGE_CONFIG_SNAPSHOT,
    config: {
      ...TEST_BRIDGE_CONFIG,
      supportedEvmChains: {
        ethereum: { chainId: 1, bridges: {} },
        base: { chainId: 8453, bridges: {} },
        arc: { chainId: 42, bridges: {} },
        nothing: { chainId: 999, bridges: {} },
        unknown: { chainId: 7, bridges: {} }
      }
    }
  };

  it('lists every chain that offers a deposit, in the document order, with a bridge network', () => {
    expect(depositSourceNetworks(snapshot, null).map(network => network.id)).toEqual(['ethereum', 'base', 'arc']);
  });

  it('lists only the chains that the relay service serves and the wallet can relay on, for a relay source', () => {
    expect(depositSourceNetworks(snapshot, [1, 42, 8453]).map(network => network.id)).toEqual(['ethereum', 'arc']);
  });

  it('lists no chain that the relay service does not serve', () => {
    expect(depositSourceNetworks(snapshot, [42]).map(network => network.id)).toEqual(['arc']);
    expect(depositSourceNetworks(snapshot, [])).toEqual([]);
  });

  it('lists no chain while the document is not loaded', () => {
    expect(depositSourceNetworks(SNAPSHOT, null)).toEqual([]);
  });
});

describe('relayTokenChoiceId', () => {
  it('names a token on a chain by its key', () => {
    expect(relayTokenChoiceId(8453, { kind: 'epoch', key: 'POL' })).toBe('8453:EPOCH_POL');
  });
});
