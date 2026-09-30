import { act, renderHook, waitFor } from '@testing-library/react';

import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';

import { resetHiddenTokens, useHiddenTokens } from './useHiddenTokens';

jest.mock('lib/miden/front/storage', () => ({ fetchFromStorage: jest.fn(), putToStorage: jest.fn() }));
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
  read.mockReset();
  read.mockResolvedValue(['mtst1old']);
  write.mockReset();
  write.mockResolvedValue(undefined);
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
  expect([...result.current.ids]).toEqual([SPAM]);
});

it('stores a newly hidden token under its canonical id', async () => {
  read.mockResolvedValue(null);
  const { result } = await renderLoaded();

  await act(async () => {
    await result.current.hide(SPAM_HEX);
  });

  expect(write).toHaveBeenLastCalledWith(KEY, [SPAM]);
});

it('treats the hex and bech32 ids of one faucet as one token', async () => {
  read.mockResolvedValue([SPAM_HEX]);
  const { result } = await renderLoaded();
  expect(result.current.isHidden(SPAM)).toBe(true);
  expect(result.current.isHidden(SPAM_HEX)).toBe(true);
  expect([...result.current.ids]).toEqual([SPAM]);

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
  read.mockResolvedValue([NATIVE_HEX, SPAM]);
  const { result } = await renderLoaded();

  expect(result.current.isHidden(NATIVE)).toBe(false);
  expect([...result.current.ids]).toEqual([SPAM]);
});

it('keeps stored tokens hidden but refuses new hides while the native token is not known', async () => {
  mockNativeId = null;
  read.mockResolvedValue([SPAM]);
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
  expect([...result.current.ids]).toEqual(['mtst1old']);
  expect(result.current.failed).toBe(true);
  // A rolled-back save leaves the set writable: the page's toggle has to stay usable for a retry.
  expect(result.current.loaded).toBe(true);

  await act(async () => {
    stored = await result.current.hide(SPAM);
  });
  expect(stored).toBe(true);
  expect(result.current.failed).toBe(false);
  log.mockRestore();
});

it('reports an unreadable set, never writes it, and reads it again on the next mount', async () => {
  const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
  let reads = 0;
  read.mockImplementation(() =>
    ++reads === 1 ? Promise.reject(new Error('Read unavailable')) : Promise.resolve([SPAM])
  );
  const first = renderHook(() => useHiddenTokens('account'));
  await waitFor(() => expect(first.result.current.failed).toBe(true));
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
  expect(result.current.failed).toBe(false);
  log.mockRestore();
});

it('ignores saves before the set is read and runs saves made during a write after it, in order', async () => {
  let releaseRead: (ids: string[]) => void = () => {};
  read.mockImplementationOnce(
    () =>
      new Promise<string[]>(resolve => {
        releaseRead = resolve;
      })
  );
  let releaseWrite: () => void = () => {};
  write.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        releaseWrite = resolve;
      })
  );
  const { result } = renderHook(() => useHiddenTokens('account'));

  let stored: boolean | undefined;
  await act(async () => {
    stored = await result.current.hide('mtst1early');
  });
  expect(stored).toBe(false);
  expect(write).not.toHaveBeenCalled();
  await act(async () => releaseRead(['mtst1old']));
  await waitFor(() => expect(result.current.loaded).toBe(true));

  let saves: Promise<unknown> = Promise.resolve();
  act(() => {
    saves = Promise.all([
      result.current.hide('mtst1first'),
      result.current.hide('mtst1second'),
      result.current.unhide('mtst1old')
    ]);
  });
  await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  expect(write).toHaveBeenLastCalledWith(KEY, ['mtst1old', 'mtst1first']);
  await act(async () => {
    releaseWrite();
    await saves;
  });
  expect(write.mock.calls.map(call => call[1])).toEqual([
    ['mtst1old', 'mtst1first'],
    ['mtst1old', 'mtst1first', 'mtst1second'],
    ['mtst1first', 'mtst1second']
  ]);
  expect([...result.current.ids]).toEqual(['mtst1first', 'mtst1second']);
});

it('reads and writes each network and each account under its own key', async () => {
  read.mockImplementation((key: string) => Promise.resolve(key === KEY ? [SPAM] : []));
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
  expect(other.result.current.ids.size).toBe(0);
});

it('shows one consumer a token another consumer just hid', async () => {
  // The token page hides; the Home that TabLayout keeps mounted has to drop the row at once.
  const page = renderHook(() => useHiddenTokens('account'));
  const home = renderHook(() => useHiddenTokens('account'));
  await waitFor(() => expect(home.result.current.loaded).toBe(true));
  expect(read).toHaveBeenCalledTimes(1);

  await act(async () => {
    await page.result.current.hide(SPAM);
  });

  expect(home.result.current.isHidden(SPAM)).toBe(true);
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

it('accepts only string ids from a stored array and treats any other payload as empty', async () => {
  read.mockResolvedValueOnce(JSON.parse('["mtst1kept", 7, null]'));
  const { result, rerender } = renderHook(({ address }) => useHiddenTokens(address), {
    initialProps: { address: 'mixed' }
  });
  await waitFor(() => expect(result.current.loaded).toBe(true));
  expect([...result.current.ids]).toEqual(['mtst1kept']);

  read.mockResolvedValueOnce(JSON.parse('{"not":"an array"}'));
  rerender({ address: 'object' });
  expect(result.current.loaded).toBe(false);
  await waitFor(() => expect(result.current.loaded).toBe(true));
  expect(read).toHaveBeenCalledWith('hidden-tokens:v1:testnet:object');
  expect(result.current.ids.size).toBe(0);
});

it('keeps the current key when a read for an earlier key settles late', async () => {
  const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const pending = new Map<string, { resolve: (ids: string[]) => void; reject: (error: Error) => void }>();
  read.mockImplementation(
    (key: string) =>
      new Promise<string[]>((resolve, reject) => {
        pending.set(key, { resolve, reject });
      })
  );
  const { result, rerender } = renderHook(({ address }) => useHiddenTokens(address), {
    initialProps: { address: 'first' }
  });
  rerender({ address: 'second' });
  rerender({ address: 'third' });

  await act(async () => pending.get('hidden-tokens:v1:testnet:third')?.resolve(['mtst1third']));
  await act(async () => {
    pending.get('hidden-tokens:v1:testnet:first')?.resolve(['mtst1first']);
    pending.get('hidden-tokens:v1:testnet:second')?.reject(new Error('Late read failure'));
  });

  expect([...result.current.ids]).toEqual(['mtst1third']);
  expect(result.current.failed).toBe(false);
  log.mockRestore();
});
