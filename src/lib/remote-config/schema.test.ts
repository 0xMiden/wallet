import { TEST_USDCX_SECTION } from 'lib/usdcx/testing/config';

import {
  isUsdcxDepositSource,
  parseBridgeConfig,
  SUPPORTED_EARN_PROTOCOLS,
  SUPPORTED_EVM_CHAIN_IDS,
  type UsdcxConfig,
  usdcxExecutorChain
} from './schema';

// The spec's testnet document, as the config repo publishes it.
const doc = (overrides: Record<string, unknown> = {}) => ({
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
    evmUsdc: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69',
    earnProtocol: 'dummy-lending'
  },
  features: { earn: true, fastBridge: true, bridgeIn: true, bridgeOut: true },
  mainnetCountdown: { enabled: true, launchAt: '2026-10-26T00:00:00Z' },
  ...overrides
});

type Section = 'evm' | 'agglayer' | 'epoch' | 'features' | 'mainnetCountdown';
const withSection = (name: Section, fields: Record<string, unknown>) => {
  const base = doc();
  return { ...base, [name]: { ...base[name], ...fields } };
};

const ALL_OFF = {
  earn: false,
  fastBridge: false,
  bridgeIn: false,
  bridgeOut: false,
  usdcxIn: false,
  usdcxOut: false
};
// The spec's document predates the USDCx switches: a missing switch is off.
const DOC_FEATURES = { ...ALL_OFF, earn: true, fastBridge: true, bridgeIn: true, bridgeOut: true };

it('parses the published testnet document, lowercasing addresses', () => {
  expect(parseBridgeConfig(doc(), 'testnet')).toStrictEqual({
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
    features: DOC_FEATURES,
    mainnetCountdown: { enabled: true, launchAt: Date.UTC(2026, 9, 26) },
    swap: { tokens: [] }
  });
});

describe('swap tokens', () => {
  const tokens = [
    { symbol: 'IMIDEN', faucetId: '0x750052a4af10cd51141f52c0ec2ada', decimals: 8, logo: 'MIDEN' },
    { symbol: 'IETH', faucetId: '0xE33498F1176661512B5AC4DED86EC7', decimals: 8, logo: 'ETH', priceSymbol: 'ETH' }
  ];
  const withTokens = (list: unknown) => doc({ swap: { tokens: list } });

  it('reads the list in order, lowercasing faucet ids and keeping the logo and price symbol', () => {
    expect(parseBridgeConfig(withTokens(tokens), 'testnet')?.swap).toStrictEqual({
      tokens: [
        { symbol: 'IMIDEN', faucetId: '0x750052a4af10cd51141f52c0ec2ada', decimals: 8, logo: 'MIDEN' },
        { symbol: 'IETH', faucetId: '0xe33498f1176661512b5ac4ded86ec7', decimals: 8, logo: 'ETH', priceSymbol: 'ETH' }
      ]
    });
  });

  it('reads a missing section, or a missing list, as no tokens', () => {
    expect(parseBridgeConfig(doc({ swap: {} }), 'testnet')?.swap).toStrictEqual({ tokens: [] });
    expect(parseBridgeConfig(withTokens([]), 'testnet')?.swap).toStrictEqual({ tokens: [] });
  });

  it('reads the quote service as a base URL, normalized like every other URL field', () => {
    const swap = { etaUrl: 'https://Quotes.Example:443/dex/', tokens };
    expect(parseBridgeConfig(doc({ swap }), 'testnet')?.swap?.etaUrl).toBe('https://quotes.example/dex');
    expect(parseBridgeConfig(doc({ swap: { etaUrl: 'http://quotes.example', tokens } }), 'testnet')).toBeNull();
    expect(parseBridgeConfig(doc({ swap: { etaUrl: 'https://quotes.example/?x=1', tokens } }), 'testnet')).toBeNull();
    expect(parseBridgeConfig(doc({ swap: { etaUrl: 42, tokens } }), 'testnet')).toBeNull();
  });

  it('drops a logo the wallet does not ship and a price symbol the feed does not quote, keeping the token', () => {
    const [imiden] = tokens;
    const parsed = parseBridgeConfig(withTokens([{ ...imiden, logo: 'SOL', priceSymbol: 'SOL' }]), 'testnet');
    expect(parsed?.swap?.tokens).toStrictEqual([
      { symbol: 'IMIDEN', faucetId: '0x750052a4af10cd51141f52c0ec2ada', decimals: 8 }
    ]);
  });

  it.each([
    ['a list that is not an array', { IETH: '0xe33498f1176661512b5ac4ded86ec7' }],
    ['an entry that is not an object', ['IETH']],
    ['a lower-case symbol', [{ ...tokens[1], symbol: 'iEth' }]],
    ['a seven-letter symbol', [{ ...tokens[1], symbol: 'IBITCON' }]],
    ['a bech32 faucet id', [{ ...tokens[1], faucetId: 'mtst1arcf9xpxfrc7wygpv744ytgr6cw2df6h' }]],
    ['a missing faucet id', [{ symbol: 'IETH', decimals: 8 }]],
    ['fractional decimals', [{ ...tokens[1], decimals: 8.5 }]],
    ['decimals above 12', [{ ...tokens[1], decimals: 13 }]],
    ['negative decimals', [{ ...tokens[1], decimals: -1 }]],
    ['a logo that is not a string', [{ ...tokens[1], logo: 1 }]],
    ['a price symbol that is not a string', [{ ...tokens[1], priceSymbol: null }]],
    ['two entries for one faucet', [tokens[1], { ...tokens[1], symbol: 'IBTC' }]],
    ['two entries for one symbol', [tokens[1], { ...tokens[1], faucetId: '0xaf8444c4a7c091114666adba25c5d0' }]]
  ])('refuses the document over %s', (_name, list) => {
    expect(parseBridgeConfig(withTokens(list), 'testnet')).toBeNull();
  });
});

it('lowercases Miden account ids written in upper case', () => {
  const parsed = parseBridgeConfig(
    withSection('agglayer', { midenBridge: '0x3B66E20B5088F25133B69216484652' }),
    'testnet'
  );
  expect(parsed?.agglayer.midenBridge).toBe('0x3b66e20b5088f25133b69216484652');
});

it.each([
  ['https://allocator.example/', 'https://allocator.example'],
  ['https://allocator.example//', 'https://allocator.example'],
  ['https://bridge.example/api/', 'https://bridge.example/api'],
  ['https://Allocator.Example:8443/v1', 'https://allocator.example:8443/v1']
])('normalizes the base URL %s to %s in every URL field', (input, expected) => {
  const epoch = parseBridgeConfig(withSection('epoch', { allocatorUrl: input, positionsUrl: input }), 'testnet');
  const agglayer = parseBridgeConfig(withSection('agglayer', { indexerUrl: input }), 'testnet');
  expect(epoch?.epoch.allocatorUrl).toBe(expected);
  expect(epoch?.epoch.positionsUrl).toBe(expected);
  expect(agglayer?.agglayer.indexerUrl).toBe(expected);
});

it('ignores fields it does not know, at every level', () => {
  const base = doc();
  const extended = {
    ...base,
    schema: 2,
    evm: { ...base.evm, rpcUrl: 'https://rpc.example' },
    agglayer: { ...base.agglayer, gerMap: 'never read' },
    epoch: { ...base.epoch, solver: 1 },
    features: { ...base.features, swap: true },
    mainnetCountdown: { ...base.mainnetCountdown, label: 'never read' }
  };
  expect(parseBridgeConfig(extended, 'testnet')).toStrictEqual(parseBridgeConfig(doc(), 'testnet'));
});

it('reads absent sections as empty and absent switches as off', () => {
  expect(parseBridgeConfig({ network: 'devnet', version: 3 }, 'devnet')).toStrictEqual({
    network: 'devnet',
    version: 3,
    evm: {},
    agglayer: {},
    epoch: {},
    features: ALL_OFF,
    mainnetCountdown: { enabled: false },
    swap: { tokens: [] }
  });
});

it('leaves an absent field out of its section', () => {
  const partial = {
    network: 'testnet',
    version: 2,
    agglayer: { l1Bridge: '0x1348947e282138d8f377b467f7d9c2eb0f335d1f' },
    epoch: { allocatorUrl: 'https://allocator.example' },
    features: { earn: true }
  };
  expect(parseBridgeConfig(partial, 'testnet')).toStrictEqual({
    network: 'testnet',
    version: 2,
    evm: {},
    agglayer: { l1Bridge: '0x1348947e282138d8f377b467f7d9c2eb0f335d1f' },
    epoch: { allocatorUrl: 'https://allocator.example' },
    features: { ...ALL_OFF, earn: true },
    mainnetCountdown: { enabled: false },
    swap: { tokens: [] }
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

it('drops an unsupported chain id and keeps the rest of the document', () => {
  const parsed = parseBridgeConfig(withSection('evm', { chainId: 1 }), 'testnet');
  expect(parsed?.evm).toStrictEqual({});
  expect(parsed?.epoch.evmUsdc).toBe('0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69');
});

it('drops an unsupported Earn protocol and keeps the rest of the document', () => {
  const parsed = parseBridgeConfig(withSection('epoch', { earnProtocol: 'aave-v3' }), 'testnet');
  expect(parsed?.epoch).not.toHaveProperty('earnProtocol');
  expect(parsed?.epoch.allocatorUrl).toBe('https://testnet-dev.epochprotocol.xyz');
});

it('supports Sepolia, Arc Testnet, Base Sepolia and Arbitrum Sepolia, and dummy lending only', () => {
  expect(SUPPORTED_EVM_CHAIN_IDS).toEqual([11155111, 5042002, 84532, 421614]);
  expect(SUPPORTED_EARN_PROTOCOLS).toEqual(['dummy-lending']);
});

it('takes the supported chains from the wallet chain registry', () => {
  let schema!: typeof import('./schema');
  jest.isolateModules(() => {
    jest.doMock('lib/walletconnect/config', () => ({ SUPPORTED_CHAINS: [{ id: 11155111 }, { id: 84532 }] }));
    schema = require('./schema');
  });
  const parsed = schema.parseBridgeConfig(withSection('evm', { chainId: 84532 }), 'testnet');
  expect(parsed?.evm.chainId).toBe(84532);
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
  ['an evm section that is not an object', doc({ evm: 11155111 })],
  ['a null agglayer section', doc({ agglayer: null })],
  ['an epoch section that is an array', doc({ epoch: [] })],
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
  ['a numeric Earn protocol', withSection('epoch', { earnProtocol: 1 })],
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
  expect(parsed?.features).toStrictEqual(DOC_FEATURES);
  expect(parsed?.evm).toStrictEqual({ chainId: 11155111 });
  expect(parsed?.epoch.allocatorUrl).toBe('https://testnet-dev.epochprotocol.xyz');
});

it('reads a fraction of any length as the same instant', () => {
  const at = (launchAt: string) =>
    parseBridgeConfig(withSection('mainnetCountdown', { launchAt }), 'testnet')?.mainnetCountdown;
  expect(at('2026-10-26T00:00:00.5Z')).toStrictEqual(at('2026-10-26T00:00:00.500Z'));
  expect(at('2026-10-26T00:00:00.5Z')?.launchAt).toBe(Date.UTC(2026, 9, 26, 0, 0, 0, 500));
});

describe('the E2E local http allowance', () => {
  it.each(['http://127.0.0.1:8548', 'http://localhost:8549/'])('accepts %s when allowed', input => {
    const parsed = parseBridgeConfig(withSection('epoch', { allocatorUrl: input }), 'testnet', {
      allowLocalHttp: true
    });
    expect(parsed?.epoch.allocatorUrl).toBe(input.replace(/\/$/, ''));
  });

  it.each(['http://allocator.example', 'http://10.0.2.2:8548'])('still rejects %s', input => {
    const body = withSection('epoch', { allocatorUrl: input });
    expect(parseBridgeConfig(body, 'testnet', { allowLocalHttp: true })).toBeNull();
  });
});

describe('the usdcx section', () => {
  const ARC = TEST_USDCX_SECTION.chains['arc-testnet'];
  const SEPOLIA = TEST_USDCX_SECTION.chains.sepolia;
  const usdcx = (overrides: Record<string, unknown> = {}) => doc({ usdcx: { ...TEST_USDCX_SECTION, ...overrides } });
  const withChains = (chains: Record<string, unknown>) => usdcx({ chains });
  const parsedUsdcx = (body: unknown) => parseBridgeConfig(body, 'testnet')?.usdcx;

  it('reads the chains in the order of the document, lowercasing addresses and naming each by its key', () => {
    expect(parsedUsdcx(usdcx())).toStrictEqual({
      midenDomain: 10007,
      attestationUrl: 'https://xreserve-api-testnet.circle.com',
      irisUrl: 'https://iris-api-sandbox.circle.com',
      chains: [
        {
          name: 'arc-testnet',
          chainId: 5042002,
          domain: 26,
          usdc: '0x3600000000000000000000000000000000000000',
          deposit: { route: 'xreserve', xReserve: '0x008888878f94c0d87defdf0b07f46b93c1934442' },
          executor: {
            address: '0xedc81040756accff070c21d37b265b9d0b5ba45e',
            handler: '0xd05e7d2e7d30b92c5f17d7d0fc575fce231f1a48'
          }
        },
        {
          name: 'sepolia',
          chainId: 11155111,
          domain: 0,
          usdc: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
          deposit: {
            route: 'executor',
            tokenMessenger: '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa',
            tokenMessengerWithFees: '0x8745d906d67c346e5eb1aeeed38eb87f34df0c0a'
          }
        },
        expect.objectContaining({ name: 'base-sepolia', chainId: 84532, domain: 6 }),
        expect.objectContaining({ name: 'arbitrum-sepolia', chainId: 421614, domain: 3 })
      ]
    });
  });

  it('leaves the section out of a document that has none, with both switches off', () => {
    const parsed = parseBridgeConfig(doc(), 'testnet');
    expect(parsed).not.toBeNull();
    expect(parsed && 'usdcx' in parsed).toBe(false);
    expect(parsed?.features).toMatchObject({ usdcxIn: false, usdcxOut: false });
  });

  it('reads the two switches', () => {
    const body = { ...usdcx(), features: { usdcxIn: true, usdcxOut: true } };
    expect(parseBridgeConfig(body, 'testnet')?.features).toStrictEqual({ ...ALL_OFF, usdcxIn: true, usdcxOut: true });
  });

  it('reads a document with no Iris API, and one with no chain', () => {
    expect(parsedUsdcx(usdcx({ irisUrl: undefined }))).not.toHaveProperty('irisUrl');
    expect(parsedUsdcx(withChains({}))?.chains).toStrictEqual([]);
  });

  it('keeps a chain with no deposit as a destination, and drops a route this build does not know', () => {
    const { deposit: _deposit, ...destinationOnly } = SEPOLIA;
    const chains = {
      sepolia: destinationOnly,
      'base-sepolia': { ...SEPOLIA, chainId: 84532, deposit: { route: 'x' } }
    };
    expect(parsedUsdcx(withChains(chains))?.chains).toStrictEqual([
      { name: 'sepolia', chainId: 11155111, domain: 0, usdc: SEPOLIA.usdc.toLowerCase() },
      { name: 'base-sepolia', chainId: 84532, domain: 0, usdc: SEPOLIA.usdc.toLowerCase() }
    ]);
  });

  // A newer document may list a chain this build ships no definition for: the rest of the list still counts.
  it('drops a chain this build does not support', () => {
    const chains = { ...TEST_USDCX_SECTION.chains, base: { ...SEPOLIA, chainId: 8453 } };
    expect(parsedUsdcx(withChains(chains))?.chains.map(chain => chain.name)).toStrictEqual([
      'arc-testnet',
      'sepolia',
      'base-sepolia',
      'arbitrum-sepolia'
    ]);
  });

  it('accepts domain 0 and the largest uint32', () => {
    expect(parsedUsdcx(usdcx({ midenDomain: 0 }))?.midenDomain).toBe(0);
    expect(parsedUsdcx(usdcx({ midenDomain: 0xffffffff }))?.midenDomain).toBe(0xffffffff);
  });

  it.each<[string, unknown]>([
    ['a section that is an array', doc({ usdcx: [] })],
    ['a null section', doc({ usdcx: null })],
    ['no Miden domain', usdcx({ midenDomain: undefined })],
    ['a Miden domain written as text', usdcx({ midenDomain: '10007' })],
    ['a negative Miden domain', usdcx({ midenDomain: -1 })],
    ['a Miden domain above uint32', usdcx({ midenDomain: 0x100000000 })],
    ['no attestation URL', usdcx({ attestationUrl: undefined })],
    ['an http attestation URL', usdcx({ attestationUrl: 'http://xreserve-api-testnet.circle.com' })],
    ['an Iris URL with a query', usdcx({ irisUrl: 'https://iris-api-sandbox.circle.com/?key=1' })],
    ['no chains', usdcx({ chains: undefined })],
    ['chains as a list', usdcx({ chains: [ARC] })],
    ['a chain name with an upper-case letter', withChains({ Arc: ARC })],
    ['a chain name with a space', withChains({ 'arc testnet': ARC })],
    ['a chain name that ends with a hyphen', withChains({ 'arc-': ARC })],
    ['an empty chain name', withChains({ '': ARC })],
    ['a chain that is not an object', withChains({ arc: 5042002 })],
    ['a chain id written as text', withChains({ arc: { ...ARC, chainId: '5042002' } })],
    ['no chain id', withChains({ arc: { ...ARC, chainId: undefined } })],
    ['no Circle domain', withChains({ arc: { ...ARC, domain: undefined } })],
    ['a fractional Circle domain', withChains({ arc: { ...ARC, domain: 26.5 } })],
    ['a 19-byte USDC', withChains({ arc: { ...ARC, usdc: '0x36000000000000000000000000000000000000' } })],
    ['no USDC', withChains({ arc: { ...ARC, usdc: undefined } })],
    ['a deposit that is not an object', withChains({ arc: { ...ARC, deposit: 'xreserve' } })],
    ['a deposit with no route', withChains({ arc: { ...ARC, deposit: { xReserve: ARC.deposit.xReserve } } })],
    ['a numeric route', withChains({ arc: { ...ARC, deposit: { route: 1 } } })],
    ['an xReserve route with no xReserve', withChains({ arc: { ...ARC, deposit: { route: 'xreserve' } } })],
    [
      'an executor route with no fee entry point',
      withChains({ sepolia: { ...SEPOLIA, deposit: { route: 'executor', tokenMessenger: ARC.usdc } } })
    ],
    ['an executor that is not an object', withChains({ arc: { ...ARC, executor: ARC.executor.address } })],
    ['an executor with no handler', withChains({ arc: { ...ARC, executor: { address: ARC.executor.address } } })],
    ['an executor on a chain with the executor route', withChains({ sepolia: { ...SEPOLIA, executor: ARC.executor } })],
    [
      'an executor on a chain with no deposit',
      withChains({ arc: { chainId: ARC.chainId, domain: ARC.domain, usdc: ARC.usdc, executor: ARC.executor } })
    ],
    ['two chains with one chain id', withChains({ arc: ARC, 'arc-again': ARC })],
    [
      'two chains that carry an executor',
      withChains({ arc: ARC, sepolia: { ...ARC, chainId: SEPOLIA.chainId, domain: SEPOLIA.domain } })
    ],
    // The duplicate is refused before a chain this build does not support is dropped.
    [
      'two unsupported chains with one chain id',
      withChains({ base: { ...SEPOLIA, chainId: 8453 }, b: { ...SEPOLIA, chainId: 8453 } })
    ],
    ['a USDCx switch written as text', { ...usdcx(), features: { usdcxIn: 'true' } }]
  ])('rejects %s', (_label, body) => {
    expect(parseBridgeConfig(body, 'testnet')).toBeNull();
  });

  it('tells a deposit source from a destination', () => {
    const config = parsedUsdcx(usdcx());
    const noIris = parsedUsdcx(usdcx({ irisUrl: undefined }));
    const { 'arc-testnet': _arc, ...executorChains } = TEST_USDCX_SECTION.chains;
    const noExecutor = parsedUsdcx(withChains(executorChains));
    const sources = (c: UsdcxConfig | undefined) =>
      c?.chains.filter(chain => isUsdcxDepositSource(c, chain)).map(chain => chain.name);
    expect(sources(config)).toStrictEqual(['arc-testnet', 'sepolia', 'base-sepolia', 'arbitrum-sepolia']);
    expect(sources(noIris)).toStrictEqual(['arc-testnet']);
    expect(sources(noExecutor)).toStrictEqual([]);
    expect(config && usdcxExecutorChain(config)?.name).toBe('arc-testnet');
    expect(noExecutor && usdcxExecutorChain(noExecutor)).toBeUndefined();
  });

  it('accepts a local http service only with the E2E allowance', () => {
    const body = usdcx({ attestationUrl: 'http://127.0.0.1:8551' });
    expect(parseBridgeConfig(body, 'testnet')).toBeNull();
    expect(parseBridgeConfig(body, 'testnet', { allowLocalHttp: true })?.usdcx?.attestationUrl).toBe(
      'http://127.0.0.1:8551'
    );
  });
});
