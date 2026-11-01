import { TEST_EARN_VAULT_INFO } from 'lib/epoch/testing/bridge-config';

import type { DerivedBridgeConfig, DerivedChainConfig } from './derive';
import { _resetE2eOverridesForTest, setEarnCollateralFaucetOverride } from './e2e-overrides';
import { type BridgeConfigSnapshot, getBridgeConfigSnapshot } from './runtime';
import type { BridgeConfig } from './schema';
import { bridgeConfigBaseUrl, bridgeConfigUrl } from './source';
import {
  BridgeConfigUnavailableError,
  getAgglayerBridgeOut,
  getAgglayerDeposit,
  getAgglayerEvmNetworkId,
  getAgglayerIndexerUrl,
  getAgglayerL1Bridge,
  getAgglayerMidenBridge,
  getAgglayerRollupId,
  getBackupBaseUrl,
  getEarnMarket,
  getEarnVaults,
  getEpochAllocatorUrl,
  getEpochPositionsUrl,
  getEvmChainId,
  findEpochUsdcAddress,
  findEvmUsdc,
  getEvmUsdc,
  getEvmUsdcAddress,
  getMidenUsdc,
  selectBackupBaseUrl,
  selectEarnMarket,
  selectEarnVault,
  selectEarnVaultCatalog,
  selectEarnVaultLogoUrl,
  selectEpochDepositTokens,
  selectEarnVaults,
  selectBridgeInMaxBalanceUsd,
  selectEvmUsdc,
  hasMainnetLaunched,
  selectMainnetLaunchAt,
  selectMidenUsdc,
  selectMidenUsdcFaucetId,
  selectAgglayerDeliveryFaucets,
  selectAgglayerDepositTokens,
  selectAgglayerRecoveryConfig,
  selectAgglayerRegistryToken,
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
  features: { earn: true, nearIntents: false },
  earn: {
    vaults: [
      {
        id: 'dummy-lending-sepolia-usdc',
        marketUid: 'dummy_lending:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
        name: 'Dummy Lending USDC',
        protocol: 'dummy-lending',
        depositsEnabled: true
      }
    ]
  }
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
    l1BridgeCode: { state: 'ok', value: true },
    depositTokens: { state: 'skipped' }
  },
  epoch: { tokens: { USDC: { state: 'ok', value: { symbol: 'USDC', decimals: 18 } } } }
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
    midenUsdcFaucet: { state: 'ok', value: { symbol: 'USDC', decimals: 6 } },
    vaults: { state: 'ok', value: [TEST_EARN_VAULT_INFO] }
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
  const { tokens, ...providers } = patch.epoch ?? {};
  return snapshot(CONFIG, {
    ...DERIVED,
    chains: {
      11155111: {
        agglayer: { ...SEPOLIA_READS.agglayer, ...patch.agglayer },
        epoch: { tokens: { ...SEPOLIA_READS.epoch.tokens, ...tokens } }
      }
    },
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

  it('select the Earn vault catalogue the derivation read', () => {
    expect(selectEarnVaultCatalog(snapshot())).toEqual([TEST_EARN_VAULT_INFO]);
    expect(selectEarnVaultCatalog(withDerived({ epoch: { vaults: { state: 'ok', value: [] } } }))).toEqual([]);
  });

  it('select nothing without an accepted document', () => {
    for (const select of [
      selectMidenUsdc,
      selectMidenUsdcFaucetId,
      selectEvmUsdc,
      selectEarnMarket,
      selectEarnVaultCatalog,
      selectNativeEthFaucet,
      selectNativeEthToken
    ]) {
      expect(select(EMPTY)).toBeNull();
    }
  });

  it('select nothing whose read did not succeed, but still name the configured faucet', () => {
    const failed = withDerived({ epoch: { midenUsdcFaucet: ERROR, tokens: { USDC: { state: 'absent' } } } });
    expect(selectEarnVaultCatalog(withDerived({ epoch: { vaults: ERROR } }))).toBeNull();
    expect(selectEarnVaultCatalog(withDerived({ epoch: { vaults: { state: 'skipped' } } }))).toBeNull();
    expect(selectMidenUsdc(failed)).toBeNull();
    expect(selectMidenUsdcFaucetId(failed)).toBe('0x537c15a622074e91188aa894456c52');
    expect(selectEvmUsdc(failed)).toBeNull();
    expect(selectNativeEthFaucet(withDerived({ agglayer: { tokens: ERROR } }))).toBeNull();
    expect(selectNativeEthToken(withDerived({ agglayer: { tokens: ERROR } }))).toBeNull();
  });

  it('offers a Fast deposit only of a token whose Miden faucet and its scale were read, while the route takes one', () => {
    const read = { symbol: 'USDC', decimals: 18, midenFaucetId: '0x537c15a622074e91188aa894456c52' };
    const scaled = withDerived({
      epoch: { tokens: { USDC: { state: 'ok', value: { ...read, midenSymbol: 'USDC', midenDecimals: 6 } } } }
    });
    expect(selectEpochDepositTokens(scaled, 11155111)).toEqual([
      expect.objectContaining({ key: 'USDC', midenFaucetId: read.midenFaucetId, midenSymbol: 'USDC', midenDecimals: 6 })
    ]);
    // The send side needs only the faucet id, so a token whose faucet could not be read is still a send's output.
    const unscaled = withDerived({ epoch: { tokens: { USDC: { state: 'ok', value: read } } } });
    expect(selectEpochDepositTokens(unscaled, 11155111)).toEqual([]);
    expect(selectEpochDepositTokens(scaled, 1)).toEqual([]);

    const closed: BridgeConfigSnapshot = JSON.parse(JSON.stringify(scaled));
    const route = closed.config?.supportedEvmChains.sepolia?.bridges.epoch;
    if (!route) throw new Error('The test route is missing');
    route.depositEnabled = false;
    expect(selectEpochDepositTokens(closed, 11155111)).toEqual([]);
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

  it('selects the mainnet launch moment the document sets, and null while the countdown is off or absent', () => {
    const launchAt = Date.parse('2026-10-26T14:00:00Z');
    expect(selectMainnetLaunchAt(snapshot({ ...CONFIG, mainnetCountdown: { enabled: true, launchAt } }))).toBe(
      launchAt
    );
    expect(selectMainnetLaunchAt(snapshot({ ...CONFIG, mainnetCountdown: { enabled: false, launchAt } }))).toBeNull();
    expect(selectMainnetLaunchAt(snapshot({ ...CONFIG, mainnetCountdown: { enabled: true } }))).toBeNull();
    expect(selectMainnetLaunchAt(snapshot())).toBeNull();
    expect(selectMainnetLaunchAt(EMPTY)).toBeNull();
  });

  it('says mainnet has launched from the moment on, and never without one', () => {
    const launchAt = Date.parse('2026-10-26T14:00:00Z');
    const on = snapshot({ ...CONFIG, mainnetCountdown: { enabled: true, launchAt } });
    expect(hasMainnetLaunched(on, launchAt - 1)).toBe(false);
    expect(hasMainnetLaunched(on, launchAt)).toBe(true);
    expect(hasMainnetLaunched(snapshot({ ...CONFIG, mainnetCountdown: { enabled: false, launchAt } }), launchAt)).toBe(
      false
    );
    expect(hasMainnetLaunched(EMPTY, launchAt)).toBe(false);
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

describe('the Earn vaults', () => {
  const [vault] = CONFIG.earn?.vaults ?? [];

  it("selects the document's list, and a vault by its market in any case", () => {
    expect(selectEarnVaults(snapshot())).toEqual([vault]);
    expect(selectEarnVault(snapshot(), 'DUMMY_LENDING:11155111:0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69')).toBe(
      vault
    );
    expect(selectEarnVault(snapshot(), 'AAVE_V3:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69')).toBeNull();
  });

  it('selects no vault while no document is accepted, or while it lists none', () => {
    const { earn: _earn, ...unlisted } = CONFIG;
    expect(selectEarnVaults(EMPTY)).toEqual([]);
    expect(selectEarnVaults(snapshot({ ...unlisted, features: { earn: false, nearIntents: false } }))).toEqual([]);
  });

  it("reads this realm's list without throwing", () => {
    jest.mocked(getBridgeConfigSnapshot).mockReturnValue(snapshot());
    expect(getEarnVaults()).toEqual([vault]);
    jest.mocked(getBridgeConfigSnapshot).mockReturnValue(EMPTY);
    expect(getEarnVaults()).toEqual([]);
  });
});

describe('the encrypted backup base URL', () => {
  const BACKUP_URL = 'https://wallet-api.example.workers.dev';
  const on = snapshot({
    ...CONFIG,
    features: { ...CONFIG.features, encryptedBackup: true },
    backup: { baseUrl: BACKUP_URL }
  });

  it("selects the document's URL while the switch is on", () => {
    expect(selectBackupBaseUrl(on)).toBe(BACKUP_URL);
  });

  it('selects null while no document is accepted, or while the switch is off or absent', () => {
    expect(selectBackupBaseUrl(EMPTY)).toBeNull();
    expect(selectBackupBaseUrl(snapshot())).toBeNull();
    expect(
      selectBackupBaseUrl(
        snapshot({
          ...CONFIG,
          features: { ...CONFIG.features, encryptedBackup: false },
          backup: { baseUrl: BACKUP_URL }
        })
      )
    ).toBeNull();
  });

  it("reads this realm's URL without throwing", () => {
    jest.mocked(getBridgeConfigSnapshot).mockReturnValue(on);
    expect(getBackupBaseUrl()).toBe(BACKUP_URL);
    jest.mocked(getBridgeConfigSnapshot).mockReturnValue(EMPTY);
    expect(getBackupBaseUrl()).toBeNull();
  });
});

describe('selectEarnVaultLogoUrl', () => {
  const [listed] = CONFIG.earn?.vaults ?? [];
  if (!listed) throw new Error('the test document lists no vault');
  const savedUrl = process.env.MIDEN_REMOTE_CONFIG_URL;
  afterEach(() => {
    if (savedUrl === undefined) delete process.env.MIDEN_REMOTE_CONFIG_URL;
    else process.env.MIDEN_REMOTE_CONFIG_URL = savedUrl;
  });

  it("resolves the logo against the base URL the network's document is fetched from", () => {
    // The document's own URL without its `/<network>.json`.
    const base = bridgeConfigUrl('testnet').replace(/\/testnet\.json$/, '');
    expect(selectEarnVaultLogoUrl(snapshot(), { ...listed, logo: 'icons/aave.svg' })).toBe(`${base}/icons/aave.svg`);
    expect(bridgeConfigBaseUrl('testnet')).toBe(base);
  });

  it('resolves against the served base in an E2E build', () => {
    process.env.MIDEN_E2E_TEST = 'true';
    process.env.MIDEN_REMOTE_CONFIG_URL = 'http://127.0.0.1:8550/config/';
    expect(selectEarnVaultLogoUrl(snapshot(), { ...listed, logo: 'icons/dummy-lending.png' })).toBe(
      'http://127.0.0.1:8550/config/icons/dummy-lending.png'
    );
  });

  it('gives null for a listing with no logo, or one that is not an icons/ path', () => {
    expect(selectEarnVaultLogoUrl(snapshot(), listed)).toBeNull();
    expect(selectEarnVaultLogoUrl(snapshot(), { ...listed, logo: 'https://evil.example/x.svg' })).toBeNull();
    expect(selectEarnVaultLogoUrl(snapshot(), { ...listed, logo: 'icons/../x.svg' })).toBeNull();
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
    jest.mocked(getBridgeConfigSnapshot).mockReturnValue(withDerived({ epoch: { tokens: { USDC: ERROR } } }));
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
          84532: {
            ...SEPOLIA_READS,
            epoch: { tokens: { USDC: { state: 'ok', value: { symbol: 'USDC', decimals: 6 } } } }
          },
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
        l1BridgeCode: { state: 'ok', value: true },
        depositTokens: { state: 'skipped' }
      },
      epoch: { tokens: {} }
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

  it('select the verified deposit tokens, nothing for a skipped or absent read, and null for a failed one', () => {
    const usdc = {
      symbol: 'USDC',
      contractAddress: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69' as const,
      decimals: 18,
      midenFaucetId: '0x36bb3163d7ef0ad102f35bf507c61e',
      scale: 10
    };
    expect(
      selectAgglayerDepositTokens(withDerived({ agglayer: { depositTokens: { state: 'ok', value: [usdc] } } }))
    ).toEqual([usdc]);
    expect(selectAgglayerDepositTokens(snapshot())).toEqual([]);
    expect(selectAgglayerDepositTokens(withDerived({ agglayer: { depositTokens: { state: 'absent' } } }))).toEqual([]);
    expect(selectAgglayerDepositTokens(withDerived({ agglayer: { depositTokens: ERROR } }))).toBeNull();
    expect(selectAgglayerDepositTokens(EMPTY)).toBeNull();
  });

  it('find a registered token by its origin address on the chain network, and every delivery faucet', () => {
    expect(
      selectAgglayerRegistryToken(snapshot(), '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69', 11155111)
    ).toMatchObject({
      midenFaucetId: '0x36bb3163d7ef0ad102f35bf507c61e',
      originNetwork: 0
    });
    expect(selectAgglayerRegistryToken(snapshot(), '0x21472df1b5d2b673f6444b41258c6460294a2c06', 11155111)).toBeNull();
    expect(
      selectAgglayerRegistryToken(
        withDerived({ agglayer: { tokens: ERROR } }),
        '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69'
      )
    ).toBeNull();
    const faucets = selectAgglayerDeliveryFaucets(snapshot());
    expect(faucets).toContain(ETH_FAUCET);
    expect(faucets).toContain('0x36bb3163d7ef0ad102f35bf507c61e');
    expect(new Set(faucets).size).toBe(faucets.length);
    expect(selectAgglayerDeliveryFaucets(withDerived({ agglayer: { tokens: ERROR } }))).toEqual([]);
  });

  // The same address registered from another network is another bridged token: with no known network the lookup
  // names none, and a saved deposit network picks its own entry whatever the chain's read says.
  it('find a registered token only on a known origin network', () => {
    const USDC: `0x${string}` = '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69';
    const registry = SEPOLIA_READS.agglayer.tokens.state === 'ok' ? SEPOLIA_READS.agglayer.tokens.value : [];
    const elsewhere = {
      midenFaucetId: '0xaef9b3cd67458ad14510d371c65a58',
      originToken: USDC,
      originNetwork: 3,
      scale: 10
    };
    const unread = withDerived({
      agglayer: { tokens: { state: 'ok', value: [elsewhere, ...registry] }, evmNetworkId: ERROR }
    });
    expect(selectAgglayerRegistryToken(unread, USDC, 11155111)).toBeNull();
    expect(selectAgglayerRegistryToken(unread, USDC, 11155111, 0)).toMatchObject({
      midenFaucetId: '0x36bb3163d7ef0ad102f35bf507c61e'
    });
    expect(selectAgglayerRegistryToken(unread, USDC, 11155111, 3)).toMatchObject({
      midenFaucetId: elsewhere.midenFaucetId
    });
  });
});
