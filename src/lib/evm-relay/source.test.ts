import { sepolia } from 'viem/chains';

import { getChain } from 'lib/walletconnect/config';

import { RelayUnavailableError } from './errors';
import { buildRelayProvider, buildRelayWalletClient, findRelaySource, relayServesChain, relaySourceOf } from './source';
import { CHAIN, RELAY_ADDRESS, upperHex } from './testing';

const SEPOLIA_RELAY = { ...CHAIN, key: 'sepolia', chainId: sepolia.id };
const mockGetRelayConfig = jest.fn();
const mockGetRelayChain = jest.fn();
jest.mock('lib/remote-config/values', () => ({
  getRelayConfig: () => mockGetRelayConfig(),
  getRelayChain: (chainId: number) => mockGetRelayChain(chainId)
}));
const mockGetRelayBaseUrl = jest.fn();
jest.mock('./base-url', () => ({ getRelayBaseUrl: () => mockGetRelayBaseUrl() }));
const mockSignRelay = jest.fn();
let mockAccounts: { publicKey: string; relayEvmAddress?: string }[] = [];
jest.mock('lib/store', () => ({
  useWalletStore: { getState: () => ({ accounts: mockAccounts, signRelay: mockSignRelay }) }
}));
const mockCreateProvider = jest.fn();
const mockCreateWalletClient = jest.fn();
jest.mock('./provider', () => ({
  createRelayProvider: (...args: unknown[]) => mockCreateProvider(...args),
  createRelayWalletClient: (...args: unknown[]) => mockCreateWalletClient(...args)
}));

const SOURCE = { accountPublicKey: 'miden-a', address: RELAY_ADDRESS };

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRelayConfig.mockReturnValue({ baseUrl: 'https://relay.example', chains: [SEPOLIA_RELAY] });
  mockGetRelayChain.mockImplementation((chainId: number) => (chainId === sepolia.id ? SEPOLIA_RELAY : null));
  mockGetRelayBaseUrl.mockReturnValue('https://relay.example');
  mockCreateProvider.mockReturnValue({ chainId: sepolia.id, address: RELAY_ADDRESS });
  mockAccounts = [{ publicKey: 'miden-b' }, { publicKey: 'miden-a', relayEvmAddress: upperHex(RELAY_ADDRESS) }];
});

describe('relaySourceOf', () => {
  it('gives the account and its relay address in lower case', () => {
    expect(relaySourceOf({ publicKey: 'miden-a', relayEvmAddress: upperHex(RELAY_ADDRESS) })).toEqual(SOURCE);
  });

  it.each([
    ['no account', null],
    ['an undefined account', undefined],
    ['an account with no relay address', { publicKey: 'miden-a' }],
    ['a relay address that is not an address', { publicKey: 'miden-a', relayEvmAddress: '0x12' }]
  ])('is null for %s', (_name, account) => {
    expect(relaySourceOf(account)).toBeNull();
  });

  it('is null while the relay is off or has no base URL', () => {
    const account = { publicKey: 'miden-a', relayEvmAddress: RELAY_ADDRESS };
    mockGetRelayConfig.mockReturnValueOnce(null);
    expect(relaySourceOf(account)).toBeNull();
    mockGetRelayBaseUrl.mockReturnValueOnce(null);
    expect(relaySourceOf(account)).toBeNull();
  });
});

describe('findRelaySource', () => {
  it('finds the account of a relay address, letter case ignored', () => {
    expect(findRelaySource(RELAY_ADDRESS)).toEqual(SOURCE);
    expect(findRelaySource(upperHex(RELAY_ADDRESS))).toEqual(SOURCE);
  });

  it('is null for another address, a value that is not an address, and while the relay is off', () => {
    expect(findRelaySource('0x00000000000000000000000000000000000000bb')).toBeNull();
    expect(findRelaySource('relay')).toBeNull();
    mockGetRelayConfig.mockReturnValueOnce(null);
    expect(findRelaySource(RELAY_ADDRESS)).toBeNull();
  });
});

describe('relayServesChain', () => {
  it('needs the relay entry, the base URL and a wallet chain definition', () => {
    expect(relayServesChain(sepolia.id)).toBe(true);
    expect(relayServesChain(8453)).toBe(false);
    mockGetRelayBaseUrl.mockReturnValueOnce(null);
    expect(relayServesChain(sepolia.id)).toBe(false);
    mockGetRelayChain.mockReturnValueOnce({ ...SEPOLIA_RELAY, chainId: 424242 });
    expect(relayServesChain(424242)).toBe(false);
  });
});

describe('buildRelayProvider', () => {
  it('builds a provider on the relay entry and the wallet RPC, with the hooks', async () => {
    const hooks = { beforeSign: jest.fn(), onJob: jest.fn() };
    const provider = buildRelayProvider(SOURCE, sepolia.id, hooks);

    expect(provider).toEqual({ chainId: sepolia.id, address: RELAY_ADDRESS });
    expect(mockCreateProvider).toHaveBeenCalledWith({
      chain: SEPOLIA_RELAY,
      address: RELAY_ADDRESS,
      rpcUrl: getChain(sepolia.id)?.rpcUrl,
      sign: expect.any(Function),
      beforeSign: hooks.beforeSign,
      onJob: hooks.onJob,
      fee: undefined
    });
  });

  it('signs through the store action of the source account', async () => {
    mockSignRelay.mockResolvedValue({ op: 'batch' });
    buildRelayProvider(SOURCE, sepolia.id);
    const [options] = mockCreateProvider.mock.calls[0];
    const request = { op: 'authorization', chainId: sepolia.id, nonce: 0 };

    await expect(options.sign(request)).resolves.toEqual({ op: 'batch' });
    expect(mockSignRelay).toHaveBeenCalledWith('miden-a', request);
  });

  it('throws RelayUnavailableError for a chain that the relay does not serve', () => {
    expect(() => buildRelayProvider(SOURCE, 8453)).toThrow(RelayUnavailableError);
    expect(mockCreateProvider).not.toHaveBeenCalled();
  });
});

describe('buildRelayWalletClient', () => {
  it('gives a wallet client over the provider on the wallet chain definition', () => {
    mockCreateWalletClient.mockReturnValue('client');

    expect(buildRelayWalletClient(SOURCE, sepolia.id)).toBe('client');

    const [provider, chain] = mockCreateWalletClient.mock.calls[0];
    expect(provider).toEqual({ chainId: sepolia.id, address: RELAY_ADDRESS });
    expect(chain).toMatchObject({ id: sepolia.id, rpcUrls: { default: { http: [getChain(sepolia.id)?.rpcUrl] } } });
  });

  it('throws RelayUnavailableError for a chain that the relay does not serve', () => {
    expect(() => buildRelayWalletClient(SOURCE, 8453)).toThrow(RelayUnavailableError);
  });
});
