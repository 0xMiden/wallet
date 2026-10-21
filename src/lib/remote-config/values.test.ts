import type { DerivedBridgeConfig, DerivedChainConfig } from './derive';
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
  findEpochUsdcAddress,
  findEvmUsdc,
  getEvmUsdc,
  getEvmUsdcAddress,
  getMidenUsdc,
  selectEarnMarket,
  selectBridgeInMaxBalanceUsd,
  selectEvmUsdc,
  selectInviteOnlyOnboarding,
  selectMidenUsdc,
  selectMidenUsdcFaucetId,
  selectAgglayerRecoveryConfig,
  selectNativeEthFaucet,
  selectNativeEthFaucets,
  selectNativeEthToken
} from './values';

jest.mock('./runtime', () => ({ getBridgeConfigSnapshot: jest.fn() }));

const CONFIG: BridgeConfig = {
  network: 'testnet',
  version: 1,
  'bridge-providers': {
    epoch: {
      allocatorUrl: 'https://testnet-dev.epochprotocol.xyz',
      positionsUrl: 'https://positions-testnet-dev.epochprotocol.xyz',
      outputs: { 'usdc-testnet-output': { faucetId: '0x537c15a622074e91188aa894456c52' } }
    },
    agglayer: { indexerUrl: 'https://miden-testnet-bridge.dev.eu-north-3.gateway.fm/api' },
    usdcx: {}
  },
  supportedEvmChains: {
    sepolia: {
      chainId: 11155111,
      bridges: {
        epoch: {
          depositEnabled: true,
          withdrawalEnabled: true,
          tokens: {
            USDC: { contractAddress: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69', outputs: ['usdc-testnet-output'] }
          }
        },
        agglayer: {
          depositEnabled: true,
          withdrawalEnabled: true,
          contractAddress: '0x1348947e282138d8f377b467f7d9c2eb0f335d1f',
          midenBridgeId: '0x3b66e20b5088f25133b69216484652'
        }
      }
    }
  },
  features: { earn: true }
};
const ETH_FAUCET = '0x0b372f2735e33e91216d995bf29b91';
const SEPOLIA_READS: DerivedChainConfig = {
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
    l1BridgeCode: { state: 'ok', value: true }
  },
  epoch: { evmUsdc: { state: 'ok', value: { symbol: 'USDC', decimals: 18 } } }
};
const DERIVED: DerivedBridgeConfig = {
  network: 'testnet',
  version: 1,
  derivedAt: 1_800_000_000_000,
  chains: { 11155111: SEPOLIA_READS },
  agglayer: { indexer: { state: 'ok', value: true } },
  epoch: {
    market: {
      state: 'ok',
      value: {
        marketUid: 'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
        protocolHash: '0x7a2ccf6fa10307c054284131a341a8d8cbd10ec7d3cc469fbf369c40fd86d0f9',
        underlying: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69',
        chainId: 11155111
      }
    },
    allocator: { state: 'ok', value: true },
    midenUsdcFaucet: { state: 'ok', value: { symbol: 'USDC', decimals: 6 } }
  }
};
const RECOVERY = {
  chainId: 11155111,
  contractAddress: '0x1348947e282138d8f377b467f7d9c2eb0f335d1f',
  midenBridgeId: '0x3b66e20b5088f25133b69216484652',
  depositEnabled: true,
  withdrawalEnabled: true,
  indexerUrl: 'https://miden-testnet-bridge.dev.eu-north-3.gateway.fm/api',
  rollupId: 86,
  evmNetworkId: 0,
  nativeEthFaucetId: ETH_FAUCET,
  nativeEthScale: 10
};
const ERROR = { state: 'error' as const, message: 'down' };

const snapshot = (
  config: BridgeConfig | null = CONFIG,
  derived: DerivedBridgeConfig | null = DERIVED
): BridgeConfigSnapshot => ({ network: 'testnet', status: 'ready', config, derived, lastFetch: null });
// Chain probes patch the Sepolia reads; the rest patch the providers'.
const withDerived = (patch: {
  agglayer?: Partial<DerivedChainConfig['agglayer']>;
  epoch?: Partial<DerivedBridgeConfig['epoch'] & DerivedChainConfig['epoch']>;
}) => {
  const { evmUsdc = SEPOLIA_READS.epoch.evmUsdc, ...providers } = patch.epoch ?? {};
  return snapshot(CONFIG, {
    ...DERIVED,
    chains: { 11155111: { agglayer: { ...SEPOLIA_READS.agglayer, ...patch.agglayer }, epoch: { evmUsdc } } },
    epoch: { ...DERIVED.epoch, ...providers }
  });
};
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
    const tokens = SEPOLIA_READS.agglayer.tokens.state === 'ok' ? SEPOLIA_READS.agglayer.tokens.value : [];
    const withoutEth = tokens.filter(token => token.midenFaucetId !== ETH_FAUCET);
    const onOtherNetwork = tokens.map(token => ({ ...token, originNetwork: 7 }));
    expect(selectNativeEthFaucet(withDerived({ agglayer: { tokens: { state: 'ok', value: withoutEth } } }))).toBeNull();
    expect(
      selectNativeEthFaucet(withDerived({ agglayer: { tokens: { state: 'ok', value: onOtherNetwork } } }))
    ).toBeNull();
    expect(selectNativeEthToken(withDerived({ agglayer: { tokens: { state: 'ok', value: withoutEth } } }))).toBeNull();
  });

  it('read the collateral faucet through the output the Epoch USDC token declares', () => {
    const OTHER_FAUCET = '0x6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f';
    const declaring = (outputs: string[], declared: Record<string, { faucetId: string }>): BridgeConfig => ({
      ...CONFIG,
      'bridge-providers': {
        ...CONFIG['bridge-providers'],
        epoch: { ...CONFIG['bridge-providers'].epoch, outputs: declared }
      },
      supportedEvmChains: {
        sepolia: {
          chainId: 11155111,
          bridges: {
            epoch: {
              depositEnabled: true,
              withdrawalEnabled: true,
              tokens: { USDC: { contractAddress: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69', outputs } }
            }
          }
        }
      }
    });
    const other = declaring(['other-output'], { 'other-output': { faucetId: OTHER_FAUCET } });
    expect(selectMidenUsdcFaucetId(snapshot(other))).toBe(OTHER_FAUCET);
    expect(selectMidenUsdc(snapshot(other))?.faucetId).toBe(OTHER_FAUCET);
    const none = declaring([], CONFIG['bridge-providers'].epoch.outputs ?? {});
    expect(selectMidenUsdcFaucetId(snapshot(none))).toBeNull();
    expect(selectMidenUsdc(snapshot(none))).toBeNull();
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

  it('select the Welcome variant the document sets, and null when it sets none', () => {
    expect(selectInviteOnlyOnboarding(snapshot({ ...CONFIG, onboarding: { inviteOnly: true } }))).toBe(true);
    expect(selectInviteOnlyOnboarding(snapshot({ ...CONFIG, onboarding: { inviteOnly: false } }))).toBe(false);
    expect(selectInviteOnlyOnboarding(snapshot())).toBeNull();
    expect(selectInviteOnlyOnboarding(EMPTY)).toBeNull();
  });

  it('selects the bridge-in balance ceiling the document sets, and null when it sets none', () => {
    expect(selectBridgeInMaxBalanceUsd(snapshot({ ...CONFIG, limits: { bridgeInMaxBalanceUsd: 1232.462 } }))).toBe(
      1232.462
    );
    expect(selectBridgeInMaxBalanceUsd(snapshot())).toBeNull();
    expect(selectBridgeInMaxBalanceUsd(EMPTY)).toBeNull();
  });
});

describe('findEpochUsdcAddress', () => {
  it('names the document contract of the chain, with no token read, and null elsewhere', () => {
    jest.mocked(getBridgeConfigSnapshot).mockReturnValue(snapshot(CONFIG, null));
    expect(findEpochUsdcAddress(11155111)?.toLowerCase()).toBe('0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69');
    expect(findEpochUsdcAddress(84532)).toBeNull();
    jest.mocked(getBridgeConfigSnapshot).mockReturnValue(EMPTY);
    expect(findEpochUsdcAddress(11155111)).toBeNull();
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
    [getAgglayerBridgeOut, { midenBridge: '0x3b66e20b5088f25133b69216484652', evmNetworkId: 0, recovery: RECOVERY }],
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

  it("find each Epoch chain's own USDC, and the first listed one when no chain is given", () => {
    const sepolia = CONFIG.supportedEvmChains.sepolia;
    const epoch = sepolia?.bridges.epoch;
    if (!sepolia || !epoch) throw new Error('The test chain is missing');
    const BASE_USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
    const baseFirst = snapshot(
      {
        ...CONFIG,
        supportedEvmChains: {
          'base-sepolia': {
            chainId: 84532,
            bridges: {
              epoch: { ...epoch, tokens: { USDC: { contractAddress: BASE_USDC, outputs: ['usdc-testnet-output'] } } }
            }
          },
          sepolia
        }
      },
      {
        ...DERIVED,
        chains: {
          84532: { ...SEPOLIA_READS, epoch: { evmUsdc: { state: 'ok', value: { symbol: 'USDC', decimals: 6 } } } },
          11155111: SEPOLIA_READS
        }
      }
    );
    jest.mocked(getBridgeConfigSnapshot).mockReturnValue(baseFirst);
    expect(findEvmUsdc(11155111)).toEqual({
      address: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69',
      symbol: 'USDC',
      decimals: 18,
      chainId: 11155111
    });
    expect(findEvmUsdc()).toMatchObject({ chainId: 84532, decimals: 6 });
    expect(findEvmUsdc(1)).toBeNull();
  });

  it('requires a complete recovery snapshot before a new bridge-out and only the rollup for a deposit', () => {
    jest.mocked(getBridgeConfigSnapshot).mockReturnValue(withDerived({ agglayer: { rollupId: ERROR } }));
    // New bridge rows must save the rollup id so claims can continue after route removal.
    expect(() => getAgglayerBridgeOut()).toThrow(BridgeConfigUnavailableError);
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

  it('read each AggLayer chain from its own reads, and the first listed one when no chain is given', () => {
    const sepolia = CONFIG.supportedEvmChains.sepolia;
    if (!sepolia) throw new Error('The test chain is missing');
    const ETH_ON_BASE = '0x0c372f2735e33e91216d995bf29b91';
    const base: DerivedChainConfig = {
      agglayer: {
        rollupId: { state: 'ok', value: 87 },
        tokens: {
          state: 'ok',
          value: [
            {
              midenFaucetId: ETH_ON_BASE,
              originToken: '0x0000000000000000000000000000000000000000',
              originNetwork: 0,
              scale: 9
            }
          ]
        },
        evmNetworkId: { state: 'ok', value: 6 },
        l1BridgeCode: { state: 'ok', value: true }
      },
      epoch: { evmUsdc: { state: 'skipped' } }
    };
    const twoChains = snapshot(
      {
        ...CONFIG,
        supportedEvmChains: {
          sepolia,
          'base-sepolia': { chainId: 84532, bridges: { agglayer: sepolia.bridges.agglayer } }
        }
      },
      { ...DERIVED, chains: { 11155111: SEPOLIA_READS, 84532: base } }
    );
    jest.mocked(getBridgeConfigSnapshot).mockReturnValue(twoChains);
    expect(getAgglayerRollupId(84532)).toBe(87);
    expect(getAgglayerEvmNetworkId(84532)).toBe(6);
    expect(selectNativeEthFaucet(twoChains, 84532)).toBe(ETH_ON_BASE);
    expect(selectNativeEthToken(twoChains, 84532)?.scale).toBe(9);
    expect(getAgglayerRollupId()).toBe(86);
    expect(getAgglayerEvmNetworkId()).toBe(0);
    expect(selectNativeEthFaucet(twoChains)).toBe(ETH_FAUCET);
    expect(selectNativeEthFaucets(twoChains)).toEqual([ETH_FAUCET, ETH_ON_BASE]);
    expect(selectAgglayerRecoveryConfig(twoChains, 84532)).toMatchObject({
      chainId: 84532,
      rollupId: 87,
      evmNetworkId: 6,
      nativeEthFaucetId: ETH_ON_BASE,
      nativeEthScale: 9
    });
  });

  it('name the indexer only for a listed AggLayer chain', () => {
    jest.mocked(getBridgeConfigSnapshot).mockReturnValue(snapshot());
    expect(getAgglayerIndexerUrl(11155111)).toBe('https://miden-testnet-bridge.dev.eu-north-3.gateway.fm/api');
    expect(() => getAgglayerIndexerUrl(84532)).toThrow(BridgeConfigUnavailableError);
    expect(() => getAgglayerRollupId(84532)).toThrow(BridgeConfigUnavailableError);
  });

  it('save no native-ETH faucet with a route whose registry names none', () => {
    const saved = selectAgglayerRecoveryConfig(withDerived({ agglayer: { tokens: { state: 'ok', value: [] } } }));
    expect(saved).toMatchObject({ chainId: 11155111, rollupId: 86, evmNetworkId: 0 });
    expect(saved).not.toHaveProperty('nativeEthFaucetId');
    expect(saved).not.toHaveProperty('nativeEthScale');
  });
});
