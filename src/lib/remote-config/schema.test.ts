import { parseBridgeConfig, SUPPORTED_EARN_PROTOCOLS, SUPPORTED_EVM_CHAIN_IDS } from './schema';

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

const ALL_OFF = { earn: false, fastBridge: false, bridgeIn: false, bridgeOut: false };

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
    features: { earn: true, fastBridge: true, bridgeIn: true, bridgeOut: true },
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
  expect(parsed?.features).toStrictEqual({ earn: true, fastBridge: true, bridgeIn: true, bridgeOut: true });
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
