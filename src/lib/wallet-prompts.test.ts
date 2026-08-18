import { act, renderHook, waitFor } from '@testing-library/react';

import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { putToStorage } from 'lib/miden/front/storage';
import { mintFromMidenFaucet } from 'lib/miden-chain/faucet-api';

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
  pollActiveBridgePrompts,
  reportHotKeyHardwareFailure,
  reportHotKeyRotationNeeded,
  seedWalletPrompt,
  setFaucetFundingMarker,
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
      pendingNotesDismissedIds: ['note-1', 'note-2']
    });
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

  it('stores the faucet alongside the other prompts', async () => {
    await seedWalletPrompt(WalletPromptType.Faucet);
    await seedWalletPrompt(WalletPromptType.VerifySeedPhrase);

    const storage = await fetchWalletPromptStorage();
    expect(storage.prompts).toEqual({
      [WalletPromptType.Faucet]: WalletPromptStatus.Pending,
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
