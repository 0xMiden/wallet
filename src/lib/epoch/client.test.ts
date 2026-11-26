import { buildEpochWalletClient, getEvmSourceConnection } from './client';

const RELAY = '0x00000000000000000000000000000000000000aa';
const EXTERNAL = '0x00000000000000000000000000000000000000bb';
const SOURCE = { accountPublicKey: 'miden-account', address: RELAY };

const mockGetConnection = jest.fn();
const mockGetWalletClient = jest.fn();
jest.mock('@wagmi/core', () => ({
  getConnection: (...args: unknown[]) => mockGetConnection(...args),
  getWalletClient: (...args: unknown[]) => mockGetWalletClient(...args),
  switchChain: jest.fn()
}));
jest.mock('lib/walletconnect/appkit', () => ({ wagmiConfig: {} }));
const mockIsNative = jest.fn(() => false);
const mockBuildNative = jest.fn();
jest.mock('lib/walletconnect/native', () => ({
  isNativeReownAvailable: () => mockIsNative(),
  buildNativeReownProvider: (...args: unknown[]) => mockBuildNative(...args),
  NativeReown: { getState: jest.fn() }
}));
const mockFindRelaySource = jest.fn();
const mockRelayServesChain = jest.fn();
const mockBuildRelayProvider = jest.fn();
jest.mock('lib/evm-relay/source', () => ({
  findRelaySource: (...args: unknown[]) => mockFindRelaySource(...args),
  relayServesChain: (...args: unknown[]) => mockRelayServesChain(...args),
  buildRelayProvider: (...args: unknown[]) => mockBuildRelayProvider(...args)
}));
const mockInitBridgeConfig = jest.fn(async () => undefined);
jest.mock('lib/remote-config/runtime', () => ({ initBridgeConfig: () => mockInitBridgeConfig() }));

/** An EIP-1193 provider that answers `eth_chainId` and records each method. */
function stubProvider(name: string, methods: string[]) {
  return {
    request: async ({ method }: { method: string }) => {
      methods.push(`${name}:${method}`);
      return '0xaa36a7';
    }
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsNative.mockReturnValue(false);
  mockFindRelaySource.mockReturnValue(null);
  mockRelayServesChain.mockReturnValue(true);
  mockGetConnection.mockReturnValue({ address: EXTERNAL, chainId: 1 });
});

describe('getEvmSourceConnection', () => {
  it('is a relay connection on the asked chain for a relay source that the relay serves', async () => {
    mockFindRelaySource.mockReturnValue(SOURCE);

    await expect(getEvmSourceConnection(RELAY.toUpperCase().replace('0X', '0x'), 8453)).resolves.toEqual({
      address: RELAY,
      chainId: 8453,
      isNative: false,
      isRelay: true
    });
    expect(mockInitBridgeConfig).toHaveBeenCalled();
    expect(mockRelayServesChain).toHaveBeenCalledWith(8453);
    expect(mockGetConnection).not.toHaveBeenCalled();
  });

  it('is the connected wallet for a relay source on a chain that the relay does not serve', async () => {
    mockFindRelaySource.mockReturnValue(SOURCE);
    mockRelayServesChain.mockReturnValue(false);

    await expect(getEvmSourceConnection(RELAY, 8453)).resolves.toEqual({
      address: EXTERNAL,
      chainId: 1,
      isNative: false
    });
  });

  it('is the connected wallet for another address, and with no address', async () => {
    await expect(getEvmSourceConnection(EXTERNAL, 1)).resolves.toMatchObject({ address: EXTERNAL, isNative: false });
    await expect(getEvmSourceConnection(undefined, 1)).resolves.toMatchObject({ address: EXTERNAL });
    expect(mockFindRelaySource).toHaveBeenCalledTimes(1);
  });
});

describe('buildEpochWalletClient', () => {
  it('sends through the relay provider on the requested chain for a relay source', async () => {
    const methods: string[] = [];
    mockFindRelaySource.mockReturnValue(SOURCE);
    mockBuildRelayProvider.mockReturnValue(stubProvider('relay', methods));
    mockIsNative.mockReturnValue(true);

    const client = await buildEpochWalletClient(RELAY, { chainOverride: 11155111 });
    await client.request({ method: 'eth_chainId' });

    expect(mockBuildRelayProvider).toHaveBeenCalledWith(SOURCE, 11155111);
    expect(client.chain?.id).toBe(11155111);
    expect(client.account?.address).toBe(RELAY);
    expect(methods).toEqual(['relay:eth_chainId']);
    expect(mockBuildNative).not.toHaveBeenCalled();
    expect(mockGetWalletClient).not.toHaveBeenCalled();
  });

  it('passes on a relay that does not serve the chain, with no fallback to an external wallet', async () => {
    mockFindRelaySource.mockReturnValue(SOURCE);
    mockBuildRelayProvider.mockImplementation(() => {
      throw new Error('relay: chain 8453 is not served');
    });

    await expect(buildEpochWalletClient(RELAY, { chainOverride: 8453 })).rejects.toThrow('not served');
    expect(mockGetWalletClient).not.toHaveBeenCalled();
  });

  it('sends through the native Reown shim on mobile', async () => {
    const methods: string[] = [];
    mockIsNative.mockReturnValue(true);
    mockBuildNative.mockReturnValue(stubProvider('native', methods));

    const client = await buildEpochWalletClient(EXTERNAL);
    await client.request({ method: 'eth_chainId' });

    expect(mockBuildNative).toHaveBeenCalledWith(expect.objectContaining({ chainId: 11155111, address: EXTERNAL }));
    expect(methods).toEqual(['native:eth_chainId']);
  });

  it('sends through the wagmi wallet client elsewhere', async () => {
    const methods: string[] = [];
    mockGetWalletClient.mockResolvedValue(stubProvider('wagmi', methods));

    const client = await buildEpochWalletClient(EXTERNAL);
    await client.request({ method: 'eth_chainId' });

    expect(methods).toEqual(['wagmi:eth_chainId']);
    expect(mockBuildRelayProvider).not.toHaveBeenCalled();
  });
});
