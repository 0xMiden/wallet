import { act, renderHook, waitFor } from '@testing-library/react';

import {
  GUARDIAN_NOTE_RECOVERY_PROGRESS_STALE_MS,
  GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY,
  reportGuardianNoteRecoveryProgress
} from 'lib/guardian-note-recovery-progress';
import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { putToStorage } from 'lib/miden/front/storage';
import { mintFromMidenFaucet } from 'lib/miden-chain/faucet-api';

import {
  EMPTY_WALLET_PROMPT_STORAGE,
  FaucetError,
  WalletPromptStatus,
  WalletPromptType,
  __resetFaucetProgressForTest,
  completeWalletPrompt,
  dismissWalletPrompt,
  faucet,
  fetchActiveBridgePrompts,
  fetchHotKeyHardwareError,
  fetchWalletPromptStorage,
  getAccountWalletPromptStatus,
  getPendingNotesUsdTotal,
  isWalletPromptPending,
  normalizeWalletPromptStorage,
  pollActiveBridgePrompts,
  reportHotKeyHardwareFailure,
  reportHotKeyRotationNeeded,
  seedWalletPrompt,
  setWalletPromptStatus,
  useGuardianNoteRecoveryProgress,
  useWalletPromptStorage,
  WALLET_PROMPTS_STORAGE_KEY
} from './wallet-prompts';

jest.mock('lib/platform', () => ({
  isMobile: () => false,
  isDesktop: () => true,
  isExtension: () => false
}));

jest.mock('lib/miden-chain/faucet-api', () => ({
  // Keep the REAL faucetFetch (timeout + Retry-After) that mintFromForkchoice
  // now routes through; only stub the MIDEN faucet so the forkchoice half is
  // driven by the mocked global fetch.
  ...jest.requireActual('lib/miden-chain/faucet-api'),
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
    // The per-address faucet-source memo is module-level; clear it so a partial
    // success in one test can't skip a source in the next (they share addresses).
    __resetFaucetProgressForTest();
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
      accountPrompts: {},
      pendingNotesDismissedIds: ['note-1', 'note-2']
    });
  });

  it('normalizes per-account prompt state, dropping unknown types, bad statuses and empty entries', () => {
    expect(
      normalizeWalletPromptStorage({
        version: 1,
        prompts: {},
        accountPrompts: {
          accountA: { faucet: 'completed', unknown: 'pending', verifySeedPhrase: 'bad-status' },
          accountB: { unknown: 'pending' },
          '': { faucet: 'pending' },
          accountC: 'not-an-object'
        }
      }).accountPrompts
    ).toEqual({ accountA: { [WalletPromptType.Faucet]: WalletPromptStatus.Completed } });
    expect(normalizeWalletPromptStorage({ version: 1, prompts: {}, accountPrompts: 5 }).accountPrompts).toEqual({});
  });

  it('reads a per-account prompt status without leaking it across accounts', () => {
    const storage = normalizeWalletPromptStorage({
      version: 1,
      prompts: {},
      accountPrompts: { accountA: { faucet: 'dismissed' } }
    });
    expect(getAccountWalletPromptStatus(storage, 'accountA', WalletPromptType.Faucet)).toBe(
      WalletPromptStatus.Dismissed
    );
    expect(getAccountWalletPromptStatus(storage, 'accountB', WalletPromptType.Faucet)).toBeUndefined();
    expect(getAccountWalletPromptStatus(storage, 'accountA', WalletPromptType.VerifySeedPhrase)).toBeUndefined();
  });

  it('keeps per-account prompt state when a wallet-wide prompt is written', async () => {
    await putToStorage(WALLET_PROMPTS_STORAGE_KEY, {
      version: 1,
      prompts: {},
      accountPrompts: { accountA: { faucet: 'completed' } }
    });

    await seedWalletPrompt(WalletPromptType.VerifySeedPhrase);
    await setWalletPromptStatus(WalletPromptType.VerifySeedPhrase, WalletPromptStatus.Dismissed);

    const storage = await fetchWalletPromptStorage();
    expect(storage.prompts[WalletPromptType.VerifySeedPhrase]).toBe(WalletPromptStatus.Dismissed);
    expect(storage.accountPrompts).toEqual({ accountA: { [WalletPromptType.Faucet]: WalletPromptStatus.Completed } });
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
    fetchMock.mockResolvedValue({ ok: true, status: 200, headers: new Headers() } as Response);
    mintFromMidenFaucetMock.mockResolvedValue({ txId: '0xtx', noteId: '0xnote' });

    await faucet('mtst1testaddress');

    // objectContaining: faucetFetch adds an AbortSignal to the init for the
    // timeout, so match the meaningful fields rather than the exact object.
    expect(fetchMock).toHaveBeenCalledWith(
      'https://faucet-api.forkchoice.xyz/api/mint',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: 'IMIDEN',
          address: 'mtst1testaddress',
          amount: 1_000_000_000,
          note_type: 'public'
        })
      })
    );
    expect(mintFromMidenFaucetMock).toHaveBeenCalledWith('mtst1testaddress', 100_000_000n);
  });

  it('tolerates a failing forkchoice faucet when the Miden faucet succeeds (best-effort)', async () => {
    // Forkchoice is a devnet-specific service and irrelevant on a custom network;
    // its failure must NOT sink the fund when the authoritative Miden faucet works.
    fetchMock.mockResolvedValue({ ok: false, status: 429, headers: new Headers() } as Response);
    mintFromMidenFaucetMock.mockResolvedValue({ txId: '0xtx', noteId: '0xnote' });

    await expect(faucet('mtst1testaddress')).resolves.toBeUndefined();
    expect(mintFromMidenFaucetMock).toHaveBeenCalledWith('mtst1testaddress', 100_000_000n);
  });

  it('does not memo a fund only forkchoice failed, so a later fund retries both sources', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, headers: new Headers() } as Response);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, headers: new Headers() } as Response);
    mintFromMidenFaucetMock.mockResolvedValue({ txId: '0xtx', noteId: '0xnote' });

    await faucet('mtst1besteffort'); // forkchoice fails, MIDEN pays out → still a success
    await faucet('mtst1besteffort'); // a genuine re-fund attempts BOTH again

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mintFromMidenFaucetMock).toHaveBeenCalledTimes(2);
  });

  it('retries ONLY the failed source and never double-mints the one that succeeded (gap 10)', async () => {
    // Partial failure: forkchoice (IMIDEN) pays out, the MIDEN faucet fails.
    fetchMock.mockResolvedValue({ ok: true, status: 200, headers: new Headers() } as Response);
    mintFromMidenFaucetMock.mockRejectedValueOnce(new Error('PoW rate limited'));

    await expect(faucet('mtst1partial')).rejects.toThrow('MIDEN: PoW rate limited');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mintFromMidenFaucetMock).toHaveBeenCalledTimes(1);

    // Retry: MIDEN now succeeds. forkchoice already paid out, so it must NOT be
    // minted a second time — the whole point of gap 10.
    mintFromMidenFaucetMock.mockResolvedValueOnce({ txId: '0xtx', noteId: '0xnote' });
    await faucet('mtst1partial');

    expect(fetchMock).toHaveBeenCalledTimes(1); // STILL 1 — no double-mint
    expect(mintFromMidenFaucetMock).toHaveBeenCalledTimes(2); // failed source retried
  });

  it('re-mints both sources on a fresh fund after a fully successful one (memo cleared)', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, headers: new Headers() } as Response);
    mintFromMidenFaucetMock.mockResolvedValue({ txId: '0xtx', noteId: '0xnote' });

    await faucet('mtst1fresh'); // both succeed → per-address memo cleared
    await faucet('mtst1fresh'); // a genuine re-fund attempts BOTH again

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mintFromMidenFaucetMock).toHaveBeenCalledTimes(2);
  });

  it('rejects when the official Miden faucet fails even if forkchoice succeeds', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, headers: new Headers() } as Response);
    mintFromMidenFaucetMock.mockRejectedValue(new Error('Faucet PoW request failed with status 429'));

    await expect(faucet('mtst1testaddress')).rejects.toThrow('Faucet PoW request failed with status 429');
  });

  it('aggregates both child messages when both faucets reject', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, headers: new Headers() } as Response);
    mintFromMidenFaucetMock.mockRejectedValue(new Error('PoW rate limited'));

    const error = await faucet('mtst1testaddress').catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(FaucetError);
    expect((error as FaucetError).message).toContain('Faucet request failed with status 500');
    expect((error as FaucetError).message).toContain('PoW rate limited');
  });

  it('stringifies a non-Error rejection reason in the aggregated message', async () => {
    // A forkchoice failure on its own is tolerated, so pair it with a MIDEN
    // failure to surface the aggregate that carries the stringified reason.
    fetchMock.mockRejectedValue('network down');
    mintFromMidenFaucetMock.mockRejectedValue(new Error('PoW rate limited'));

    await expect(faucet('mtst1testaddress')).rejects.toThrow('IMIDEN: network down');
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
      accountPrompts: {},
      pendingNotesDismissedIds: ['note-1', 'note-2']
    });

    await waitFor(async () => {
      expect(await fetchWalletPromptStorage()).toEqual(result.current.storage);
    });
  });

  it('stores a per-account prompt status for that account alone and persists it', async () => {
    const { result } = renderHook(() => useWalletPromptStorage());
    // Let the mount-time load land first, or it overwrites the writes below.
    await waitFor(() => expect(result.current.isLoaded).toBe(true));

    act(() => {
      result.current.setAccountPromptStatus('accountA', WalletPromptType.Faucet, WalletPromptStatus.Completed);
    });
    act(() => {
      result.current.setAccountPromptStatus('accountB', WalletPromptType.Faucet, WalletPromptStatus.Pending);
    });

    expect(result.current.storage.accountPrompts).toEqual({
      accountA: { [WalletPromptType.Faucet]: WalletPromptStatus.Completed },
      accountB: { [WalletPromptType.Faucet]: WalletPromptStatus.Pending }
    });
    // The wallet-wide map is untouched — the seed-phrase prompt is not per account.
    expect(result.current.storage.prompts).toEqual({});

    await waitFor(async () => {
      expect(await fetchWalletPromptStorage()).toEqual(result.current.storage);
    });

    // Re-writing one account leaves the other exactly as it was.
    act(() => {
      result.current.setAccountPromptStatus('accountA', WalletPromptType.Faucet, WalletPromptStatus.Dismissed);
    });
    expect(result.current.storage.accountPrompts).toEqual({
      accountA: { [WalletPromptType.Faucet]: WalletPromptStatus.Dismissed },
      accountB: { [WalletPromptType.Faucet]: WalletPromptStatus.Pending }
    });
  });

  it('warns and refreshes when per-account persistence fails', async () => {
    const { result } = renderHook(() => useWalletPromptStorage());
    await waitFor(() => expect(result.current.isLoaded).toBe(true));

    const setItemSpy = jest.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new Error('storage full');
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    act(() => {
      result.current.setAccountPromptStatus('accountA', WalletPromptType.Faucet, WalletPromptStatus.Completed);
    });

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        '[wallet-prompts] failed to persist account prompt status:',
        expect.any(Error)
      );
    });
    // Refreshed from storage, which never received the write.
    await waitFor(() => {
      expect(result.current.storage.accountPrompts).toEqual({});
    });

    setItemSpy.mockRestore();
    warnSpy.mockRestore();
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

    await pollActiveBridgePrompts([claimable, alreadyReady, stillProving, notBridge]);

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

    await pollActiveBridgePrompts([
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
    ]);

    expect(updateClaimStatus).toHaveBeenCalledTimes(1);
    expect(updateClaimStatus).toHaveBeenCalledWith('agg-a', 'ready', { depositReady: true });
  });

  // Defence in depth: today's only caller passes the list `fetchActiveBridgePrompts`
  // already filtered, but this is exported and takes whatever it is given, and
  // `pollBridgedSend` queries the allocator and writes back onto the row.
  it('polls nothing for a restored row even when handed one directly', async () => {
    const restored = baseBridge({
      id: 'agg-restored',
      restoredFromBackup: true,
      extraInputs: { provider: 'agglayer', claimStatus: 'pending', destinationAddress: '0xdest' }
    });

    await pollActiveBridgePrompts([restored]);

    expect(findClaimableDeposit).not.toHaveBeenCalled();
    expect(updateClaimStatus).not.toHaveBeenCalled();
  });

  it('leaves a pending AggLayer bridge untouched while no deposit is claimable', async () => {
    await pollActiveBridgePrompts([
      baseBridge({
        id: 'agg-wait',
        extraInputs: { provider: 'agglayer', claimStatus: 'pending', destinationAddress: '0xdest' }
      })
    ]);

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

    await pollActiveBridgePrompts([filling, settled, noNonce]);

    expect(pollEpochIntentFill).toHaveBeenCalledTimes(1);
    expect(updateClaimStatus).toHaveBeenCalledWith('epoch-filling', 'not-applicable', {
      epochStatus: 'confirmed',
      fillTxHash: '0xfill',
      fillChainId: 8453
    });
  });

  it('keeps polling an Epoch intent whose fill is still pending without a hash', async () => {
    pollEpochIntentFill.mockResolvedValue({ status: 'pending', fillTxHash: undefined });

    await pollActiveBridgePrompts([
      baseBridge({
        id: 'epoch-unfilled',
        extraInputs: { provider: 'epoch', epochStatus: 'pending', intentNonce: 'n1', destinationAddress: '0xdest' }
      })
    ]);

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
