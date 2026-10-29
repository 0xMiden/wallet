import { initBridgeConfig } from 'lib/remote-config/runtime';
import { getBackupBaseUrl } from 'lib/remote-config/values';

import { checkWalletApiEnabled, getWalletApiBaseUrl, isWalletApiEnabled } from './api-client';

jest.mock('lib/remote-config/runtime', () => ({ initBridgeConfig: jest.fn() }));
jest.mock('lib/remote-config/values', () => ({ getBackupBaseUrl: jest.fn() }));

const DOCUMENT_URL = 'https://wallet-api.example.workers.dev';
const savedDefine = process.env.MIDEN_WALLET_API_URL;

beforeEach(() => {
  delete process.env.MIDEN_WALLET_API_URL;
  jest.mocked(getBackupBaseUrl).mockReset().mockReturnValue(null);
  jest.mocked(initBridgeConfig).mockReset();
});

afterAll(() => {
  if (savedDefine === undefined) delete process.env.MIDEN_WALLET_API_URL;
  else process.env.MIDEN_WALLET_API_URL = savedDefine;
});

describe('getWalletApiBaseUrl', () => {
  it.each([
    ['http://localhost:8787', 'http://localhost:8787'],
    ['http://127.0.0.1:8787/', 'http://127.0.0.1:8787'],
    ['  http://localhost:8787//  ', 'http://localhost:8787']
  ])('lets a loopback define %j go before the document', (define, expected) => {
    process.env.MIDEN_WALLET_API_URL = define;
    jest.mocked(getBackupBaseUrl).mockReturnValue(DOCUMENT_URL);
    expect(getWalletApiBaseUrl()).toBe(expected);
    expect(getBackupBaseUrl).not.toHaveBeenCalled();
  });

  it.each([
    ['an https define', 'https://wallet-api.other.workers.dev'],
    ['an http define on another host', 'http://wallet-api.example.com'],
    ['an empty define', ''],
    ['a define that is not a URL', 'localhost:8787']
  ])("ignores %s and takes the document's URL", (_name, define) => {
    process.env.MIDEN_WALLET_API_URL = define;
    jest.mocked(getBackupBaseUrl).mockReturnValue(DOCUMENT_URL);
    expect(getWalletApiBaseUrl()).toBe(DOCUMENT_URL);
  });

  it("takes the document's URL with no define", () => {
    jest.mocked(getBackupBaseUrl).mockReturnValue(DOCUMENT_URL);
    expect(getWalletApiBaseUrl()).toBe(DOCUMENT_URL);
  });

  it('gives null with neither a loopback define nor a document URL', () => {
    process.env.MIDEN_WALLET_API_URL = 'https://wallet-api.other.workers.dev';
    expect(getWalletApiBaseUrl()).toBeNull();
  });
});

describe('isWalletApiEnabled', () => {
  it('is true exactly when a base URL exists', () => {
    expect(isWalletApiEnabled()).toBe(false);
    jest.mocked(getBackupBaseUrl).mockReturnValue(DOCUMENT_URL);
    expect(isWalletApiEnabled()).toBe(true);
    jest.mocked(getBackupBaseUrl).mockReturnValue(null);
    process.env.MIDEN_WALLET_API_URL = 'http://localhost:8787';
    expect(isWalletApiEnabled()).toBe(true);
  });
});

describe('checkWalletApiEnabled', () => {
  it('hydrates the bridge config before it reads the base URL', async () => {
    jest.mocked(initBridgeConfig).mockImplementation(async () => {
      jest.mocked(getBackupBaseUrl).mockReturnValue(DOCUMENT_URL);
      return { network: 'testnet', status: 'ready', config: null, derived: null, lastFetch: null };
    });
    await expect(checkWalletApiEnabled()).resolves.toBe(true);
    expect(initBridgeConfig).toHaveBeenCalledTimes(1);
  });

  it('reads the snapshot as it is when the hydration fails, and never throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.mocked(initBridgeConfig).mockRejectedValue(new Error('storage down'));
    await expect(checkWalletApiEnabled()).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
