import { act, renderHook, waitFor } from '@testing-library/react';

import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';

import { resetHiddenTokens, useHiddenTokens } from './useHiddenTokens';

jest.mock('lib/miden/front/storage', () => ({
  fetchFromStorage: jest.fn(),
  putToStorage: jest.fn(),
  inStorageTurn: jest.requireActual('lib/miden/front/storage').inStorageTurn,
  onStorageChanged: jest.fn(() => () => {}),
  registerStorageReread: jest.fn()
}));
const read = jest.mocked(fetchFromStorage);
const write = jest.mocked(putToStorage);

let mockNetwork = 'testnet';
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => mockNetwork }));

// One faucet in two encodings: the SDK turns the hex id into the bech32 one.
const SPAM = 'mtst1spam';
const SPAM_HEX = '0x5ba3';
const NATIVE = 'mtst1native';
const NATIVE_HEX = '0x0a71';
const mockCanonical: Record<string, string> = { [SPAM_HEX]: SPAM, [NATIVE_HEX]: NATIVE };
jest.mock('lib/miden/swap/tokens', () => ({ normalizedFaucetId: (id: string) => mockCanonical[id] ?? id }));

let mockNativeId: string | null = NATIVE;
jest.mock('app/hooks/useMidenFaucetId', () => ({ __esModule: true, default: () => mockNativeId }));

const KEY = 'hidden-tokens:v1:testnet:account';

// What storage holds: a save reads the set inside its turn, so a write has to land where the next read finds it.
const storedIds = new Map<string, unknown>();

const renderLoaded = async (address = 'account') => {
  const hook = renderHook(() => useHiddenTokens(address));
  await waitFor(() => expect(hook.result.current.loaded).toBe(true));
  return hook;
};

beforeEach(() => {
  jest.clearAllMocks();
  // The set is a module-level store, so it outlives a test the way it outlives a mount.
  resetHiddenTokens();
  mockNetwork = 'testnet';
  mockNativeId = NATIVE;
  storedIds.clear();
  storedIds.set(KEY, ['mtst1old']);
  read.mockReset();
  read.mockImplementation(async (key: string) => storedIds.get(key) ?? null);
  write.mockReset();
  write.mockImplementation(async (key: string, value: unknown) => {
    storedIds.set(key, value);
  });
});

it('reads the set under the network and account key, then hides and unhides a token', async () => {
  const { result } = await renderLoaded();
  expect(read).toHaveBeenCalledWith(KEY);
  expect(result.current.isHidden('mtst1old')).toBe(true);

  let stored: boolean | undefined;
  await act(async () => {
    stored = await result.current.hide(SPAM);
  });
  expect(stored).toBe(true);
  expect(write).toHaveBeenLastCalledWith(KEY, ['mtst1old', SPAM]);
  expect(result.current.isHidden(SPAM)).toBe(true);

  await act(async () => {
    stored = await result.current.unhide('mtst1old');
  });
  expect(stored).toBe(true);
  expect(write).toHaveBeenLastCalledWith(KEY, [SPAM]);
  expect(result.current.isHidden(SPAM)).toBe(true);
  expect(result.current.isHidden('mtst1old')).toBe(false);
});

it('stores a newly hidden token under its canonical id', async () => {
  storedIds.delete(KEY);
  const { result } = await renderLoaded();

  await act(async () => {
    await result.current.hide(SPAM_HEX);
  });

  expect(write).toHaveBeenLastCalledWith(KEY, [SPAM]);
});

it('treats the hex and bech32 ids of one faucet as one token', async () => {
  storedIds.set(KEY, [SPAM_HEX]);
  const { result } = await renderLoaded();
  expect(result.current.isHidden(SPAM)).toBe(true);
  expect(result.current.isHidden(SPAM_HEX)).toBe(true);

  // Hiding it again under its other encoding adds no second entry.
  await act(async () => {
    await result.current.hide(SPAM);
  });
  expect(write).toHaveBeenLastCalledWith(KEY, [SPAM_HEX]);

  await act(async () => {
    await result.current.unhide(SPAM);
  });
  expect(write).toHaveBeenLastCalledWith(KEY, []);
  expect(result.current.isHidden(SPAM_HEX)).toBe(false);
});

it('refuses to hide the native token under either of its ids', async () => {
  mockNativeId = NATIVE_HEX;
  const { result } = await renderLoaded();

  let stored: boolean | undefined;
  await act(async () => {
    stored = await result.current.hide(NATIVE);
  });
  expect(stored).toBe(false);
  await act(async () => {
    stored = await result.current.hide(NATIVE_HEX);
  });
  expect(stored).toBe(false);
  expect(write).not.toHaveBeenCalled();
  expect(result.current.isHidden(NATIVE)).toBe(false);
});

it('never reports the native token hidden, even when the stored set holds its id', async () => {
  storedIds.set(KEY, [NATIVE_HEX, SPAM]);
  const { result } = await renderLoaded();

  expect(result.current.isHidden(NATIVE)).toBe(false);
  expect(result.current.isHidden(SPAM)).toBe(true);
});

it('answers canHide for any token but the native one, in either encoding, and for none before it is known', async () => {
  mockNativeId = NATIVE_HEX;
  const { result, rerender } = await renderLoaded();
  expect(result.current.canHide(NATIVE)).toBe(false);
  expect(result.current.canHide(NATIVE_HEX)).toBe(false);
  expect(result.current.canHide(SPAM)).toBe(true);

  mockNativeId = null;
  rerender();
  expect(result.current.canHide(SPAM)).toBe(false);
});

it('keeps stored tokens hidden but refuses new hides while the native token is not known', async () => {
  mockNativeId = null;
  storedIds.set(KEY, [SPAM]);
  const { result } = await renderLoaded();
  expect(result.current.isHidden(SPAM)).toBe(true);

  let stored: boolean | undefined;
  await act(async () => {
    stored = await result.current.hide('mtst1other');
  });
  expect(stored).toBe(false);
  expect(write).not.toHaveBeenCalled();
});

it('rolls a failed save back and reports it, and the set stays writable for a retry', async () => {
  const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
  write.mockRejectedValueOnce(new Error('Storage unavailable'));
  const { result } = await renderLoaded();

  let stored: boolean | undefined;
  await act(async () => {
    stored = await result.current.hide(SPAM);
  });
  expect(stored).toBe(false);
  expect(result.current.isHidden(SPAM)).toBe(false);
  expect(result.current.isHidden('mtst1old')).toBe(true);
  // A rolled-back save leaves the set writable: the page's toggle has to stay usable for a retry.
  expect(result.current.loaded).toBe(true);
  expect(result.current.unreadable).toBe(false);

  await act(async () => {
    stored = await result.current.hide(SPAM);
  });
  expect(stored).toBe(true);
  expect(result.current.isHidden(SPAM)).toBe(true);
  log.mockRestore();
});

it('reports an unreadable set, never writes it, and reads it again on the next mount', async () => {
  const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
  let reads = 0;
  read.mockImplementation(() =>
    ++reads === 1 ? Promise.reject(new Error('Read unavailable')) : Promise.resolve([SPAM])
  );
  const first = renderHook(() => useHiddenTokens('account'));
  await waitFor(() => expect(first.result.current.unreadable).toBe(true));
  expect(first.result.current.loaded).toBe(false);
  expect(first.result.current.isHidden(SPAM)).toBe(false);
  await act(async () => {
    await first.result.current.hide(SPAM);
    await first.result.current.unhide(SPAM);
  });
  expect(write).not.toHaveBeenCalled();
  first.unmount();

  const { result } = renderHook(() => useHiddenTokens('account'));
  await waitFor(() => expect(result.current.loaded).toBe(true));
  expect(result.current.isHidden(SPAM)).toBe(true);
  expect(result.current.unreadable).toBe(false);
  log.mockRestore();
});

it('reads and writes each network and each account under its own key', async () => {
  storedIds.set(KEY, [SPAM]);
  const testnet = await renderLoaded('account');
  expect(testnet.result.current.isHidden(SPAM)).toBe(true);
  testnet.unmount();

  mockNetwork = 'devnet';
  const devnet = await renderLoaded('account');
  expect(read).toHaveBeenCalledWith('hidden-tokens:v1:devnet:account');
  expect(devnet.result.current.isHidden(SPAM)).toBe(false);
  await act(async () => {
    await devnet.result.current.hide('mtst1devnet');
  });
  expect(write).toHaveBeenLastCalledWith('hidden-tokens:v1:devnet:account', ['mtst1devnet']);
  devnet.unmount();

  const other = await renderLoaded('other');
  expect(read).toHaveBeenCalledWith('hidden-tokens:v1:devnet:other');
  expect(other.result.current.isHidden(SPAM)).toBe(false);
});

it("reads the new network's set on a rerender, the real path for a network switch with no reload", async () => {
  const { result, rerender } = await renderLoaded('account');
  expect(result.current.isHidden('mtst1old')).toBe(true);

  storedIds.set('hidden-tokens:v1:devnet:account', [SPAM]);
  mockNetwork = 'devnet';
  rerender();

  await waitFor(() => expect(read).toHaveBeenCalledWith('hidden-tokens:v1:devnet:account'));
  await waitFor(() => expect(result.current.isHidden(SPAM)).toBe(true));
  expect(result.current.isHidden('mtst1old')).toBe(false);
});

it('returns only what its callers use', async () => {
  const { result } = await renderLoaded();

  expect(Object.keys(result.current).sort()).toEqual(['canHide', 'hide', 'isHidden', 'loaded', 'unhide', 'unreadable']);
});

it('keeps isHidden the same function until the set changes', async () => {
  const { result, rerender } = await renderLoaded();
  const first = result.current.isHidden;

  rerender();
  expect(result.current.isHidden).toBe(first);

  await act(async () => {
    await result.current.hide(SPAM);
  });
  expect(result.current.isHidden).not.toBe(first);
});
