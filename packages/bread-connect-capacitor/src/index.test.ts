import { PrivateDataPermission, WalletAdapterNetwork } from '@miden-sdk/miden-wallet-adapter-base';
import { readFileSync } from 'fs';
import { join } from 'path';

import { BreadConnectWallet, capacitorLinks, installBreadConnect, openWithPlugin } from './index.js';

const mockOpenWallet = jest.fn();
const mockPrepareOpen = jest.fn();
const mockOpenStep = jest.fn();
const mockRevokeOpen = jest.fn();
const mockGetLaunchUrl = jest.fn();
const mockAddListener = jest.fn();

// The root manual mock of the adapter base has none of the classes the wallet extends and throws.
jest.mock('@miden-sdk/miden-wallet-adapter-base', () =>
  jest.requireActual('../../../node_modules/@miden-sdk/miden-wallet-adapter-base/dist/index.js')
);

jest.mock('@capacitor/core', () => ({
  registerPlugin: () => ({
    openWallet: (options: unknown) => mockOpenWallet(options),
    prepareOpen: (options: unknown) => mockPrepareOpen(options),
    openStep: (options: unknown) => mockOpenStep(options),
    revokeOpen: (options: unknown) => mockRevokeOpen(options)
  })
}));

jest.mock('@capacitor/app', () => ({
  App: {
    getLaunchUrl: () => mockGetLaunchUrl(),
    addListener: (event: string, listener: unknown) => mockAddListener(event, listener)
  }
}));

const CALLBACK = 'https://game.example/bread';
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  mockPrepareOpen.mockReset().mockResolvedValue({ attemptId: 'attempt-1' });
  mockOpenStep.mockReset();
  mockRevokeOpen.mockReset().mockResolvedValue(undefined);
});

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
    expect(openWallet.mock.calls[0]).toHaveLength(1);
    expect(mockPrepareOpen).not.toHaveBeenCalled();
    expect(storage.setItem).toHaveBeenCalledWith('bread-connect:pending', expect.any(String));
  });

  it.each([undefined, openWithPlugin])('uses managed steps for the built-in opener %p', async openWallet => {
    mockOpenStep
      .mockResolvedValueOnce({ opened: false, next: 'primaryStore' })
      .mockResolvedValueOnce({ opened: false });
    const links = { launchUrl: async () => undefined, onUrl: () => () => undefined };
    const wallet = installBreadConnect({ callback: CALLBACK, appName: 'Game', links, openWallet });
    await expect(wallet.connect(PrivateDataPermission.UponRequest, WalletAdapterNetwork.Testnet)).rejects.toMatchObject(
      {
        code: 'NOT_INSTALLED'
      }
    );
    expect(mockPrepareOpen).toHaveBeenCalledWith({
      url: expect.stringMatching(/^https:\/\/bread\.miden\.xyz\/request#/)
    });
    expect(mockOpenStep.mock.calls).toEqual([
      [{ attemptId: 'attempt-1', step: 'wallet' }],
      [{ attemptId: 'attempt-1', step: 'primaryStore' }]
    ]);
    expect(mockRevokeOpen).toHaveBeenCalledTimes(1);
    expect(mockOpenWallet).not.toHaveBeenCalled();
  });

  it('keeps a successfully opened wallet waiting for its answer without opening a store', async () => {
    mockOpenStep.mockResolvedValueOnce({ opened: true });
    const links = { launchUrl: async () => undefined, onUrl: () => () => undefined };
    const wallet = installBreadConnect({ callback: CALLBACK, appName: 'Game', links });
    const answer = wallet.connect(PrivateDataPermission.UponRequest, WalletAdapterNetwork.Testnet);
    const outcome = answer.catch(error => error);
    await flush();
    expect(mockOpenStep.mock.calls).toEqual([[{ attemptId: 'attempt-1', step: 'wallet' }]]);
    expect(mockRevokeOpen).toHaveBeenCalledWith({ attemptId: 'attempt-1' });
    await wallet.disconnect();
    expect(await outcome).toMatchObject({ code: 'CANCELLED' });
  });

  it('uses distinct Android market and HTTPS steps and keeps a store result separate from Bread', async () => {
    mockOpenStep
      .mockResolvedValueOnce({ opened: false, next: 'primaryStore' })
      .mockResolvedValueOnce({ opened: false, next: 'secondaryStore' })
      .mockResolvedValueOnce({ opened: false });
    const links = { launchUrl: async () => undefined, onUrl: () => () => undefined };
    const wallet = installBreadConnect({ callback: CALLBACK, appName: 'Game', links });
    await expect(wallet.connect(PrivateDataPermission.UponRequest, WalletAdapterNetwork.Testnet)).rejects.toMatchObject(
      {
        code: 'NOT_INSTALLED'
      }
    );
    expect(mockOpenStep.mock.calls.map(call => call[0].step)).toEqual(['wallet', 'primaryStore', 'secondaryStore']);
    expect(mockRevokeOpen).toHaveBeenCalledTimes(1);
  });

  it('preserves an active bridge failure even when native cleanup also rejects', async () => {
    mockOpenStep.mockRejectedValueOnce(new Error('native unavailable'));
    mockRevokeOpen.mockRejectedValueOnce(new Error('cleanup unavailable'));
    const links = { launchUrl: async () => undefined, onUrl: () => () => undefined };
    const wallet = installBreadConnect({ callback: CALLBACK, appName: 'Game', links });
    await expect(wallet.connect(PrivateDataPermission.UponRequest, WalletAdapterNetwork.Testnet)).rejects.toMatchObject(
      {
        code: 'INTERNAL_ERROR',
        message: expect.stringContaining('native unavailable')
      }
    );
    expect(mockRevokeOpen).toHaveBeenCalledTimes(1);
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

describe('the native package an app installs', () => {
  // Capacitor's CLI adds the plugin to an iOS app under its own name for the npm package: the app's CapApp-SPM
  // manifest asks for a Swift package and library of that name, and its Podfile for a pod of that name.
  const { fixName } = jest.requireActual<{ fixName(name: string): string }>('@capacitor/cli/dist/plugin');
  const read = (file: string) => readFileSync(join(__dirname, '..', file), 'utf8');
  const manifest: { name: string; files: string[] } = JSON.parse(read('package.json'));
  const name = fixName(manifest.name);

  it('names its Swift package and its library as the Capacitor CLI does', () => {
    const swift = read('Package.swift');
    expect(swift.match(/Package\(\s*name: "([^"]+)"/)?.[1]).toBe(name);
    expect([...swift.matchAll(/\.library\(\s*name: "([^"]+)"/g)].map(match => match[1])).toEqual([name]);
  });

  it('ships its podspec under the name the Capacitor CLI gives the pod', () => {
    expect(manifest.files).toContain(`${name}.podspec`);
    expect(read(`${name}.podspec`)).toContain(`s.name = '${name}'`);
  });
});
