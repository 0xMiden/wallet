import type { DerivedBridgeConfig } from './derive';
import { _resetE2eOverridesForTest, setEarnCollateralFaucetOverride } from './e2e-overrides';
import { type BridgeConfigSnapshot, getBridgeConfigSnapshot } from './runtime';
import type { BridgeConfig } from './schema';
import {
  BridgeConfigUnavailableError,
  getAgglayerBridgeOut,
  getAgglayerDeposit,
  getAgglayerEvmNetworkId,
  getAgglayerIndexerUrl,
  getAgglayerL1Bridge,
  getAgglayerMidenBridge,
  getAgglayerRollupId,
  getEarnMarket,
  getEpochAllocatorUrl,
  getEpochPositionsUrl,
  getEvmChainId,
  findEvmUsdc,
  getEvmUsdc,
  getEvmUsdcAddress,
  getMidenUsdc,
  selectEarnMarket,
  selectEvmUsdc,
  selectMidenUsdc,
  selectMidenUsdcFaucetId,
  selectNativeEthFaucet,
  selectNativeEthToken
} from './values';

jest.mock('./runtime', () => ({ getBridgeConfigSnapshot: jest.fn() }));

const CONFIG: BridgeConfig = {
  network: 'testnet',
  version: 1,
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
    evmUsdc: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
    earnProtocol: 'dummy-lending'
  },
  features: { earn: true, fastBridge: true, bridgeIn: true, bridgeOut: true }
};
const ETH_FAUCET = '0x0b372f2735e33e91216d995bf29b91';
const DERIVED: DerivedBridgeConfig = {
  network: 'testnet',
  version: 1,
  derivedAt: 1_800_000_000_000,
  agglayer: {
    rollupId: { state: 'ok', value: 86 },
    tokens: {
      state: 'ok',
      value: [
        {
          midenFaucetId: '0x36bb3163d7ef0ad102f35bf507c61e',
          originToken: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
          originNetwork: 0,
          scale: 10
        },
        {
          midenFaucetId: ETH_FAUCET,
          originToken: '0x0000000000000000000000000000000000000000',
          originNetwork: 0,
          scale: 10
        }
      ]
    },
    evmNetworkId: { state: 'ok', value: 0 },
    l1BridgeCode: { state: 'ok', value: true },
    indexer: { state: 'ok', value: true }
  },
  epoch: {
    allocator: { state: 'ok', value: true },
    midenUsdcFaucet: { state: 'ok', value: { symbol: 'USDC', decimals: 6 } },
    evmUsdc: { state: 'ok', value: { symbol: 'USDC', decimals: 18 } }
  }
};
const ERROR = { state: 'error' as const, message: 'down' };

const snapshot = (config: BridgeConfig | null = CONFIG, derived: DerivedBridgeConfig | null = DERIVED) =>
  ({ network: 'testnet', status: 'ready', config, derived, lastFetch: null }) satisfies BridgeConfigSnapshot;
const withDerived = (patch: {
  agglayer?: Partial<DerivedBridgeConfig['agglayer']>;
  epoch?: Partial<DerivedBridgeConfig['epoch']>;
}) =>
  snapshot(CONFIG, {
    ...DERIVED,
    agglayer: { ...DERIVED.agglayer, ...patch.agglayer },
    epoch: { ...DERIVED.epoch, ...patch.epoch }
  });
const EMPTY = snapshot(null, null);

const savedE2e = process.env.MIDEN_E2E_TEST;
beforeEach(() => {
  delete process.env.MIDEN_E2E_TEST;
  _resetE2eOverridesForTest();
  jest.mocked(getBridgeConfigSnapshot).mockReset();
});
afterAll(() => {
  process.env.MIDEN_E2E_TEST = savedE2e;
});

describe('selectors', () => {
  it('select the testnet values, addresses checksummed as the Epoch intents carry them', () => {
    expect(selectMidenUsdc(snapshot())).toEqual({
      faucetId: '0x537c15a622074e91188aa894456c52',
      symbol: 'USDC',
      decimals: 6
    });
    expect(selectEvmUsdc(snapshot())).toEqual({
      address: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69',
      symbol: 'USDC',
      decimals: 18,
      chainId: 11155111
    });
    expect(selectNativeEthFaucet(snapshot())).toBe(ETH_FAUCET);
    expect(selectNativeEthToken(snapshot())).toEqual({
      midenFaucetId: ETH_FAUCET,
      originToken: '0x0000000000000000000000000000000000000000',
      originNetwork: 0,
      scale: 10
    });
  });

  it('keeps the testnet Earn market uid, protocol hash and underlying the wallet compiled in before', () => {
    expect(selectEarnMarket(snapshot())).toEqual({
      marketUid: 'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
      protocolHash: '0x7a2ccf6fa10307c054284131a341a8d8cbd10ec7d3cc469fbf369c40fd86d0f9',
      underlying: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69',
      chainId: 11155111
    });
  });

  it('select nothing without an accepted document', () => {
    for (const select of [
      selectMidenUsdc,
      selectMidenUsdcFaucetId,
      selectEvmUsdc,
      selectEarnMarket,
      selectNativeEthFaucet,
      selectNativeEthToken
    ]) {
      expect(select(EMPTY)).toBeNull();
    }
  });

  it('select nothing whose read did not succeed, but still name the configured faucet', () => {
    const failed = withDerived({ epoch: { midenUsdcFaucet: ERROR, evmUsdc: { state: 'absent' } } });
    expect(selectMidenUsdc(failed)).toBeNull();
    expect(selectMidenUsdcFaucetId(failed)).toBe('0x537c15a622074e91188aa894456c52');
    expect(selectEvmUsdc(failed)).toBeNull();
    expect(selectNativeEthFaucet(withDerived({ agglayer: { tokens: ERROR } }))).toBeNull();
    expect(selectNativeEthToken(withDerived({ agglayer: { tokens: ERROR } }))).toBeNull();
  });

  it('finds no native-ETH faucet in a registry that lists none', () => {
    const tokens = DERIVED.agglayer.tokens.state === 'ok' ? DERIVED.agglayer.tokens.value : [];
    const withoutEth = tokens.filter(token => token.midenFaucetId !== ETH_FAUCET);
    const onOtherNetwork = tokens.map(token => ({ ...token, originNetwork: 7 }));
    expect(selectNativeEthFaucet(withDerived({ agglayer: { tokens: { state: 'ok', value: withoutEth } } }))).toBeNull();
    expect(
      selectNativeEthFaucet(withDerived({ agglayer: { tokens: { state: 'ok', value: onOtherNetwork } } }))
    ).toBeNull();
    expect(selectNativeEthToken(withDerived({ agglayer: { tokens: { state: 'ok', value: withoutEth } } }))).toBeNull();
  });

  it('prefer the E2E collateral faucet, and only in an E2E build', () => {
    process.env.MIDEN_E2E_TEST = 'true';
    setEarnCollateralFaucetOverride({ faucetId: '0xab000000000000ab00000000000001' });
    const injected = { faucetId: '0xab000000000000ab00000000000001', symbol: 'USDC', decimals: 6 };
    expect(selectMidenUsdc(EMPTY)).toEqual(injected);
    expect(selectMidenUsdcFaucetId(EMPTY)).toBe(injected.faucetId);
    delete process.env.MIDEN_E2E_TEST;
    expect(selectMidenUsdc(snapshot())?.faucetId).toBe('0x537c15a622074e91188aa894456c52');
  });
});

describe('getters', () => {
  it.each([
    [getEpochAllocatorUrl, 'https://testnet-dev.epochprotocol.xyz'],
    [getEpochPositionsUrl, 'https://positions-testnet-dev.epochprotocol.xyz'],
    [getEvmChainId, 11155111],
    [getMidenUsdc, selectMidenUsdc(snapshot())],
    [getEvmUsdc, selectEvmUsdc(snapshot())],
    [getEvmUsdcAddress, '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69'],
    [findEvmUsdc, selectEvmUsdc(snapshot())],
    [getEarnMarket, selectEarnMarket(snapshot())],
    [getAgglayerMidenBridge, '0x3b66e20b5088f25133b69216484652'],
    [getAgglayerIndexerUrl, 'https://miden-testnet-bridge.dev.eu-north-3.gateway.fm/api'],
    [getAgglayerL1Bridge, '0x1348947e282138d8f377b467f7d9c2eb0f335d1f'],
    [getAgglayerRollupId, 86],
    [getAgglayerEvmNetworkId, 0],
    [getAgglayerBridgeOut, { midenBridge: '0x3b66e20b5088f25133b69216484652', evmNetworkId: 0 }],
    [getAgglayerDeposit, { l1Bridge: '0x1348947e282138d8f377b467f7d9c2eb0f335d1f', rollupId: 86 }]
  ])('%p returns the current value synchronously', (get, expected) => {
    jest.mocked(getBridgeConfigSnapshot).mockReturnValue(snapshot());
    const value = get();
    expect(value).not.toBeInstanceOf(Promise);
    expect(value).toEqual(expected);
  });

  it.each([
    getEpochAllocatorUrl,
    getEpochPositionsUrl,
    getEvmChainId,
    getMidenUsdc,
    getEvmUsdc,
    getEvmUsdcAddress,
    getEarnMarket,
    getAgglayerMidenBridge,
    getAgglayerIndexerUrl,
    getAgglayerL1Bridge,
    getAgglayerRollupId,
    getAgglayerEvmNetworkId,
    getAgglayerBridgeOut,
    getAgglayerDeposit
  ])('%p throws while there is no accepted document', get => {
    jest.mocked(getBridgeConfigSnapshot).mockReturnValue(EMPTY);
    expect(() => get()).toThrow(BridgeConfigUnavailableError);
  });

  it('name the EVM USDC from the document alone while its read has not succeeded', () => {
    jest.mocked(getBridgeConfigSnapshot).mockReturnValue(withDerived({ epoch: { evmUsdc: ERROR } }));
    expect(getEvmUsdcAddress()).toBe('0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69');
    expect(findEvmUsdc()).toBeNull();
    expect(() => getEvmUsdc()).toThrow(BridgeConfigUnavailableError);
    jest.mocked(getBridgeConfigSnapshot).mockReturnValue(EMPTY);
    expect(findEvmUsdc()).toBeNull();
  });

  it('need only their own derived read: bridge out the L1 network id, a deposit the rollup id', () => {
    jest.mocked(getBridgeConfigSnapshot).mockReturnValue(withDerived({ agglayer: { rollupId: ERROR } }));
    expect(getAgglayerBridgeOut()).toEqual({
      midenBridge: '0x3b66e20b5088f25133b69216484652',
      evmNetworkId: 0
    });
    expect(() => getAgglayerDeposit()).toThrow('The bridge config has no usable Agglayer deposit values.');
    jest.mocked(getBridgeConfigSnapshot).mockReturnValue(withDerived({ agglayer: { evmNetworkId: ERROR } }));
    expect(() => getAgglayerBridgeOut()).toThrow(BridgeConfigUnavailableError);
    expect(getAgglayerDeposit()).toMatchObject({ rollupId: 86 });
  });

  it('read the rollup id and the L1 network id each from its own derived read', () => {
    jest.mocked(getBridgeConfigSnapshot).mockReturnValue(withDerived({ agglayer: { rollupId: ERROR } }));
    expect(() => getAgglayerRollupId()).toThrow('The bridge config has no usable Agglayer rollup id.');
    expect(getAgglayerEvmNetworkId()).toBe(0);
    jest.mocked(getBridgeConfigSnapshot).mockReturnValue(withDerived({ agglayer: { evmNetworkId: ERROR } }));
    expect(() => getAgglayerEvmNetworkId()).toThrow('The bridge config has no usable Agglayer L1 network id.');
    expect(getAgglayerRollupId()).toBe(86);
  });
});
