import type { NearIntentsCatalog, NearIntentsCatalogChain, OneClickAsset } from 'lib/one-click/types';

import { depositPairs, firstNearPair, nearPairId, pairOfRelay } from './deposit-pairs';
import type { RelayTokenChoice } from './relay-token-choices';

// Faucet ids compare in one case here; the SDK form is not needed for the rule under test.
jest.mock('lib/miden/swap/faucet-ids', () => ({ normalizedFaucetId: (id: string) => id.toLowerCase() }));
jest.mock('screens/send-flow/bridge-networks', () => ({
  getBridgeNetworkByChainId: (chainId: number) =>
    [
      { id: 'ethereum', name: 'Ethereum', chainId: 1 },
      { id: 'base', name: 'Base', chainId: 8453 },
      { id: 'arbitrum', name: 'Arbitrum One', chainId: 42161 }
    ].find(network => network.chainId === chainId)
}));

const USDC_ETH = '0x00000000000000000000000000000000000000c1';
const USDT_ETH = '0x00000000000000000000000000000000000000d1';
const ZERO = '0x0000000000000000000000000000000000000000';

const ETHEREUM = { id: 'ethereum', name: 'Ethereum' };

const relayChoices: RelayTokenChoice[] = [
  {
    option: { id: '1:CIRCLE_USDC', symbol: 'USDC', receivedSymbol: 'USDCx', logoFaucetId: 'USDCX', network: ETHEREUM },
    chainId: 1,
    token: 'CIRCLE_USDC',
    address: USDC_ETH,
    routes: ['usdcx', 'epoch']
  },
  {
    option: { id: '1:ETH', symbol: 'ETH', receivedSymbol: 'ETH', logoFaucetId: undefined, network: ETHEREUM },
    chainId: 1,
    token: 'ETH',
    address: ZERO,
    routes: ['agglayer']
  }
];

function miden(id: string, symbol: string, faucetId?: string): OneClickAsset {
  return { assetId: `miden:${id}`, blockchain: 'miden', symbol, decimals: 6, ...(faucetId ? { faucetId } : {}) };
}

function chain(
  id: string,
  name: string,
  addressKind: NearIntentsCatalogChain['addressKind'],
  tokens: Array<[string, string | undefined, OneClickAsset[]]>
): NearIntentsCatalogChain {
  return {
    id,
    name,
    addressKind,
    tokens: tokens.map(([symbol, contractAddress, outputs]) => ({
      symbol,
      asset: {
        assetId: `${id}:${symbol}`,
        blockchain: id,
        symbol,
        decimals: 6,
        ...(contractAddress ? { contractAddress } : {})
      },
      outputs
    }))
  };
}

const catalog: NearIntentsCatalog = {
  chains: [
    chain('eth', 'Ethereum', 'evm', [
      // The relay's Circle USDC row: the same contract (letter case aside) and the same faucet.
      ['USDC', USDC_ETH.toUpperCase().replace('0X', '0x'), [miden('usdcx', 'USDCx', 'usdcx')]],
      // The relay's ETH row: the native coin, and the relay names no faucet, so the symbol decides.
      ['ETH', undefined, [miden('eth', 'ETH', 'eth-faucet')]],
      // A token the relay does not deposit.
      ['USDT', USDT_ETH, [miden('usdt', 'USDT', 'usdt')]]
    ]),
    // An EVM chain the relay does not serve: its own chip, with the bridge network's id.
    chain('arb', 'Arbitrum', 'evm', [['USDT0', '0xabc', [miden('usdt', 'USDT', 'usdt')]]]),
    chain('sol', 'Solana', 'solana', [
      ['SOL', undefined, [miden('wsol', 'wSOL', 'wsol')]],
      ['USDC', 'EPjF', [miden('usdcx', 'USDCx', 'usdcx'), miden('usdc2', 'USDC', 'usdc2')]]
    ]),
    // An EVM chain with no bridge network.
    chain('gnosis', 'Gnosis', 'evm', [['XDAI', undefined, [miden('xdai', 'XDAI', 'xdai')]]])
  ]
};

describe('depositPairs', () => {
  it('is the relay rows alone without a catalogue', () => {
    const pairs = depositPairs(relayChoices, [ETHEREUM], undefined);
    expect(pairs.networks).toEqual([ETHEREUM]);
    expect(pairs.pairs.map(pair => pair.option.id)).toEqual(['1:CIRCLE_USDC', '1:ETH']);
    expect(firstNearPair(pairs)).toBeUndefined();
  });

  it('joins a pair that both serve into the relay row, and adds every other pair with its network chip', () => {
    const pairs = depositPairs(relayChoices, [ETHEREUM], catalog);

    expect(pairs.networks).toEqual([
      ETHEREUM,
      { id: 'arbitrum', name: 'Arbitrum' },
      { id: 'solana', name: 'Solana' },
      { id: 'gnosis', name: 'Gnosis' }
    ]);
    const usdt = { chainId: 'eth', tokenAssetId: 'eth:USDT', outputAssetId: 'miden:usdt' };
    expect(pairs.pairs.map(pair => pair.option.id)).toEqual([
      '1:CIRCLE_USDC',
      '1:ETH',
      nearPairId(usdt),
      'near:arb:arb:USDT0:miden:usdt',
      'near:sol:sol:SOL:miden:wsol',
      'near:sol:sol:USDC:miden:usdcx',
      'near:sol:sol:USDC:miden:usdc2',
      'near:gnosis:gnosis:XDAI:miden:xdai'
    ]);
    expect(pairs.pairs[0]?.near).toEqual({ chainId: 'eth', tokenAssetId: 'eth:USDC', outputAssetId: 'miden:usdcx' });
    expect(pairs.pairs[1]?.near).toEqual({ chainId: 'eth', tokenAssetId: 'eth:ETH', outputAssetId: 'miden:eth' });
    expect(pairs.pairs[2]).toEqual({
      option: { id: nearPairId(usdt), symbol: 'USDT', receivedSymbol: 'USDT', logoFaucetId: 'usdt', network: ETHEREUM },
      near: usdt
    });
    expect(pairs.pairs[2]?.relay).toBeUndefined();
    expect(firstNearPair(pairs)?.option.id).toBe('1:CIRCLE_USDC');
    expect(pairOfRelay(pairs, '1:ETH')?.near?.tokenAssetId).toBe('eth:ETH');
    expect(pairOfRelay(pairs, nearPairId(usdt))).toBeUndefined();
  });

  it('keeps a NEAR Intents pair apart when it arrives as another Miden token', () => {
    const other: NearIntentsCatalog = {
      chains: [chain('eth', 'Ethereum', 'evm', [['USDC', USDC_ETH, [miden('usdc2', 'USDC', 'usdc2')]]])]
    };
    const pairs = depositPairs(relayChoices, [ETHEREUM], other);
    expect(pairs.pairs[0]?.near).toBeUndefined();
    expect(pairs.pairs.map(pair => pair.option.id)).toEqual([
      '1:CIRCLE_USDC',
      '1:ETH',
      'near:eth:eth:USDC:miden:usdc2'
    ]);
  });

  it('lists NEAR Intents alone when the relay is off', () => {
    const pairs = depositPairs([], [], catalog);
    expect(pairs.networks[0]).toEqual({ id: 'ethereum', name: 'Ethereum' });
    expect(pairs.pairs).toHaveLength(8);
    expect(pairs.pairs.every(pair => pair.relay === undefined)).toBe(true);
  });
});
