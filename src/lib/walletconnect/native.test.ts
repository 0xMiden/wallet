import {
  assertNativeSessionChain,
  buildNativeReownProvider,
  ensureNativeSessionChain,
  NativeReown,
  NativeSessionChainNotApprovedError,
  prepareNativeSessionChain,
  ReownState
} from './native';

// The plugin object is built inside the factory: `registerPlugin` runs when `./native` loads,
// before any constant in this file is initialized.
jest.mock('@capacitor/core', () => ({
  registerPlugin: () => ({
    getState: jest.fn(),
    request: jest.fn(),
    sendTransaction: jest.fn()
  })
}));

jest.mock('lib/platform', () => ({
  isIOS: () => true,
  isAndroid: () => false
}));

const SEPOLIA = 11155111;
const ARC = 5042002;

jest.mock('./config', () => ({
  getChain: (id: number) =>
    id === 5042002
      ? {
          id: 5042002,
          name: 'Arc Testnet',
          rpcUrl: 'https://rpc.walletconnect.org/v1?chainId=eip155:5042002&projectId=secret',
          publicRpcUrl: 'https://rpc.testnet.arc.network',
          explorer: 'https://testnet.arcscan.app',
          nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }
        }
      : undefined
}));

// The add-and-switch attempt logs a rejection it swallows.
beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

const sessionState = (chainIds?: number[]): ReownState => ({
  configured: true,
  connected: true,
  topic: 'topic-1',
  address: '0x00000000000000000000000000000000000000e1',
  accounts: ['0x00000000000000000000000000000000000000e1'],
  chainId: SEPOLIA,
  chainIds
});

describe('assertNativeSessionChain', () => {
  it('throws a NativeSessionChainNotApprovedError when the session did not approve the chain', () => {
    const thrown = (() => {
      try {
        assertNativeSessionChain(sessionState([SEPOLIA]), ARC, 'Arc Testnet');
        return undefined;
      } catch (err) {
        return err;
      }
    })();

    expect(thrown).toBeInstanceOf(NativeSessionChainNotApprovedError);
    expect(thrown).toMatchObject({ chainId: ARC, networkName: 'Arc Testnet' });
  });

  it('passes when the session approved the chain', () => {
    expect(() => assertNativeSessionChain(sessionState([SEPOLIA, ARC]), ARC, 'Arc Testnet')).not.toThrow();
  });

  it('passes when an older native build reports no chainIds', () => {
    expect(() => assertNativeSessionChain(sessionState(undefined), ARC, 'Arc Testnet')).not.toThrow();
  });
});

describe('ensureNativeSessionChain', () => {
  beforeEach(() => {
    jest.mocked(NativeReown.request).mockReset();
    jest.mocked(NativeReown.getState).mockReset();
  });

  it('adds and switches to a missing chain on an approved chain, then reads the state again', async () => {
    jest.mocked(NativeReown.request).mockResolvedValue({ result: null });
    const reread = sessionState([SEPOLIA, ARC]);
    jest.mocked(NativeReown.getState).mockResolvedValue(reread);

    const next = await ensureNativeSessionChain(sessionState([SEPOLIA]), ARC);

    expect(NativeReown.request).toHaveBeenCalledTimes(2);
    expect(NativeReown.request).toHaveBeenNthCalledWith(1, {
      topic: 'topic-1',
      chainId: SEPOLIA,
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: '0x4cef52',
          chainName: 'Arc Testnet',
          rpcUrls: ['https://rpc.testnet.arc.network'],
          nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
          blockExplorerUrls: ['https://testnet.arcscan.app']
        }
      ]
    });
    expect(NativeReown.request).toHaveBeenNthCalledWith(2, {
      topic: 'topic-1',
      chainId: SEPOLIA,
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x4cef52' }]
    });
    expect(NativeReown.getState).toHaveBeenCalledTimes(1);
    expect(next).toBe(reread);
  });

  it('sends nothing when the session already approved the chain', async () => {
    const state = sessionState([SEPOLIA, ARC]);

    await expect(ensureNativeSessionChain(state, ARC)).resolves.toBe(state);

    expect(NativeReown.request).not.toHaveBeenCalled();
    expect(NativeReown.getState).not.toHaveBeenCalled();
  });

  it('sends nothing when an older native build reports no chainIds', async () => {
    const state = sessionState(undefined);

    await expect(ensureNativeSessionChain(state, ARC)).resolves.toBe(state);

    expect(NativeReown.request).not.toHaveBeenCalled();
  });

  it('swallows a rejected add, sends no switch, and leaves the guard to refuse the chain', async () => {
    jest.mocked(NativeReown.request).mockRejectedValue(new Error('Invalid permissions for call.'));
    jest.mocked(NativeReown.getState).mockResolvedValue(sessionState([SEPOLIA]));

    await expect(prepareNativeSessionChain(ARC)).rejects.toThrow(NativeSessionChainNotApprovedError);

    expect(NativeReown.request).toHaveBeenCalledTimes(1);
    expect(NativeReown.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'wallet_addEthereumChain' }));
  });
});

describe('buildNativeReownProvider', () => {
  beforeEach(() => {
    jest.mocked(NativeReown.request).mockReset();
    jest.mocked(NativeReown.getState).mockReset();
    jest.mocked(NativeReown.sendTransaction).mockReset();
  });

  it('refuses eth_sendTransaction on a chain the session did not approve, before any wallet prompt', async () => {
    jest.mocked(NativeReown.request).mockRejectedValue(new Error('User rejected'));
    jest.mocked(NativeReown.getState).mockResolvedValue(sessionState([SEPOLIA]));
    const provider = buildNativeReownProvider({
      chainId: ARC,
      address: '0x00000000000000000000000000000000000000e1',
      rpcUrl: 'https://rpc.test'
    });

    await expect(
      provider.request({
        method: 'eth_sendTransaction',
        params: [{ to: '0x00000000000000000000000000000000000000b2' }]
      })
    ).rejects.toThrow(NativeSessionChainNotApprovedError);

    expect(NativeReown.sendTransaction).not.toHaveBeenCalled();
  });

  it('sends eth_sendTransaction on a chain the session approved', async () => {
    jest.mocked(NativeReown.getState).mockResolvedValue(sessionState([SEPOLIA]));
    jest.mocked(NativeReown.sendTransaction).mockResolvedValue({ hash: '0xhash' });
    const provider = buildNativeReownProvider({
      chainId: SEPOLIA,
      address: '0x00000000000000000000000000000000000000e1',
      rpcUrl: 'https://rpc.test'
    });

    await expect(
      provider.request({
        method: 'eth_sendTransaction',
        params: [{ to: '0x00000000000000000000000000000000000000b2' }]
      })
    ).resolves.toBe('0xhash');

    expect(NativeReown.request).not.toHaveBeenCalled();
    expect(NativeReown.sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ chainId: SEPOLIA }));
  });
});
