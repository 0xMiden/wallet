import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import type { BridgeNetwork } from 'screens/send-flow/bridge-networks';

import { relayTokenChoiceId, relayTokenChoices } from './relay-token-choices';

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
  selectEpochDepositTokens: (_snapshot: unknown, chainId: number) => [
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
  ]
}));

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
  isUsdcxRouteEnabled: (chainId: number) => mockCircleChains.includes(chainId)
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
    expect(choices[2]?.token).toEqual({ kind: 'erc20', contractAddress: LINK });
    expect(choices[3]?.option.network).toEqual({ id: 'base', name: 'Base' });
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
      option: {
        id: '1:CIRCLE_USDC',
        symbol: 'USDC',
        receivedSymbol: 'USDCx',
        logoFaucetId: 'usdcx-faucet',
        network: { id: 'ethereum', name: 'Ethereum' }
      }
    });
  });

  it('names a token on a chain by its key', () => {
    expect(relayTokenChoiceId(8453, { kind: 'epoch', key: 'POL' })).toBe('8453:EPOCH_POL');
  });
});
