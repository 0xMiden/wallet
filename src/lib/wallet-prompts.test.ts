import { act, renderHook, waitFor } from '@testing-library/react';

import { mintFromMidenFaucet } from 'lib/miden-chain/faucet-api';

import {
  EMPTY_WALLET_PROMPT_STORAGE,
  HOT_KEY_HARDWARE_ERROR_STORAGE_KEY,
  WalletPromptStatus,
  WalletPromptType,
  completeWalletPrompt,
  dismissWalletPrompt,
  faucet,
  fetchHotKeyHardwareError,
  fetchWalletPromptStorage,
  getPendingNotesUsdTotal,
  isWalletPromptPending,
  normalizeWalletPromptStorage,
  reportHotKeyHardwareFailure,
  seedWalletPrompt,
  setWalletPromptStatus,
  useWalletPromptStorage
} from './wallet-prompts';

jest.mock('lib/platform', () => ({
  isMobile: () => false,
  isDesktop: () => true,
  isExtension: () => false
}));

jest.mock('lib/miden-chain/faucet-api', () => ({
  mintFromMidenFaucet: jest.fn()
}));

const mintFromMidenFaucetMock = jest.mocked(mintFromMidenFaucet);

const fetchMock = jest.fn();
Object.defineProperty(globalThis, 'fetch', {
  value: fetchMock,
  writable: true,
  configurable: true
});

describe('wallet prompts', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  it('normalizes missing and malformed storage to an empty prompt set', () => {
    expect(normalizeWalletPromptStorage(null)).toEqual(EMPTY_WALLET_PROMPT_STORAGE);
    expect(normalizeWalletPromptStorage({ version: 1, prompts: { unknown: 'pending' } })).toEqual(
      EMPTY_WALLET_PROMPT_STORAGE
    );
    expect(normalizeWalletPromptStorage({ version: 1, prompts: { verifySeedPhrase: 'bad-status' } })).toEqual(
      EMPTY_WALLET_PROMPT_STORAGE
    );
  });

  it('normalizes pending-note prompt state and valid unique dismissed note ids', () => {
    expect(
      normalizeWalletPromptStorage({
        version: 1,
        prompts: { pendingNotes: 'dismissed' },
        pendingNotesDismissedIds: ['note-1', '', 7, 'note-1', 'note-2']
      })
    ).toEqual({
      version: 1,
      prompts: { [WalletPromptType.PendingNotes]: WalletPromptStatus.Dismissed },
      pendingNotesDismissedIds: ['note-1', 'note-2']
    });
  });

  it('calculates the aggregate pending-note USD value across token decimals and prices', () => {
    expect(
      getPendingNotesUsdTotal(
        [
          { id: 'note-1', amount: '1250000', metadata: { decimals: 6, symbol: 'MIDEN' } },
          { id: 'note-2', amount: '200000000', metadata: { decimals: 8, symbol: 'IMIDEN' } },
          { id: 'note-3', amount: '3000000', metadata: { decimals: 6, symbol: 'UNKNOWN' } }
        ],
        {
          MIDEN: { price: 2, change24h: 0, percentageChange24h: 0 },
          IMIDEN: { price: 0.5, change24h: 0, percentageChange24h: 0 }
        }
      )
    ).toBe(6.5);
    expect(getPendingNotesUsdTotal([], {})).toBe(0);
  });

  it('seeds a pending prompt when no prompt state exists', async () => {
    await seedWalletPrompt(WalletPromptType.VerifySeedPhrase);

    const storage = await fetchWalletPromptStorage();
    expect(storage.prompts[WalletPromptType.VerifySeedPhrase]).toBe(WalletPromptStatus.Pending);
    expect(isWalletPromptPending(storage, WalletPromptType.VerifySeedPhrase)).toBe(true);
  });

  it('stores dismissed and completed statuses', async () => {
    await seedWalletPrompt(WalletPromptType.VerifySeedPhrase);
    await dismissWalletPrompt(WalletPromptType.VerifySeedPhrase);

    let storage = await fetchWalletPromptStorage();
    expect(storage.prompts[WalletPromptType.VerifySeedPhrase]).toBe(WalletPromptStatus.Dismissed);
    expect(isWalletPromptPending(storage, WalletPromptType.VerifySeedPhrase)).toBe(false);

    await setWalletPromptStatus(WalletPromptType.VerifySeedPhrase, WalletPromptStatus.Completed);
    storage = await fetchWalletPromptStorage();
    expect(storage.prompts[WalletPromptType.VerifySeedPhrase]).toBe(WalletPromptStatus.Completed);
  });

  it('stores completed status through the exported helper', async () => {
    await completeWalletPrompt(WalletPromptType.VerifySeedPhrase);

    const storage = await fetchWalletPromptStorage();
    expect(storage.prompts[WalletPromptType.VerifySeedPhrase]).toBe(WalletPromptStatus.Completed);
  });

  it('does not let seeding resurrect a terminal prompt', async () => {
    await dismissWalletPrompt(WalletPromptType.VerifySeedPhrase);
    await seedWalletPrompt(WalletPromptType.VerifySeedPhrase);
    expect((await fetchWalletPromptStorage()).prompts[WalletPromptType.VerifySeedPhrase]).toBe(
      WalletPromptStatus.Dismissed
    );

    await setWalletPromptStatus(WalletPromptType.VerifySeedPhrase, WalletPromptStatus.Completed);
    await seedWalletPrompt(WalletPromptType.VerifySeedPhrase);
    expect((await fetchWalletPromptStorage()).prompts[WalletPromptType.VerifySeedPhrase]).toBe(
      WalletPromptStatus.Completed
    );
  });

  it('stores the faucet alongside the other prompts', async () => {
    await seedWalletPrompt(WalletPromptType.Faucet);
    await seedWalletPrompt(WalletPromptType.VerifySeedPhrase);

    const storage = await fetchWalletPromptStorage();
    expect(storage.prompts).toEqual({
      [WalletPromptType.Faucet]: WalletPromptStatus.Pending,
      [WalletPromptType.VerifySeedPhrase]: WalletPromptStatus.Pending
    });
  });

  it('requests tokens from both the forkchoice and official Miden faucets', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    mintFromMidenFaucetMock.mockResolvedValue({ txId: '0xtx', noteId: '0xnote' });

    await faucet('mtst1testaddress');

    expect(fetchMock).toHaveBeenCalledWith('https://faucet-api.forkchoice.xyz/api/mint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: 'IMIDEN',
        address: 'mtst1testaddress',
        amount: 1_000_000_000,
        note_type: 'public'
      })
    });
    expect(mintFromMidenFaucetMock).toHaveBeenCalledWith('mtst1testaddress', 100_000_000n);
  });

  it('rejects unsuccessful forkchoice faucet responses', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429 });
    mintFromMidenFaucetMock.mockResolvedValue({ txId: '0xtx', noteId: '0xnote' });

    await expect(faucet('mtst1testaddress')).rejects.toThrow('Faucet request failed with status 429');
  });

  it('rejects when the official Miden faucet fails even if forkchoice succeeds', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    mintFromMidenFaucetMock.mockRejectedValue(new Error('Faucet PoW request failed with status 429'));

    await expect(faucet('mtst1testaddress')).rejects.toThrow('Faucet PoW request failed with status 429');
  });

  it('loads prompt storage in the hook and exposes pending checks', async () => {
    await seedWalletPrompt(WalletPromptType.VerifySeedPhrase);

    const { result } = renderHook(() => useWalletPromptStorage());

    await waitFor(() => {
      expect(result.current.isPromptPending(WalletPromptType.VerifySeedPhrase)).toBe(true);
    });
  });

  it('updates hook state and persists prompt status changes', async () => {
    const { result } = renderHook(() => useWalletPromptStorage());

    act(() => {
      result.current.dismissPrompt(WalletPromptType.VerifySeedPhrase);
    });

    expect(result.current.storage.prompts[WalletPromptType.VerifySeedPhrase]).toBe(WalletPromptStatus.Dismissed);

    await waitFor(async () => {
      expect((await fetchWalletPromptStorage()).prompts[WalletPromptType.VerifySeedPhrase]).toBe(
        WalletPromptStatus.Dismissed
      );
    });

    act(() => {
      result.current.completePrompt(WalletPromptType.VerifySeedPhrase);
    });

    expect(result.current.storage.prompts[WalletPromptType.VerifySeedPhrase]).toBe(WalletPromptStatus.Completed);

    await waitFor(async () => {
      expect((await fetchWalletPromptStorage()).prompts[WalletPromptType.VerifySeedPhrase]).toBe(
        WalletPromptStatus.Completed
      );
    });
  });

  it('atomically stores a pending-note dismissal and its note ids', async () => {
    const { result } = renderHook(() => useWalletPromptStorage());

    act(() => {
      result.current.setPromptStatus(WalletPromptType.PendingNotes, WalletPromptStatus.Dismissed, [
        'note-1',
        'note-1',
        'note-2'
      ]);
    });

    expect(result.current.storage).toEqual({
      version: 1,
      prompts: { [WalletPromptType.PendingNotes]: WalletPromptStatus.Dismissed },
      pendingNotesDismissedIds: ['note-1', 'note-2']
    });

    await waitFor(async () => {
      expect(await fetchWalletPromptStorage()).toEqual(result.current.storage);
    });
  });

  it('refreshes hook state on demand', async () => {
    const { result } = renderHook(() => useWalletPromptStorage());

    await setWalletPromptStatus(WalletPromptType.VerifySeedPhrase, WalletPromptStatus.Pending);

    let refreshedStorage = EMPTY_WALLET_PROMPT_STORAGE;
    await act(async () => {
      refreshedStorage = await result.current.refreshPrompts();
    });

    expect(refreshedStorage.prompts[WalletPromptType.VerifySeedPhrase]).toBe(WalletPromptStatus.Pending);
    expect(result.current.storage.prompts[WalletPromptType.VerifySeedPhrase]).toBe(WalletPromptStatus.Pending);
  });

  it('warns and refreshes when hook persistence fails', async () => {
    await seedWalletPrompt(WalletPromptType.VerifySeedPhrase);

    const { result } = renderHook(() => useWalletPromptStorage());

    await waitFor(() => {
      expect(result.current.storage.prompts[WalletPromptType.VerifySeedPhrase]).toBe(WalletPromptStatus.Pending);
    });

    const setItemSpy = jest.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new Error('storage full');
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    act(() => {
      result.current.dismissPrompt(WalletPromptType.VerifySeedPhrase);
    });

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith('[wallet-prompts] failed to persist prompt status:', expect.any(Error));
    });

    await waitFor(() => {
      expect(result.current.storage.prompts[WalletPromptType.VerifySeedPhrase]).toBe(WalletPromptStatus.Pending);
    });

    setItemSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe('hot-key hardware failure report', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns null while no failure has been recorded or the record is malformed', async () => {
    expect(await fetchHotKeyHardwareError()).toBeNull();
    localStorage.setItem(HOT_KEY_HARDWARE_ERROR_STORAGE_KEY, JSON.stringify({ message: 42 }));
    expect(await fetchHotKeyHardwareError()).toBeNull();
  });

  it('stores the native error and seeds the report prompt', async () => {
    await reportHotKeyHardwareFailure('SecureEnclave unavailable');

    expect(await fetchHotKeyHardwareError()).toEqual({ message: 'SecureEnclave unavailable' });
    const storage = await fetchWalletPromptStorage();
    expect(storage.prompts[WalletPromptType.HotKeyHardwareUnavailable]).toBe(WalletPromptStatus.Pending);
  });

  it('does not re-seed the prompt after the user dismissed it', async () => {
    await dismissWalletPrompt(WalletPromptType.HotKeyHardwareUnavailable);
    await reportHotKeyHardwareFailure('still broken');

    const storage = await fetchWalletPromptStorage();
    expect(storage.prompts[WalletPromptType.HotKeyHardwareUnavailable]).toBe(WalletPromptStatus.Dismissed);
    expect(await fetchHotKeyHardwareError()).toEqual({ message: 'still broken' });
  });
});
