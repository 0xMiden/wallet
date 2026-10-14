import { parseBridgeConfig, SUPPORTED_EVM_CHAIN_IDS } from './schema';
import testnet from './testing/testnet.json';

type ConfigValue = Parameters<typeof parseBridgeConfig>[0];
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
                contractAddress: 'l1Bridge' in fields ? fields.l1Bridge : chain.bridges.agglayer.contractAddress,
                midenBridgeId: fields.midenBridge ?? chain.bridges.agglayer.midenBridgeId
              }
            }
          }
        }
      };
  }
};

const ALL_OFF = { earn: false };

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
  expect(parsed?.features).toEqual({ earn: true });
  expect(parsed?.mainnetCountdown).toEqual({ enabled: true, launchAt: Date.UTC(2026, 9, 26) });
  expect(parsed?.swap).toEqual({});
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

it('leaves absent provider fields out', () => {
  const partial = {
    network: 'testnet',
    version: 2,
    'bridge-providers': { epoch: { allocatorUrl: 'https://allocator.example' } },
    features: { earn: false }
  };
  expect(parseBridgeConfig(partial, 'testnet')).toEqual({
    ...partial,
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
  ['a null switch', withSection('features', { bridgeOut: null })]
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
  expect(parsed?.features).toStrictEqual({ earn: true });
  expect(parsed?.supportedEvmChains.sepolia?.chainId).toBe(11155111);
  expect(parsed?.['bridge-providers'].epoch.allocatorUrl).toBe('https://testnet-dev.epochprotocol.xyz');
});

it('reads a fraction of any length as the same instant', () => {
  const at = (launchAt: string) =>
    parseBridgeConfig(withSection('mainnetCountdown', { launchAt }), 'testnet')?.mainnetCountdown;
  expect(at('2026-10-26T00:00:00.5Z')).toStrictEqual(at('2026-10-26T00:00:00.500Z'));
  expect(at('2026-10-26T00:00:00.5Z')?.launchAt).toBe(Date.UTC(2026, 9, 26, 0, 0, 0, 500));
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
