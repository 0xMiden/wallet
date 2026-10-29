import { keccak256, toBytes } from 'viem';

import { EARN_VAULT_PROTOCOLS, parseBridgeConfig, SUPPORTED_EVM_CHAIN_IDS } from './schema';
import testnet from './testing/testnet.json';

describe('EARN_VAULT_PROTOCOLS', () => {
  it('names the protocol strings a vault can list', () => {
    expect(EARN_VAULT_PROTOCOLS).toEqual(['1delta', 'dummy-lending']);
  });

  it('keeps the hash the testnet deposits use for the dummy lender', () => {
    expect(keccak256(toBytes('dummy-lending'))).toBe(
      '0x7a2ccf6fa10307c054284131a341a8d8cbd10ec7d3cc469fbf369c40fd86d0f9'
    );
  });
});

type ConfigValue = Parameters<typeof parseBridgeConfig>[0];
/** The testnet document's one Earn vault, as written: the dummy lender's market of the route's USDC. */
const DUMMY_VAULT = {
  id: 'dummy-lending-sepolia-usdc',
  marketUid: 'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
  name: 'Dummy Lending USDC',
  protocol: 'dummy-lending'
};
const doc = (overrides: Record<string, ConfigValue> = {}) => ({
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
            USDC: { contractAddress: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69', outputs: ['usdc-testnet-output'] }
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
  features: { earn: true },
  earn: { vaults: [DUMMY_VAULT] },
  mainnetCountdown: { enabled: true, launchAt: '2026-10-26T00:00:00Z' },
  ...overrides
});

type Section = 'evm' | 'agglayer' | 'epoch' | 'features' | 'mainnetCountdown';
const withSection = (name: Section, fields: Record<string, ConfigValue>) => {
  const base = doc();
  const providers = base['bridge-providers'];
  const chain = base.supportedEvmChains.sepolia;
  switch (name) {
    case 'evm':
      return { ...base, supportedEvmChains: { sepolia: { ...chain, ...fields } } };
    case 'features': {
      const route = { ...chain.bridges.agglayer };
      if ('bridgeIn' in fields)
        return {
          ...base,
          supportedEvmChains: {
            sepolia: {
              ...chain,
              bridges: { ...chain.bridges, agglayer: { ...route, depositEnabled: fields.bridgeIn } }
            }
          }
        };
      if ('bridgeOut' in fields)
        return {
          ...base,
          supportedEvmChains: {
            sepolia: {
              ...chain,
              bridges: { ...chain.bridges, agglayer: { ...route, withdrawalEnabled: fields.bridgeOut } }
            }
          }
        };
      return { ...base, features: { ...base.features, ...fields } };
    }
    case 'mainnetCountdown':
      return { ...base, mainnetCountdown: { ...base.mainnetCountdown, ...fields } };
    case 'epoch': {
      const token = chain.bridges.epoch.tokens.USDC;
      const faucetId = fields.midenUsdcFaucet ?? providers.epoch.outputs['usdc-testnet-output'].faucetId;
      return {
        ...base,
        'bridge-providers': {
          ...providers,
          epoch: { ...providers.epoch, ...fields, outputs: { 'usdc-testnet-output': { faucetId } } }
        },
        supportedEvmChains: {
          sepolia: {
            ...chain,
            bridges: {
              ...chain.bridges,
              epoch: {
                ...chain.bridges.epoch,
                tokens: { USDC: { ...token, contractAddress: fields.evmUsdc ?? token.contractAddress } }
              }
            }
          }
        }
      };
    }
    case 'agglayer':
      return {
        ...base,
        'bridge-providers': { ...providers, agglayer: { ...providers.agglayer, ...fields } },
        supportedEvmChains: {
          sepolia: {
            ...chain,
            bridges: {
              ...chain.bridges,
              agglayer: {
                ...chain.bridges.agglayer,
                ...fields,
                contractAddress: 'l1Bridge' in fields ? fields.l1Bridge : chain.bridges.agglayer.contractAddress,
                midenBridgeId: fields.midenBridge ?? chain.bridges.agglayer.midenBridgeId
              }
            }
          }
        }
      };
  }
};

const ALL_OFF = { earn: false, nearIntents: false };

it('parses the testnet document and normalizes addresses', () => {
  const parsed = parseBridgeConfig(doc(), 'testnet');
  expect(parsed).not.toBeNull();
  expect(parsed?.network).toBe('testnet');
  expect(parsed?.version).toBe(1);
  expect(parsed?.['bridge-providers']).toEqual(doc()['bridge-providers']);
  expect(parsed?.supportedEvmChains.sepolia?.bridges.agglayer).toEqual(
    doc().supportedEvmChains.sepolia.bridges.agglayer
  );
  expect(parsed?.supportedEvmChains.sepolia?.bridges.epoch?.tokens.USDC).toEqual({
    contractAddress: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
    outputs: ['usdc-testnet-output']
  });
  expect(parsed?.features).toEqual({ earn: true, nearIntents: false });
  expect(parsed?.mainnetCountdown).toEqual({ enabled: true, launchAt: Date.UTC(2026, 9, 26) });
  expect(parsed?.swap).toEqual({});
});

describe('features.arcadeGcPurchase and arcade.sale', () => {
  const seller = '0xA6BE5C4D8FDC03415BDE66453D5F91';

  it('is left out when absent, and the sale exists exactly when the switch is on', () => {
    const parsed = parseBridgeConfig(doc(), 'testnet');
    expect(parsed?.features.arcadeGcPurchase).toBeUndefined();
    expect(parsed?.arcade).toBeUndefined();
    const on = parseBridgeConfig(
      doc({ features: { earn: true, arcadeGcPurchase: true }, arcade: { sale: { seller } } }),
      'testnet'
    );
    expect(on?.features.arcadeGcPurchase).toBe(true);
    expect(on?.arcade).toEqual({ sale: { seller: seller.toLowerCase() } });
    expect(
      parseBridgeConfig(doc({ features: { earn: true, arcadeGcPurchase: false } }), 'testnet')?.features
        .arcadeGcPurchase
    ).toBe(false);
  });

  it.each([
    ['the switch on without a sale', { features: { earn: true, arcadeGcPurchase: true } }],
    ['a sale while the switch is off', { features: { earn: true }, arcade: { sale: { seller } } }],
    ['a sale with no seller', { features: { earn: true, arcadeGcPurchase: true }, arcade: { sale: {} } }],
    [
      'a bech32 seller',
      {
        features: { earn: true, arcadeGcPurchase: true },
        arcade: { sale: { seller: 'mm1azntuhzd3lwqxs2mmeny202ljy3fxnpm' } }
      }
    ],
    ['a nonboolean switch', { features: { earn: true, arcadeGcPurchase: 'true' } }]
  ])('rejects %s', (_name, overrides) => {
    expect(parseBridgeConfig(doc(overrides), 'testnet')).toBeNull();
  });
});

describe('features.encryptedBackup and backup.baseUrl', () => {
  const baseUrl = 'https://wallet-api.example.workers.dev';
  const on = (backup: ConfigValue) => doc({ features: { earn: true, encryptedBackup: true }, backup });

  it('is left out when absent, so the backup is off, and has no section', () => {
    const parsed = parseBridgeConfig(doc(), 'testnet');
    expect(parsed?.features.encryptedBackup).toBeUndefined();
    expect(parsed?.backup).toBeUndefined();
  });

  it('reads the section while the switch is on', () => {
    const parsed = parseBridgeConfig(on({ baseUrl }), 'testnet');
    expect(parsed?.features.encryptedBackup).toBe(true);
    expect(parsed?.backup).toEqual({ baseUrl });
    expect(parseBridgeConfig(on({ baseUrl: `${baseUrl}/v1` }), 'testnet')?.backup).toEqual({
      baseUrl: `${baseUrl}/v1`
    });
  });

  it('lower-cases the host and drops a default port, as the config repo validator does', () => {
    expect(
      parseBridgeConfig(on({ baseUrl: 'https://Wallet-API.Example.workers.dev:443/v1' }), 'testnet')?.backup
    ).toEqual({ baseUrl: `${baseUrl}/v1` });
  });

  it('keeps an explicit off without a section', () => {
    const parsed = parseBridgeConfig(doc({ features: { earn: true, encryptedBackup: false } }), 'testnet');
    expect(parsed?.features.encryptedBackup).toBe(false);
    expect(parsed?.backup).toBeUndefined();
  });

  it.each([
    ['the switch on without a section', { features: { earn: true, encryptedBackup: true } }],
    ['a section while the switch is off', { features: { earn: true, encryptedBackup: false }, backup: { baseUrl } }],
    ['a section while the switch is absent', { backup: { baseUrl } }],
    ['a section with no base URL', { features: { earn: true, encryptedBackup: true }, backup: {} }],
    ['a nonboolean switch', { features: { earn: true, encryptedBackup: 'true' }, backup: { baseUrl } }],
    ['a section that is not an object', { features: { earn: true, encryptedBackup: true }, backup: baseUrl }]
  ])('rejects %s', (_name, overrides) => {
    expect(parseBridgeConfig(doc(overrides), 'testnet')).toBeNull();
  });

  it.each([
    ['an http URL', 'http://wallet-api.example.workers.dev'],
    ['a loopback http URL', 'http://127.0.0.1:8787'],
    ['a trailing slash', `${baseUrl}/`],
    ['a path with a trailing slash', `${baseUrl}/backup/`],
    ['a query', `${baseUrl}?network=testnet`],
    ['an empty query', `${baseUrl}?`],
    ['a fragment', `${baseUrl}#backup`],
    ['credentials', 'https://user:secret@wallet-api.example.workers.dev'],
    ['a relative URL', '/v1'],
    ['another scheme', 'wss://wallet-api.example.workers.dev'],
    ['a number', 8787]
  ])('rejects a base URL with %s', (_name, value) => {
    expect(parseBridgeConfig(on({ baseUrl: value }), 'testnet')).toBeNull();
    // The E2E local http allowance of the other URLs does not reach this one.
    expect(parseBridgeConfig(on({ baseUrl: value }), 'testnet', { allowLocalHttp: true })).toBeNull();
  });
});

describe('features.nearIntents', () => {
  it('defaults to false when absent and accepts an explicit true', () => {
    expect(parseBridgeConfig(doc(), 'testnet')?.features.nearIntents).toBe(false);
    expect(
      parseBridgeConfig(doc({ features: { earn: true, nearIntents: true } }), 'testnet')?.features.nearIntents
    ).toBe(true);
  });

  it.each([null, 0, 1, 'true', {}])('rejects a nonboolean nearIntents switch: %j', nearIntents => {
    expect(parseBridgeConfig(doc({ features: { earn: true, nearIntents } }), 'testnet')).toBeNull();
  });
});

describe('swap section', () => {
  it('reads a missing section, or a section that names no solver, as no solver', () => {
    expect(parseBridgeConfig(doc({}), 'testnet')?.swap).toStrictEqual({});
    expect(parseBridgeConfig(doc({ swap: {} }), 'testnet')?.swap).toStrictEqual({});
  });

  it('reads the solver as a base URL, normalized like every other URL field', () => {
    const swap = { etaUrl: 'https://Quotes.Example:443/dex/' };
    expect(parseBridgeConfig(doc({ swap }), 'testnet')?.swap).toStrictEqual({ etaUrl: 'https://quotes.example/dex' });
    expect(parseBridgeConfig(doc({ swap: { etaUrl: 'http://quotes.example' } }), 'testnet')).toBeNull();
    expect(parseBridgeConfig(doc({ swap: { etaUrl: 'https://quotes.example/?x=1' } }), 'testnet')).toBeNull();
    expect(parseBridgeConfig(doc({ swap: { etaUrl: 42 } }), 'testnet')).toBeNull();
  });

  // The registry is the solver's /v2/pairs now: a list an older document still carries is not read, whatever it holds.
  it('ignores a token list the document still carries', () => {
    const swap = { etaUrl: 'https://quotes.example', tokens: [{ symbol: 'iEth', faucetId: 'not-an-id' }] };
    expect(parseBridgeConfig(doc({ swap }), 'testnet')?.swap).toStrictEqual({ etaUrl: 'https://quotes.example' });
  });

  it('accepts an explicit mainnet one-click mapping and fixed app fees', () => {
    const swap = {
      oneClick: {
        serviceUrl: 'https://swap.example',
        midenAssets: [{ assetId: 'miden:token', faucetId: '0x123456789012345678901234567890', decimals: 6 }],
        appFees: [{ recipient: 'wallet.near', fee: 25 }]
      }
    };
    expect(parseBridgeConfig({ ...doc({ swap }), network: 'mainnet' }, 'mainnet')?.swap).toStrictEqual({
      ...swap,
      oneClick: { ...swap.oneClick, evmAssets: [] }
    });
    expect(parseBridgeConfig(doc({ swap }), 'testnet')?.swap).toStrictEqual({});
  });

  it.each([
    {
      serviceUrl: 'http://swap.example',
      midenAssets: [{ assetId: 'm', faucetId: '0x123456789012345678901234567890', decimals: 6 }]
    },
    {
      serviceUrl: 'https://swap.example/?key=x',
      midenAssets: [{ assetId: 'm', faucetId: '0x123456789012345678901234567890', decimals: 6 }]
    },
    { serviceUrl: 'https://swap.example', midenAssets: [{ assetId: 'm', faucetId: 'bad id', decimals: 6 }] },
    {
      serviceUrl: 'https://swap.example',
      midenAssets: [{ assetId: 'm', faucetId: '0x123456789012345678901234567890', decimals: 9007199254740992 }]
    },
    {
      serviceUrl: 'https://swap.example',
      midenAssets: [
        { assetId: 'm', faucetId: '0x123456789012345678901234567890', decimals: 6 },
        { assetId: 'm', faucetId: '0x567890123456789012345678901234', decimals: 6 }
      ]
    },
    {
      serviceUrl: 'https://swap.example',
      midenAssets: [{ assetId: 'm', faucetId: '0x123456789012345678901234567890', decimals: 6 }],
      appFees: [{ recipient: 'wallet.near', fee: 10001 }]
    },
    {
      serviceUrl: 'https://swap.example',
      midenAssets: [{ assetId: 'm', faucetId: '0x123456789012345678901234567890', decimals: 6 }],
      appFees: [
        { recipient: 'wallet.near', fee: 600 },
        { recipient: 'wallet2.near', fee: 500 }
      ]
    }
  ])('disables malformed one-click config: %j', oneClick => {
    expect(parseBridgeConfig({ ...doc({ swap: { oneClick } }), network: 'mainnet' }, 'mainnet')).toBeNull();
  });
});

describe('OneClick trusted EVM asset identities', () => {
  const midenAssets = [{ assetId: 'miden:usdc', faucetId: '0x123456789012345678901234567890', decimals: 6 }];
  const evmAsset = {
    assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
    blockchain: 'base',
    chainId: 8453,
    contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    decimals: 6,
    symbol: 'USDC'
  };

  it('defaults missing EVM asset mappings to an empty list while preserving Miden mappings', () => {
    const oneClick = { serviceUrl: 'https://swap.example', midenAssets };
    const parsed = parseBridgeConfig({ ...doc({ swap: { oneClick } }), network: 'mainnet' }, 'mainnet');

    expect(parsed?.swap?.oneClick).toStrictEqual({ ...oneClick, evmAssets: [] });
  });

  it('accepts a configured EVM asset identity binding', () => {
    const oneClick = { serviceUrl: 'https://swap.example', midenAssets, evmAssets: [evmAsset] };
    const parsed = parseBridgeConfig({ ...doc({ swap: { oneClick } }), network: 'mainnet' }, 'mainnet');

    expect(parsed?.swap?.oneClick).toStrictEqual(oneClick);
  });

  it.each([
    ['missing asset ID', { ...evmAsset, assetId: undefined }],
    ['unsupported chain', { ...evmAsset, blockchain: 'polygon', chainId: 137 }],
    ['chain ID does not match its chain', { ...evmAsset, chainId: 1 }],
    ['malformed contract address', { ...evmAsset, contractAddress: '0xnot-an-address' }],
    ['invalid decimals', { ...evmAsset, decimals: 39 }],
    ['missing display symbol', { ...evmAsset, symbol: '' }]
  ])('disables an invalid EVM asset binding: %s', (_label, mapping) => {
    const oneClick = { serviceUrl: 'https://swap.example', midenAssets, evmAssets: [mapping] };

    expect(parseBridgeConfig({ ...doc({ swap: { oneClick } }), network: 'mainnet' }, 'mainnet')).toBeNull();
  });

  it('disables duplicate EVM asset IDs', () => {
    const oneClick = { serviceUrl: 'https://swap.example', midenAssets, evmAssets: [evmAsset, { ...evmAsset }] };

    expect(parseBridgeConfig({ ...doc({ swap: { oneClick } }), network: 'mainnet' }, 'mainnet')).toBeNull();
  });

  it('disables duplicate EVM chain and contract bindings', () => {
    const oneClick = {
      serviceUrl: 'https://swap.example',
      midenAssets,
      evmAssets: [evmAsset, { ...evmAsset, assetId: 'another-provider-id' }]
    };

    expect(parseBridgeConfig({ ...doc({ swap: { oneClick } }), network: 'mainnet' }, 'mainnet')).toBeNull();
  });
});

it('lowercases Miden account ids written in upper case', () => {
  const parsed = parseBridgeConfig(
    withSection('agglayer', { midenBridge: '0x3B66E20B5088F25133B69216484652' }),
    'testnet'
  );
  expect(parsed?.supportedEvmChains.sepolia?.bridges.agglayer?.midenBridgeId).toBe('0x3b66e20b5088f25133b69216484652');
});

it.each([
  ['https://allocator.example/', 'https://allocator.example'],
  ['https://allocator.example//', 'https://allocator.example'],
  ['https://bridge.example/api/', 'https://bridge.example/api'],
  ['https://Allocator.Example:8443/v1', 'https://allocator.example:8443/v1']
])('normalizes the base URL %s to %s in every URL field', (input, expected) => {
  const epoch = parseBridgeConfig(withSection('epoch', { allocatorUrl: input, positionsUrl: input }), 'testnet');
  const agglayer = parseBridgeConfig(withSection('agglayer', { indexerUrl: input }), 'testnet');
  expect(epoch?.['bridge-providers'].epoch.allocatorUrl).toBe(expected);
  expect(epoch?.['bridge-providers'].epoch.positionsUrl).toBe(expected);
  expect(agglayer?.['bridge-providers'].agglayer.indexerUrl).toBe(expected);
});

it('ignores unknown fields at each level', () => {
  const base = doc();
  const extended = {
    ...base,
    schema: 2,
    'bridge-providers': { ...base['bridge-providers'], epoch: { ...base['bridge-providers'].epoch, solver: 1 } },
    supportedEvmChains: { sepolia: { ...base.supportedEvmChains.sepolia, rpcUrl: 'https://rpc.example' } },
    features: { ...base.features, swap: true },
    mainnetCountdown: { ...base.mainnetCountdown, label: 'never read' }
  };
  expect(parseBridgeConfig(extended, 'testnet')).toStrictEqual(parseBridgeConfig(doc(), 'testnet'));
});

it('reads absent sections as empty and absent switches as off', () => {
  expect(parseBridgeConfig({ network: 'devnet', version: 3 }, 'devnet')).toStrictEqual({
    network: 'devnet',
    version: 3,
    'bridge-providers': { epoch: {}, agglayer: {}, usdcx: {} },
    supportedEvmChains: {},
    features: ALL_OFF,
    mainnetCountdown: { enabled: false },
    swap: {}
  });
});

describe('limits.bridgeInMaxBalanceUsd', () => {
  it('reads the bridge-in balance ceiling', () => {
    const parsed = parseBridgeConfig(doc({ limits: { bridgeInMaxBalanceUsd: 1232.462 } }), 'testnet');
    expect(parsed?.limits).toStrictEqual({ bridgeInMaxBalanceUsd: 1232.462 });
  });

  it.each([
    ['no limits section', doc()],
    ['an empty limits section', doc({ limits: {} })],
    ['a limits section with other fields', doc({ limits: { other: 1 } })]
  ])('leaves limits out for %s', (_label, body) => {
    const parsed = parseBridgeConfig(body, 'testnet');
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty('limits');
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1232.462', null, true])(
    'fails the document on the malformed ceiling %p',
    bridgeInMaxBalanceUsd => {
      expect(parseBridgeConfig(doc({ limits: { bridgeInMaxBalanceUsd } }), 'testnet')).toBeNull();
    }
  );

  it('fails the document on a limits section that is not an object', () => {
    expect(parseBridgeConfig(doc({ limits: 1232 }), 'testnet')).toBeNull();
  });
});

describe('onboarding', () => {
  // The countdown's moment is the one switch behind the invite-only Welcome, so a document's `onboarding`
  // section, which older wallets read, is neither read nor checked.
  it.each([
    ['an onboarding section', doc({ onboarding: { inviteOnly: true } })],
    ['an onboarding section that is not an object', doc({ onboarding: true })],
    ['an invite-only flag written as text', doc({ onboarding: { inviteOnly: 'true' } })]
  ])('ignores %s', (_label, body) => {
    const parsed = parseBridgeConfig(body, 'testnet');
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty('onboarding');
  });
});

it('leaves absent provider fields out', () => {
  const partial = {
    network: 'testnet',
    version: 2,
    'bridge-providers': { epoch: { allocatorUrl: 'https://allocator.example' } },
    features: { earn: false }
  };
  expect(parseBridgeConfig(partial, 'testnet')).toEqual({
    ...partial,
    features: { earn: false, nearIntents: false },
    'bridge-providers': { epoch: partial['bridge-providers'].epoch, agglayer: {}, usdcx: {} },
    supportedEvmChains: {},
    mainnetCountdown: { enabled: false },
    swap: {}
  });
});

it('reads the countdown switch without its moment, and a moment with fractional seconds', () => {
  expect(parseBridgeConfig(doc({ mainnetCountdown: { enabled: true } }), 'testnet')?.mainnetCountdown).toStrictEqual({
    enabled: true
  });
  expect(
    parseBridgeConfig(doc({ mainnetCountdown: { launchAt: '2026-10-26T00:00:00.500Z' } }), 'testnet')?.mainnetCountdown
  ).toStrictEqual({ enabled: false, launchAt: Date.UTC(2026, 9, 26, 0, 0, 0, 500) });
});

it('rejects a chain whose slug and id do not match', () => {
  expect(parseBridgeConfig(withSection('evm', { chainId: 84532 }), 'testnet')).toBeNull();
  expect(parseBridgeConfig(doc({ supportedEvmChains: { polygon: { chainId: 11155111 } } }), 'testnet')).toBeNull();
});

describe('values this build does not know', () => {
  const published = parseBridgeConfig(testnet, 'testnet');
  const chains = testnet.supportedEvmChains;
  const providers = testnet['bridge-providers'];
  const withChains = (supportedEvmChains: Record<string, ConfigValue>) => ({ ...testnet, supportedEvmChains });
  const withProviders = (fields: Record<string, ConfigValue>) => ({
    ...testnet,
    'bridge-providers': { ...providers, ...fields }
  });

  it('skips a chain this build has no name for and keeps the rest', () => {
    const body = withChains({
      ...chains,
      'polygon-amoy': { chainId: 80002, bridges: { usdcx: chains['base-sepolia'].bridges.usdcx } }
    });
    const parsed = parseBridgeConfig(body, 'testnet');
    expect(parsed).not.toBeNull();
    expect(parsed).toStrictEqual(published);
  });

  it('leaves out a USDCx deposit route it does not know and every executor deposit through that chain', () => {
    const arc = chains['arc-testnet'];
    const body = withChains({
      ...chains,
      'arc-testnet': {
        ...arc,
        bridges: {
          usdcx: { ...arc.bridges.usdcx, deposit: { route: 'cctp-v3', bridge: arc.bridges.usdcx.executor.address } }
        }
      }
    });
    const parsed = parseBridgeConfig(body, 'testnet');
    expect(parsed).not.toBeNull();
    expect(parsed?.swap).toStrictEqual(published?.swap);
    expect(parsed?.supportedEvmChains.sepolia?.bridges.epoch).toStrictEqual(
      published?.supportedEvmChains.sepolia?.bridges.epoch
    );
    expect(parsed?.supportedEvmChains.sepolia?.bridges.agglayer).toStrictEqual(
      published?.supportedEvmChains.sepolia?.bridges.agglayer
    );
    const arcRoute = parsed?.supportedEvmChains['arc-testnet']?.bridges.usdcx;
    expect(arcRoute?.tokens).toStrictEqual(published?.supportedEvmChains['arc-testnet']?.bridges.usdcx?.tokens);
    expect(arcRoute).not.toHaveProperty('deposit');
    expect(arcRoute).not.toHaveProperty('executor');
    for (const slug of ['sepolia', 'base-sepolia', 'arbitrum-sepolia']) {
      const source = parsed?.supportedEvmChains[slug]?.bridges.usdcx;
      expect(source?.depositEnabled).toBe(true);
      expect(source).not.toHaveProperty('deposit');
    }
  });

  it('leaves out an Epoch or USDCx route that lists no token it knows', () => {
    const baseSepolia = chains['base-sepolia'];
    const tokens = { USDT: { contractAddress: '0x7169D38820dfd117C3FA1f22a697dBA58d90BA06' } };
    const epoch = { depositEnabled: true, withdrawalEnabled: true, tokens };
    const body = withChains({
      ...chains,
      'base-sepolia': { ...baseSepolia, bridges: { ...baseSepolia.bridges, epoch } }
    });
    expect(parseBridgeConfig(body, 'testnet')).not.toBeNull();
    expect(parseBridgeConfig(body, 'testnet')).toStrictEqual(published);
    const usdcx = { ...baseSepolia.bridges.usdcx, tokens };
    const parsed = parseBridgeConfig(
      withChains({ ...chains, 'base-sepolia': { ...baseSepolia, bridges: { usdcx } } }),
      'testnet'
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.supportedEvmChains['base-sepolia']?.bridges).toStrictEqual({});
  });

  it('reads an Epoch output under any name and leaves out a token output nothing declares', () => {
    const sepolia = chains.sepolia;
    const usdc = sepolia.bridges.epoch.tokens.USDC;
    const outputs = {
      ...providers.epoch.outputs,
      'usdc-mainnet-output': { faucetId: '0x537c15a622074e91188aa894456c52' }
    };
    const epoch = {
      ...sepolia.bridges.epoch,
      tokens: { USDC: { ...usdc, outputs: ['usdc-mainnet-output', 'usdc-other'] } }
    };
    const body = {
      ...withProviders({ epoch: { ...providers.epoch, outputs } }),
      supportedEvmChains: { ...chains, sepolia: { ...sepolia, bridges: { ...sepolia.bridges, epoch } } }
    };
    const parsed = parseBridgeConfig(body, 'testnet');
    expect(parsed).not.toBeNull();
    expect(parsed?.['bridge-providers'].epoch.outputs).toStrictEqual(outputs);
    expect(parsed?.supportedEvmChains.sepolia?.bridges.epoch?.tokens.USDC?.outputs).toStrictEqual([
      'usdc-mainnet-output'
    ]);
    expect(parsed?.swap).toStrictEqual(published?.swap);
  });

  it('keeps only the declared Epoch output where Object.hasOwn is missing', () => {
    const sepolia = chains.sepolia;
    const usdc = sepolia.bridges.epoch.tokens.USDC;
    const epoch = {
      ...sepolia.bridges.epoch,
      tokens: { USDC: { ...usdc, outputs: ['usdc-testnet-output', 'usdc-other'] } }
    };
    const body = {
      ...withProviders({ epoch: providers.epoch }),
      supportedEvmChains: { ...chains, sepolia: { ...sepolia, bridges: { ...sepolia.bridges, epoch } } }
    };
    const saved = Object.hasOwn;
    // @ts-expect-error simulating Safari before 15.4
    delete Object.hasOwn;
    try {
      const parsed = parseBridgeConfig(body, 'testnet');
      expect(parsed?.supportedEvmChains.sepolia?.bridges.epoch?.tokens.USDC?.outputs).toStrictEqual([
        'usdc-testnet-output'
      ]);
    } finally {
      Object.hasOwn = saved;
    }
  });

  it('reads Epoch outputs off testnet', () => {
    const outputs = { 'usdc-mainnet-output': { faucetId: '0x537c15a622074e91188aa894456c52' } };
    const parsed = parseBridgeConfig(
      { network: 'mainnet', version: 1, 'bridge-providers': { epoch: { outputs } } },
      'mainnet'
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.['bridge-providers'].epoch.outputs).toStrictEqual(outputs);
  });

  it('still rejects an executor deposit through a listed chain that never had an executor, and a route id not text', () => {
    const baseSepolia = chains['base-sepolia'];
    const usdcx = baseSepolia.bridges.usdcx;
    const through = (deposit: Record<string, ConfigValue>) =>
      withChains({ ...chains, 'base-sepolia': { ...baseSepolia, bridges: { usdcx: { ...usdcx, deposit } } } });
    expect(parseBridgeConfig(through({ ...usdcx.deposit, executorChain: 'sepolia' }), 'testnet')).toBeNull();
    expect(parseBridgeConfig(through({ ...usdcx.deposit, route: 7 }), 'testnet')).toBeNull();
  });

  it.each([
    ['indexerUrl', { agglayer: {} }, 'agglayer'],
    ['positionsUrl', { epoch: { ...providers.epoch, positionsUrl: undefined } }, 'epoch'],
    ['allocatorUrl', { epoch: { ...providers.epoch, allocatorUrl: undefined } }, 'epoch'],
    ['irisUrl', { usdcx: { ...providers.usdcx, irisUrl: undefined } }, 'usdcx'],
    ['attestationUrl', { usdcx: { ...providers.usdcx, attestationUrl: undefined } }, 'usdcx'],
    ['midenDomain', { usdcx: { ...providers.usdcx, midenDomain: undefined } }, 'usdcx']
  ])('leaves out every route that needs a missing %s and keeps the rest', (_name, fields, bridge) => {
    const parsed = parseBridgeConfig(withProviders(fields), 'testnet');
    expect(parsed).not.toBeNull();
    expect(parsed?.swap).toStrictEqual(published?.swap);
    expect(parsed?.features).toStrictEqual(published?.features);
    expect(parsed?.mainnetCountdown).toStrictEqual(published?.mainnetCountdown);
    for (const [slug, chain] of Object.entries(published?.supportedEvmChains ?? {})) {
      const kept = Object.fromEntries(Object.entries(chain.bridges).filter(([name]) => name !== bridge));
      expect(parsed?.supportedEvmChains[slug]?.bridges).toStrictEqual(kept);
    }
  });
});

it('ignores removed market configuration', () => {
  const parsed = parseBridgeConfig(withSection('epoch', { earnProtocol: 'aave-v3' }), 'testnet');
  expect(parsed?.['bridge-providers'].epoch).not.toHaveProperty('earnProtocol');
  expect(parsed?.['bridge-providers'].epoch.allocatorUrl).toBe('https://testnet-dev.epochprotocol.xyz');
});

it('supports each chain in the wallet registry', () => {
  expect(SUPPORTED_EVM_CHAIN_IDS).toEqual([11155111, 5042002, 84532, 421614, 1, 8453, 42161, 5042, 10]);
});

it('takes supported ids from the wallet registry', () => {
  let schema!: typeof import('./schema');
  jest.isolateModules(() => {
    jest.doMock('lib/walletconnect/config', () => ({ SUPPORTED_CHAINS: [{ id: 11155111 }, { id: 84532 }] }));
    schema = require('./schema');
  });
  expect(schema.SUPPORTED_EVM_CHAIN_IDS).toEqual([11155111, 84532]);
});

it.each([
  ['a string', 'testnet'],
  ['null', null],
  ['an array', [doc()]],
  ['another network', doc({ network: 'devnet' })],
  ['no network', doc({ network: undefined })],
  ['version 0', doc({ version: 0 })],
  ['a negative version', doc({ version: -1 })],
  ['a fractional version', doc({ version: 1.5 })],
  ['a version written as text', doc({ version: '1' })],
  ['a version past the safe integers', doc({ version: 2 ** 53 })],
  ['no version', doc({ version: undefined })],
  ['an evm section that is not an object', doc({ supportedEvmChains: 11155111 })],
  ['a null agglayer section', doc({ 'bridge-providers': { agglayer: null } })],
  ['an epoch section that is an array', doc({ 'bridge-providers': { epoch: [] } })],
  ['a features section that is not an object', doc({ features: true })],
  ['a chain id written as text', withSection('evm', { chainId: '11155111' })],
  ['chain id 0', withSection('evm', { chainId: 0 })],
  ['a fractional chain id', withSection('evm', { chainId: 1.5 })],
  ['a null field', withSection('agglayer', { l1Bridge: null })],
  ['a 19-byte L1 bridge', withSection('agglayer', { l1Bridge: '0x1348947e282138d8f377b467f7d9c2eb0f335d' })],
  ['an L1 bridge without 0x', withSection('agglayer', { l1Bridge: '1348947e282138d8f377b467f7d9c2eb0f335d1f' })],
  ['an EVM USDC that is not hex', withSection('epoch', { evmUsdc: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefdZZ' })],
  ['a 16-byte Miden bridge', withSection('agglayer', { midenBridge: '0x3b66e20b5088f25133b6921648465200' })],
  ['a bech32 Miden USDC faucet', withSection('epoch', { midenUsdcFaucet: 'mtst1qpg3usdcfaucet' })],
  ['a numeric account id', withSection('epoch', { midenUsdcFaucet: 12 })],
  ['an http URL', withSection('epoch', { allocatorUrl: 'http://testnet-dev.epochprotocol.xyz' })],
  ['local http without the E2E allowance', withSection('epoch', { allocatorUrl: 'http://127.0.0.1:8548' })],
  ['an ftp URL', withSection('agglayer', { indexerUrl: 'ftp://bridge.example/api' })],
  ['a URL that does not parse', withSection('epoch', { positionsUrl: 'positions.example' })],
  ['a URL with a user name', withSection('epoch', { allocatorUrl: 'https://user@allocator.example' })],
  ['a URL with a password', withSection('epoch', { allocatorUrl: 'https://:secret@allocator.example' })],
  ['a URL with a query', withSection('epoch', { allocatorUrl: 'https://allocator.example/?key=1' })],
  ['a URL with a fragment', withSection('epoch', { allocatorUrl: 'https://allocator.example/#top' })],
  ['a numeric URL', withSection('agglayer', { indexerUrl: 443 })],
  ['a numeric output list', doc({ 'bridge-providers': { epoch: { outputs: 1 } } })],
  ['a switch written as text', withSection('features', { earn: 'true' })],
  ['a numeric switch', withSection('features', { bridgeIn: 1 })],
  ['a null switch', withSection('features', { bridgeOut: null })],
  ['a geo section that is not an object', doc({ geo: [] })],
  ['a geo rule that is not an object', doc({ geo: { earn: ['block UK'] } })],
  ['a geo answer that is not yes or no', doc({ geo: { earn: { 'block UK': true } } })]
])('rejects a document with %s', (_label, body) => {
  expect(parseBridgeConfig(body, 'testnet')).toBeNull();
});

it.each([
  ['a countdown section that is an array', doc({ mainnetCountdown: [] })],
  ['a null countdown section', doc({ mainnetCountdown: null })],
  ['a countdown switch written as text', withSection('mainnetCountdown', { enabled: 'true' })],
  ['a countdown moment as a date only', withSection('mainnetCountdown', { launchAt: '2026-10-26' })],
  ['a countdown moment with an offset', withSection('mainnetCountdown', { launchAt: '2026-10-26T00:00:00+02:00' })],
  ['a countdown moment with a space', withSection('mainnetCountdown', { launchAt: '2026-10-26 00:00:00Z' })],
  ['a countdown moment that is not a date', withSection('mainnetCountdown', { launchAt: '2026-13-40T00:00:00Z' })],
  ['a countdown moment on an impossible day', withSection('mainnetCountdown', { launchAt: '2026-02-30T00:00:00Z' })],
  ['a numeric countdown moment', withSection('mainnetCountdown', { launchAt: 1792000000000 })]
])('turns the countdown off, and keeps the rest, for %s', (_label, body) => {
  const parsed = parseBridgeConfig(body, 'testnet');
  expect(parsed).not.toBeNull();
  expect(parsed?.mainnetCountdown).toStrictEqual({ enabled: false });
  expect(parsed?.features).toStrictEqual({ earn: true, nearIntents: false });
  expect(parsed?.supportedEvmChains.sepolia?.chainId).toBe(11155111);
  expect(parsed?.['bridge-providers'].epoch.allocatorUrl).toBe('https://testnet-dev.epochprotocol.xyz');
});

it('reads a fraction of any length as the same instant', () => {
  const at = (launchAt: string) =>
    parseBridgeConfig(withSection('mainnetCountdown', { launchAt }), 'testnet')?.mainnetCountdown;
  expect(at('2026-10-26T00:00:00.5Z')).toStrictEqual(at('2026-10-26T00:00:00.500Z'));
  expect(at('2026-10-26T00:00:00.5Z')?.launchAt).toBe(Date.UTC(2026, 9, 26, 0, 0, 0, 500));
});

describe('the Earn vaults', () => {
  const SEPOLIA_USDC = '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69';
  const withVaults = (vaults: ConfigValue) => doc({ earn: { vaults } });
  const withVault = (fields: Record<string, ConfigValue>) => withVaults([{ ...DUMMY_VAULT, ...fields }]);
  const without = (field: string) =>
    withVaults([Object.fromEntries(Object.entries(DUMMY_VAULT).filter(([key]) => key !== field))]);
  // A second Epoch-less chain, so a vault can name a listed chain that has no Epoch route.
  const withArc = (vaults: ConfigValue) => {
    const base = withVaults(vaults);
    return {
      ...base,
      supportedEvmChains: { ...base.supportedEvmChains, 'arc-testnet': { chainId: 5042002, bridges: {} } }
    };
  };

  it('keeps each vault in the document order, its uid in lowercase and its deposits on by default', () => {
    const aave = {
      id: 'aave-v3-sepolia-usdc',
      marketUid: `AAVE_V3:11155111:${SEPOLIA_USDC}`,
      name: 'Aave V3 USDC',
      protocol: '1delta',
      about: 'Lends USDC to Aave V3 borrowers.',
      risk: 'medium',
      depositsEnabled: false
    };
    expect(parseBridgeConfig(withVaults([DUMMY_VAULT, aave]), 'testnet')?.earn).toStrictEqual({
      vaults: [
        {
          id: 'dummy-lending-sepolia-usdc',
          marketUid: `dummy_lending:11155111:${SEPOLIA_USDC}`,
          name: 'Dummy Lending USDC',
          protocol: 'dummy-lending',
          depositsEnabled: true
        },
        {
          id: 'aave-v3-sepolia-usdc',
          marketUid: `aave_v3:11155111:${SEPOLIA_USDC}`,
          name: 'Aave V3 USDC',
          protocol: '1delta',
          about: 'Lends USDC to Aave V3 borrowers.',
          risk: 'medium',
          depositsEnabled: false
        }
      ]
    });
  });

  it('parses the bundled testnet document with its vault', () => {
    expect(parseBridgeConfig(testnet, 'testnet')?.earn?.vaults.map(vault => vault.id)).toEqual([
      'dummy-lending-sepolia-usdc'
    ]);
  });

  it.each([
    ['a 64-character name', withVault({ name: 'n'.repeat(64) })],
    ['a 200-character about', withVault({ about: 'a'.repeat(200) })],
    ['a name with spaces at its ends, which no rule checks', withVault({ name: ' Dummy ' })],
    ['a risk of low', withVault({ risk: 'low' })],
    ['a risk of medium', withVault({ risk: 'medium' })],
    ['a risk of high', withVault({ risk: 'high' })],
    ['vaults that all stop deposits', withVault({ depositsEnabled: false })],
    ['an unknown field', withVault({ colour: 'blue' })],
    ['an SVG logo', withVault({ logo: 'icons/aave.svg' })],
    ['a PNG logo with hyphens and digits', withVault({ logo: 'icons/morpho-blue-2.png' })]
  ])('accepts %s', (_label, body) => {
    expect(parseBridgeConfig(body, 'testnet')?.earn?.vaults).toHaveLength(1);
  });

  it('keeps a logo as written and omits one the vault does not name', () => {
    const second = { ...DUMMY_VAULT, id: 'aave-v3-sepolia-usdc', marketUid: `AAVE_V3:11155111:${SEPOLIA_USDC}` };
    const vaults = parseBridgeConfig(
      withVaults([
        { ...DUMMY_VAULT, logo: 'icons/aave.svg' },
        { ...second, logo: 'icons/aave.svg' },
        { ...second, id: 'third', marketUid: `MORPHO_BLUE:11155111:${SEPOLIA_USDC}` }
      ]),
      'testnet'
    )?.earn?.vaults;
    // Two vaults may share one file.
    expect(vaults?.map(vault => vault.logo)).toEqual(['icons/aave.svg', 'icons/aave.svg', undefined]);
    expect(vaults?.[2]).not.toHaveProperty('logo');
  });

  it('accepts as many vaults as the document lists', () => {
    const vaults = Array.from({ length: 40 }, (_, i) => ({
      ...DUMMY_VAULT,
      id: `vault-${i}`,
      marketUid: `LENDER_${i}:11155111:${SEPOLIA_USDC}`
    }));
    expect(parseBridgeConfig(withVaults(vaults), 'testnet')?.earn?.vaults).toHaveLength(40);
  });

  it('reads a vault on a route this build leaves out, as the config repo reads it', () => {
    const base = doc();
    const futureChain = {
      chainId: 999999999,
      bridges: {
        epoch: {
          depositEnabled: true,
          withdrawalEnabled: true,
          tokens: { USDC: { contractAddress: '0x1111111111111111111111111111111111111111' } }
        }
      }
    };
    const body = {
      ...base,
      supportedEvmChains: { ...base.supportedEvmChains, 'future-chain': futureChain },
      earn: {
        vaults: [
          DUMMY_VAULT,
          { ...DUMMY_VAULT, id: 'future', marketUid: 'AAVE_V3:999999999:0x1111111111111111111111111111111111111111' }
        ]
      }
    };
    const parsed = parseBridgeConfig(body, 'testnet');
    expect(parsed?.supportedEvmChains).not.toHaveProperty('future-chain');
    expect(parsed?.earn?.vaults.map(vault => vault.id)).toEqual(['dummy-lending-sepolia-usdc', 'future']);
  });

  it('reads a vault on an Epoch route left out for want of provider values', () => {
    const body = withSection('epoch', { allocatorUrl: undefined });
    const parsed = parseBridgeConfig(body, 'testnet');
    expect(parsed?.supportedEvmChains.sepolia?.bridges).not.toHaveProperty('epoch');
    expect(parsed?.earn?.vaults).toHaveLength(1);
  });

  it.each([
    ['Earn on with no earn section', doc({ earn: undefined })],
    ['Earn on with an empty vault list', withVaults([])],
    ['Earn on with no vault list', doc({ earn: {} })],
    ['an earn section with Earn off', doc({ features: { earn: false } })],
    ['an earn section with no Earn switch', doc({ features: {} })],
    ['an earn section that is not an object', doc({ earn: [DUMMY_VAULT] })],
    ['a vault list that is not an array', withVaults({ dummy: DUMMY_VAULT })],
    ['a vault that is not an object', withVaults(['dummy-lending-sepolia-usdc'])],
    ['a vault with no id', without('id')],
    ['an id with a capital letter', withVault({ id: 'Dummy-lending' })],
    ['an id that starts with a digit', withVault({ id: '1-dummy' })],
    ['an id that starts with a hyphen', withVault({ id: '-dummy' })],
    ['an id with an underscore', withVault({ id: 'dummy_lending' })],
    ['an empty id', withVault({ id: '' })],
    ['a numeric id', withVault({ id: 7 })],
    [
      'two vaults with one id',
      withVaults([DUMMY_VAULT, { ...DUMMY_VAULT, marketUid: `AAVE_V3:11155111:${SEPOLIA_USDC}` }])
    ],
    ['a vault with no market', without('marketUid')],
    ['a market of two parts', withVault({ marketUid: `DUMMY_LENDING:${SEPOLIA_USDC}` })],
    ['a market of four parts', withVault({ marketUid: `DUMMY_LENDING:11155111:${SEPOLIA_USDC}:1` })],
    ['a lowercase lender key', withVault({ marketUid: `dummy_lending:11155111:${SEPOLIA_USDC}` })],
    ['a lender key with a hyphen', withVault({ marketUid: `DUMMY-LENDING:11155111:${SEPOLIA_USDC}` })],
    ['an empty lender key', withVault({ marketUid: `:11155111:${SEPOLIA_USDC}` })],
    ['a chain id of zero', withVault({ marketUid: `DUMMY_LENDING:0:${SEPOLIA_USDC}` })],
    ['a chain id with a leading zero', withVault({ marketUid: `DUMMY_LENDING:011155111:${SEPOLIA_USDC}` })],
    ['a chain id that is not a number', withVault({ marketUid: `DUMMY_LENDING:sepolia:${SEPOLIA_USDC}` })],
    ['a chain the document does not list', withVault({ marketUid: `DUMMY_LENDING:1:${SEPOLIA_USDC}` })],
    [
      'a listed chain with no Epoch route',
      withArc([{ ...DUMMY_VAULT, marketUid: `DUMMY_LENDING:5042002:${SEPOLIA_USDC}` }])
    ],
    [
      'a token other than the route USDC',
      withVault({ marketUid: 'DUMMY_LENDING:11155111:0x1c7d4b196cb0c7b01d743fbc6116a902379c7238' })
    ],
    [
      'a checksummed token',
      withVault({ marketUid: 'DUMMY_LENDING:11155111:0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69' })
    ],
    ['a token without 0x', withVault({ marketUid: `DUMMY_LENDING:11155111:${SEPOLIA_USDC.slice(2)}` })],
    ['a numeric market', withVault({ marketUid: 11155111 })],
    ['two vaults with one market', withVaults([DUMMY_VAULT, { ...DUMMY_VAULT, id: 'dummy-again' }])],
    ['a vault with no name', without('name')],
    ['an empty name', withVault({ name: '' })],
    ['a 65-character name', withVault({ name: 'n'.repeat(65) })],
    ['a numeric name', withVault({ name: 12 })],
    ['a vault with no protocol', without('protocol')],
    ['an unknown protocol', withVault({ protocol: 'aave-v3' })],
    ['a protocol in capitals', withVault({ protocol: '1DELTA' })],
    ['an empty about', withVault({ about: '' })],
    ['a 201-character about', withVault({ about: 'a'.repeat(201) })],
    ['a null about', withVault({ about: null })],
    ['an unknown risk', withVault({ risk: 'extreme' })],
    ['a risk in capitals', withVault({ risk: 'Low' })],
    ['a deposits switch written as text', withVault({ depositsEnabled: 'false' })],
    ['a null deposits switch', withVault({ depositsEnabled: null })],
    ['a logo outside icons/', withVault({ logo: 'aave.svg' })],
    ['a logo that is a URL', withVault({ logo: 'https://example.com/icons/aave.svg' })],
    ['a logo that climbs out of icons/', withVault({ logo: 'icons/../aave.svg' })],
    ['a logo in a folder under icons/', withVault({ logo: 'icons/lender/aave.svg' })],
    ['a logo with a capital letter', withVault({ logo: 'icons/Aave.svg' })],
    ['a logo with an underscore', withVault({ logo: 'icons/aave_v3.svg' })],
    ['a logo with a doubled hyphen', withVault({ logo: 'icons/aave--v3.svg' })],
    ['a logo with a leading hyphen', withVault({ logo: 'icons/-aave.svg' })],
    ['a WebP logo', withVault({ logo: 'icons/aave.webp' })],
    ['a logo with an upper-case extension', withVault({ logo: 'icons/aave.SVG' })],
    ['a logo with a query', withVault({ logo: 'icons/aave.svg?x=1' })],
    ['an empty logo', withVault({ logo: '' })],
    ['a null logo', withVault({ logo: null })],
    ['a numeric logo', withVault({ logo: 7 })]
  ])('rejects a document with %s', (_label, body) => {
    expect(parseBridgeConfig(body, 'testnet')).toBeNull();
  });

  it('accepts no earn section while Earn is off or absent', () => {
    expect(parseBridgeConfig(doc({ features: { earn: false }, earn: undefined }), 'testnet')?.earn).toBeUndefined();
    expect(parseBridgeConfig(doc({ features: {}, earn: undefined }), 'testnet')?.features.earn).toBe(false);
  });
});

describe('the Guardian operators', () => {
  const OZ = {
    id: 'open-zeppelin',
    name: 'OpenZeppelin',
    operatedBy: 'OpenZeppelin',
    location: 'US-EAST',
    endpoint: 'https://guardian-testnet.openzeppelin.com'
  };
  const KODA = {
    id: 'kodax',
    name: 'Koda',
    operatedBy: 'Korea Digital Asset (Koda)',
    location: 'Asia (SK)',
    endpoint: 'https://guardian-testnet.kodax.com'
  };
  const entry = (index: number) => ({ ...OZ, id: `operator-${index}`, endpoint: `https://guardian-${index}.example` });
  const guardians = (list: unknown) => parseBridgeConfig(doc({ guardians: list }), 'testnet');

  it('reads no list from a document that has none, so the wallet keeps its own', () => {
    const parsed = parseBridgeConfig(doc(), 'testnet');
    expect(parsed).not.toBeNull();
    expect(parsed && 'guardians' in parsed).toBe(false);
  });

  it('reads the list in document order', () => {
    expect(guardians([KODA, OZ])?.guardians).toStrictEqual([KODA, OZ]);
  });

  it('puts an endpoint in the form the wallet compares: lowercase host, no default port, no trailing slash', () => {
    const parsed = guardians([{ ...OZ, endpoint: 'https://GUARDIAN-TESTNET.openzeppelin.com:443//' }]);
    expect(parsed?.guardians?.[0]?.endpoint).toBe('https://guardian-testnet.openzeppelin.com');
  });

  it('ignores a field of an entry that it does not know', () => {
    expect(guardians([{ ...OZ, logoUrl: 'https://example.com/logo.png' }])?.guardians).toStrictEqual([OZ]);
  });

  it('accepts 16 operators and refuses 17', () => {
    expect(guardians(Array.from({ length: 16 }, (_, index) => entry(index)))?.guardians).toHaveLength(16);
    expect(guardians(Array.from({ length: 17 }, (_, index) => entry(index)))).toBeNull();
  });

  it.each<[string, unknown]>([
    ['a list that is an object', {}],
    ['a list that is null', null],
    ['an empty list', []],
    ['an entry that is a URL string', [OZ.endpoint]],
    ['an entry that is null', [null]],
    ['an id with an upper-case letter', [{ ...OZ, id: 'OpenZeppelin' }]],
    ['an id with a double hyphen', [{ ...OZ, id: 'open--zeppelin' }]],
    ['an id that ends in a hyphen', [{ ...OZ, id: 'open-' }]],
    ['an empty id', [{ ...OZ, id: '' }]],
    ['an id of 33 characters', [{ ...OZ, id: 'a'.repeat(33) }]],
    ['a numeric id', [{ ...OZ, id: 7 }]],
    ['the id of the custom endpoint', [{ ...OZ, id: 'custom' }]],
    ['the id of the no-Guardian choice', [{ ...OZ, id: 'no-guardian' }]],
    ['a missing name', [{ id: OZ.id, operatedBy: OZ.operatedBy, location: OZ.location, endpoint: OZ.endpoint }]],
    ['an empty name', [{ ...OZ, name: '' }]],
    ['a name of 49 characters', [{ ...OZ, name: 'n'.repeat(49) }]],
    ['a name with a space at its start', [{ ...OZ, name: ' OpenZeppelin' }]],
    ['an operator with a line break', [{ ...OZ, operatedBy: 'Open\nZeppelin' }]],
    ['an operator with a C1 control', [{ ...OZ, operatedBy: 'Open\u0085Zeppelin' }]],
    ['a numeric location', [{ ...OZ, location: 7 }]],
    ['a missing endpoint', [{ id: OZ.id, name: OZ.name, operatedBy: OZ.operatedBy, location: OZ.location }]],
    ['an http endpoint', [{ ...OZ, endpoint: 'http://guardian-testnet.openzeppelin.com' }]],
    ['a local http endpoint', [{ ...OZ, endpoint: 'http://localhost:3000' }]],
    ['an endpoint with a query', [{ ...OZ, endpoint: 'https://guardian-testnet.openzeppelin.com/?a=1' }]],
    ['an endpoint with credentials', [{ ...OZ, endpoint: 'https://user:pass@guardian-testnet.openzeppelin.com' }]],
    ['an about that is an object', [{ ...OZ, about: { en: 'A security company.' } }]],
    ['an empty about', [{ ...OZ, about: '' }]],
    ['an about of 161 characters', [{ ...OZ, about: 'a'.repeat(161) }]],
    ['an about with a line break', [{ ...OZ, about: 'A security\ncompany.' }]],
    ['an about with a space at its end', [{ ...OZ, about: 'A security company. ' }]],
    ['a kind that is null', [{ ...OZ, kind: null }]],
    ['a numeric kind', [{ ...OZ, kind: 7 }]],
    ['a kind of 65 characters', [{ ...OZ, kind: 'k'.repeat(65) }]],
    ['two entries with one id', [OZ, { ...KODA, id: OZ.id }]],
    [
      'two entries with one endpoint in two spellings',
      [OZ, { ...KODA, endpoint: 'https://Guardian-Testnet.OpenZeppelin.com/' }]
    ]
  ])('rejects the document for %s', (_label, list) => {
    expect(guardians(list)).toBeNull();
  });

  it('reads the about and kind texts as written', () => {
    const described = { ...OZ, about: 'A smart contract security company.', kind: 'Smart contract security' };
    expect(guardians([described, KODA])?.guardians).toStrictEqual([described, KODA]);
  });

  it('accepts an about and a kind at their length limits', () => {
    const parsed = guardians([{ ...OZ, about: 'a'.repeat(160), kind: 'k'.repeat(64) }]);
    expect(parsed?.guardians?.[0]).toMatchObject({ about: 'a'.repeat(160), kind: 'k'.repeat(64) });
  });

  it('accepts a name and an id at their length limits', () => {
    const parsed = guardians([{ ...OZ, id: 'a'.repeat(32), name: 'n'.repeat(48) }]);
    expect(parsed?.guardians?.[0]).toMatchObject({ id: 'a'.repeat(32), name: 'n'.repeat(48) });
  });

  it('accepts a local http endpoint only under the E2E allowance', () => {
    const parsed = parseBridgeConfig(doc({ guardians: [{ ...OZ, endpoint: 'http://localhost:3000/' }] }), 'testnet', {
      allowLocalHttp: true
    });
    expect(parsed?.guardians?.[0]?.endpoint).toBe('http://localhost:3000');
  });
});

describe('the E2E local http allowance', () => {
  it.each(['http://127.0.0.1:8548', 'http://localhost:8549/'])('accepts %s when allowed', input => {
    const parsed = parseBridgeConfig(withSection('epoch', { allocatorUrl: input }), 'testnet', {
      allowLocalHttp: true
    });
    expect(parsed?.['bridge-providers'].epoch.allocatorUrl).toBe(input.replace(/\/$/, ''));
  });

  it.each(['http://allocator.example', 'http://10.0.2.2:8548'])('still rejects %s', input => {
    const body = withSection('epoch', { allocatorUrl: input });
    expect(parseBridgeConfig(body, 'testnet', { allowLocalHttp: true })).toBeNull();
  });
});

describe('the 1Click local E2E gate', () => {
  const configured = doc({
    swap: {
      oneClick: {
        serviceUrl: 'https://one-click.example',
        midenAssets: [{ assetId: 'miden:usdc', faucetId: '0x537c15a622074e91188aa894456c52', decimals: 6 }]
      }
    }
  });

  it('hides 1Click outside mainnet unless the explicit local E2E option is enabled', () => {
    expect(parseBridgeConfig(configured, 'testnet')?.swap?.oneClick).toBeUndefined();
    const localnet = {
      ...configured,
      network: 'localnet',
      swap: {
        oneClick: {
          serviceUrl: 'http://127.0.0.1:8550',
          midenAssets: [{ assetId: 'miden:usdc', faucetId: '0x537c15a622074e91188aa894456c52', decimals: 6 }]
        }
      }
    };
    expect(parseBridgeConfig(localnet, 'localnet')?.swap?.oneClick).toBeUndefined();
    expect(
      parseBridgeConfig(localnet, 'localnet', { allowLocalHttp: true, allowOneClickLocalE2E: true })?.swap?.oneClick
    ).toMatchObject({ serviceUrl: 'http://127.0.0.1:8550' });
  });

  it('does not allow the local E2E option to enable 1Click on testnet or another network', () => {
    expect(parseBridgeConfig(configured, 'testnet', { allowOneClickLocalE2E: true })?.swap?.oneClick).toBeUndefined();
    expect(
      parseBridgeConfig({ ...configured, network: 'devnet' }, 'devnet', { allowOneClickLocalE2E: true })?.swap?.oneClick
    ).toBeUndefined();
  });

  it('allows loopback HTTP for 1Click only when both local E2E allowances are enabled', () => {
    const local = {
      ...configured,
      network: 'localnet',
      swap: {
        oneClick: {
          serviceUrl: 'http://127.0.0.1:8550',
          midenAssets: [{ assetId: 'miden:usdc', faucetId: '0x537c15a622074e91188aa894456c52', decimals: 6 }]
        }
      }
    };
    expect(parseBridgeConfig(local, 'localnet', { allowLocalHttp: true })?.swap?.oneClick).toBeUndefined();
    expect(parseBridgeConfig(local, 'localnet', { allowOneClickLocalE2E: true })?.swap).toBeUndefined();
    expect(
      parseBridgeConfig(local, 'localnet', { allowLocalHttp: true, allowOneClickLocalE2E: true })?.swap?.oneClick
    ).toMatchObject({ serviceUrl: 'http://127.0.0.1:8550' });
    expect(
      parseBridgeConfig({ ...local, network: 'mainnet' }, 'mainnet', {
        allowLocalHttp: true,
        allowOneClickLocalE2E: true
      })
    ).toBeNull();
    expect(
      parseBridgeConfig(
        {
          ...local,
          swap: {
            oneClick: {
              ...local.swap.oneClick,
              serviceUrl: 'https://one-click.example'
            }
          }
        },
        'localnet',
        { allowLocalHttp: true, allowOneClickLocalE2E: true }
      )
    ).toBeNull();
  });
});

describe('the AggLayer deposit tokens', () => {
  const agglayerRoute = (body: ReturnType<typeof parseBridgeConfig>) =>
    body?.supportedEvmChains.sepolia?.bridges.agglayer;

  it('reads the listed tokens, addresses lowercase, and the Blockscout root without its trailing slash', () => {
    const parsed = parseBridgeConfig(
      withSection('agglayer', {
        tokens: {
          USDC: { contractAddress: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69' },
          WBTC: { contractAddress: '0x21472DF1B5d2b673F6444B41258C6460294a2C06' }
        },
        tokenApiUrl: 'https://eth-sepolia.blockscout.com/api/v2/'
      }),
      'testnet'
    );
    expect(agglayerRoute(parsed)).toMatchObject({
      tokens: {
        USDC: { contractAddress: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69' },
        WBTC: { contractAddress: '0x21472df1b5d2b673f6444b41258c6460294a2c06' }
      },
      tokenApiUrl: 'https://eth-sepolia.blockscout.com/api/v2'
    });
  });

  it('leaves both out when the document names none', () => {
    const route = agglayerRoute(parseBridgeConfig(doc(), 'testnet'));
    expect(route).not.toHaveProperty('tokens');
    expect(route).not.toHaveProperty('tokenApiUrl');
  });

  it.each<[string, Record<string, ConfigValue>]>([
    ['a list instead of a map', { tokens: [] }],
    ['a lower-case symbol', { tokens: { usdc: { contractAddress: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69' } } }],
    ['a short address', { tokens: { USDC: { contractAddress: '0x1' } } }],
    [
      'one address twice',
      {
        tokens: {
          USDC: { contractAddress: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69' },
          USDT: { contractAddress: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69' }
        }
      }
    ],
    ['an http Blockscout root', { tokenApiUrl: 'http://eth-sepolia.blockscout.com/api/v2' }],
    ['a Blockscout root with a query', { tokenApiUrl: 'https://eth-sepolia.blockscout.com/api/v2?x=1' }]
  ])('rejects %s', (_label, fields) => {
    expect(parseBridgeConfig(withSection('agglayer', fields), 'testnet')).toBeNull();
  });
});

describe('geo place rules', () => {
  it('keeps yes answers for earn and swap, and drops a no, an unknown phrase, and an unknown feature', () => {
    const parsed = parseBridgeConfig(
      doc({
        geo: {
          earn: { 'block NY state': 'yes', 'block UK': 'yes', 'block US-CA': 'no', 'block Narnia': 'yes' },
          swap: { 'block DE': 'yes' },
          bridgeIn: { 'block UK': 'yes' }
        }
      }),
      'testnet'
    );
    expect(parsed?.geo).toEqual({
      earn: [{ country: 'US', region: 'NY' }, { country: 'GB' }],
      swap: [{ country: 'DE' }]
    });
  });

  it('omits the section when the document names none', () => {
    expect(parseBridgeConfig(doc(), 'testnet')?.geo).toBeUndefined();
  });
});
