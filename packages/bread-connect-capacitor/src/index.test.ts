import { PrivateDataPermission, WalletAdapterNetwork } from '@miden-sdk/miden-wallet-adapter-base';

import { BreadConnectWallet, capacitorLinks, installBreadConnect, openWithPlugin } from './index.js';

const mockOpenWallet = jest.fn();
const mockGetLaunchUrl = jest.fn();
const mockAddListener = jest.fn();

// The root manual mock of the adapter base has none of the classes the wallet extends and throws.
jest.mock('@miden-sdk/miden-wallet-adapter-base', () =>
  jest.requireActual('../../../node_modules/@miden-sdk/miden-wallet-adapter-base/dist/index.js')
);

jest.mock('@capacitor/core', () => ({
  registerPlugin: () => ({ openWallet: (options: unknown) => mockOpenWallet(options) })
}));

jest.mock('@capacitor/app', () => ({
  App: {
    getLaunchUrl: () => mockGetLaunchUrl(),
    addListener: (event: string, listener: unknown) => mockAddListener(event, listener)
  }
}));

const CALLBACK = 'https://game.example/bread';
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

afterEach(() => {
  Reflect.deleteProperty(window, 'midenWallet');
  window.localStorage.clear();
  jest.clearAllMocks();
});

describe('installBreadConnect', () => {
  it("makes Bread the app's window.midenWallet and listens for Bread's answers through Capacitor", async () => {
    const remove = jest.fn();
    mockAddListener.mockResolvedValue({ remove });
    mockGetLaunchUrl.mockResolvedValue({ url: 'https://game.example/elsewhere' });
    const wallet = installBreadConnect({ callback: CALLBACK, appName: 'Game' });
    expect(wallet).toBeInstanceOf(BreadConnectWallet);
    expect(Reflect.get(window, 'midenWallet')).toBe(wallet);
    await flush();
    expect(mockGetLaunchUrl).toHaveBeenCalledTimes(1);
    expect(mockAddListener).toHaveBeenCalledWith('appUrlOpen', expect.any(Function));
  });

  it('uses the storage, links and opener the app passes', async () => {
    const links = { launchUrl: jest.fn(async () => undefined), onUrl: jest.fn(() => () => undefined) };
    const openWallet = jest.fn(async () => false);
    const storage = { getItem: jest.fn(() => null), setItem: jest.fn(), removeItem: jest.fn() };
    const wallet = installBreadConnect({ callback: CALLBACK, appName: 'Game', storage, links, openWallet });
    await flush();
    expect(links.onUrl).toHaveBeenCalledTimes(1);
    expect(mockAddListener).not.toHaveBeenCalled();

    await expect(wallet.connect(PrivateDataPermission.UponRequest, WalletAdapterNetwork.Testnet)).rejects.toMatchObject(
      { code: 'NOT_INSTALLED' }
    );
    expect(openWallet).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/bread\.miden\.xyz\/request#v=1&m=/));
    expect(storage.setItem).toHaveBeenCalledWith('bread-connect:pending', expect.any(String));
  });

  it('refuses a callback that is not a canonical https link', () => {
    for (const callback of ['http://game.example/bread', 'https://game.example/bread?x=1', 'game://bread']) {
      expect(() => installBreadConnect({ callback, appName: 'Game' })).toThrow('canonical https link');
    }
    expect(Reflect.get(window, 'midenWallet')).toBeUndefined();
  });
});

describe('capacitorLinks', () => {
  it('reads the launch link and the links the app is opened with, until unsubscribed', async () => {
    const remove = jest.fn();
    mockAddListener.mockResolvedValue({ remove });
    mockGetLaunchUrl
      .mockResolvedValueOnce({ url: 'https://game.example/bread#v=1&m=x' })
      .mockResolvedValueOnce(undefined);
    const links = capacitorLinks();
    await expect(links.launchUrl()).resolves.toBe('https://game.example/bread#v=1&m=x');
    await expect(links.launchUrl()).resolves.toBeUndefined();

    const received: string[] = [];
    const unsubscribe = links.onUrl(url => received.push(url));
    const listener: unknown = mockAddListener.mock.calls[0]![1];
    if (typeof listener !== 'function') throw new Error('no appUrlOpen listener');
    listener({ url: 'https://game.example/bread#v=1&m=y' });
    expect(received).toEqual(['https://game.example/bread#v=1&m=y']);
    unsubscribe();
    await flush();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe('openWithPlugin', () => {
  it("opens Bread's link with the native plugin and reports whether Bread opened", async () => {
    mockOpenWallet.mockResolvedValueOnce({ opened: true }).mockResolvedValueOnce({ opened: false });
    await expect(openWithPlugin('https://bread.miden.xyz/request#v=1&m=x')).resolves.toBe(true);
    expect(mockOpenWallet).toHaveBeenCalledWith({ url: 'https://bread.miden.xyz/request#v=1&m=x' });
    await expect(openWithPlugin('https://bread.miden.xyz/request#v=1&m=x')).resolves.toBe(false);
  });
});
