import { act, renderHook, waitFor } from '@testing-library/react';

import {
  GUARDIAN_NOTE_RECOVERY_PROGRESS_STALE_MS,
  GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY,
  reportGuardianNoteRecoveryProgress
} from 'lib/guardian-note-recovery-progress';
import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { putToStorage } from 'lib/miden/front/storage';
import { mintFromMidenFaucet } from 'lib/miden-chain/faucet-api';
import { getStorageProvider } from 'lib/platform/storage-adapter';

import {
  EMPTY_WALLET_PROMPT_STORAGE,
  WalletPromptStatus,
  WalletPromptType,
  __resetInFlightFaucetRequestsForTest,
  completeWalletPrompt,
  dismissWalletPrompt,
  faucet,
  fetchActiveBridgePrompts,
  fetchFaucetFundingMarker,
  fetchHotKeyHardwareError,
  fetchWalletPromptStorage,
  getInFlightFaucetRequest,
  getPendingNotesUsdTotal,
  isWalletPromptPending,
  normalizeWalletPromptStorage,
  reconcileBridgedSends,
  reportHotKeyHardwareFailure,
  reportHotKeyRotationNeeded,
  seedWalletPrompt,
  setFaucetFundingMarker,
  setWalletPromptStatus,
  useGuardianNoteRecoveryProgress,
  useWalletPromptStorage,
  WALLET_PROMPT_TURN_WAIT_MS
} from './wallet-prompts';

jest.mock('lib/platform', () => ({
  isMobile: () => false,
  isDesktop: () => true,
  isExtension: () => false
}));

jest.mock('lib/miden-chain/faucet-api', () => ({
  mintFromMidenFaucet: jest.fn()
}));

const bridgeRows: ITransaction[] = [];
const findClaimableDeposit = jest.fn();
const updateClaimStatus = jest.fn();
const pollEpochIntentFill = jest.fn();

jest.mock('lib/miden/repo', () => ({
  transactions: {
    filter: (predicate: (row: ITransaction) => boolean) => ({
      toArray: async () => bridgeRows.filter(predicate)
    })
  }
}));
jest.mock('lib/agglayer', () => ({
  findClaimableMidenToEvmDeposit: (...args: unknown[]) => findClaimableDeposit(...args)
}));
jest.mock('lib/miden/transaction/complete', () => ({
  updateBridgeClaimStatus: (...args: unknown[]) => updateClaimStatus(...args)
}));
jest.mock('lib/epoch', () => ({
  pollEpochIntentFill: (...args: unknown[]) => pollEpochIntentFill(...args)
}));

const mintFromMidenFaucetMock = jest.mocked(mintFromMidenFaucet);

describe('wallet prompts', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
    __resetInFlightFaucetRequestsForTest();
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

  it('coerces a non-object prompts field on an object value to an empty prompt set', () => {
    // The value itself is an object (so it isn't short-circuited at the top),
    // but its `prompts` field is missing / not a record — drop it rather than
    // iterating a non-object.
    expect(normalizeWalletPromptStorage({ prompts: null })).toEqual(EMPTY_WALLET_PROMPT_STORAGE);
    expect(normalizeWalletPromptStorage({ prompts: 'not-an-object' })).toEqual(EMPTY_WALLET_PROMPT_STORAGE);
    expect(normalizeWalletPromptStorage({ prompts: 5 })).toEqual(EMPTY_WALLET_PROMPT_STORAGE);
    expect(normalizeWalletPromptStorage({})).toEqual(EMPTY_WALLET_PROMPT_STORAGE);
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
      pendingNotesDismissedIds: ['note-1', 'note-2'],
      faucetByAccount: {}
    });
  });

  it('drops a wallet-wide faucet status: that status lives per account', () => {
    // Written by a build that kept one faucet status for the whole wallet (#921).
    const storage = normalizeWalletPromptStorage({
      version: 1,
      prompts: { [WalletPromptType.Faucet]: 'completed', [WalletPromptType.Bridge]: 'pending' },
      pendingNotesDismissedIds: [],
      faucetByAccount: { accountA: 'dismissed' }
    });

    expect(storage.prompts).toEqual({ [WalletPromptType.Bridge]: WalletPromptStatus.Pending });
    expect(storage.faucetByAccount).toEqual({ accountA: WalletPromptStatus.Dismissed });
  });

  it('keeps valid per-account faucet statuses and drops malformed ones', () => {
    expect(
      normalizeWalletPromptStorage({
        version: 1,
        prompts: {},
        pendingNotesDismissedIds: [],
        faucetByAccount: { accountA: 'completed', accountB: 'bogus', '': 'dismissed', accountC: 7 }
      }).faucetByAccount
    ).toEqual({ accountA: WalletPromptStatus.Completed });

    // An older build's storage has no map at all.
    expect(normalizeWalletPromptStorage({ version: 1, prompts: {} }).faucetByAccount).toEqual({});
  });

  it('calculates the aggregate pending-note USD value across token decimals and prices', () => {
    expect(
      getPendingNotesUsdTotal(
        [
          { id: 'note-1', amount: '1250000', faucetId: '0xmiden', metadata: { decimals: 6, symbol: 'MIDEN' } },
          { id: 'note-2', amount: '200000000', faucetId: '0ximiden', metadata: { decimals: 8, symbol: 'IMIDEN' } },
          { id: 'note-3', amount: '3000000', faucetId: '0xother', metadata: { decimals: 6, symbol: 'UNKNOWN' } }
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

  it('stores several prompts side by side', async () => {
    await seedWalletPrompt(WalletPromptType.Bridge);
    await seedWalletPrompt(WalletPromptType.VerifySeedPhrase);

    const storage = await fetchWalletPromptStorage();
    expect(storage.prompts).toEqual({
      [WalletPromptType.Bridge]: WalletPromptStatus.Pending,
      [WalletPromptType.VerifySeedPhrase]: WalletPromptStatus.Pending
    });
  });

  it('requests native tokens from the official Miden faucet', async () => {
    mintFromMidenFaucetMock.mockResolvedValue({ txId: '0xtx', noteId: '0xnote' });

    await faucet('mtst1testaddress');

    expect(mintFromMidenFaucetMock).toHaveBeenCalledWith('mtst1testaddress', 100_000_000n, expect.any(AbortSignal));
  });

  it('joins concurrent requests for one address into a single mint, per address', async () => {
    const resolvers: Array<() => void> = [];
    mintFromMidenFaucetMock.mockImplementation(
      () =>
        new Promise(resolve => {
          resolvers.push(() => resolve({ txId: '0xtx', noteId: '0xnote' }));
        })
    );

    const first = faucet('mtst1testaddress');
    const second = faucet('mtst1testaddress');
    // Joined: one real request, and the join is observable for the UI.
    expect(second).toBe(first);
    expect(mintFromMidenFaucetMock).toHaveBeenCalledTimes(1);
    expect(getInFlightFaucetRequest('mtst1testaddress')).toBe(first);

    // A DIFFERENT address is not blocked by the first one being in flight.
    const other = faucet('mtst1otheraddress');
    expect(other).not.toBe(first);
    expect(mintFromMidenFaucetMock).toHaveBeenCalledTimes(2);

    resolvers.forEach(resolveMint => resolveMint());
    await Promise.all([first, second, other]);
    // Settling clears the join, so a genuine later re-fund mints again.
    expect(getInFlightFaucetRequest('mtst1testaddress')).toBeNull();
    mintFromMidenFaucetMock.mockResolvedValue({ txId: '0xtx', noteId: '0xnote' });
    await faucet('mtst1testaddress');
    expect(mintFromMidenFaucetMock).toHaveBeenCalledTimes(3);
  });

  it('clears the in-flight join when the request rejects', async () => {
    mintFromMidenFaucetMock.mockRejectedValue(new Error('down'));

    await expect(faucet('mtst1testaddress')).rejects.toThrow('down');

    expect(getInFlightFaucetRequest('mtst1testaddress')).toBeNull();
  });

  it('rejects when the official Miden faucet fails', async () => {
    mintFromMidenFaucetMock.mockRejectedValue(new Error('Faucet PoW request failed with status 429'));

    await expect(faucet('mtst1testaddress')).rejects.toThrow('Faucet PoW request failed with status 429');
  });

  it('rejects a faucet request that hangs past the timeout', async () => {
    jest.useFakeTimers();
    try {
      mintFromMidenFaucetMock.mockReturnValue(new Promise(() => {}));

      const request = faucet('mtst1testaddress');
      // Swallow the interim rejection while the timers advance; the real
      // assertion follows.
      request.catch(() => undefined);
      const signal = mintFromMidenFaucetMock.mock.calls[0]?.[2];
      if (!signal) throw new Error('expected faucet() to pass an AbortSignal');
      expect(signal.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(60_000);
      await expect(request).rejects.toThrow('Faucet request timed out');
      // The timeout must also cancel the in-flight work, not just reject the
      // wrapper — otherwise a late response could still mint behind a retry.
      expect(signal.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses a funding marker stamped in the future', async () => {
    // A forward clock step leaves a stamp the freshness test reads as always
    // fresh, which would wedge the Funding wait past its own 3-minute timeout.
    await setFaucetFundingMarker('accountClock', {
      requestedAt: Date.now() + 60_000,
      baselineNoteIds: []
    });

    expect(await fetchFaucetFundingMarker('accountClock')).toBeNull();
  });

  it('stores the funding marker per account', async () => {
    await setFaucetFundingMarker('accountA', { requestedAt: 1_000, baselineNoteIds: ['note-1'] });

    expect(await fetchFaucetFundingMarker('accountA')).toEqual({ requestedAt: 1_000, baselineNoteIds: ['note-1'] });
    expect(await fetchFaucetFundingMarker('accountB')).toBeNull();

    await setFaucetFundingMarker('accountA', null);
    expect(await fetchFaucetFundingMarker('accountA')).toBeNull();
  });

  it('ignores malformed funding markers', async () => {
    await putToStorage('faucet_funding_v2:accountA', { requestedAt: 'soon', baselineNoteIds: [] });
    expect(await fetchFaucetFundingMarker('accountA')).toBeNull();

    await putToStorage('faucet_funding_v2:accountA', 12345);
    expect(await fetchFaucetFundingMarker('accountA')).toBeNull();

    await putToStorage('faucet_funding_v2:accountA', { requestedAt: 5, baselineNoteIds: 'nope' });
    expect(await fetchFaucetFundingMarker('accountA')).toBeNull();
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
      pendingNotesDismissedIds: ['note-1', 'note-2'],
      faucetByAccount: {}
    });

    await waitFor(async () => {
      expect(await fetchWalletPromptStorage()).toEqual(result.current.storage);
    });
  });

  it('stores the faucet prompt status per account, without touching other accounts or prompts', async () => {
    const { result } = renderHook(() => useWalletPromptStorage());
    await waitFor(() => expect(result.current.isLoaded).toBe(true));

    act(() => {
      result.current.setPromptStatus(WalletPromptType.VerifySeedPhrase, WalletPromptStatus.Pending);
      result.current.setFaucetStatus('accountA', WalletPromptStatus.Completed);
      result.current.setFaucetStatus('accountB', WalletPromptStatus.Pending);
    });

    // One account's completion is not every account's (#921).
    expect(result.current.storage.faucetByAccount).toEqual({
      accountA: WalletPromptStatus.Completed,
      accountB: WalletPromptStatus.Pending
    });
    expect(result.current.storage.prompts[WalletPromptType.VerifySeedPhrase]).toBe(WalletPromptStatus.Pending);
    // The last of the three writes landing is what the stored record must show.
    await waitFor(async () => {
      const stored = await fetchWalletPromptStorage();
      expect(stored.faucetByAccount).toEqual({
        accountA: WalletPromptStatus.Completed,
        accountB: WalletPromptStatus.Pending
      });
      expect(stored.prompts[WalletPromptType.VerifySeedPhrase]).toBe(WalletPromptStatus.Pending);
    });
  });

  it('keeps per-account faucet statuses when an unrelated prompt is written', async () => {
    const { result } = renderHook(() => useWalletPromptStorage());
    await waitFor(() => expect(result.current.isLoaded).toBe(true));
    act(() => result.current.setFaucetStatus('accountA', WalletPromptStatus.Dismissed));
    await waitFor(async () =>
      expect((await fetchWalletPromptStorage()).faucetByAccount).toEqual({ accountA: 'dismissed' })
    );

    // Every writer rebuilds the whole storage object; one that forgot the map would
    // silently wipe every account's faucet status on an unrelated write. Checked
    // after EACH writer: the hook rebuilds storage from its own state, so a later
    // hook write would quietly restore what an earlier writer had wiped.
    const expected = { accountA: WalletPromptStatus.Dismissed };

    await setWalletPromptStatus(WalletPromptType.Bridge, WalletPromptStatus.Pending);
    expect((await fetchWalletPromptStorage()).faucetByAccount).toEqual(expected);

    await seedWalletPrompt(WalletPromptType.HotKeyHardwareUnavailable);
    expect((await fetchWalletPromptStorage()).faucetByAccount).toEqual(expected);

    act(() => result.current.setPromptStatus(WalletPromptType.VerifySeedPhrase, WalletPromptStatus.Completed));
    // Wait for this write to land before checking what it had to keep.
    await waitFor(async () => {
      const stored = await fetchWalletPromptStorage();
      expect(stored.prompts[WalletPromptType.VerifySeedPhrase]).toBe(WalletPromptStatus.Completed);
      expect(stored.faucetByAccount).toEqual(expected);
    });
  });

  it('does not let one storage call that never settles hold every later prompt write', async () => {
    jest.useFakeTimers();
    const provider = getStorageProvider();
    const get = jest.spyOn(provider, 'get').mockImplementationOnce(() => new Promise(() => undefined));
    try {
      setWalletPromptStatus(WalletPromptType.Bridge, WalletPromptStatus.Pending).catch(() => undefined);
      let seeded = false;
      const seed = seedWalletPrompt(WalletPromptType.VerifySeedPhrase).then(() => {
        seeded = true;
      });

      await jest.advanceTimersByTimeAsync(WALLET_PROMPT_TURN_WAIT_MS);
      await seed;

      expect(seeded).toBe(true);
      expect((await fetchWalletPromptStorage()).prompts[WalletPromptType.VerifySeedPhrase]).toBe(
        WalletPromptStatus.Pending
      );
    } finally {
      get.mockRestore();
      jest.useRealTimers();
    }
  });

  it('writes nothing when seeding a prompt that is already dismissed or completed', async () => {
    await setWalletPromptStatus(WalletPromptType.VerifySeedPhrase, WalletPromptStatus.Completed);
    const set = jest.spyOn(getStorageProvider(), 'set').mockRejectedValue(new Error('storage unavailable'));
    try {
      await expect(seedWalletPrompt(WalletPromptType.VerifySeedPhrase)).resolves.toMatchObject({
        prompts: { [WalletPromptType.VerifySeedPhrase]: WalletPromptStatus.Completed }
      });
      expect(set).not.toHaveBeenCalled();
    } finally {
      set.mockRestore();
    }
  });

  it('never lets an earlier write take back a newer change shown in hook state', async () => {
    const { result } = renderHook(() => useWalletPromptStorage());
    await waitFor(() => expect(result.current.isLoaded).toBe(true));
    const provider = getStorageProvider();
    const writeRecord = provider.set.bind(provider);
    const readRecord = provider.get.bind(provider);
    let releaseFirstWrite!: () => void;
    const set = jest.spyOn(provider, 'set').mockImplementationOnce(
      items =>
        new Promise(resolve => {
          releaseFirstWrite = () => resolve(writeRecord(items));
        })
    );
    const get = jest.spyOn(provider, 'get');
    // Released in `finally` too: a held storage call left pending would stall the shared
    // write queue for every later test.
    let releaseSecondRead = () => undefined;

    try {
      act(() => result.current.setPromptStatus(WalletPromptType.PendingNotes, WalletPromptStatus.Dismissed));
      act(() => result.current.setFaucetStatus('accountA', WalletPromptStatus.Dismissed));
      await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
      // The second write's read is held, so the first write's result lands on its own.
      get.mockImplementationOnce(keys => {
        const record = readRecord(keys);
        return new Promise(resolve => {
          releaseSecondRead = () => {
            resolve(record);
            return undefined;
          };
        });
      });

      await act(async () => {
        releaseFirstWrite();
      });
      // The first write predates the faucet change, so its result must not replace the state.
      expect(result.current.storage.faucetByAccount).toEqual({ accountA: WalletPromptStatus.Dismissed });

      await act(async () => {
        releaseSecondRead();
      });
      await waitFor(async () =>
        expect((await fetchWalletPromptStorage()).faucetByAccount).toEqual({ accountA: WalletPromptStatus.Dismissed })
      );
      expect(result.current.storage.prompts[WalletPromptType.PendingNotes]).toBe(WalletPromptStatus.Dismissed);
      expect(result.current.storage.faucetByAccount).toEqual({ accountA: WalletPromptStatus.Dismissed });
    } finally {
      releaseFirstWrite?.();
      releaseSecondRead();
      set.mockRestore();
      get.mockRestore();
    }
  });

  it('keeps a faucet status the hook writes while another writer is still reading the record', async () => {
    const { result } = renderHook(() => useWalletPromptStorage());
    await waitFor(() => expect(result.current.isLoaded).toBe(true));
    const provider = getStorageProvider();
    const readRecord = provider.get.bind(provider);
    let releaseRead!: () => void;
    // The read happens now; only its result is held back.
    const get = jest.spyOn(provider, 'get').mockImplementationOnce(keys => {
      const record = readRecord(keys);
      return new Promise(resolve => {
        releaseRead = () => resolve(record);
      });
    });

    try {
      // A module writer reads the record first; the hook writes a faucet status before
      // that read returns. Both writers own different fields of one record.
      const bridge = setWalletPromptStatus(WalletPromptType.Bridge, WalletPromptStatus.Pending);
      await act(async () => {
        result.current.setFaucetStatus('accountA', WalletPromptStatus.Completed);
      });
      releaseRead();
      await bridge;

      await waitFor(async () => {
        const stored = await fetchWalletPromptStorage();
        expect(stored.prompts[WalletPromptType.Bridge]).toBe(WalletPromptStatus.Pending);
        expect(stored.faucetByAccount).toEqual({ accountA: WalletPromptStatus.Completed });
      });
    } finally {
      get.mockRestore();
    }
  });

  it('reloads hook state from storage when a status write fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { result } = renderHook(() => useWalletPromptStorage());
    await waitFor(() => expect(result.current.isLoaded).toBe(true));
    const set = jest.spyOn(getStorageProvider(), 'set').mockRejectedValueOnce(new Error('storage unavailable'));

    try {
      act(() => result.current.setFaucetStatus('accountA', WalletPromptStatus.Dismissed));
      // Shown at once, then taken back once storage says it never landed.
      expect(result.current.storage.faucetByAccount).toEqual({ accountA: WalletPromptStatus.Dismissed });
      await waitFor(() => expect(result.current.storage.faucetByAccount).toEqual({}));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to persist'), expect.any(Error));
    } finally {
      set.mockRestore();
      warn.mockRestore();
    }
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

describe('guardian note-recovery progress card', () => {
  const OTHER_ACCOUNT = 'account-2';
  const ACCOUNT = 'account-1';

  beforeEach(async () => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  it('reads the progress of the account it was given', async () => {
    await reportGuardianNoteRecoveryProgress({ accountId: ACCOUNT, step: 'transport' });

    const { result } = renderHook(() => useGuardianNoteRecoveryProgress(ACCOUNT));

    await waitFor(() => expect(result.current?.step).toBe('transport'));
  });

  // Seed recovery flags EVERY adopted account, so a record belonging to another
  // account is the normal case rather than an edge one. Narrating its blocks
  // under this account's name would be a lie about which recovery is running.
  it('ignores the progress of a different account', async () => {
    await reportGuardianNoteRecoveryProgress({ accountId: OTHER_ACCOUNT, step: 'public', syncedToBlock: 500 });

    const { result } = renderHook(() => useGuardianNoteRecoveryProgress(ACCOUNT));

    await waitFor(() => expect(result.current).toBeNull());
  });

  // The card is non-dismissible, so a record whose run died with its realm
  // would otherwise sit on screen forever.
  it('ages out a record that stopped being refreshed', async () => {
    // Written far enough in the past that the real clock makes it stale, so the
    // hook runs against an unmocked `Date.now`.
    const dateSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() - GUARDIAN_NOTE_RECOVERY_PROGRESS_STALE_MS - 60_000);
    await reportGuardianNoteRecoveryProgress({ accountId: ACCOUNT, step: 'public', syncedToBlock: 900 });
    dateSpy.mockRestore();

    const { result } = renderHook(() => useGuardianNoteRecoveryProgress(ACCOUNT));

    // Long enough for a fresh record to have shown up.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBeNull();
  });

  it('drops the card when the account it was narrating stops recovering', async () => {
    await reportGuardianNoteRecoveryProgress({ accountId: ACCOUNT, step: 'transport' });
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useGuardianNoteRecoveryProgress(id), {
      initialProps: { id: ACCOUNT as string | null }
    });
    await waitFor(() => expect(result.current?.step).toBe('transport'));

    rerender({ id: null });

    await waitFor(() => expect(result.current).toBeNull());
  });

  // Every home view mounts this. Reading storage on a 2s interval for accounts
  // with no recovery at all is pure background cost, so a null id means idle.
  it('does not read storage at all when no account is recovering', async () => {
    await reportGuardianNoteRecoveryProgress({ accountId: ACCOUNT, step: 'transport' });
    const getItemSpy = jest.spyOn(Storage.prototype, 'getItem');

    const { result } = renderHook(() => useGuardianNoteRecoveryProgress(null));

    await waitFor(() => expect(result.current).toBeNull());
    expect(getItemSpy).not.toHaveBeenCalledWith(GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY);
  });

  it('picks up a later write without remounting', async () => {
    jest.useFakeTimers();
    try {
      await reportGuardianNoteRecoveryProgress({ accountId: ACCOUNT, step: 'transport' });
      const { result } = renderHook(() => useGuardianNoteRecoveryProgress(ACCOUNT));
      await waitFor(() => expect(result.current?.step).toBe('transport'));

      await reportGuardianNoteRecoveryProgress({ accountId: ACCOUNT, step: 'public', syncedToBlock: 900 });
      // Mobile and desktop get no storage events, so the poll is the only way
      // the card advances there.
      await act(async () => {
        jest.advanceTimersByTime(2_000);
      });

      await waitFor(() => expect(result.current?.syncedToBlock).toBe(900));
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('bridge prompts', () => {
  const baseBridge = (over: Partial<ITransaction>): ITransaction =>
    ({
      id: 'bridge-1',
      type: 'bridged-send',
      accountId: 'acct-1',
      status: ITransactionStatus.Completed,
      initiatedAt: 100,
      displayIcon: 'SEND',
      extraInputs: { provider: 'epoch' },
      ...over
    }) as ITransaction;

  beforeEach(() => {
    jest.clearAllMocks();
    bridgeRows.splice(0);
    findClaimableDeposit.mockResolvedValue(undefined);
    updateClaimStatus.mockResolvedValue(undefined);
    pollEpochIntentFill.mockResolvedValue(undefined);
  });

  it('returns unsettled bridged-sends for the account, newest first', async () => {
    bridgeRows.push(
      baseBridge({ id: 'in-flight', status: ITransactionStatus.GeneratingTransaction, initiatedAt: 50 }),
      baseBridge({ id: 'epoch-pending', extraInputs: { provider: 'epoch', epochStatus: 'pending' }, initiatedAt: 300 }),
      baseBridge({ id: 'epoch-confirmed', extraInputs: { provider: 'epoch', epochStatus: 'confirmed' } }),
      baseBridge({
        id: 'agg-unclaimed',
        extraInputs: { provider: 'agglayer', claimStatus: 'pending' },
        initiatedAt: 200
      }),
      baseBridge({ id: 'agg-claimed', extraInputs: { provider: 'agglayer', claimStatus: 'claimed' } }),
      baseBridge({ id: 'failed', status: ITransactionStatus.Failed }),
      baseBridge({ id: 'other-account', accountId: 'acct-2', initiatedAt: 400 })
    );

    const active = await fetchActiveBridgePrompts('acct-1');

    expect(active.map(tx => tx.id)).toEqual(['epoch-pending', 'agg-unclaimed', 'in-flight']);
  });

  // Import deliberately leaves a restored row's bridge status alone so history
  // stays truthful, which means the prompt is what has to refuse it: this card
  // polls the bridge indexer against dump-supplied values on a timer and puts a
  // Claim button — an EVM signature — in front of the user.
  it('excludes a restored bridge from the prompt whatever its recorded status', async () => {
    bridgeRows.push(
      baseBridge({
        id: 'restored-epoch',
        restoredFromBackup: true,
        extraInputs: { provider: 'epoch', epochStatus: 'pending' },
        initiatedAt: 500
      }),
      baseBridge({
        id: 'restored-agg',
        restoredFromBackup: true,
        extraInputs: { provider: 'agglayer', claimStatus: 'ready' },
        initiatedAt: 400
      }),
      baseBridge({ id: 'restored-in-flight', restoredFromBackup: true, status: ITransactionStatus.Queued }),
      baseBridge({ id: 'mine', extraInputs: { provider: 'epoch', epochStatus: 'pending' }, initiatedAt: 10 })
    );

    const active = await fetchActiveBridgePrompts('acct-1');

    expect(active.map(tx => tx.id)).toEqual(['mine']);
  });

  it('reconciles every unsettled bridged-send across accounts and skips settled or restored rows', async () => {
    pollEpochIntentFill.mockResolvedValue({ status: 'confirmed', fillTxHash: '0xfill', fillChainId: 11155111 });
    const pending = (id: string, accountId: string, over: Partial<ITransaction> = {}) =>
      baseBridge({
        id,
        accountId,
        extraInputs: {
          provider: 'epoch',
          epochStatus: 'pending',
          intentNonce: 'N1',
          destinationAddress: '0x1111111111111111111111111111111111111111'
        },
        ...over
      });
    bridgeRows.push(
      pending('acct-1-pending', 'acct-1'),
      pending('acct-2-pending', 'acct-2'),
      pending('restored', 'acct-1', { restoredFromBackup: true }),
      baseBridge({ id: 'confirmed', extraInputs: { provider: 'epoch', epochStatus: 'confirmed' } }),
      baseBridge({ id: 'not-a-bridge', type: 'send' })
    );

    await reconcileBridgedSends();

    expect(pollEpochIntentFill).toHaveBeenCalledTimes(2);
    expect(updateClaimStatus.mock.calls.map(call => call[0])).toEqual(
      expect.arrayContaining(['acct-1-pending', 'acct-2-pending'])
    );
    expect(updateClaimStatus).toHaveBeenCalledTimes(2);
  });

  it('keeps polling the other rows when one row fails, and names the failing row', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    pollEpochIntentFill.mockImplementation(async ({ intentNonce }: { intentNonce: string }) => {
      if (intentNonce === 'N-broken') throw new Error('allocator down');
      return { status: 'confirmed', fillTxHash: '0xfill', fillChainId: 11155111 };
    });
    const pending = (id: string, accountId: string, intentNonce: string) =>
      baseBridge({
        id,
        accountId,
        extraInputs: {
          provider: 'epoch',
          epochStatus: 'pending',
          intentNonce,
          destinationAddress: '0x1111111111111111111111111111111111111111'
        }
      });
    bridgeRows.push(pending('broken-row', 'acct-1', 'N-broken'), pending('healthy-row', 'acct-2', 'N-healthy'));

    await expect(reconcileBridgedSends()).resolves.toBeUndefined();

    expect(updateClaimStatus).toHaveBeenCalledWith('healthy-row', 'not-applicable', expect.any(Object));
    expect(warn).toHaveBeenCalledWith('[wallet-prompts] bridged-send poll failed', 'broken-row', expect.any(Error));
    warn.mockRestore();
  });

  it('flips a pending AggLayer bridge to ready once its deposit is claimable', async () => {
    findClaimableDeposit.mockResolvedValue({ deposit: true });
    const claimable = baseBridge({
      id: 'agg-ready',
      extraInputs: { provider: 'agglayer', claimStatus: 'pending', destinationAddress: '0xdest' }
    });
    const alreadyReady = baseBridge({
      id: 'agg-already',
      extraInputs: { provider: 'agglayer', claimStatus: 'ready', destinationAddress: '0xdest' }
    });
    const stillProving = baseBridge({ id: 'proving', status: ITransactionStatus.GeneratingTransaction });
    const notBridge = baseBridge({ id: 'send', type: 'send' });

    bridgeRows.push(claimable, alreadyReady, stillProving, notBridge);
    await reconcileBridgedSends();

    expect(findClaimableDeposit).toHaveBeenCalledTimes(1);
    expect(updateClaimStatus).toHaveBeenCalledWith('agg-ready', 'ready', { depositReady: true });
  });

  it('marks ready only the row whose OWN bridge-out produced the claimable deposit', async () => {
    // Two Slow bridge-outs to the same L1 address. The claim the user then makes
    // is stamped onto whichever row flipped to 'ready', so flipping both off one
    // deposit reports a bridge as claimed that was never claimed.
    // Deposit 41 belongs to row A. An unbound lookup (no origin hash) resolves it
    // too, so dropping the binding flips BOTH rows ready off this one deposit.
    findClaimableDeposit.mockImplementation(async (_dest: unknown, originTxHash: unknown) =>
      originTxHash === '0xrow-b-origin' ? null : { deposit_cnt: 41 }
    );

    bridgeRows.push(
      baseBridge({
        id: 'agg-a',
        transactionId: '0xrow-a-origin',
        extraInputs: { provider: 'agglayer', claimStatus: 'pending', destinationAddress: '0xdest' }
      }),
      baseBridge({
        id: 'agg-b',
        transactionId: '0xrow-b-origin',
        extraInputs: { provider: 'agglayer', claimStatus: 'pending', destinationAddress: '0xdest' }
      })
    );
    await reconcileBridgedSends();

    expect(updateClaimStatus).toHaveBeenCalledTimes(1);
    expect(updateClaimStatus).toHaveBeenCalledWith('agg-a', 'ready', { depositReady: true });
  });

  // `pollBridgedSend` queries the allocator and writes back onto the row, so a
  // row restored from a backup must never reach it.
  it('polls nothing for a restored row', async () => {
    const restored = baseBridge({
      id: 'agg-restored',
      restoredFromBackup: true,
      extraInputs: { provider: 'agglayer', claimStatus: 'pending', destinationAddress: '0xdest' }
    });

    bridgeRows.push(restored);
    await reconcileBridgedSends();

    expect(findClaimableDeposit).not.toHaveBeenCalled();
    expect(updateClaimStatus).not.toHaveBeenCalled();
  });

  it('leaves a pending AggLayer bridge untouched while no deposit is claimable', async () => {
    bridgeRows.push(
      baseBridge({
        id: 'agg-wait',
        extraInputs: { provider: 'agglayer', claimStatus: 'pending', destinationAddress: '0xdest' }
      })
    );
    await reconcileBridgedSends();

    expect(updateClaimStatus).not.toHaveBeenCalled();
  });

  it('records an Epoch fill once the intent settles and skips unfilled or settled intents', async () => {
    pollEpochIntentFill.mockResolvedValue({ status: 'confirmed', fillTxHash: '0xfill', fillChainId: 8453 });
    const filling = baseBridge({
      id: 'epoch-filling',
      extraInputs: { provider: 'epoch', epochStatus: 'pending', intentNonce: 'n1', destinationAddress: '0xdest' }
    });
    const settled = baseBridge({
      id: 'epoch-settled',
      extraInputs: { provider: 'epoch', epochStatus: 'confirmed', intentNonce: 'n2', destinationAddress: '0xdest' }
    });
    const noNonce = baseBridge({
      id: 'epoch-no-nonce',
      extraInputs: { provider: 'epoch', epochStatus: 'pending', destinationAddress: '0xdest' }
    });

    bridgeRows.push(filling, settled, noNonce);
    await reconcileBridgedSends();

    expect(pollEpochIntentFill).toHaveBeenCalledTimes(1);
    expect(updateClaimStatus).toHaveBeenCalledWith('epoch-filling', 'not-applicable', {
      epochStatus: 'confirmed',
      fillTxHash: '0xfill',
      fillChainId: 8453
    });
  });

  it('keeps polling an Epoch intent whose fill is still pending without a hash', async () => {
    pollEpochIntentFill.mockResolvedValue({ status: 'pending', fillTxHash: undefined });

    bridgeRows.push(
      baseBridge({
        id: 'epoch-unfilled',
        extraInputs: { provider: 'epoch', epochStatus: 'pending', intentNonce: 'n1', destinationAddress: '0xdest' }
      })
    );
    await reconcileBridgedSends();

    expect(updateClaimStatus).not.toHaveBeenCalled();
  });
});

describe('hot-key hardware failure report', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns null while no failure has been recorded or the record is malformed', async () => {
    expect(await fetchHotKeyHardwareError()).toBeNull();
    localStorage.setItem('hot_key_hardware_error_v1', JSON.stringify({ message: 42 }));
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

describe('hot-key rotation-needed report', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('seeds the rotation prompt', async () => {
    await reportHotKeyRotationNeeded();

    const storage = await fetchWalletPromptStorage();
    expect(storage.prompts[WalletPromptType.HotKeyRotationNeeded]).toBe(WalletPromptStatus.Pending);
  });

  it('does not re-seed after the user dismissed it', async () => {
    await dismissWalletPrompt(WalletPromptType.HotKeyRotationNeeded);
    await reportHotKeyRotationNeeded();

    const storage = await fetchWalletPromptStorage();
    expect(storage.prompts[WalletPromptType.HotKeyRotationNeeded]).toBe(WalletPromptStatus.Dismissed);
  });

  it('re-arms after a completed rotation (a new unwrap failure is a new incident)', async () => {
    await completeWalletPrompt(WalletPromptType.HotKeyRotationNeeded);
    await reportHotKeyRotationNeeded();

    const storage = await fetchWalletPromptStorage();
    expect(storage.prompts[WalletPromptType.HotKeyRotationNeeded]).toBe(WalletPromptStatus.Pending);
  });
});
