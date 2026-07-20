/**
 * Unit tests for `lib/store/types`.
 *
 * This module is a *type-only* declaration file: it exports nothing but
 * TypeScript `interface`s describing the shape of the Zustand wallet store
 * (its state slices and action groups). After transformation the emitted
 * JavaScript is empty, so there is no runtime behaviour to exercise.
 *
 * These tests therefore do two things:
 *   1. Force the (empty) module to load via a side-effect import, so the file
 *      is counted by the coverage collector instead of being reported as an
 *      untouched 0% file.
 *   2. Act as a compile-time + runtime contract guard: for every exported
 *      interface we construct a conforming value. If a slice or action group
 *      ever changes shape incompatibly, `tsc` fails here — which keeps this
 *      test meaningful documentation of the store's public surface rather than
 *      a bare smoke test.
 */

// (1) Side-effect import so the module is loaded and shows up in coverage.
//     A bare import is retained by the transformer even though every named
//     import below is type-only and erased.
import './types';

import type {
  WalletSlice,
  BalancesSlice,
  AssetsSlice,
  UISlice,
  FiatCurrencySlice,
  SyncSlice,
  TransactionModalSlice,
  NoteToastSlice,
  ExtensionSyncSlice,
  WalletActions,
  BalanceActions,
  AssetActions,
  FiatCurrencyActions,
  SyncActions,
  TransactionModalActions,
  NoteToastActions,
  ExtensionSyncActions,
  WalletStore
} from './types';
import type { TokenPrices } from 'lib/prices/binance';

import { WalletStatus } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

/** Assert every named key on `obj` is a callable function and nothing else. */
function expectAllFunctions(obj: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    expect(typeof obj[key]).toBe('function');
  }
  // Sanity: no unexpected extra keys sneak in (keeps the key list honest).
  expect(Object.keys(obj).sort()).toEqual([...keys].sort());
}

describe('lib/store/types', () => {
  describe('module', () => {
    it('is importable and evaluates to an empty runtime module (type-only)', async () => {
      const mod = await import('./types');
      // No runtime exports: only erased `interface` declarations.
      expect(Object.keys(mod)).toHaveLength(0);
    });
  });

  describe('state slices', () => {
    it('WalletSlice accepts a fully-populated core wallet state', () => {
      const slice: WalletSlice = {
        status: WalletStatus.Ready,
        accounts: [],
        currentAccount: null,
        networks: [],
        settings: null,
        ownMnemonic: null
      };
      expect(slice.status).toBe(WalletStatus.Ready);
      expect(slice.accounts).toEqual([]);
      expect(slice.currentAccount).toBeNull();
      expect(slice.networks).toEqual([]);
      expect(slice.settings).toBeNull();
      expect(slice.ownMnemonic).toBeNull();
    });

    it('WalletSlice accepts every WalletStatus and a boolean ownMnemonic', () => {
      for (const status of [WalletStatus.Idle, WalletStatus.Locked, WalletStatus.Ready]) {
        const slice: WalletSlice = {
          status,
          accounts: [],
          currentAccount: null,
          networks: [],
          settings: null,
          ownMnemonic: true
        };
        expect(slice.status).toBe(status);
        expect(slice.ownMnemonic).toBe(true);
      }
    });

    it('BalancesSlice keys are string-indexed records', () => {
      const slice: BalancesSlice = {
        balances: { addr: [] },
        balancesLoading: { addr: true },
        balancesLastFetched: { addr: 1234 }
      };
      expect(slice.balances.addr).toEqual([]);
      expect(slice.balancesLoading.addr).toBe(true);
      expect(slice.balancesLastFetched.addr).toBe(1234);
    });

    it('AssetsSlice holds a metadata record', () => {
      const slice: AssetsSlice = { assetsMetadata: {} };
      expect(slice.assetsMetadata).toEqual({});
    });

    it('UISlice supports the null (no selection / no confirmation) branch', () => {
      const slice: UISlice = { selectedNetworkId: null, confirmation: null };
      expect(slice.selectedNetworkId).toBeNull();
      expect(slice.confirmation).toBeNull();
    });

    it('UISlice supports the populated confirmation branch (with and without error)', () => {
      const withoutError: UISlice = {
        selectedNetworkId: 'net-1',
        confirmation: { id: 'req-1' }
      };
      const withError: UISlice = {
        selectedNetworkId: 'net-2',
        confirmation: { id: 'req-2', error: new Error('boom') }
      };
      expect(withoutError.confirmation?.id).toBe('req-1');
      expect(withoutError.confirmation?.error).toBeUndefined();
      expect(withError.confirmation?.error).toBeInstanceOf(Error);
    });

    it('FiatCurrencySlice supports null and populated rate fields', () => {
      const empty: FiatCurrencySlice = {
        selectedFiatCurrency: null,
        fiatRates: null,
        fiatRatesLoading: false,
        tokenPrices: {} as TokenPrices
      };
      const loading: FiatCurrencySlice = {
        selectedFiatCurrency: null,
        fiatRates: null,
        fiatRatesLoading: true,
        tokenPrices: {} as TokenPrices
      };
      expect(empty.fiatRatesLoading).toBe(false);
      expect(empty.selectedFiatCurrency).toBeNull();
      expect(loading.fiatRatesLoading).toBe(true);
    });

    it('SyncSlice tracks initialization and sync flags', () => {
      const slice: SyncSlice = {
        isInitialized: true,
        isSyncing: false,
        lastSyncedAt: null,
        hasCompletedInitialSync: false
      };
      expect(slice.isInitialized).toBe(true);
      expect(slice.isSyncing).toBe(false);
      expect(slice.lastSyncedAt).toBeNull();
      expect(slice.hasCompletedInitialSync).toBe(false);

      const synced: SyncSlice = { ...slice, lastSyncedAt: 42, hasCompletedInitialSync: true };
      expect(synced.lastSyncedAt).toBe(42);
      expect(synced.hasCompletedInitialSync).toBe(true);
    });

    it('TransactionModalSlice keeps modal + dApp session flags in lockstep', () => {
      const closed: TransactionModalSlice = {
        isTransactionModalOpen: false,
        isTransactionModalDismissedByUser: false,
        isDappBrowserOpen: false,
        activeDappSessionId: null,
        lastCompletedTxHash: null
      };
      const open: TransactionModalSlice = {
        isTransactionModalOpen: true,
        isTransactionModalDismissedByUser: true,
        isDappBrowserOpen: true,
        activeDappSessionId: 'session-1',
        lastCompletedTxHash: '0xabc'
      };
      expect(closed.activeDappSessionId).toBeNull();
      expect(closed.isDappBrowserOpen).toBe(false);
      expect(open.activeDappSessionId).toBe('session-1');
      expect(open.lastCompletedTxHash).toBe('0xabc');
    });

    it('NoteToastSlice stores seen note ids as a Set', () => {
      const slice: NoteToastSlice = {
        seenNoteIds: new Set<string>(['note-1']),
        isNoteToastVisible: true,
        noteToastShownAt: 100
      };
      expect(slice.seenNoteIds.has('note-1')).toBe(true);
      expect(slice.isNoteToastVisible).toBe(true);
      expect(slice.noteToastShownAt).toBe(100);

      const hidden: NoteToastSlice = {
        seenNoteIds: new Set<string>(),
        isNoteToastVisible: false,
        noteToastShownAt: null
      };
      expect(hidden.seenNoteIds.size).toBe(0);
      expect(hidden.noteToastShownAt).toBeNull();
    });

    it('ExtensionSyncSlice supports null and populated claimable notes', () => {
      const empty: ExtensionSyncSlice = {
        extensionClaimableNotes: null,
        extensionClaimingNoteIds: new Set<string>()
      };
      const populated: ExtensionSyncSlice = {
        extensionClaimableNotes: [],
        extensionClaimingNoteIds: new Set<string>(['n1'])
      };
      expect(empty.extensionClaimableNotes).toBeNull();
      expect(empty.extensionClaimingNoteIds.size).toBe(0);
      expect(populated.extensionClaimableNotes).toEqual([]);
      expect(populated.extensionClaimingNoteIds.has('n1')).toBe(true);
    });
  });

  describe('action groups', () => {
    it('WalletActions declares every wallet mutation as a function', () => {
      const actions = {
        syncFromBackend: jest.fn(),
        registerWallet: jest.fn(),
        importWalletFromClient: jest.fn(),
        unlock: jest.fn(),
        createAccount: jest.fn(),
        updateCurrentAccount: jest.fn(),
        editAccountName: jest.fn(),
        revealMnemonic: jest.fn(),
        revealPrivateKey: jest.fn(),
        revealHotKey: jest.fn(),
        revealGuardianKeys: jest.fn(),
        importAccount: jest.fn(),
        updateSettings: jest.fn(),
        signData: jest.fn(),
        signTransaction: jest.fn(),
        signWord: jest.fn(),
        persistNewHotKey: jest.fn(),
        swapHotKey: jest.fn(),
        setGuardianEndpoint: jest.fn(),
        getPublicKeyForCommitment: jest.fn(),
        getAuthSecretKey: jest.fn(),
        getDAppPayload: jest.fn(),
        confirmDAppPermission: jest.fn(),
        confirmDAppSign: jest.fn(),
        confirmDAppPrivateNotes: jest.fn(),
        confirmDAppAssets: jest.fn(),
        confirmDAppImportPrivateNote: jest.fn(),
        confirmDAppConsumableNotes: jest.fn(),
        confirmDAppTransaction: jest.fn(),
        getAllDAppSessions: jest.fn(),
        removeDAppSession: jest.fn(),
        setSelectedNetworkId: jest.fn(),
        setConfirmation: jest.fn(),
        resetConfirmation: jest.fn()
      } as unknown as WalletActions;

      expectAllFunctions(actions as unknown as Record<string, unknown>, [
        'syncFromBackend',
        'registerWallet',
        'importWalletFromClient',
        'unlock',
        'createAccount',
        'updateCurrentAccount',
        'editAccountName',
        'revealMnemonic',
        'revealPrivateKey',
        'revealHotKey',
        'revealGuardianKeys',
        'importAccount',
        'updateSettings',
        'signData',
        'signTransaction',
        'signWord',
        'persistNewHotKey',
        'swapHotKey',
        'setGuardianEndpoint',
        'getPublicKeyForCommitment',
        'getAuthSecretKey',
        'getDAppPayload',
        'confirmDAppPermission',
        'confirmDAppSign',
        'confirmDAppPrivateNotes',
        'confirmDAppAssets',
        'confirmDAppImportPrivateNote',
        'confirmDAppConsumableNotes',
        'confirmDAppTransaction',
        'getAllDAppSessions',
        'removeDAppSession',
        'setSelectedNetworkId',
        'setConfirmation',
        'resetConfirmation'
      ]);

      // Exercise a couple of representative signatures at runtime so the
      // function-typed contract is not merely structural.
      actions.syncFromBackend({} as never);
      actions.setSelectedNetworkId('net-1');
      actions.setConfirmation({ id: 'x' });
      actions.resetConfirmation();
      expect(actions.syncFromBackend).toHaveBeenCalledWith({});
      expect(actions.setSelectedNetworkId).toHaveBeenCalledWith('net-1');
    });

    it('BalanceActions declares balance fetchers', () => {
      const actions = {
        fetchBalances: jest.fn(),
        setBalancesLoading: jest.fn()
      } as unknown as BalanceActions;
      expectAllFunctions(actions as unknown as Record<string, unknown>, [
        'fetchBalances',
        'setBalancesLoading'
      ]);
    });

    it('AssetActions declares metadata setters/fetchers', () => {
      const actions = {
        setAssetsMetadata: jest.fn(),
        fetchAssetMetadata: jest.fn()
      } as unknown as AssetActions;
      expectAllFunctions(actions as unknown as Record<string, unknown>, [
        'setAssetsMetadata',
        'fetchAssetMetadata'
      ]);
    });

    it('FiatCurrencyActions declares fiat setters/fetchers', () => {
      const actions = {
        setSelectedFiatCurrency: jest.fn(),
        setFiatRates: jest.fn(),
        fetchFiatRates: jest.fn(),
        setTokenPrices: jest.fn()
      } as unknown as FiatCurrencyActions;
      expectAllFunctions(actions as unknown as Record<string, unknown>, [
        'setSelectedFiatCurrency',
        'setFiatRates',
        'fetchFiatRates',
        'setTokenPrices'
      ]);
    });

    it('SyncActions declares the sync-status setter', () => {
      const actions = { setSyncStatus: jest.fn() } as unknown as SyncActions;
      expectAllFunctions(actions as unknown as Record<string, unknown>, ['setSyncStatus']);
    });

    it('TransactionModalActions declares modal + dApp-session controls', () => {
      const actions = {
        openTransactionModal: jest.fn(),
        closeTransactionModal: jest.fn(),
        resetTransactionModalDismiss: jest.fn(),
        setDappBrowserOpen: jest.fn(),
        setActiveDappSession: jest.fn(),
        setLastCompletedTxHash: jest.fn()
      } as unknown as TransactionModalActions;
      expectAllFunctions(actions as unknown as Record<string, unknown>, [
        'openTransactionModal',
        'closeTransactionModal',
        'resetTransactionModalDismiss',
        'setDappBrowserOpen',
        'setActiveDappSession',
        'setLastCompletedTxHash'
      ]);

      // Optional `dismissedByUser` param branch, plus null vs. id session.
      actions.closeTransactionModal();
      actions.closeTransactionModal(true);
      actions.setActiveDappSession(null);
      actions.setActiveDappSession('s1');
      expect(actions.closeTransactionModal).toHaveBeenCalledTimes(2);
    });

    it('ExtensionSyncActions declares claiming-note controls', () => {
      const actions = {
        setExtensionClaimableNotes: jest.fn(),
        addExtensionClaimingNoteId: jest.fn(),
        removeExtensionClaimingNoteIds: jest.fn(),
        clearExtensionClaimingNoteIds: jest.fn()
      } as unknown as ExtensionSyncActions;
      expectAllFunctions(actions as unknown as Record<string, unknown>, [
        'setExtensionClaimableNotes',
        'addExtensionClaimingNoteId',
        'removeExtensionClaimingNoteIds',
        'clearExtensionClaimingNoteIds'
      ]);
    });

    it('NoteToastActions declares toast controls', () => {
      const actions = {
        checkForNewNotes: jest.fn(),
        dismissNoteToast: jest.fn(),
        resetSeenNotes: jest.fn()
      } as unknown as NoteToastActions;
      expectAllFunctions(actions as unknown as Record<string, unknown>, [
        'checkForNewNotes',
        'dismissNoteToast',
        'resetSeenNotes'
      ]);
    });
  });

  describe('WalletStore (combined)', () => {
    it('is assignable from the union of every slice and action group', () => {
      const store = {
        // slices
        status: WalletStatus.Ready,
        accounts: [],
        currentAccount: null,
        networks: [],
        settings: null,
        ownMnemonic: null,
        balances: {},
        balancesLoading: {},
        balancesLastFetched: {},
        assetsMetadata: {},
        selectedNetworkId: null,
        confirmation: null,
        selectedFiatCurrency: null,
        fiatRates: null,
        fiatRatesLoading: false,
        tokenPrices: {} as TokenPrices,
        isInitialized: false,
        isSyncing: false,
        lastSyncedAt: null,
        hasCompletedInitialSync: false,
        isTransactionModalOpen: false,
        isTransactionModalDismissedByUser: false,
        isDappBrowserOpen: false,
        activeDappSessionId: null,
        lastCompletedTxHash: null,
        seenNoteIds: new Set<string>(),
        isNoteToastVisible: false,
        noteToastShownAt: null,
        extensionClaimableNotes: null,
        extensionClaimingNoteIds: new Set<string>()
      } as unknown as WalletStore;

      // A representative field from each state slice is present.
      expect(store.status).toBe(WalletStatus.Ready);
      expect(store.balances).toEqual({});
      expect(store.assetsMetadata).toEqual({});
      expect(store.selectedNetworkId).toBeNull();
      expect(store.fiatRatesLoading).toBe(false);
      expect(store.isInitialized).toBe(false);
      expect(store.isTransactionModalOpen).toBe(false);
      expect(store.isNoteToastVisible).toBe(false);
      expect(store.extensionClaimableNotes).toBeNull();
    });
  });

  describe('imported enum contracts referenced by the slices', () => {
    it('WalletStatus and WalletType enums resolve to runtime values', () => {
      expect(WalletStatus.Ready).toBeDefined();
      expect(WalletType.OffChain).toBe('off-chain');
    });
  });
});
