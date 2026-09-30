import { act, renderHook, waitFor } from '@testing-library/react';

import { SharedEarnLocks } from 'lib/epoch/testing/earn-locks';
import {
  GUARDIAN_NOTE_RECOVERY_PROGRESS_STALE_MS,
  GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY,
  reportGuardianNoteRecoveryProgress
} from 'lib/guardian-note-recovery-progress';
import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { putToStorage } from 'lib/miden/front/storage';
import { TOKEN_IETH } from 'lib/miden/swap/tokens';
import { FaucetOutcomeUnknownError, mintFromMidenFaucet } from 'lib/miden-chain/faucet-api';
import { getStorageProvider } from 'lib/platform/storage-adapter';

import {
  EMPTY_WALLET_PROMPT_STORAGE,
  FAUCET_FUNDS_ARRIVAL_TIMEOUT_MS,
  FAUCET_UNSUBMITTED_MARKER_MS,
  FaucetRequestInProgressError,
  FaucetRequestUnresolvedError,
  type FaucetFundingMarker,
  WalletPromptStatus,
  WalletPromptType,
  __resetInFlightFaucetRequestsForTest,
  clearFaucetFundingMarker,
  completeWalletPrompt,
  dismissWalletPrompt,
  faucet,
  fetchActiveBridgePrompts,
  fetchFaucetFundingMarker,
  fetchHotKeyHardwareError,
  fetchWalletPromptStorage,
  getFaucetRequestSettledAt,
  getInFlightFaucetMarker,
  getInFlightFaucetRequest,
  getPendingNotesUsdTotal,
  isFaucetFundingMarkerLive,
  isWalletPromptPending,
  normalizeWalletPromptStorage,
  parseFaucetFundingMarker,
  reconcileBridgedSends,
  reportHotKeyHardwareFailure,
  reportHotKeyRotationNeeded,
  seedWalletPrompt,
  setFaucetFundingMarker,
  setWalletPromptStatus,
  useGuardianNoteRecoveryProgress,
  useWalletPromptStorage,
  withFaucetFundingMarkerLock
} from './wallet-prompts';

jest.mock('lib/platform', () => ({
  isMobile: () => false,
  isDesktop: () => true,
  isExtension: () => false
}));

jest.mock('lib/miden-chain/faucet-api', () => ({
  // The real error class: wallet-prompts constructs it, and callers classify by it.
  FaucetOutcomeUnknownError: jest.requireActual('lib/miden-chain/faucet-api').FaucetOutcomeUnknownError,
  mintFromMidenFaucet: jest.fn()
}));

const bridgeRows: ITransaction[] = [];
const findClaimableDeposit = jest.fn();
const updateClaimStatus = jest.fn();
const pollEpochIntentFill = jest.fn();
const completeVerifiedLanded = jest.fn();

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
  updateBridgeClaimStatus: (...args: unknown[]) => updateClaimStatus(...args),
  // The one shared source of the bridged-send landed display values (#1250) -
  // stubbed rather than the real function so this suite stays about
  // `reconcileBridgedSends`'s own decisions, not `complete.ts`'s literals.
  bridgedSendLandedValues: () => ({ displayMessage: 'Bridged to EVM', displayIcon: 'SEND', completedAt: 1_700_000_000 })
}));
jest.mock('lib/miden/transaction/helper', () => ({
  completeVerifiedLandedTransaction: (...args: unknown[]) => completeVerifiedLanded(...args)
}));
jest.mock('lib/epoch', () => ({
  pollEpochIntentFill: (...args: unknown[]) => pollEpochIntentFill(...args)
}));

const mintFromMidenFaucetMock = jest.mocked(mintFromMidenFaucet);

// One lock manager for every surface, as navigator.locks is for the extension's pages. Every
// suite here needs it: the prompt record's turns and the faucet marker both take a Web Lock.
beforeEach(() => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: new SharedEarnLocks() });
});

describe('wallet prompts', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
    // clearAllMocks keeps implementations, and a leaked mint that never settles turns a
    // failed assertion about minting into a test timeout.
    mintFromMidenFaucetMock.mockReset();
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

  it('normalizes pending-note prompt state and drops the retired dismissed-note ids', () => {
    // The pending-transfer card can no longer be dismissed, so a list of ids it once hid is
    // state nothing writes and nothing reads. A wallet that carries one is not held silent by it.
    expect(
      normalizeWalletPromptStorage({
        version: 1,
        prompts: { pendingNotes: 'dismissed' },
        pendingNotesDismissedIds: ['note-1', 'note-2']
      })
    ).toEqual({
      version: 1,
      prompts: { [WalletPromptType.PendingNotes]: WalletPromptStatus.Dismissed },
      faucetByAccount: {}
    });
  });

  it('drops a wallet-wide faucet status: that status lives per account', () => {
    // Written by a build that kept one faucet status for the whole wallet (#921).
    const storage = normalizeWalletPromptStorage({
      version: 1,
      prompts: { [WalletPromptType.Faucet]: 'completed', [WalletPromptType.Bridge]: 'pending' },
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
        faucetByAccount: { accountA: 'completed', accountB: 'bogus', '': 'dismissed', accountC: 7 }
      }).faucetByAccount
    ).toEqual({ accountA: WalletPromptStatus.Completed });

    // An older build's storage has no map at all.
    expect(normalizeWalletPromptStorage({ version: 1, prompts: {} }).faucetByAccount).toEqual({});
  });

  describe('getPendingNotesUsdTotal', () => {
    const prices = {
      MIDEN: { price: 2, change24h: 0, percentageChange24h: 0 },
      ETH: { price: 3000, change24h: 0, percentageChange24h: 0 }
    };
    const miden = {
      id: 'note-1',
      amount: '1250000',
      faucetId: '0xmiden',
      metadata: { decimals: 6, symbol: 'MIDEN', name: 'Miden' }
    };
    // IETH is quoted under ETH (its swap token's priceSymbol), never under its own symbol.
    const ieth = {
      id: 'note-2',
      amount: '200000000',
      faucetId: TOKEN_IETH.faucetId,
      metadata: { decimals: 8, symbol: 'IETH', name: 'IETH' }
    };

    it('sums every note at its quoted price, across decimals, reading IETH at the ETH price', () => {
      expect(getPendingNotesUsdTotal([miden, ieth], prices)).toBe(6002.5);
    });

    it('gives no total when any note has no quote, never a $1 figure for it', () => {
      const unquoted = {
        id: 'note-3',
        amount: '3000000',
        faucetId: '0xother',
        metadata: { decimals: 6, symbol: 'OTHER', name: 'Other' }
      };
      expect(getPendingNotesUsdTotal([miden, unquoted], prices)).toBeNull();
    });

    // A registry faucet is priced by its id, so a note still carrying the placeholder's guessed 6
    // decimals would be the real ETH quote times a quantity 100x too large (38 IETH, not 0.38).
    it('gives no total for a note whose scale is unknown, even when its faucet is quoted', () => {
      const unsized = {
        id: 'note-4',
        amount: '38000000',
        faucetId: TOKEN_IETH.faucetId,
        metadata: { decimals: 6, symbol: 'Unknown', name: 'Unknown', scaleIsUnknown: true }
      };
      expect(getPendingNotesUsdTotal([miden, unsized], prices)).toBeNull();
    });

    it('totals nothing as zero', () => {
      expect(getPendingNotesUsdTotal([], {})).toBe(0);
    });
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

    expect(mintFromMidenFaucetMock).toHaveBeenCalledWith(
      'mtst1testaddress',
      100_000_000n,
      expect.any(AbortSignal),
      expect.any(Function),
      expect.any(Function)
    );
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

  it('keeps the marker a request was started with beside it, and ignores a joiner marker', async () => {
    let finish!: () => void;
    mintFromMidenFaucetMock.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = () => resolve({ txId: '0xtx', noteId: '0xnote' });
        })
    );
    const marker = { requestedAt: 1_000, baselineNoteIds: ['note-1'] };

    const request = faucet('accountJoin', marker);
    faucet('accountJoin', { requestedAt: 2_000, baselineNoteIds: [] });
    expect(getInFlightFaucetMarker('accountJoin')).toBe(marker);
    await waitFor(() => expect(mintFromMidenFaucetMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      finish();
      await request;
    });
    expect(getInFlightFaucetMarker('accountJoin')).toBeNull();
  });

  it('remembers when a request settled, for the request it was started with', async () => {
    mintFromMidenFaucetMock.mockResolvedValue({ txId: '0xtx', noteId: '0xnote' });
    const before = Date.now();

    await faucet('accountSettled', { requestedAt: 1_000, baselineNoteIds: [] });

    const settledAt = getFaucetRequestSettledAt('accountSettled', 1_000);
    expect(settledAt).not.toBeNull();
    expect(settledAt!).toBeGreaterThanOrEqual(before);
    expect(getFaucetRequestSettledAt('accountSettled', 2_000)).toBeNull();

    // A request sent and never answered settles too: its mint may land from here on.
    mintFromMidenFaucetMock.mockRejectedValueOnce(
      new FaucetOutcomeUnknownError('Faucet token request got no response')
    );
    await faucet('accountUnknown', { requestedAt: 4_000, baselineNoteIds: [] }).catch(() => undefined);
    expect(getFaucetRequestSettledAt('accountUnknown', 4_000)).not.toBeNull();

    // A refused request went nowhere, so there is no settle to anchor a wait to.
    mintFromMidenFaucetMock.mockRejectedValueOnce(new Error('rate limited'));
    await faucet('accountRefused', { requestedAt: 3_000, baselineNoteIds: [] }).catch(() => undefined);
    expect(getFaucetRequestSettledAt('accountRefused', 3_000)).toBeNull();
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

  it('reports a timeout before the token request as a plain failure, safe to retry', async () => {
    jest.useFakeTimers();
    try {
      // Still in the proof of work: nothing has been sent that could mint.
      mintFromMidenFaucetMock.mockReturnValue(new Promise(() => {}));

      const request = faucet('mtst1testaddress');
      request.catch(() => undefined);
      await jest.advanceTimersByTimeAsync(60_000);

      const error = await request.catch((e: unknown) => e);
      expect(error).toEqual(new Error('Faucet request timed out'));
      expect(error).not.toBeInstanceOf(FaucetOutcomeUnknownError);
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails before the proof of work, with the storage error, when the marker cannot be read (#936)', async () => {
    const provider = getStorageProvider();
    const readRecord = provider.get.bind(provider);
    const get = jest.spyOn(provider, 'get').mockImplementation(async keys => {
      if ([keys].flat().some(key => String(key).startsWith('faucet_funding_v2:'))) {
        throw new Error('storage unreadable');
      }
      return readRecord(keys);
    });
    try {
      const error = await faucet('accountReadFail', { requestedAt: Date.now(), baselineNoteIds: [] }).catch(
        (e: unknown) => e
      );

      // A surface that cannot read the marker still offers Fund, as #504 chose. The check
      // before the proof of work is what keeps that safe: an unreadable marker may belong
      // to a request already minting, so this one is refused rather than sent.
      expect(error).toEqual(new Error('storage unreadable'));
      expect(error).not.toBeInstanceOf(FaucetOutcomeUnknownError);
      expect(mintFromMidenFaucetMock).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
    }
  });

  it('fails before the proof of work, with the storage error, when the marker cannot be stored', async () => {
    const provider = getStorageProvider();
    const writeRecord = provider.set.bind(provider);
    const set = jest.spyOn(provider, 'set').mockImplementation(async items => {
      if (Object.keys(items).some(key => key.startsWith('faucet_funding_v2:'))) throw new Error('storage unavailable');
      await writeRecord(items);
    });
    try {
      const error = await faucet('accountWriteFail', { requestedAt: Date.now(), baselineNoteIds: [] }).catch(
        (e: unknown) => e
      );

      // The pre-send check needs this request's marker stored: without it the request can
      // only fail after the proof of work, blaming another surface.
      expect(error).toEqual(new Error('storage unavailable'));
      expect(mintFromMidenFaucetMock).not.toHaveBeenCalled();
    } finally {
      set.mockRestore();
    }
  });

  it('writes no marker for a request its timeout ended during the first check', async () => {
    jest.useFakeTimers();
    const provider = getStorageProvider();
    const readRecord = provider.get.bind(provider);
    let releaseCheck = () => {};
    const get = jest.spyOn(provider, 'get').mockImplementationOnce(keys => {
      const record = readRecord(keys);
      return new Promise(resolve => {
        releaseCheck = () => resolve(record);
      });
    });
    try {
      const request = faucet('accountSlowCheck', { requestedAt: Date.now(), baselineNoteIds: [] });
      request.catch(() => undefined);
      await jest.advanceTimersByTimeAsync(60_000);
      await expect(request).rejects.not.toBeInstanceOf(FaucetOutcomeUnknownError);

      // A retry may have stored its own marker by now; the ended request must not write over it.
      releaseCheck();
      await jest.advanceTimersByTimeAsync(0);
      expect(await fetchFaucetFundingMarker('accountSlowCheck')).toBeNull();
      expect(mintFromMidenFaucetMock).not.toHaveBeenCalled();
    } finally {
      releaseCheck();
      get.mockRestore();
      jest.useRealTimers();
    }
  });

  it('lets only one of two surfaces send when their checks of the marker interleave', async () => {
    type Realm = {
      faucet: typeof faucet;
      mint: jest.Mock;
      provider: ReturnType<typeof getStorageProvider>;
    };
    const loadRealm = (): Realm => {
      let realm!: Realm;
      jest.isolateModules(() => {
        realm = {
          faucet: require('./wallet-prompts').faucet,
          mint: require('lib/miden-chain/faucet-api').mintFromMidenFaucet,
          provider: require('lib/platform/storage-adapter').getStorageProvider()
        };
      });
      return realm;
    };
    const popup = loadRealm();
    const sidePanel = loadRealm();
    let sent = 0;
    const send = async (
      _address: string,
      _amount: bigint,
      _signal?: AbortSignal,
      beforeSubmit?: () => Promise<void>
    ) => {
      await beforeSubmit?.();
      sent += 1;
      return { txId: '0xtx', noteId: '0xnote' };
    };
    popup.mint.mockImplementation(send);
    sidePanel.mint.mockImplementation(send);
    // The popup's check of the marker is slow: it reads an empty record and answers late.
    const readRecord = popup.provider.get.bind(popup.provider);
    let releaseRead = () => {};
    const get = jest.spyOn(popup.provider, 'get').mockImplementationOnce(keys => {
      const record = readRecord(keys);
      return new Promise(resolve => {
        releaseRead = () => resolve(record);
      });
    });
    const settle = async () => {
      for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0));
    };

    try {
      const fromPopup = popup.faucet('accountShared', { requestedAt: Date.now(), baselineNoteIds: [] });
      await settle();
      const fromSidePanel = sidePanel
        .faucet('accountShared', { requestedAt: Date.now() + 1, baselineNoteIds: [] })
        .catch((e: unknown) => e);
      await settle();
      releaseRead();
      await fromPopup.catch(() => undefined);
      const sidePanelOutcome = await fromSidePanel;

      expect(sent).toBe(1);
      // Each surface loads its own copy of the module, so the class is matched by name.
      expect(sidePanelOutcome).toMatchObject({ name: 'FaucetRequestInProgressError' });
    } finally {
      releaseRead();
      get.mockRestore();
    }
  });

  it('stores no submitted flag for a request its timeout already ended', async () => {
    jest.useFakeTimers();
    const provider = getStorageProvider();
    const readRecord = provider.get.bind(provider);
    let releaseCheck = () => {};
    try {
      mintFromMidenFaucetMock.mockImplementation(
        async (_address: string, _amount: bigint, _signal?: AbortSignal, beforeSubmit?: () => Promise<void>) => {
          // The pre-send check's read is slow: the request times out while it is out.
          const get = jest.spyOn(provider, 'get').mockImplementationOnce(keys => {
            const record = readRecord(keys);
            return new Promise(resolve => {
              releaseCheck = () => resolve(record);
            });
          });
          try {
            await beforeSubmit?.();
          } finally {
            get.mockRestore();
          }
          return { txId: '0xtx', noteId: '0xnote' };
        }
      );

      const request = faucet('accountLate', { requestedAt: Date.now(), baselineNoteIds: [] });
      request.catch(() => undefined);
      await jest.advanceTimersByTimeAsync(60_000);
      const error = await request.catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(FaucetOutcomeUnknownError);

      // The abandoned work goes on once the read returns: a flag stored now would read
      // as a sent request on every surface, for a request that reported a safe failure.
      releaseCheck();
      await jest.advanceTimersByTimeAsync(0);
      expect((await fetchFaucetFundingMarker('accountLate'))?.submitted).toBeUndefined();
    } finally {
      releaseCheck();
      jest.useRealTimers();
    }
  });

  it('reports a timeout that lands while the submitted flag is being stored as an unknown outcome', async () => {
    jest.useFakeTimers();
    const provider = getStorageProvider();
    const writeRecord = provider.set.bind(provider);
    let releaseFlag = () => {};
    try {
      mintFromMidenFaucetMock.mockImplementation(
        async (_address: string, _amount: bigint, _signal?: AbortSignal, beforeSubmit?: () => Promise<void>) => {
          const set = jest.spyOn(provider, 'set').mockImplementationOnce(
            items =>
              new Promise(resolve => {
                releaseFlag = () => resolve(writeRecord(items));
              })
          );
          try {
            await beforeSubmit?.();
          } finally {
            set.mockRestore();
          }
          return new Promise(() => {});
        }
      );

      const request = faucet('accountFlagging', { requestedAt: Date.now(), baselineNoteIds: [] });
      request.catch(() => undefined);
      await jest.advanceTimersByTimeAsync(60_000);

      // The flag may still land, and every surface would then read the request as sent.
      await expect(request).rejects.toBeInstanceOf(FaucetOutcomeUnknownError);
    } finally {
      releaseFlag();
      jest.useRealTimers();
    }
  });

  it('reports a timeout after the faucet refused the token request as a plain failure, safe to retry', async () => {
    jest.useFakeTimers();
    try {
      // Refused, then the refusal's body (or a rate-limit back-off) outlasts the request time.
      mintFromMidenFaucetMock.mockImplementation(
        async (
          _address: string,
          _amount: bigint,
          _signal?: AbortSignal,
          beforeSubmit?: () => Promise<void>,
          onMayMint?: (mayMint: boolean) => void
        ) => {
          await beforeSubmit?.();
          onMayMint?.(true);
          onMayMint?.(false);
          return new Promise(() => {});
        }
      );

      const request = faucet('accountRefusedSlow', { requestedAt: Date.now(), baselineNoteIds: [] });
      request.catch(() => undefined);
      await jest.advanceTimersByTimeAsync(60_000);

      const error = await request.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(FaucetOutcomeUnknownError);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports a timeout after the token request went out as an unknown outcome', async () => {
    jest.useFakeTimers();
    try {
      // The proof of work finishes and the token request is sent, then hangs.
      mintFromMidenFaucetMock.mockImplementation(
        async (_address: string, _amount: bigint, _signal?: AbortSignal, beforeSubmit?: () => Promise<void>) => {
          await beforeSubmit?.();
          return new Promise(() => {});
        }
      );

      const request = faucet('mtst1testaddress', { requestedAt: 1_000, baselineNoteIds: [] });
      request.catch(() => undefined);
      await jest.advanceTimersByTimeAsync(60_000);

      // The faucet may have minted, so this must not read as a refusal a retry
      // can safely follow.
      await expect(request).rejects.toBeInstanceOf(FaucetOutcomeUnknownError);
    } finally {
      jest.useRealTimers();
    }
  });

  it('persists the funding marker, and flags it submitted before the token request goes out', async () => {
    const marker = { requestedAt: 1_000, baselineNoteIds: ['note-1'] };
    const seen: Array<Awaited<ReturnType<typeof fetchFaucetFundingMarker>>> = [];
    mintFromMidenFaucetMock.mockImplementation(
      async (_address: string, _amount: bigint, _signal?: AbortSignal, beforeSubmit?: () => Promise<void>) => {
        seen.push(await fetchFaucetFundingMarker('accountMarker'));
        await beforeSubmit?.();
        // What a resume reads once the token request is out.
        seen.push(await fetchFaucetFundingMarker('accountMarker'));
        return { txId: '0xtx', noteId: '0xnote' };
      }
    );

    await faucet('accountMarker', marker);

    // The flag carries when the token request went out: its mint's arrival window starts there.
    expect(seen).toEqual([marker, { ...marker, submitted: true, submittedAt: expect.any(Number) }]);
  });

  it.each([
    ['sent', true],
    ['still before its token request', false]
  ])(
    'sends nothing over another request that is live and %s, and leaves its marker alone',
    async (_state, submitted) => {
      // A surface that read no marker before another surface's tap still offers Fund.
      const running = {
        requestedAt: Date.now() - 20_000,
        baselineNoteIds: ['note-1'],
        ...(submitted && { submitted })
      };
      await setFaucetFundingMarker('accountBusy', running);
      mintFromMidenFaucetMock.mockResolvedValue({ txId: '0xtx', noteId: '0xnote' });

      const error = await faucet('accountBusy', { requestedAt: Date.now(), baselineNoteIds: [] }).catch(
        (e: unknown) => e
      );

      expect(error).toBeInstanceOf(FaucetRequestInProgressError);
      expect(error).toMatchObject({ marker: running });
      expect(mintFromMidenFaucetMock).not.toHaveBeenCalled();
      expect(await fetchFaucetFundingMarker('accountBusy')).toEqual(running);
    }
  );

  it.each([
    // No surface flagged it (each one watching closed first, or the flag write failed), yet it is
    // unresolved all the same, as the mount read names it: only a request that names it replaces it.
    ['a sent request past its arrival window, named as the one replaced', FAUCET_FUNDS_ARRIVAL_TIMEOUT_MS, true],
    ['an unsent request past its own timeout', FAUCET_UNSUBMITTED_MARKER_MS, false]
  ])('starts a new request over %s', async (_state, ageMs, submitted) => {
    const stale = { requestedAt: Date.now() - ageMs - 1, baselineNoteIds: [], ...(submitted && { submitted }) };
    await setFaucetFundingMarker('accountStale', stale);
    const marker = { requestedAt: Date.now(), baselineNoteIds: [] };
    mintFromMidenFaucetMock.mockImplementation(
      async (_address: string, _amount: bigint, _signal?: AbortSignal, beforeSubmit?: () => Promise<void>) => {
        await beforeSubmit?.();
        return { txId: '0xtx', noteId: '0xnote' };
      }
    );

    await faucet('accountStale', marker, { replaces: submitted ? stale.requestedAt : undefined });

    expect(mintFromMidenFaucetMock).toHaveBeenCalledTimes(1);
    expect(await fetchFaucetFundingMarker('accountStale')).toEqual({
      ...marker,
      submitted: true,
      submittedAt: expect.any(Number)
    });
  });

  it('refuses a request over a sent request past its arrival window that does not name it', async () => {
    const stale: FaucetFundingMarker = {
      requestedAt: Date.now() - FAUCET_FUNDS_ARRIVAL_TIMEOUT_MS - 1,
      baselineNoteIds: ['note-1'],
      submitted: true
    };
    await setFaucetFundingMarker('accountStale', stale);
    mintFromMidenFaucetMock.mockResolvedValue({ txId: '0xtx', noteId: '0xnote' });

    const error = await faucet('accountStale', { requestedAt: Date.now(), baselineNoteIds: [] }).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(FaucetRequestUnresolvedError);
    expect(error).toMatchObject({ record: { requestedAt: stale.requestedAt, baselineNoteIds: ['note-1'] } });
    expect(mintFromMidenFaucetMock).not.toHaveBeenCalled();
    expect(await fetchFaucetFundingMarker('accountStale')).toEqual(stale);
  });

  describe('over an unresolved request', () => {
    // Sent 30 s ago by this clock, yet already flagged unresolved by the surface whose wait ended.
    const unresolvedRecord = (): FaucetFundingMarker => ({
      requestedAt: Date.now() - 60_000,
      baselineNoteIds: ['note-1'],
      submitted: true,
      submittedAt: Date.now() - 30_000,
      unresolved: true
    });

    it.each([
      ['a request that does not name it', () => undefined],
      ['a request that names another record', (record: FaucetFundingMarker) => record.requestedAt - 1]
    ])('refuses %s before any proof of work, and leaves the record', async (_case, replacing) => {
      // A surface that read storage before another surface flagged the record never asked the user.
      const record = unresolvedRecord();
      await setFaucetFundingMarker('accountUnresolved', record);
      mintFromMidenFaucetMock.mockResolvedValue({ txId: '0xtx', noteId: '0xnote' });

      const error = await faucet(
        'accountUnresolved',
        { requestedAt: Date.now(), baselineNoteIds: [] },
        { replaces: replacing(record) }
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FaucetRequestUnresolvedError);
      expect(error).toMatchObject({
        record: { requestedAt: record.requestedAt, baselineNoteIds: record.baselineNoteIds }
      });
      expect(mintFromMidenFaucetMock).not.toHaveBeenCalled();
      expect(await fetchFaucetFundingMarker('accountUnresolved')).toEqual(record);
    });

    it("sends once the request names the record, and the new request's marker replaces it", async () => {
      const record = unresolvedRecord();
      await setFaucetFundingMarker('accountUnresolved', record);
      const marker = { requestedAt: Date.now(), baselineNoteIds: [] };
      const seen: Array<Awaited<ReturnType<typeof fetchFaucetFundingMarker>>> = [];
      mintFromMidenFaucetMock.mockImplementation(
        async (_address: string, _amount: bigint, _signal?: AbortSignal, beforeSubmit?: () => Promise<void>) => {
          seen.push(await fetchFaucetFundingMarker('accountUnresolved'));
          await beforeSubmit?.();
          return { txId: '0xtx', noteId: '0xnote' };
        }
      );

      await faucet('accountUnresolved', marker, { replaces: record.requestedAt });

      expect(mintFromMidenFaucetMock).toHaveBeenCalledTimes(1);
      expect(seen).toEqual([marker]);
      expect(await fetchFaucetFundingMarker('accountUnresolved')).toEqual({
        ...marker,
        submitted: true,
        submittedAt: expect.any(Number)
      });
    });
  });

  it('does not send a request another surface already ended as abandoned', async () => {
    let sent = false;
    mintFromMidenFaucetMock.mockImplementation(
      async (_address: string, _amount: bigint, _signal?: AbortSignal, beforeSubmit?: () => Promise<void>) => {
        // This realm's timers were held back; meanwhile another surface found the marker
        // unflagged past the request timeout, cleared it and offered Fund again.
        await clearFaucetFundingMarker('accountFenced');
        await beforeSubmit?.();
        sent = true;
        return { txId: '0xtx', noteId: '0xnote' };
      }
    );

    const error = await faucet('accountFenced', { requestedAt: 1_000, baselineNoteIds: [] }).catch((e: unknown) => e);

    expect(sent).toBe(false);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(FaucetOutcomeUnknownError);
    expect(await fetchFaucetFundingMarker('accountFenced')).toBeNull();
  });

  it('does not send while another surface is ending the request as abandoned', async () => {
    let sent = false;
    mintFromMidenFaucetMock.mockImplementation(
      async (_address: string, _amount: bigint, _signal?: AbortSignal, beforeSubmit?: () => Promise<void>) => {
        // Another surface's backstop has read the marker unflagged and is about to clear it.
        let readDone = () => {};
        const read = new Promise<void>(resolve => {
          readDone = resolve;
        });
        let releaseClear = () => {};
        const clearing = withFaucetFundingMarkerLock('accountClearing', async () => {
          const stored = await fetchFaucetFundingMarker('accountClearing');
          readDone();
          await new Promise<void>(resolve => {
            releaseClear = resolve;
          });
          if (stored !== null && !stored.submitted) await clearFaucetFundingMarker('accountClearing');
        });
        await read;
        const flagging = beforeSubmit?.();
        flagging?.catch(() => undefined);
        for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0));
        releaseClear();
        await clearing;
        await flagging;
        sent = true;
        return { txId: '0xtx', noteId: '0xnote' };
      }
    );

    const error = await faucet('accountClearing', { requestedAt: 1_000, baselineNoteIds: [] }).catch((e: unknown) => e);

    // Flagging in between would leave a request on its way with no marker for any surface.
    expect(sent).toBe(false);
    expect(error).not.toBeInstanceOf(FaucetOutcomeUnknownError);
    expect(await fetchFaucetFundingMarker('accountClearing')).toBeNull();
  });

  it('fails before the token request, safe to retry, when the submitted flag cannot be stored', async () => {
    const provider = getStorageProvider();
    const writeRecord = provider.set.bind(provider);
    const set = jest.spyOn(provider, 'set');
    // Every write lands except the one that flags the request submitted.
    set.mockImplementation(async items => {
      if (Object.values(items).some(value => Reflect.get(Object(value), 'submitted') !== undefined)) {
        throw new Error('storage unavailable');
      }
      await writeRecord(items);
    });
    let sent = false;
    mintFromMidenFaucetMock.mockImplementation(
      async (_address: string, _amount: bigint, _signal?: AbortSignal, beforeSubmit?: () => Promise<void>) => {
        await beforeSubmit?.();
        sent = true;
        return { txId: '0xtx', noteId: '0xnote' };
      }
    );

    try {
      const error = await faucet('accountNoFlag', { requestedAt: 1_000, baselineNoteIds: [] }).catch((e: unknown) => e);

      // A later open would read the unflagged marker as abandoned and offer Fund,
      // so the request must not go out without the flag.
      expect(sent).toBe(false);
      expect(error).toEqual(new Error('storage unavailable'));
      expect(error).not.toBeInstanceOf(FaucetOutcomeUnknownError);
    } finally {
      set.mockRestore();
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

  it('keeps an unresolved marker stamped in the future: it is never live, so the stamp wedges nothing', async () => {
    const unresolved: FaucetFundingMarker = {
      requestedAt: Date.now() + 60_000,
      baselineNoteIds: [],
      submitted: true,
      unresolved: true
    };
    await setFaucetFundingMarker('accountClockUnresolved', unresolved);

    expect(await fetchFaucetFundingMarker('accountClockUnresolved')).toEqual(unresolved);
  });

  it('reads a sent marker stamped in the future as unresolved, before any surface flagged it', async () => {
    // Dropped, the request would read as never made, and the next tap would send again without asking.
    const requestedAt = Date.now() + 60_000;
    await setFaucetFundingMarker('accountClockSent', { requestedAt, baselineNoteIds: [], submitted: true });

    expect(await fetchFaucetFundingMarker('accountClockSent')).toEqual({
      requestedAt,
      baselineNoteIds: [],
      submitted: true,
      unresolved: true
    });
  });

  it('parses each shape of a marker stamped in the future as the stored read does', async () => {
    const requestedAt = Date.now() + 60_000;
    const unresolved: FaucetFundingMarker = { requestedAt, baselineNoteIds: [], submitted: true, unresolved: true };
    const shapes: Array<[object, FaucetFundingMarker | null]> = [
      [{ requestedAt, baselineNoteIds: [] }, null],
      [{ requestedAt, baselineNoteIds: [], submitted: true }, unresolved],
      [{ requestedAt, baselineNoteIds: [], unresolved: true }, unresolved],
      [{ requestedAt, baselineNoteIds: [], submitted: true, unresolved: true }, unresolved]
    ];

    for (const [stored, parsed] of shapes) {
      expect(parseFaucetFundingMarker(stored)).toEqual(parsed);
      await putToStorage('faucet_funding_v2:accountAhead', stored);
      expect(await fetchFaucetFundingMarker('accountAhead')).toEqual(parsed);
    }
  });

  it('refuses a request over a sent marker stamped in the future that does not name it', async () => {
    await setFaucetFundingMarker('accountClockSent', {
      requestedAt: Date.now() + 60_000,
      baselineNoteIds: [],
      submitted: true
    });
    mintFromMidenFaucetMock.mockResolvedValue({ txId: '0xtx', noteId: '0xnote' });

    const error = await faucet('accountClockSent', { requestedAt: Date.now(), baselineNoteIds: [] }).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(FaucetRequestUnresolvedError);
    expect(mintFromMidenFaucetMock).not.toHaveBeenCalled();
  });

  it('keeps when a flagged request went out, and ignores a send time it cannot trust', async () => {
    const submittedAt = Date.now() - 30_000;
    await setFaucetFundingMarker('accountSent', {
      requestedAt: 1_000,
      baselineNoteIds: [],
      submitted: true,
      submittedAt
    });
    expect(await fetchFaucetFundingMarker('accountSent')).toEqual({
      requestedAt: 1_000,
      baselineNoteIds: [],
      submitted: true,
      submittedAt
    });

    // A send time in the future (a forward clock step), before the request (a backward one) or
    // not a number falls back to the request time.
    for (const bad of [Date.now() + 60_000, 999, 'soon']) {
      await putToStorage('faucet_funding_v2:accountBadSend', {
        requestedAt: 1_000,
        baselineNoteIds: [],
        submitted: true,
        submittedAt: bad
      });
      expect(await fetchFaucetFundingMarker('accountBadSend')).toEqual({
        requestedAt: 1_000,
        baselineNoteIds: [],
        submitted: true
      });
    }
  });

  it.each<[string, { submitted?: true; age: number; sentAgo?: number }, boolean, boolean]>([
    ['a request still running here, whatever its age', { submitted: true, age: 4 * 60_000 }, true, true],
    ['an unsent request still running here, past its arrival window', { age: 4 * 60_000 }, true, true],
    [
      'a sent request whose window runs from its late send',
      { submitted: true, age: 5 * 60_000, sentAgo: 30_000 },
      false,
      true
    ],
    [
      'a sent request past its window from its send',
      { submitted: true, age: 5 * 60_000, sentAgo: 3 * 60_000 + 1 },
      false,
      false
    ]
  ])(
    'judges %s',
    (_case, { submitted, age, sentAgo }: { submitted?: true; age: number; sentAgo?: number }, runningHere, live) => {
      const now = Date.now();
      const marker = {
        requestedAt: now - age,
        baselineNoteIds: [],
        ...(submitted && { submitted }),
        ...(sentAgo !== undefined && { submittedAt: now - sentAgo })
      };
      expect(isFaucetFundingMarkerLive(marker, { runningHere, settledAt: null })).toBe(live);
    }
  );

  it('keeps the submitted flag, and reads a malformed one as submitted', async () => {
    await setFaucetFundingMarker('accountFlag', { requestedAt: 1_000, baselineNoteIds: [], submitted: true });
    expect(await fetchFaucetFundingMarker('accountFlag')).toEqual({
      requestedAt: 1_000,
      baselineNoteIds: [],
      submitted: true
    });

    // A garbled flag still means the request may have gone out; reading it as
    // absent would clear a marker for a mint that could still land.
    await putToStorage('faucet_funding_v2:accountGarbled', {
      requestedAt: 1_000,
      baselineNoteIds: [],
      submitted: 'x'
    });
    expect(await fetchFaucetFundingMarker('accountGarbled')).toEqual({
      requestedAt: 1_000,
      baselineNoteIds: [],
      submitted: true
    });
  });

  it('keeps the unresolved flag, and reads any stored value of it as unresolved', async () => {
    await setFaucetFundingMarker('accountUnresolved', {
      requestedAt: 1_000,
      baselineNoteIds: [],
      submitted: true,
      unresolved: true
    });
    expect(await fetchFaucetFundingMarker('accountUnresolved')).toEqual({
      requestedAt: 1_000,
      baselineNoteIds: [],
      submitted: true,
      unresolved: true
    });

    // Read as absent, a garbled flag would let a second surface send again without asking.
    await putToStorage('faucet_funding_v2:accountUnresolvedGarbled', {
      requestedAt: 1_000,
      baselineNoteIds: [],
      submitted: true,
      unresolved: 'yes'
    });
    expect(await fetchFaucetFundingMarker('accountUnresolvedGarbled')).toEqual({
      requestedAt: 1_000,
      baselineNoteIds: [],
      submitted: true,
      unresolved: true
    });
  });

  it('reads an unresolved marker as sent, even with no submitted flag stored', async () => {
    // Only a sent request can be left unresolved; read as unsent, it would be cleared as abandoned.
    await putToStorage('faucet_funding_v2:accountUnresolvedOnly', {
      requestedAt: 1_000,
      baselineNoteIds: [],
      unresolved: true
    });

    expect(await fetchFaucetFundingMarker('accountUnresolvedOnly')).toEqual({
      requestedAt: 1_000,
      baselineNoteIds: [],
      submitted: true,
      unresolved: true
    });
  });

  it('never reads an unresolved request as live, unless it still runs here', () => {
    const now = Date.now();
    // Sent 30 s ago, so its arrival window has not ended by this clock: the flag alone ends the wait.
    const marker: FaucetFundingMarker = {
      requestedAt: now - 60_000,
      baselineNoteIds: [],
      submitted: true,
      submittedAt: now - 30_000,
      unresolved: true
    };

    expect(isFaucetFundingMarkerLive(marker, { runningHere: false, settledAt: null })).toBe(false);
    expect(isFaucetFundingMarkerLive(marker, { runningHere: true, settledAt: null })).toBe(true);
  });

  it('stores the funding marker per account', async () => {
    await setFaucetFundingMarker('accountA', { requestedAt: 1_000, baselineNoteIds: ['note-1'] });

    expect(await fetchFaucetFundingMarker('accountA')).toEqual({ requestedAt: 1_000, baselineNoteIds: ['note-1'] });
    expect(await fetchFaucetFundingMarker('accountB')).toBeNull();

    await clearFaucetFundingMarker('accountA');
    expect(await fetchFaucetFundingMarker('accountA')).toBeNull();
  });

  it('removes the storage key when the marker is cleared, rather than writing null', async () => {
    const marker = { requestedAt: 1_000, baselineNoteIds: ['note-1'] };
    await setFaucetFundingMarker('accountClear', marker);

    await clearFaucetFundingMarker('accountClear');

    const provider = getStorageProvider();
    const stored = await provider.get(['faucet_funding_v2:accountClear']);
    expect('faucet_funding_v2:accountClear' in stored).toBe(false);
    expect(await fetchFaucetFundingMarker('accountClear')).toBeNull();
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

  it('keeps both changes when two surfaces write the record at the same moment (#937)', async () => {
    type Realm = {
      setStatus: typeof setWalletPromptStatus;
      provider: ReturnType<typeof getStorageProvider>;
    };
    const loadRealm = (): Realm => {
      let realm!: Realm;
      jest.isolateModules(() => {
        realm = {
          setStatus: require('./wallet-prompts').setWalletPromptStatus,
          provider: require('lib/platform/storage-adapter').getStorageProvider()
        };
      });
      return realm;
    };
    const popup = loadRealm();
    const sidePanel = loadRealm();
    // The popup reads the record and answers late: each surface queues only its own
    // writes, so without a shared turn the side panel's change lands in between.
    const readRecord = popup.provider.get.bind(popup.provider);
    let releaseRead = () => {};
    const get = jest.spyOn(popup.provider, 'get').mockImplementationOnce(keys => {
      const record = readRecord(keys);
      return new Promise(resolve => {
        releaseRead = () => resolve(record);
      });
    });
    try {
      const fromPopup = popup.setStatus(WalletPromptType.VerifySeedPhrase, WalletPromptStatus.Completed);
      // The popup holds the turn on a read that has not answered; the side panel's write queues.
      expect(get).toHaveBeenCalledTimes(1);
      const fromSidePanel = sidePanel.setStatus(WalletPromptType.Bridge, WalletPromptStatus.Dismissed);
      releaseRead();
      await fromPopup;
      await fromSidePanel;

      // Neither surface put back the other's field.
      expect((await fetchWalletPromptStorage()).prompts).toEqual({
        [WalletPromptType.VerifySeedPhrase]: WalletPromptStatus.Completed,
        [WalletPromptType.Bridge]: WalletPromptStatus.Dismissed
      });
    } finally {
      releaseRead();
      get.mockRestore();
    }
  });

  it('keeps a slow prompt write ahead of every later one, so it never lands over a newer change', async () => {
    jest.useFakeTimers();
    const provider = getStorageProvider();
    const realGet = provider.get.bind(provider);
    let release = () => {};
    const released = new Promise<void>(resolve => {
      release = resolve;
    });
    // The first read takes its copy of the record at once and answers only much later.
    const get = jest.spyOn(provider, 'get').mockImplementationOnce(async keys => {
      const snapshot = await realGet(keys);
      await released;
      return snapshot;
    });
    try {
      const slow = setWalletPromptStatus(WalletPromptType.Bridge, WalletPromptStatus.Pending);
      let seeded = false;
      const seed = seedWalletPrompt(WalletPromptType.VerifySeedPhrase).then(() => {
        seeded = true;
      });

      await jest.advanceTimersByTimeAsync(15_000);
      expect(seeded).toBe(false);

      release();
      await slow;
      await seed;
      const { prompts } = await fetchWalletPromptStorage();
      expect(prompts[WalletPromptType.Bridge]).toBe(WalletPromptStatus.Pending);
      expect(prompts[WalletPromptType.VerifySeedPhrase]).toBe(WalletPromptStatus.Pending);
    } finally {
      release();
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
    let releaseFirstWrite = () => {};
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
      releaseFirstWrite();
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
    // Released in `finally` too, so a held read cannot stall the shared queue for later tests.
    let releaseRead = () => {};
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
      releaseRead();
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

  it('logs, and lets nothing escape, when the reload after a failed write fails too', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { result } = renderHook(() => useWalletPromptStorage());
    await waitFor(() => expect(result.current.isLoaded).toBe(true));
    const provider = getStorageProvider();
    const readRecord = provider.get.bind(provider);
    const set = jest.spyOn(provider, 'set').mockRejectedValueOnce(new Error('storage unavailable'));
    // The write's own read works; the reload after it fails.
    const get = jest
      .spyOn(provider, 'get')
      .mockImplementationOnce(keys => readRecord(keys))
      .mockRejectedValueOnce(new Error('storage unreadable'));

    try {
      act(() => result.current.setFaucetStatus('accountA', WalletPromptStatus.Dismissed));
      await waitFor(() =>
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to reload'), expect.any(Error))
      );
    } finally {
      set.mockRestore();
      get.mockRestore();
      warn.mockRestore();
    }
  });

  it('answers the hook load from after a write this surface already issued (#937)', async () => {
    const provider = getStorageProvider();
    const writeRecord = provider.set.bind(provider);
    // Released in `finally` too, so a held call cannot stall the shared turn for later tests.
    let releaseWrite = () => {};
    const set = jest.spyOn(provider, 'set').mockImplementationOnce(
      items =>
        new Promise(resolve => {
          releaseWrite = () => resolve(writeRecord(items));
        })
    );

    try {
      const write = setWalletPromptStatus(WalletPromptType.VerifySeedPhrase, WalletPromptStatus.Completed);
      const { result } = renderHook(() => useWalletPromptStorage());
      await act(async () => {});

      // The load takes its turn behind that write, so it cannot answer from before it.
      expect(result.current.isLoaded).toBe(false);
      await act(async () => {
        releaseWrite();
        await write;
      });

      await waitFor(() =>
        expect(result.current.storage.prompts[WalletPromptType.VerifySeedPhrase]).toBe(WalletPromptStatus.Completed)
      );
    } finally {
      releaseWrite();
      set.mockRestore();
    }
  });

  it('does not let the first load take back a change made before it lands', async () => {
    const provider = getStorageProvider();
    const readRecord = provider.get.bind(provider);
    const writeRecord = provider.set.bind(provider);
    // Released in `finally` too, so a held call cannot stall the shared queue for later tests.
    let releaseLoad = () => {};
    let releaseWrite = () => {};
    const get = jest.spyOn(provider, 'get').mockImplementationOnce(keys => {
      const record = readRecord(keys);
      return new Promise(resolve => {
        releaseLoad = () => resolve(record);
      });
    });
    const set = jest.spyOn(provider, 'set').mockImplementationOnce(
      items =>
        new Promise(resolve => {
          releaseWrite = () => resolve(writeRecord(items));
        })
    );

    try {
      const { result } = renderHook(() => useWalletPromptStorage());
      await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
      act(() => result.current.setFaucetStatus('accountA', WalletPromptStatus.Dismissed));
      await act(async () => {
        releaseLoad();
      });
      await waitFor(() => expect(set).toHaveBeenCalledTimes(1));

      // The load read the record from before the change, whose write has not landed yet.
      expect(result.current.isLoaded).toBe(true);
      expect(result.current.storage.faucetByAccount).toEqual({ accountA: WalletPromptStatus.Dismissed });
    } finally {
      releaseLoad();
      releaseWrite();
      get.mockRestore();
      set.mockRestore();
    }
  });

  it('does not let a refresh take back a change made before it lands', async () => {
    const { result } = renderHook(() => useWalletPromptStorage());
    await waitFor(() => expect(result.current.isLoaded).toBe(true));
    const provider = getStorageProvider();
    const readRecord = provider.get.bind(provider);
    const writeRecord = provider.set.bind(provider);
    let releaseRefresh = () => {};
    let releaseWrite = () => {};
    const get = jest.spyOn(provider, 'get').mockImplementationOnce(keys => {
      const record = readRecord(keys);
      return new Promise(resolve => {
        releaseRefresh = () => resolve(record);
      });
    });
    const set = jest.spyOn(provider, 'set').mockImplementationOnce(
      items =>
        new Promise(resolve => {
          releaseWrite = () => resolve(writeRecord(items));
        })
    );

    try {
      let refresh: Promise<unknown> = Promise.resolve();
      act(() => {
        refresh = result.current.refreshPrompts();
      });
      await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
      act(() => result.current.setFaucetStatus('accountA', WalletPromptStatus.Dismissed));
      await act(async () => {
        releaseRefresh();
        await refresh;
      });
      await waitFor(() => expect(set).toHaveBeenCalledTimes(1));

      expect(result.current.storage.faucetByAccount).toEqual({ accountA: WalletPromptStatus.Dismissed });
    } finally {
      releaseRefresh();
      releaseWrite();
      get.mockRestore();
      set.mockRestore();
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
    completeVerifiedLanded.mockResolvedValue(undefined);
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
    findClaimableDeposit.mockResolvedValue({ tx_hash: '0xAAA1' });
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
    expect(updateClaimStatus).toHaveBeenCalledWith('agg-ready', 'ready', { depositReady: true }, '0xAAA1');
  });

  it('marks ready only the row whose OWN bridge-out produced the claimable deposit', async () => {
    // Two Slow bridge-outs to the same L1 address. The claim the user then makes
    // is stamped onto whichever row flipped to 'ready', so flipping both off one
    // deposit reports a bridge as claimed that was never claimed.
    // Deposit 41 belongs to row A. An unbound lookup (no origin hash) resolves it
    // too, so dropping the binding flips BOTH rows ready off this one deposit.
    findClaimableDeposit.mockImplementation(async (_dest: unknown, originTxHash: unknown) =>
      originTxHash === '0xrow-b-origin' ? null : { deposit_cnt: 41, tx_hash: '0xrow-a-origin' }
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
    expect(updateClaimStatus).toHaveBeenCalledWith('agg-a', 'ready', { depositReady: true }, '0xrow-a-origin');
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

  // Stored Epoch evidence settles a Failed row on its own, before this pass's
  // polls even run - it needs no fresh fill answer (#1250).
  it('promotes a Failed, non-restored Epoch bridge to Completed from its own stored evidence', async () => {
    completeVerifiedLanded.mockImplementation(async (id: string, otherValues: Partial<ITransaction> = {}) => {
      const target = bridgeRows.find(r => r.id === id);
      if (target) Object.assign(target, otherValues, { status: ITransactionStatus.Completed });
    });
    const landed = baseBridge({
      id: 'epoch-landed',
      status: ITransactionStatus.Failed,
      extraInputs: { provider: 'epoch', claimStatus: 'not-applicable', epochStatus: 'confirmed' }
    });
    bridgeRows.push(landed);

    await reconcileBridgedSends();

    expect(completeVerifiedLanded).toHaveBeenCalledWith('epoch-landed', expect.any(Object));
    expect(landed.status).toBe(ITransactionStatus.Completed);
  });

  it('leaves alone a restored row, an Epoch row whose evidence itself says failed, a Failed Agglayer claimed row, and a Completed row', async () => {
    bridgeRows.push(
      baseBridge({
        id: 'restored-epoch-confirmed',
        status: ITransactionStatus.Failed,
        restoredFromBackup: true,
        extraInputs: { provider: 'epoch', claimStatus: 'not-applicable', epochStatus: 'confirmed' }
      }),
      baseBridge({
        id: 'epoch-evidence-failed',
        status: ITransactionStatus.Failed,
        extraInputs: { provider: 'epoch', claimStatus: 'failed', epochStatus: 'failed' }
      }),
      baseBridge({
        id: 'agg-claimed-but-failed-row',
        status: ITransactionStatus.Failed,
        extraInputs: { provider: 'agglayer', claimStatus: 'claimed' }
      }),
      baseBridge({
        id: 'epoch-already-completed',
        status: ITransactionStatus.Completed,
        extraInputs: { provider: 'epoch', claimStatus: 'not-applicable', epochStatus: 'confirmed' }
      })
    );

    await reconcileBridgedSends();

    expect(completeVerifiedLanded).not.toHaveBeenCalled();
  });

  // A Failed row's own outcome can still be unknown (#1250): the rotation gate and
  // Activity History already call this "not confirmed" via `isUnconfirmedFailure`,
  // so the background poll settles it by the same bound evidence a Completed row
  // gets, rather than leaving it stuck until the user reopens the detail page.
  it('flips a Failed AggLayer bridge to ready once its OWN bound deposit is claimable', async () => {
    findClaimableDeposit.mockResolvedValue({ tx_hash: '0xABC' });
    const unconfirmed = baseBridge({
      id: 'agg-failed-unconfirmed',
      status: ITransactionStatus.Failed,
      mayHaveSubmitted: true,
      transactionId: '0xabc',
      initiatedAt: Math.floor(Date.now() / 1000) - 3600,
      extraInputs: { provider: 'agglayer', claimStatus: 'pending', destinationAddress: '0xdest' }
    });

    bridgeRows.push(unconfirmed);
    await reconcileBridgedSends();

    expect(findClaimableDeposit).toHaveBeenCalledWith('0xdest', '0xabc');
    expect(updateClaimStatus).toHaveBeenCalledWith('agg-failed-unconfirmed', 'ready', { depositReady: true }, '0xABC');
  });

  // An unbound lookup on a Failed row could claim a sibling deposit for a bridge that
  // never even landed - the same reason `findClaimableMidenToEvmDeposit` binds by
  // `originTxHash` in the first place - so a Failed row with no transaction id is left
  // alone rather than guessed at.
  it('never looks up a claimable deposit for a Failed AggLayer bridge with no transaction id', async () => {
    const unconfirmed = baseBridge({
      id: 'agg-failed-no-txid',
      status: ITransactionStatus.Failed,
      mayHaveSubmitted: true,
      initiatedAt: Math.floor(Date.now() / 1000) - 3600,
      extraInputs: { provider: 'agglayer', claimStatus: 'pending', destinationAddress: '0xdest' }
    });

    bridgeRows.push(unconfirmed);
    await reconcileBridgedSends();

    expect(findClaimableDeposit).not.toHaveBeenCalled();
    expect(updateClaimStatus).not.toHaveBeenCalled();
  });

  it('polls the Epoch fill for a Failed row whose outcome is unconfirmed, keyed by its own intent nonce', async () => {
    pollEpochIntentFill.mockResolvedValue({ status: 'confirmed', fillTxHash: '0xfill', fillChainId: 8453 });
    const unconfirmed = baseBridge({
      id: 'epoch-failed-unconfirmed',
      status: ITransactionStatus.Failed,
      mayHaveSubmitted: true,
      initiatedAt: Math.floor(Date.now() / 1000) - 3600,
      extraInputs: {
        provider: 'epoch',
        epochStatus: 'pending',
        intentNonce: 'n-unconfirmed',
        destinationAddress: '0xdest'
      }
    });

    bridgeRows.push(unconfirmed);
    await reconcileBridgedSends();

    expect(pollEpochIntentFill).toHaveBeenCalledWith({ destinationAddress: '0xdest', intentNonce: 'n-unconfirmed' });
    expect(updateClaimStatus).toHaveBeenCalledWith('epoch-failed-unconfirmed', 'not-applicable', {
      epochStatus: 'confirmed',
      fillTxHash: '0xfill',
      fillChainId: 8453
    });
  });

  // `isUnconfirmedFailure` is false with none of its own qualifying evidence - an
  // ordinary error and no `mayHaveSubmitted` reads as a definite failure, the same
  // as today, so the row is skipped rather than resurfacing a poll for good.
  it('never polls a Failed row whose failure is definite', async () => {
    const definite = baseBridge({
      id: 'agg-failed-definite',
      status: ITransactionStatus.Failed,
      error: 'Some ordinary rejection',
      transactionId: '0xabc',
      initiatedAt: Math.floor(Date.now() / 1000) - 3600,
      extraInputs: { provider: 'agglayer', claimStatus: 'pending', destinationAddress: '0xdest' }
    });

    bridgeRows.push(definite);
    await reconcileBridgedSends();

    expect(findClaimableDeposit).not.toHaveBeenCalled();
    expect(updateClaimStatus).not.toHaveBeenCalled();
  });

  // A background poll of a row whose landing is unknown cannot rely on an answer ever
  // arriving, the way a Completed row can - so it has a terminal condition. Past it, the
  // row is left to the detail page's own on-demand tracker and fill poll (#1250).
  it('excludes a Failed AggLayer bridge whose 24-hour unconfirmed window has elapsed, but still polls one inside it', async () => {
    findClaimableDeposit.mockResolvedValue({ tx_hash: '0xABC' });
    const stale = baseBridge({
      id: 'agg-failed-stale',
      status: ITransactionStatus.Failed,
      mayHaveSubmitted: true,
      transactionId: '0xstale',
      initiatedAt: Math.floor(Date.now() / 1000) - 25 * 60 * 60,
      extraInputs: { provider: 'agglayer', claimStatus: 'pending', destinationAddress: '0xdest' }
    });
    const fresh = baseBridge({
      id: 'agg-failed-fresh',
      status: ITransactionStatus.Failed,
      mayHaveSubmitted: true,
      transactionId: '0xfresh',
      initiatedAt: Math.floor(Date.now() / 1000) - 60 * 60,
      extraInputs: { provider: 'agglayer', claimStatus: 'pending', destinationAddress: '0xdest' }
    });

    bridgeRows.push(stale, fresh);
    await reconcileBridgedSends();

    expect(findClaimableDeposit).not.toHaveBeenCalledWith('0xdest', '0xstale');
    expect(findClaimableDeposit).toHaveBeenCalledWith('0xdest', '0xfresh');
  });

  it('does not fill-poll a Failed Epoch row whose 24-hour unconfirmed window has elapsed, but still polls one inside it', async () => {
    pollEpochIntentFill.mockResolvedValue({ status: 'pending', fillTxHash: undefined });
    const stale = baseBridge({
      id: 'epoch-failed-stale',
      status: ITransactionStatus.Failed,
      mayHaveSubmitted: true,
      initiatedAt: Math.floor(Date.now() / 1000) - 25 * 60 * 60,
      extraInputs: {
        provider: 'epoch',
        epochStatus: 'pending',
        intentNonce: 'n-stale',
        destinationAddress: '0xdest'
      }
    });
    const fresh = baseBridge({
      id: 'epoch-failed-fresh',
      status: ITransactionStatus.Failed,
      mayHaveSubmitted: true,
      initiatedAt: Math.floor(Date.now() / 1000) - 60 * 60,
      extraInputs: {
        provider: 'epoch',
        epochStatus: 'pending',
        intentNonce: 'n-fresh',
        destinationAddress: '0xdest'
      }
    });

    bridgeRows.push(stale, fresh);
    await reconcileBridgedSends();

    expect(pollEpochIntentFill).not.toHaveBeenCalledWith({ destinationAddress: '0xdest', intentNonce: 'n-stale' });
    expect(pollEpochIntentFill).toHaveBeenCalledWith({ destinationAddress: '0xdest', intentNonce: 'n-fresh' });
  });

  // A Completed row is polled as today, with no window - only an unconfirmed Failed
  // row's outcome can be left unresolved forever the way a landed one cannot.
  it('still polls a Completed row 25 hours old, since the window applies only to an unconfirmed Failed row', async () => {
    pollEpochIntentFill.mockResolvedValue({ status: 'pending', fillTxHash: undefined });
    const oldCompleted = baseBridge({
      id: 'epoch-completed-old',
      status: ITransactionStatus.Completed,
      initiatedAt: Math.floor(Date.now() / 1000) - 25 * 60 * 60,
      extraInputs: {
        provider: 'epoch',
        epochStatus: 'pending',
        intentNonce: 'n-completed-old',
        destinationAddress: '0xdest'
      }
    });

    bridgeRows.push(oldCompleted);
    await reconcileBridgedSends();

    expect(pollEpochIntentFill).toHaveBeenCalledWith({ destinationAddress: '0xdest', intentNonce: 'n-completed-old' });
  });

  // F-049: the window's age comes from the row's own failure stamp - `completedAt`
  // when `cancelTransaction` wrote one, `initiatedAt` otherwise - not from
  // `initiatedAt` alone, so a row initiated long ago that only just failed is not
  // excluded before its own 24-hour window has even started.
  it('looks up a Failed-unconfirmed Agglayer row by its completedAt, not its far-older initiatedAt, and fill-polls the same shape for Epoch', async () => {
    findClaimableDeposit.mockResolvedValue({ tx_hash: '0xrecent' });
    pollEpochIntentFill.mockResolvedValue({ status: 'pending', fillTxHash: undefined });
    const now = Math.floor(Date.now() / 1000);
    const aggRecentFailure = baseBridge({
      id: 'agg-recent-failure',
      status: ITransactionStatus.Failed,
      mayHaveSubmitted: true,
      transactionId: '0xrecent',
      initiatedAt: now - 48 * 60 * 60,
      completedAt: now - 60 * 60,
      extraInputs: { provider: 'agglayer', claimStatus: 'pending', destinationAddress: '0xdest' }
    });
    const epochRecentFailure = baseBridge({
      id: 'epoch-recent-failure',
      status: ITransactionStatus.Failed,
      mayHaveSubmitted: true,
      initiatedAt: now - 48 * 60 * 60,
      completedAt: now - 60 * 60,
      extraInputs: {
        provider: 'epoch',
        epochStatus: 'pending',
        intentNonce: 'n-recent-failure',
        destinationAddress: '0xdest'
      }
    });

    bridgeRows.push(aggRecentFailure, epochRecentFailure);
    await reconcileBridgedSends();

    expect(findClaimableDeposit).toHaveBeenCalledWith('0xdest', '0xrecent');
    expect(pollEpochIntentFill).toHaveBeenCalledWith({ destinationAddress: '0xdest', intentNonce: 'n-recent-failure' });
  });

  // Same shape, but the failure stamp itself is already 25 hours old, so the window
  // has elapsed regardless of how long ago the transaction was initiated. Passes
  // today too, since the far-older initiatedAt already excludes it.
  it('still excludes a Failed-unconfirmed row whose own completedAt is 25 hours old', async () => {
    const now = Math.floor(Date.now() / 1000);
    const aggStaleFailure = baseBridge({
      id: 'agg-stale-completedat',
      status: ITransactionStatus.Failed,
      mayHaveSubmitted: true,
      transactionId: '0xstale2',
      initiatedAt: now - 48 * 60 * 60,
      completedAt: now - 25 * 60 * 60,
      extraInputs: { provider: 'agglayer', claimStatus: 'pending', destinationAddress: '0xdest' }
    });
    const epochStaleFailure = baseBridge({
      id: 'epoch-stale-completedat',
      status: ITransactionStatus.Failed,
      mayHaveSubmitted: true,
      initiatedAt: now - 48 * 60 * 60,
      completedAt: now - 25 * 60 * 60,
      extraInputs: {
        provider: 'epoch',
        epochStatus: 'pending',
        intentNonce: 'n-stale-completedat',
        destinationAddress: '0xdest'
      }
    });

    bridgeRows.push(aggStaleFailure, epochStaleFailure);
    await reconcileBridgedSends();

    expect(findClaimableDeposit).not.toHaveBeenCalledWith('0xdest', '0xstale2');
    expect(pollEpochIntentFill).not.toHaveBeenCalledWith({
      destinationAddress: '0xdest',
      intentNonce: 'n-stale-completedat'
    });
  });

  // F-050: a stamp ahead of the clock (a clock stepped back, or a stamp written while
  // the clock ran fast) is untrusted, the way the faucet marker's stampedAhead already
  // is in this file - it pauses the background poll until the clock reaches it, rather
  // than reading as already elapsed. The stamp here is only an hour ahead, well inside
  // the window's own magnitude, so only the sign rule excludes it.
  it('pauses the background poll for a Failed-unconfirmed row whose completedAt is ahead of the clock', async () => {
    const now = Math.floor(Date.now() / 1000);
    const aggFutureFailure = baseBridge({
      id: 'agg-future-failure',
      status: ITransactionStatus.Failed,
      mayHaveSubmitted: true,
      transactionId: '0xfuture',
      initiatedAt: now - 60 * 60,
      completedAt: now + 60 * 60,
      extraInputs: { provider: 'agglayer', claimStatus: 'pending', destinationAddress: '0xdest' }
    });
    const epochFutureFailure = baseBridge({
      id: 'epoch-future-failure',
      status: ITransactionStatus.Failed,
      mayHaveSubmitted: true,
      initiatedAt: now - 60 * 60,
      completedAt: now + 60 * 60,
      extraInputs: {
        provider: 'epoch',
        epochStatus: 'pending',
        intentNonce: 'n-future-failure',
        destinationAddress: '0xdest'
      }
    });

    bridgeRows.push(aggFutureFailure, epochFutureFailure);
    await reconcileBridgedSends();

    expect(findClaimableDeposit).not.toHaveBeenCalledWith('0xdest', '0xfuture');
    expect(pollEpochIntentFill).not.toHaveBeenCalledWith({
      destinationAddress: '0xdest',
      intentNonce: 'n-future-failure'
    });
  });

  // F-053: the same guard is symmetric with time - once the clock reaches the stamp
  // it once was ahead of, the row reads as within the window again and the poll
  // resumes on its own, with no separate unpause step.
  it('resumes the background poll once the clock passes a stamp that was ahead of it', async () => {
    const now = Math.floor(Date.now() / 1000);
    const aggFutureFailure = baseBridge({
      id: 'agg-future-failure',
      status: ITransactionStatus.Failed,
      mayHaveSubmitted: true,
      transactionId: '0xfuture',
      initiatedAt: now - 60 * 60,
      completedAt: now + 60 * 60,
      extraInputs: { provider: 'agglayer', claimStatus: 'pending', destinationAddress: '0xdest' }
    });
    const epochFutureFailure = baseBridge({
      id: 'epoch-future-failure',
      status: ITransactionStatus.Failed,
      mayHaveSubmitted: true,
      initiatedAt: now - 60 * 60,
      completedAt: now + 60 * 60,
      extraInputs: {
        provider: 'epoch',
        epochStatus: 'pending',
        intentNonce: 'n-future-failure',
        destinationAddress: '0xdest'
      }
    });

    bridgeRows.push(aggFutureFailure, epochFutureFailure);
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue((now + 2 * 60 * 60) * 1000);
    try {
      await reconcileBridgedSends();

      expect(findClaimableDeposit).toHaveBeenCalledWith('0xdest', '0xfuture');
      expect(pollEpochIntentFill).toHaveBeenCalledWith({
        destinationAddress: '0xdest',
        intentNonce: 'n-future-failure'
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  // F-051: the future-stamp check sits inside the failedUnconfirmed expression only,
  // so a Completed row keeps its unwindowed poll whatever its own completedAt says.
  it('still polls a Completed row whose completedAt is ahead of the clock', async () => {
    findClaimableDeposit.mockResolvedValue({ tx_hash: '0xstillpolled' });
    pollEpochIntentFill.mockResolvedValue({ status: 'pending', fillTxHash: undefined });
    const now = Math.floor(Date.now() / 1000);
    const aggCompletedFuture = baseBridge({
      id: 'agg-completed-future',
      status: ITransactionStatus.Completed,
      completedAt: now + 25 * 60 * 60,
      extraInputs: { provider: 'agglayer', claimStatus: 'pending', destinationAddress: '0xdest' }
    });
    const epochCompletedFuture = baseBridge({
      id: 'epoch-completed-future',
      status: ITransactionStatus.Completed,
      completedAt: now + 25 * 60 * 60,
      extraInputs: {
        provider: 'epoch',
        epochStatus: 'pending',
        intentNonce: 'n-completed-future',
        destinationAddress: '0xdest'
      }
    });

    bridgeRows.push(aggCompletedFuture, epochCompletedFuture);
    await reconcileBridgedSends();

    expect(findClaimableDeposit).toHaveBeenCalledWith('0xdest', undefined);
    expect(pollEpochIntentFill).toHaveBeenCalledWith({
      destinationAddress: '0xdest',
      intentNonce: 'n-completed-future'
    });
  });

  // F-047: `extraInputs` is read defensively, the same way the promotion filter already
  // reads it, so an in-window Failed-unconfirmed row that somehow carries none does not
  // throw out of the per-row catch as a warning.
  it('does not warn when an in-window Failed-unconfirmed bridged-send has no extraInputs', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const noExtraInputs = baseBridge({
      id: 'agg-failed-no-extra-inputs',
      status: ITransactionStatus.Failed,
      mayHaveSubmitted: true,
      initiatedAt: Math.floor(Date.now() / 1000) - 60 * 60,
      extraInputs: undefined
    });

    bridgeRows.push(noExtraInputs);
    await reconcileBridgedSends();

    expect(warn).not.toHaveBeenCalledWith(
      '[wallet-prompts] bridged-send poll failed',
      'agg-failed-no-extra-inputs',
      expect.any(Error)
    );
    warn.mockRestore();
  });

  // One row's rejecting promotion must not stop the pass for the others, the same
  // rule the polling pass already keeps (#1250).
  it('keeps promoting and polling other rows when one stored-evidence promotion rejects, and names the failing row', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    completeVerifiedLanded.mockRejectedValueOnce(new Error('write conflict'));
    pollEpochIntentFill.mockResolvedValue({ status: 'pending', fillTxHash: undefined });
    const rejectingPromotion = baseBridge({
      id: 'epoch-landed-rejects',
      status: ITransactionStatus.Failed,
      extraInputs: { provider: 'epoch', claimStatus: 'not-applicable', epochStatus: 'confirmed' }
    });
    const stillPolled = baseBridge({
      id: 'epoch-completed-pending',
      status: ITransactionStatus.Completed,
      extraInputs: {
        provider: 'epoch',
        epochStatus: 'pending',
        intentNonce: 'n-still-polled',
        destinationAddress: '0xdest'
      }
    });

    bridgeRows.push(rejectingPromotion, stillPolled);

    await expect(reconcileBridgedSends()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      '[wallet-prompts] bridged-send landing failed',
      'epoch-landed-rejects',
      expect.any(Error)
    );
    expect(pollEpochIntentFill).toHaveBeenCalledWith({ destinationAddress: '0xdest', intentNonce: 'n-still-polled' });
    warn.mockRestore();
  });

  // The stored-evidence promotion filter reads a Failed row's `extraInputs` the same
  // defensive way `isBridgeRouteFailedRow` already does - `undefined` is excluded,
  // never dereferenced - so a row with none never crashes the filter itself, which
  // runs synchronously ahead of the pass's own per-row catch.
  it('excludes a Failed bridged-send row with no extraInputs from the promotion filter, and does not reject', async () => {
    pollEpochIntentFill.mockResolvedValue({ status: 'pending', fillTxHash: undefined });
    const noExtraInputs = baseBridge({
      id: 'epoch-no-extra-inputs',
      status: ITransactionStatus.Failed,
      extraInputs: undefined
    });
    const stillPolled = baseBridge({
      id: 'epoch-completed-pending-2',
      status: ITransactionStatus.Completed,
      extraInputs: {
        provider: 'epoch',
        epochStatus: 'pending',
        intentNonce: 'n-still-polled-2',
        destinationAddress: '0xdest'
      }
    });

    bridgeRows.push(noExtraInputs, stillPolled);

    await expect(reconcileBridgedSends()).resolves.toBeUndefined();

    expect(completeVerifiedLanded).not.toHaveBeenCalled();
    expect(pollEpochIntentFill).toHaveBeenCalledWith({ destinationAddress: '0xdest', intentNonce: 'n-still-polled-2' });
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

  it('re-arms for a failure reported while a completion of the prompt is still being stored', async () => {
    await setWalletPromptStatus(WalletPromptType.HotKeyRotationNeeded, WalletPromptStatus.Pending);
    const provider = getStorageProvider();
    const writeRecord = provider.set.bind(provider);
    let releaseCompletion = () => {};
    const set = jest.spyOn(provider, 'set').mockImplementationOnce(
      items =>
        new Promise(resolve => {
          releaseCompletion = () => resolve(writeRecord(items));
        })
    );
    try {
      const completion = completeWalletPrompt(WalletPromptType.HotKeyRotationNeeded);
      await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
      // A new failure after the rotation that completed the prompt: a new incident.
      const report = reportHotKeyRotationNeeded();
      releaseCompletion();
      await completion;
      await report;

      const storage = await fetchWalletPromptStorage();
      expect(storage.prompts[WalletPromptType.HotKeyRotationNeeded]).toBe(WalletPromptStatus.Pending);
    } finally {
      releaseCompletion();
      set.mockRestore();
    }
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

describe('without Web Locks (iOS 15.0-15.3)', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
    mintFromMidenFaucetMock.mockReset();
    __resetInFlightFaucetRequestsForTest();
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  });

  it('loads the prompt record in the hook and stores a dismissal', async () => {
    await seedWalletPrompt(WalletPromptType.VerifySeedPhrase);
    const { result } = renderHook(() => useWalletPromptStorage());
    await waitFor(() => expect(result.current.isLoaded).toBe(true));
    expect(result.current.isPromptPending(WalletPromptType.VerifySeedPhrase)).toBe(true);

    act(() => {
      result.current.dismissPrompt(WalletPromptType.VerifySeedPhrase);
    });

    await waitFor(async () => {
      expect((await fetchWalletPromptStorage()).prompts[WalletPromptType.VerifySeedPhrase]).toBe(
        WalletPromptStatus.Dismissed
      );
    });
  });

  it('funds an account, flagging its marker submitted before the token request goes out', async () => {
    const marker = { requestedAt: Date.now(), baselineNoteIds: [] };
    mintFromMidenFaucetMock.mockImplementation(
      async (_address: string, _amount: bigint, _signal?: AbortSignal, beforeSubmit?: () => Promise<void>) => {
        await beforeSubmit?.();
        return { txId: '0xtx', noteId: '0xnote' };
      }
    );

    await faucet('accountA', marker);

    expect(mintFromMidenFaucetMock).toHaveBeenCalledTimes(1);
    expect(await fetchFaucetFundingMarker('accountA')).toEqual({
      ...marker,
      submitted: true,
      submittedAt: expect.any(Number)
    });
  });
});
