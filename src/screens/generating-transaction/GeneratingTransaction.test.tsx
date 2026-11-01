import React from 'react';

import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { ITransactionStatus } from 'lib/miden/db/types';
import {
  REMOTE_PROVER_FAILED_ERROR,
  TRANSACTION_INTERRUPTED_ON_STARTUP,
  TRANSACTION_NEVER_COMMITTED_ERROR,
  TRANSACTION_STUCK_ERROR
} from 'lib/miden/transaction/constants';
import { GuardianHoldRetryError } from 'lib/miden/transaction/retry-refusal';
import { GUARDIAN_PENDING_HOLD_SEC } from 'lib/miden/transaction/verdict-rules';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';
import { WalletType } from 'screens/onboarding/types';

import {
  GeneratingTransaction,
  GeneratingTransactionPage,
  isRecoverableExpiredOneClick
} from './GeneratingTransaction';

jest.mock('lib/telemetry/user-visible-error', () => ({
  ...jest.requireActual('lib/telemetry/user-visible-error'),
  reportUserVisibleError: jest.fn()
}));

let mockFeeCopy = 'worker-fee-copy';
jest.mock('lib/i18n', () => ({
  ...jest.requireActual('lib/i18n'),
  getMessage: (key: string) => (key === 'insufficientFeeAsset' ? mockFeeCopy : key)
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, substitutions?: { seconds?: string; time?: string }) => {
      if (key === 'insufficientFeeAsset') return mockFeeCopy;
      if (key === 'guardianHoldNotice') return `${key} ${substitutions?.time}`;
      return key === 'transactionStepDurationSec' ? `${key} ${substitutions?.seconds}` : key;
    }
  })
}));
let mockMaxNetworkFee: string | undefined;
jest.mock('app/hooks/useNetworkFeeEstimate', () => ({ useNetworkFeeEstimate: () => mockMaxNetworkFee }));

jest.mock('lib/platform', () => ({
  isMobile: jest.fn(() => false),
  isExtension: jest.fn(() => false)
}));

jest.mock('components/Alert', () => ({
  Alert: ({ title }: { title: string }) => <div data-testid="alert">{title}</div>,
  AlertVariant: { Warning: 'Warning' }
}));
jest.mock('components/Button', () => ({
  Button: ({
    children,
    onClick,
    variant,
    accent,
    disabled,
    className
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
    variant?: string;
    accent?: string;
    disabled?: boolean;
    className?: string;
  }) => (
    <button
      type="button"
      data-variant={variant}
      data-accent={accent}
      className={className}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  ),
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary' }
}));
jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: { Success: 'Success', Failed: 'Failed', InProgress: 'InProgress' }
}));

const mockWalletStoreState = {
  assetsMetadata: {} as Record<string, any>,
  accounts: [] as { publicKey: string; type: WalletType }[],
  currentAccount: { type: WalletType.Guardian } as { type: WalletType } | undefined,
  lastCompletedTxHash: null as string | null,
  setLastCompletedTxHash: jest.fn()
};

jest.mock('lib/store', () => ({
  useWalletStore: Object.assign(
    (selector?: (state: typeof mockWalletStoreState) => unknown) =>
      selector ? selector(mockWalletStoreState) : mockWalletStoreState,
    {
      getState: () => mockWalletStoreState
    }
  )
}));

jest.mock('lib/woozie', () => ({
  navigate: jest.fn(),
  Redirect: ({ to }: { to: string }) => <div data-testid="redirect">redirect:{to}</div>
}));

jest.mock('lib/miden/front', () => ({
  useMidenContext: () => ({ signTransaction: jest.fn() })
}));

const mockReconcileUnconfirmed = jest.fn(async () => {});
jest.mock('lib/miden/front/guardian-sync', () => ({
  zustandProvider: {},
  reconcileUnconfirmedInApp: () => mockReconcileUnconfirmed()
}));

const getExplorerTxUrlMock = jest.fn<string | undefined, [string]>(() => undefined);
jest.mock('lib/miden-chain/constants', () => ({
  ...jest.requireActual('lib/miden-chain/constants'),
  getExplorerTxUrl: (txHash: string) => getExplorerTxUrlMock(txHash)
}));

const openExternalUrlMock = jest.fn();
jest.mock('lib/mobile/external-browser', () => ({
  openExternalUrl: (...args: any[]) => openExternalUrlMock(...args)
}));

// The container drives the FIFO loop via safeGenerateTransactionsLoop (unchanged
// behaviour). That's the only thing it still pulls from lib/miden/activity.
const safeGenerateTransactionsLoopMock = jest.fn();
const requeueFailedTransactionMock = jest.fn();
const requestSWTransactionProcessingMock = jest.fn();
const isRequeueableTransactionMock = jest.fn((..._a: unknown[]) => true);
const mockAcknowledgementOf = jest.fn((..._a: unknown[]): { attemptId: string | null } | null => null);
jest.mock('lib/miden/activity', () => ({
  safeGenerateTransactionsLoop: (...args: any[]) => safeGenerateTransactionsLoopMock(...args),
  requeueFailedTransaction: (...a: any[]) => requeueFailedTransactionMock(...a),
  requestSWTransactionProcessing: (...a: any[]) => requestSWTransactionProcessingMock(...a),
  isRequeueableTransaction: (...a: any[]) => isRequeueableTransactionMock(...a),
  acknowledgementOf: (...a: any[]) => mockAcknowledgementOf(...a),
  // Real helper: the retry gate reads the provider off the row's `extraInputs`,
  // and an Epoch (Fast) bridged-send must not be offered a Retry.
  bridgeProviderOf: jest.requireActual('lib/miden/transaction/retry').bridgeProviderOf,
  // Real predicate: which failed rows read as not confirmed is what the failure tests assert.
  isUnconfirmedFailure: jest.requireActual('lib/miden/transaction/constants').isUnconfirmedFailure,
  isOutcomeUnconfirmed: jest.requireActual('lib/miden/transaction/constants').isOutcomeUnconfirmed,
  notConfirmedHintKey: jest.requireActual('lib/miden/transaction/verdict-rules').notConfirmedHintKey
}));

// The container observes the tracked row through this hook. Tests drive the row
// (status/stage/transactionId) via `mockRowState` instead of touching Dexie.
let mockRowState: { row: any; loaded: boolean } = { row: undefined, loaded: false };
jest.mock('./useTransactionRow', () => ({
  useTransactionRow: () => mockRowState
}));
jest.mock('screens/swap-flow/OneClickRecovery', () => ({
  OneClickRecovery: () => <div data-testid="restored-flow" />
}));

// Minimal ITransaction factory for container tests.
const makeTx = (overrides: Record<string, any> = {}) => ({
  id: 'tx-1',
  type: 'send',
  accountId: 'acc-1',
  status: 1, // ITransactionStatus.GeneratingTransaction
  initiatedAt: 0,
  displayIcon: 'SEND',
  ...overrides
});

const networkRefusal =
  'failed to submit proven transaction: RPC error: grpc request failed for submit_proven_transaction: invalid request parameters';

const checkableEntry = {
  attemptId: 'a1',
  capturedAt: 1_700_000_000,
  source: 'stage',
  transactionId: '0x01',
  initialCommitment: '0x02',
  finalCommitment: '0x03',
  initialNonce: '4',
  outputNoteIds: ['0x05'],
  nullifiers: [],
  refBlock: 100,
  refBlockCommitment: '0x06'
};

// A row the node refused after its crossing ends Failed, while the reconciler still judges what it recorded (#2060).
const refusedAfterCrossing = (entry: Record<string, unknown>) =>
  makeTx({
    status: ITransactionStatus.Failed,
    stage: 'submitting',
    mayHaveSubmitted: true,
    error: networkRefusal,
    submitEvidence: [entry]
  });

describe('GeneratingTransactionPage interval driver', () => {
  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    jest.useFakeTimers();
    mockWalletStoreState.lastCompletedTxHash = null;
    mockWalletStoreState.accounts = [];
    mockWalletStoreState.currentAccount = { type: WalletType.Guardian };
    mockWalletStoreState.setLastCompletedTxHash.mockClear();
    safeGenerateTransactionsLoopMock.mockReset();
    mockRowState = { row: makeTx({ stage: 'submitting' }), loaded: true };
    getExplorerTxUrlMock.mockReset();
    getExplorerTxUrlMock.mockReturnValue(undefined);
    openExternalUrlMock.mockClear();
    window.location.hash = '';
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    window.location.hash = '';
  });

  it('continues polling when the transaction loop reports failure', async () => {
    safeGenerateTransactionsLoopMock.mockReturnValue(false);
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(<GeneratingTransactionPage txId="tx-1" />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(setIntervalSpy).toHaveBeenCalled();

    const callsBefore = safeGenerateTransactionsLoopMock.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    // Loop continues processing even after a reported failure.
    expect(safeGenerateTransactionsLoopMock.mock.calls.length).toBeGreaterThan(callsBefore);

    act(() => root.unmount());
  });

  it('continues polling when the transaction loop throws', async () => {
    safeGenerateTransactionsLoopMock.mockImplementation(() => {
      throw new Error('boom');
    });
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(<GeneratingTransactionPage txId="tx-1" />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(setIntervalSpy).toHaveBeenCalled();

    const callsBefore = safeGenerateTransactionsLoopMock.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    // Loop continues processing even after errors.
    expect(safeGenerateTransactionsLoopMock.mock.calls.length).toBeGreaterThan(callsBefore);

    act(() => root.unmount());
  });

  it('clears the polling interval on unmount', async () => {
    safeGenerateTransactionsLoopMock.mockReturnValue(true);
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(<GeneratingTransactionPage txId="tx-1" />);
    });

    act(() => root.unmount());
    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  describe('the unconfirmed reconciler (#1081)', () => {
    const platform: { isExtension: jest.Mock; isMobile: jest.Mock } = jest.requireMock('lib/platform');
    const ticks = async (count: number) => {
      const root = createRoot(document.createElement('div'));
      await act(async () => {
        root.render(<GeneratingTransactionPage txId="tx-1" />);
      });
      await act(async () => {
        jest.advanceTimersByTime(count * 10_000);
      });
      act(() => root.unmount());
    };

    beforeEach(() => {
      mockReconcileUnconfirmed.mockClear();
      safeGenerateTransactionsLoopMock.mockReturnValue(true);
    });

    afterEach(() => {
      platform.isExtension.mockReturnValue(false);
      platform.isMobile.mockReturnValue(false);
    });

    it('fires on the page`s own tick while its row is Unconfirmed, since the sync tick skips this page', async () => {
      mockRowState = { row: makeTx({ status: ITransactionStatus.Unconfirmed }), loaded: true };
      await ticks(2);
      expect(mockReconcileUnconfirmed).toHaveBeenCalledTimes(3);
    });

    it.each([
      ['still being generated', ITransactionStatus.GeneratingTransaction],
      ['Failed', ITransactionStatus.Failed],
      ['Completed', ITransactionStatus.Completed]
    ])('does not fire while its row is %s', async (_label, status) => {
      mockRowState = { row: makeTx({ status }), loaded: true };
      await ticks(2);
      expect(mockReconcileUnconfirmed).not.toHaveBeenCalled();
    });

    it('fires on the page`s own tick on mobile while a Failed row still awaits a verdict (#2060)', async () => {
      platform.isMobile.mockReturnValue(true);
      mockRowState = { row: refusedAfterCrossing(checkableEntry), loaded: true };
      await ticks(2);
      expect(mockReconcileUnconfirmed).toHaveBeenCalledTimes(3);
    });

    it.each([
      ['it is proven dead', { neverCommittedAt: 1 }],
      ['it was restored', { restoredFromBackup: true }]
    ])('does not fire for a Failed row once %s', async (_label, fields) => {
      platform.isMobile.mockReturnValue(true);
      mockRowState = { row: { ...refusedAfterCrossing(checkableEntry), ...fields }, loaded: true };
      await ticks(2);
      expect(mockReconcileUnconfirmed).not.toHaveBeenCalled();
    });

    it('stops firing when the verdict arrives, without a remount', async () => {
      const root = createRoot(document.createElement('div'));
      mockRowState = { row: refusedAfterCrossing(checkableEntry), loaded: true };
      await act(async () => {
        root.render(<GeneratingTransactionPage txId="tx-1" />);
      });
      expect(mockReconcileUnconfirmed).toHaveBeenCalledTimes(1);
      mockRowState = { row: { ...refusedAfterCrossing(checkableEntry), neverCommittedAt: 1 }, loaded: true };
      await act(async () => {
        root.render(<GeneratingTransactionPage txId="tx-1" />);
      });
      await act(async () => {
        jest.advanceTimersByTime(20_000);
      });
      expect(mockReconcileUnconfirmed).toHaveBeenCalledTimes(1);
      act(() => root.unmount());
    });

    it('does not fire on the extension, whose service worker reconciles after its own sync', async () => {
      platform.isExtension.mockReturnValue(true);
      mockRowState = { row: makeTx({ status: ITransactionStatus.Unconfirmed }), loaded: true };
      await ticks(2);
      expect(mockReconcileUnconfirmed).not.toHaveBeenCalled();
    });
  });
});

describe('GeneratingTransactionPage container effects', () => {
  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    jest.useFakeTimers();
    mockWalletStoreState.lastCompletedTxHash = null;
    mockWalletStoreState.accounts = [];
    mockWalletStoreState.currentAccount = { type: WalletType.Guardian };
    mockWalletStoreState.setLastCompletedTxHash.mockClear();
    safeGenerateTransactionsLoopMock.mockReset();
    safeGenerateTransactionsLoopMock.mockReturnValue(true);
    mockRowState = { row: undefined, loaded: false };
    getExplorerTxUrlMock.mockReset();
    getExplorerTxUrlMock.mockReturnValue(undefined);
    openExternalUrlMock.mockClear();
    navigateMock.mockClear();
    requeueFailedTransactionMock.mockClear();
    requestSWTransactionProcessingMock.mockClear();
    isRequeueableTransactionMock.mockReset();
    isRequeueableTransactionMock.mockReturnValue(true);
    mockAcknowledgementOf.mockReset();
    mockAcknowledgementOf.mockReturnValue(null);
    window.location.hash = '';
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    window.location.hash = '';
  });

  const navigateMock = jest.requireMock('lib/woozie').navigate as jest.Mock;

  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  const mount = async (element: React.ReactElement) => {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(element);
    });
    await flush();
    return { container, root };
  };

  it('redirects home when the id is unknown (loaded, no row)', async () => {
    mockRowState = { row: undefined, loaded: true };

    const { container, root } = await mount(<GeneratingTransactionPage txId="tx-missing" />);

    expect(container.querySelector('[data-testid="redirect"]')?.textContent).toBe('redirect:/');
    act(() => root.unmount());
  });

  it('only recovers definite pre-submit OneClick deadline failures', () => {
    const failedOneClick = {
      status: ITransactionStatus.Failed,
      type: 'send',
      error: 'The 1Click quote has expired. Request a new quote before depositing.',
      extraInputs: { oneClick: { direction: 'miden-to-evm' } }
    };

    expect(isRecoverableExpiredOneClick(failedOneClick, ITransactionStatus.Failed)).toBe(true);
    expect(isRecoverableExpiredOneClick({ ...failedOneClick, mayHaveSubmitted: true }, ITransactionStatus.Failed)).toBe(
      false
    );
    expect(isRecoverableExpiredOneClick(failedOneClick, ITransactionStatus.GeneratingTransaction)).toBe(false);
  });

  it('routes a persisted inbound attempted row to recovery after reload', async () => {
    const oneClick = Object.assign(
      {
        direction: 'evm-to-miden',
        request: { originAsset: { blockchain: 'eth' }, destinationAsset: { blockchain: 'miden' } },
        quote: { quote: { depositAddress: '0x8888888888888888888888888888888888888888' } },
        config: { serviceUrl: 'https://quotes.example', midenAssets: [] },
        network: 'mainnet',
        accountId: 'acc-1',
        accountAddress: 'acc-1',
        originAsset: { assetId: 'eth:token', blockchain: 'eth' },
        destinationAsset: { assetId: 'miden:token', blockchain: 'miden' },
        faucetId: 'miden-faucet',
        depositAddress: '0x8888888888888888888888888888888888888888',
        phase: 'pending-deposit'
      },
      { evmSubmission: 'attempted' }
    );
    mockRowState = {
      row: makeTx({ type: 'bridged-receive', status: ITransactionStatus.Completed, extraInputs: { oneClick } }),
      loaded: true
    };
    const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

    try {
      await act(async () => {
        for (let index = 0; index < 8; index++) await Promise.resolve();
      });
      expect(container.querySelector('[data-testid="restored-flow"]')).not.toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  // #602 — the processing screen nests a fixed-height full-screen page
  // (overflow-hidden) > this flex-1 wrapper (default overflow:visible) > the
  // `overflow-y-auto` scroll region. Flexbox gives a visible flex item an
  // automatic minimum size equal to its content, so WITHOUT `min-h-0` this
  // wrapper refuses to shrink to its viewport slot on a short (safe-area-inset)
  // phone; the parent then clips it and the scroll region inherits a height ==
  // its content (zero scroll range), leaving the pinned footer "Hide" CTA on a
  // two-line-title flow (Earn, guardian, …) spilled below the viewport and
  // unreachable. This pins the guard on the wrapper that actually needs it —
  // NOT the scroll region (already auto-min 0 via overflow-y-auto).
  it('keeps the processing scroll chain shrinkable (min-h-0) so the footer CTA can never be clipped (#602)', async () => {
    mockRowState = { row: makeTx({ type: 'earn-deposit', stage: 'submitting' }), loaded: true };

    const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

    const scroller = container.querySelector('.overflow-y-auto'); // the single scroll region
    expect(scroller).not.toBeNull();
    const shrinkableWrapper = scroller!.parentElement as HTMLElement;
    expect(shrinkableWrapper).toHaveClass('flex-1'); // it is the flex-1 wrapper feeding the scroll region
    expect(shrinkableWrapper).toHaveClass('min-h-0'); // ...and it must be allowed to shrink to its slot
    act(() => root.unmount());
  });

  it('records the completed tx hash when the row reaches Completed with a hash', async () => {
    mockRowState = { row: makeTx({ status: 2, transactionId: '0xdeadbeef' }), loaded: true };

    const { root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

    expect(mockWalletStoreState.setLastCompletedTxHash).toHaveBeenCalledWith('0xdeadbeef');
    act(() => root.unmount());
  });

  it('does not record a hash when the completed row has no transactionId', async () => {
    mockRowState = { row: makeTx({ status: 2 }), loaded: true };

    const { root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

    expect(mockWalletStoreState.setLastCompletedTxHash).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('renders the failed state when the row status is Failed', async () => {
    mockRowState = { row: makeTx({ status: 3 }), loaded: true };

    const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

    expect(container.textContent).toContain('transactionFailed');
    act(() => root.unmount());
  });

  it('fee refusal uses localized fee copy and leaves the current view open', async () => {
    const { ClaimFeeRefusedError } = jest.requireActual<typeof import('lib/miden/transaction/initiate')>(
      'lib/miden/transaction/initiate'
    );
    mockFeeCopy = 'worker-fee-copy';
    const refusal = new ClaimFeeRefusedError();
    mockFeeCopy = 'localized-fee-copy';
    mockRowState = { row: makeTx({ status: 3, type: 'consume', displayIcon: 'RECEIVE' }), loaded: true };
    requeueFailedTransactionMock.mockRejectedValueOnce(refusal);
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);
    try {
      const retryButton = Array.from(container.querySelectorAll('button')).find(
        button => button.textContent === 'retry'
      );
      expect(retryButton).toBeTruthy();
      await act(async () => {
        retryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(container.textContent).toContain('localized-fee-copy');
      expect(container.textContent).not.toContain(refusal.message);
      expect(navigateMock).not.toHaveBeenCalled();
      expect(requestSWTransactionProcessingMock).not.toHaveBeenCalled();
      expect(retryButton).not.toBeDisabled();
      expect(log).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      mockFeeCopy = 'worker-fee-copy';
      log.mockRestore();
    }
  });

  it('shows Retry on a failed requeueable tx and requeues + kicks processing on click (#483)', async () => {
    isRequeueableTransactionMock.mockReturnValue(true);
    mockRowState = { row: makeTx({ status: 3, type: 'swap' }), loaded: true };

    const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

    const retryBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('retry'));
    expect(retryBtn).toBeTruthy();

    await act(async () => {
      retryBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Plain Retry never acknowledges on the user's behalf.
    expect(requeueFailedTransactionMock).toHaveBeenCalledWith('tx-1', {});
    expect(requestSWTransactionProcessingMock).toHaveBeenCalled();
    // Requeue flips the watched row back in place — the screen must NOT navigate
    // (the key difference from HistoryDetails.handleRetry).
    expect(navigateMock).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  // The refusal has to lead somewhere: the wallet cannot tell whether the send
  // landed, so it shows why and offers the user's own confirmation as a second,
  // separate tap. Without this the Retry button throws the same error forever.
  it('offers "retry anyway" only after a send is refused as unverifiable', async () => {
    isRequeueableTransactionMock.mockReturnValue(true);
    mockRowState = { row: makeTx({ status: 3, type: 'send' }), loaded: true };
    requeueFailedTransactionMock.mockRejectedValueOnce(new Error('may already have reached the network'));
    mockAcknowledgementOf.mockReturnValue({ attemptId: 'a1' });

    const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

    const findRetryAnyway = () =>
      Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('retryAnyway')) ?? null;
    expect(findRetryAnyway()).toBeNull();

    const retryBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('retry'));
    await act(async () => {
      retryBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // The warning is on screen, and only now is the override reachable.
    expect(container.textContent).toContain('may already have reached the network');
    expect(findRetryAnyway()).not.toBeNull();

    requeueFailedTransactionMock.mockResolvedValueOnce(undefined);
    await act(async () => {
      findRetryAnyway()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(requeueFailedTransactionMock).toHaveBeenLastCalledWith('tx-1', { acknowledged: { attemptId: 'a1' } });
    act(() => root.unmount());
  });

  it('does not offer it for an ordinary retry failure', async () => {
    isRequeueableTransactionMock.mockReturnValue(true);
    mockRowState = { row: makeTx({ status: 3, type: 'send' }), loaded: true };
    requeueFailedTransactionMock.mockRejectedValueOnce(new Error('row is gone'));
    mockAcknowledgementOf.mockReturnValue(null);

    const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);
    const retryBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('retry'));
    await act(async () => {
      retryBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('row is gone');
    expect(
      Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('retryAnyway'))
    ).toBeUndefined();
    act(() => root.unmount());
  });

  // The page watches the LIVE row: another surface may have run a newer attempt since the refusal
  // rendered. The acknowledgement still answers the attempt the user was shown (#1081).
  it('passes back the attempt the rendered refusal named, not the newer attempt on the live row', async () => {
    isRequeueableTransactionMock.mockReturnValue(true);
    mockRowState = { row: makeTx({ status: 3, type: 'send', attemptId: 'a1' }), loaded: true };
    requeueFailedTransactionMock.mockRejectedValueOnce(new Error('may already have reached the network'));
    mockAcknowledgementOf.mockReturnValue({ attemptId: 'a1' });

    const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);
    const retryBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('retry'));
    await act(async () => {
      retryBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    mockRowState = { row: makeTx({ status: 3, type: 'send', attemptId: 'a2' }), loaded: true };
    await act(async () => {
      root.render(<GeneratingTransactionPage txId="tx-1" />);
    });
    const retryAnyway = Array.from(container.querySelectorAll('button')).find(b =>
      b.textContent?.includes('retryAnyway')
    );
    requeueFailedTransactionMock.mockResolvedValueOnce(undefined);
    await act(async () => {
      retryAnyway!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(requeueFailedTransactionMock).toHaveBeenLastCalledWith('tx-1', { acknowledged: { attemptId: 'a1' } });
    act(() => root.unmount());
  });

  it('offers no "retry anyway" for the liveness refusal (#1081)', async () => {
    isRequeueableTransactionMock.mockReturnValue(true);
    mockRowState = { row: makeTx({ status: 3, type: 'execute' }), loaded: true };
    requeueFailedTransactionMock.mockRejectedValueOnce(new Error('may still be finishing in the background'));
    mockAcknowledgementOf.mockReturnValue(null);

    const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);
    const retryBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('retry'));
    await act(async () => {
      retryBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('may still be finishing in the background');
    expect(
      Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('retryAnyway'))
    ).toBeUndefined();
    act(() => root.unmount());
  });

  const buttonLabelled = (container: HTMLElement, label: string) =>
    Array.from(container.querySelectorAll('button')).find(b => b.textContent === label);

  // Only the types isRequeueableTransaction accepts ever reach Retry; execute has no flow of its own.
  it.each([
    ['send', 'send'],
    ['consume', 'receive'],
    ['swap', 'swap'],
    ['bridged-send', 'send'],
    ['execute', 'brand']
  ])('draws Retry and Done on a failed %s row in its flow colour', async (type, accent) => {
    mockRowState = { row: makeTx({ status: 3, type }), loaded: true };

    const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

    expect(buttonLabelled(container, 'retry')).toHaveAttribute('data-accent', accent);
    expect(buttonLabelled(container, 'done')).toHaveAttribute('data-accent', accent);
    act(() => root.unmount());
  });

  it.each([
    ['send', 'send'],
    ['swap', 'swap'],
    ['earn-deposit', 'earn'],
    ['consume', 'receive']
  ])('draws Done on a completed %s row in its flow colour', async (type, accent) => {
    mockRowState = { row: makeTx({ status: 2, type }), loaded: true };

    const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

    expect(buttonLabelled(container, 'done')).toHaveAttribute('data-accent', accent);
    act(() => root.unmount());
  });

  it('does NOT show Retry when the failed tx is not requeueable (#483)', async () => {
    isRequeueableTransactionMock.mockReturnValue(false);
    mockRowState = { row: makeTx({ status: 3, type: 'replace-hot-key' }), loaded: true };

    const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

    const retryBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('retry'));
    expect(retryBtn).toBeFalsy();
    act(() => root.unmount());
  });

  it('marks the step matching the frozen stage as failed, not the last step', async () => {
    mockRowState = { row: makeTx({ status: 3, stage: 'proving' }), loaded: true };

    const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

    const stateByStep = Object.fromEntries(
      Array.from(container.querySelectorAll('[data-transaction-step]')).map(el => [
        el.getAttribute('data-transaction-step'),
        el.getAttribute('data-state')
      ])
    );
    expect(stateByStep).toEqual({
      'guardian-approving': 'complete',
      'generating-proof': 'failed',
      submitting: 'pending',
      'syncing-guardian': 'pending'
    });
    act(() => root.unmount());
  });

  const stepStates = (container: HTMLElement) =>
    Object.fromEntries(
      Array.from(container.querySelectorAll('[data-transaction-step]')).map(el => [
        el.getAttribute('data-transaction-step'),
        el.getAttribute('data-state')
      ])
    );

  // A private send's commit wait and relay are a step of their own after the Guardian sync (#1492), so a row
  // failed during either carries its cross there, past a finished sync.
  it.each(['confirming', 'delivering'])('marks a private send failed at %s on its delivery step', async stage => {
    mockRowState = { row: makeTx({ status: 3, stage, noteType: 'private', error: 'boom' }), loaded: true };

    const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

    expect(stepStates(container)).toEqual({
      'guardian-approving': 'complete',
      'generating-proof': 'complete',
      submitting: 'complete',
      'syncing-guardian': 'complete',
      'delivering-note': 'failed'
    });
    act(() => root.unmount());
  });

  // The same rule Activity and the rotation gate apply (#1250): a row whose outcome is unknown
  // is not titled failed, and its classifier copy is not shown as the reason. Neither row holds an
  // entry the reconciler can check, so the hint says the wallet is not checking it (#1081).
  it.each([
    ['a row that may have been submitted', { mayHaveSubmitted: true, error: REMOTE_PROVER_FAILED_ERROR }],
    ['a row the reaper failed', { error: TRANSACTION_STUCK_ERROR }]
  ])('reads %s as not confirmed, not failed', async (_label, fields) => {
    mockRowState = { row: makeTx({ status: 3, stage: 'proving', ...fields }), loaded: true };

    const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

    expect(container.querySelector('h2')?.textContent).toBe('notConfirmed');
    expect(container.textContent).toContain('transactionUndeterminedHint');
    expect(container.textContent).not.toContain('transactionFailed');
    expect(container.textContent).not.toContain(fields.error);
    expect(container.querySelector('.size-16 > .bg-status-pending')).not.toBeNull();
    expect(container.querySelector('.bg-status-negative')).toBeNull();
    expect(stepStates(container)).toEqual({
      'guardian-approving': 'complete',
      'generating-proof': 'pending',
      submitting: 'pending',
      'syncing-guardian': 'pending'
    });
    act(() => root.unmount());
  });

  it('keeps the failed title, row error, hero and step for a definite failure', async () => {
    mockRowState = { row: makeTx({ status: 3, stage: 'proving', error: REMOTE_PROVER_FAILED_ERROR }), loaded: true };

    const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

    expect(container.querySelector('h2')?.textContent).toBe('transactionFailed');
    expect(container.textContent).toContain(REMOTE_PROVER_FAILED_ERROR);
    expect(container.textContent).not.toContain('transactionNotConfirmedHint');
    expect(container.textContent).not.toContain('transactionUndeterminedHint');
    expect(container.textContent).not.toContain('showFullError');
    expect(container.querySelector('.size-16 > .bg-status-negative')).not.toBeNull();
    expect(container.querySelector('.bg-status-pending')).toBeNull();
    expect(stepStates(container)['generating-proof']).toBe('failed');
    act(() => root.unmount());
  });

  const submitDeadline =
    'failed to submit proven transaction: RPC error: grpc request failed for submit_proven_transaction: request to Miden node timed out; the node may be under heavy load';

  it('explains an explicit submit refusal and retries through the existing action', async () => {
    mockReconcileUnconfirmed.mockClear();
    mockRowState = {
      row: makeTx({
        status: ITransactionStatus.Failed,
        stage: 'submitting',
        type: 'consume',
        mayHaveSubmitted: true,
        error: networkRefusal
      }),
      loaded: true
    };

    const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

    expect(container.querySelector('h2')?.textContent).toBe('transactionFailed');
    expect(container.textContent).toContain('submissionRejectedByNetwork');
    expect(container.textContent).not.toContain('invalid request parameters');
    expect(container.textContent).not.toContain('notConfirmed');
    expect(container.querySelector('.size-16 > .bg-status-negative')).not.toBeNull();
    expect(stepStates(container).submitting).toBe('failed');
    expect(requeueFailedTransactionMock).not.toHaveBeenCalled();
    const retryButton = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'retry');
    expect(retryButton).toBeTruthy();
    await act(async () => {
      retryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(requeueFailedTransactionMock).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('reads a refusal the reconciler still judges as not confirmed, with no refused sentence (#2060)', async () => {
    mockRowState = { row: refusedAfterCrossing(checkableEntry), loaded: true };

    const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

    expect(container.querySelector('h2')?.textContent).toBe('notConfirmed');
    expect(container.textContent).toContain('transactionNotConfirmedHint');
    expect(container.textContent).not.toContain('submissionRejectedByNetwork');
    expect(container.textContent).not.toContain('transactionFailed');
    expect(container.textContent).toContain('showFullError');
    expect(container.querySelector('.size-16 > .bg-status-pending')).not.toBeNull();
    expect(container.querySelector('.bg-status-negative')).toBeNull();
    expect(stepStates(container).submitting).toBe('pending');
    act(() => root.unmount());
  });

  it('turns to the failed title and the refusal once nothing is left to judge (#2060)', async () => {
    mockRowState = {
      row: refusedAfterCrossing({ ...checkableEntry, verdict: 'never-committed' }),
      loaded: true
    };

    const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

    expect(container.querySelector('h2')?.textContent).toBe('transactionFailed');
    expect(container.textContent).toContain('submissionRejectedByNetwork');
    expect(container.textContent).not.toContain('notConfirmed');
    act(() => root.unmount());
  });

  it('turns to the failed title and the refusal when the reconciler gave up on its entry (#2060)', async () => {
    mockRowState = { row: refusedAfterCrossing({ ...checkableEntry, verdict: 'unresolvable' }), loaded: true };

    const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

    expect(container.querySelector('h2')?.textContent).toBe('transactionFailed');
    expect(container.textContent).toContain('submissionRejectedByNetwork');
    expect(container.textContent).not.toContain('transactionUndeterminedHint');
    act(() => root.unmount());
  });

  describe('a row the node proved never committed (#2060)', () => {
    const provenRow = (entry: Record<string, unknown> = {}) =>
      makeTx({
        status: ITransactionStatus.Failed,
        stage: 'submitting',
        mayHaveSubmitted: true,
        neverCommittedAt: 1,
        error: TRANSACTION_NEVER_COMMITTED_ERROR,
        rawError: TRANSACTION_INTERRUPTED_ON_STARTUP,
        submitEvidence: [{ ...checkableEntry, verdict: 'never-committed', ...entry }]
      });

    it('reads Failed and says it is safe to retry, with nothing about the answer it missed', async () => {
      mockRowState = { row: provenRow(), loaded: true };

      const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

      try {
        expect(container.querySelector('h2')?.textContent).toBe('transactionFailed');
        expect(container.textContent).toContain(TRANSACTION_NEVER_COMMITTED_ERROR);
        expect(container.textContent).not.toContain('submissionUnanswered');
        expect(container.querySelector('.bg-status-negative')).not.toBeNull();
      } finally {
        act(() => root.unmount());
      }
    });

    it('does not invite a retry while the Guardian still holds its candidate', async () => {
      mockRowState = {
        row: provenRow({ candidateKept: true, capturedAt: Math.floor(Date.now() / 1000) - 60 }),
        loaded: true
      };

      const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

      try {
        expect(container.querySelector('h2')?.textContent).toBe('transactionFailed');
        expect(container.textContent).toContain('submissionProvenHeldByGuardian');
        expect(container.textContent).not.toContain(TRANSACTION_NEVER_COMMITTED_ERROR);
      } finally {
        act(() => root.unmount());
      }
    });
  });

  it('says why a refused row with nothing left to judge cannot be retried yet (#2060)', async () => {
    mockRowState = {
      row: refusedAfterCrossing({
        ...checkableEntry,
        verdict: 'unresolvable',
        candidateKept: true,
        capturedAt: Math.floor(Date.now() / 1000) - 60
      }),
      loaded: true
    };

    const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

    expect(container.querySelector('h2')?.textContent).toBe('transactionFailed');
    expect(container.textContent).toContain('submissionHeldByGuardian');
    expect(container.textContent).not.toContain('submissionRejectedByNetwork');
    expect(container.textContent).not.toContain(networkRefusal);
    act(() => root.unmount());
  });

  describe('a refused row whose candidate the Guardian still holds (#2060)', () => {
    const heldRow = () =>
      refusedAfterCrossing({ ...checkableEntry, candidateKept: true, capturedAt: Math.floor(Date.now() / 1000) - 60 });

    afterEach(() => {
      mockMaxNetworkFee = undefined;
      mockAcknowledgementOf.mockReturnValue(null);
      requeueFailedTransactionMock.mockReset();
      jest.useRealTimers();
    });

    const notice = (container: HTMLElement) => container.querySelector('[data-testid="guardian-hold-notice"]');
    const secondsFromNow = (seconds: number) => Math.floor(Date.now() / 1000) + seconds;

    it('states the deadline and hides the fee a Retry would pay', async () => {
      mockMaxNetworkFee = '0.3 MIDEN';
      mockRowState = { row: heldRow(), loaded: true };

      const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

      try {
        expect(notice(container)?.textContent).toContain('guardianHoldNotice');
        expect(container.querySelector('[data-testid="guardian-hold-countdown"]')?.textContent).toMatch(/^17:\d\d$/);
        expect(container.textContent).not.toContain('networkFeeMax');
      } finally {
        act(() => root.unmount());
      }
    });

    it('announces the deadline once and never the countdown', async () => {
      mockRowState = { row: heldRow(), loaded: true };

      const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

      try {
        const areas = [...container.querySelectorAll('[aria-live], [role="status"]')];
        expect(areas.filter(area => area.textContent?.includes('guardianHoldNotice'))).toHaveLength(1);
        expect(areas.filter(area => area.querySelector('time') !== null)).toEqual([]);
        expect(container.querySelector('time')?.closest('[aria-live], [role="status"]')).toBeNull();
      } finally {
        act(() => root.unmount());
      }
    });

    it('turns on Retry and the fee, and drops the hold sentence, the moment the hold ends', async () => {
      jest.useFakeTimers();
      mockMaxNetworkFee = '0.3 MIDEN';
      mockRowState = {
        row: refusedAfterCrossing({
          ...checkableEntry,
          verdict: 'unresolvable',
          candidateKept: true,
          capturedAt: secondsFromNow(3) - GUARDIAN_PENDING_HOLD_SEC
        }),
        loaded: true
      };

      const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

      try {
        expect(buttonLabelled(container, 'retry')).toBeDisabled();
        expect(container.textContent).toContain('submissionHeldByGuardian');

        await act(async () => {
          jest.advanceTimersByTime(3_000);
        });

        expect(buttonLabelled(container, 'retry')).toBeEnabled();
        expect(notice(container)).toBeNull();
        expect(container.textContent).toContain('networkFeeMax');
        expect(container.textContent).not.toContain('submissionHeldByGuardian');
        expect(container.textContent).toContain('submissionRejectedByNetwork');
      } finally {
        act(() => root.unmount());
      }
    });

    it('replaces the proven row`s safe-to-retry sentence, and gives it back when the hold ends', async () => {
      jest.useFakeTimers();
      const proven = makeTx({
        status: ITransactionStatus.Failed,
        stage: 'submitting',
        mayHaveSubmitted: true,
        neverCommittedAt: 1,
        error: TRANSACTION_NEVER_COMMITTED_ERROR,
        rawError: TRANSACTION_INTERRUPTED_ON_STARTUP,
        submitEvidence: [
          {
            ...checkableEntry,
            verdict: 'never-committed',
            candidateKept: true,
            capturedAt: secondsFromNow(3) - GUARDIAN_PENDING_HOLD_SEC
          }
        ]
      });
      mockRowState = { row: proven, loaded: true };

      const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

      try {
        expect(notice(container)).not.toBeNull();
        expect(buttonLabelled(container, 'retry')).toBeDisabled();
        expect(container.textContent).not.toContain(TRANSACTION_NEVER_COMMITTED_ERROR);

        await act(async () => {
          jest.advanceTimersByTime(3_000);
        });

        expect(buttonLabelled(container, 'retry')).toBeEnabled();
        expect(container.textContent).toContain(TRANSACTION_NEVER_COMMITTED_ERROR);
      } finally {
        act(() => root.unmount());
      }
    });

    it('clears a refusal that met the hold, with its Retry anyway, when the Guardian lets go', async () => {
      const refused = refusedAfterCrossing({ ...checkableEntry, verdict: 'unresolvable' });
      mockRowState = { row: refused, loaded: true };
      requeueFailedTransactionMock.mockRejectedValue(new GuardianHoldRetryError(secondsFromNow(60)));
      mockAcknowledgementOf.mockReturnValue({ attemptId: 'a1' });
      const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

      try {
        await act(async () => {
          buttonLabelled(container, 'retry')?.click();
        });
        expect(container.textContent).toContain('guardianHoldRetryRefused');

        mockRowState = { row: heldRow(), loaded: true };
        await act(async () => {
          root.render(<GeneratingTransactionPage txId="tx-1" />);
        });
        expect(buttonLabelled(container, 'retryAnyway')).toBeDisabled();

        mockRowState = { row: refused, loaded: true };
        await act(async () => {
          root.render(<GeneratingTransactionPage txId="tx-1" />);
        });
        expect(container.textContent).not.toContain('guardianHoldRetryRefused');
        expect(buttonLabelled(container, 'retryAnyway')).toBeUndefined();
      } finally {
        act(() => root.unmount());
      }
    });

    it('keeps another row`s refusal and Retry anyway off this row', async () => {
      const refused = (id: string) => ({
        ...refusedAfterCrossing({ ...checkableEntry, verdict: 'unresolvable' }),
        id
      });
      mockRowState = { row: refused('tx-1'), loaded: true };
      requeueFailedTransactionMock.mockRejectedValue(new Error('refused for tx-1'));
      mockAcknowledgementOf.mockReturnValue({ attemptId: 'a1' });
      const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

      try {
        await act(async () => {
          buttonLabelled(container, 'retry')?.click();
        });
        expect(container.textContent).toContain('refused for tx-1');

        mockRowState = { row: refused('tx-2'), loaded: true };
        await act(async () => {
          root.render(<GeneratingTransactionPage txId="tx-2" />);
        });

        expect(container.textContent).not.toContain('refused for tx-1');
        expect(buttonLabelled(container, 'retryAnyway')).toBeUndefined();
      } finally {
        act(() => root.unmount());
      }
    });

    it('shows Retry disabled before any tap', async () => {
      mockRowState = { row: heldRow(), loaded: true };

      const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

      try {
        expect(buttonLabelled(container, 'retry')).toBeTruthy();
        expect(buttonLabelled(container, 'retry')).toBeDisabled();
        expect(requeueFailedTransactionMock).not.toHaveBeenCalled();
      } finally {
        act(() => root.unmount());
      }
    });

    it('does not say the network refused it and to try again', async () => {
      mockRowState = { row: heldRow(), loaded: true };

      const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

      try {
        expect(container.textContent).not.toContain('submissionRejectedByNetwork');
      } finally {
        act(() => root.unmount());
      }
    });
  });

  it('explains a dropped connection and a missing answer without calling the transaction failed', async () => {
    mockReconcileUnconfirmed.mockClear();
    mockRowState = {
      row: makeTx({
        status: ITransactionStatus.Failed,
        stage: 'submitting',
        type: 'consume',
        mayHaveSubmitted: true,
        error: 'TypeError: Failed to fetch'
      }),
      loaded: true
    };

    const dropped = await mount(<GeneratingTransactionPage txId="tx-1" />);
    expect(dropped.container.querySelector('h2')?.textContent).toBe('notConfirmed');
    expect(dropped.container.textContent).toContain('submissionInterrupted');
    expect(dropped.container.textContent).not.toContain('transactionFailed');
    expect(dropped.container.querySelector('.size-16 > .bg-status-pending')).not.toBeNull();
    expect(stepStates(dropped.container).submitting).toBe('pending');
    expect(requeueFailedTransactionMock).not.toHaveBeenCalled();
    act(() => dropped.root.unmount());

    mockRowState = {
      row: makeTx({
        status: ITransactionStatus.Unconfirmed,
        stage: 'submitting',
        type: 'consume',
        error: submitDeadline
      }),
      loaded: true
    };
    const quiet = await mount(<GeneratingTransactionPage txId="tx-1" />);
    expect(quiet.container.querySelector('h2')?.textContent).toBe('notConfirmed');
    expect(quiet.container.textContent).toContain('submissionUnanswered');
    expect(quiet.container.textContent).not.toContain('transactionFailed');
    expect(requeueFailedTransactionMock).not.toHaveBeenCalled();
    expect(mockReconcileUnconfirmed).toHaveBeenCalled();
    act(() => quiet.root.unmount());
  });

  it('keeps an in-progress submission on the spinner and Hide, and a late success on the receipt path', async () => {
    mockRowState = {
      row: makeTx({ status: ITransactionStatus.GeneratingTransaction, stage: 'submitting', type: 'consume' }),
      loaded: true
    };
    const pending = await mount(<GeneratingTransactionPage txId="tx-1" />);
    expect(pending.container.textContent).toContain('generatingTransactionDescription');
    expect(pending.container.textContent).toContain('hide');
    expect(pending.container.textContent).not.toContain('submissionUnanswered');
    expect(pending.container.textContent).not.toContain('submissionRejectedByNetwork');
    act(() => pending.root.unmount());

    mockRowState = {
      row: makeTx({
        status: ITransactionStatus.Failed,
        stage: 'submitting',
        type: 'consume',
        error: submitDeadline
      }),
      loaded: true
    };
    const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);
    expect(container.textContent).toContain('submissionUnanswered');

    mockRowState = {
      row: makeTx({
        status: ITransactionStatus.Completed,
        stage: 'submitting',
        type: 'consume',
        error: "Transaction 0xabc was accepted into the node's mempool at block 9 but the local store update failed."
      }),
      loaded: true
    };
    await act(async () => {
      root.render(<GeneratingTransactionPage txId="tx-1" />);
    });
    await flush();
    expect(container.textContent).not.toContain('submissionUnanswered');
    expect(container.textContent).toContain('transactionCompleted');
    act(() => root.unmount());
  });

  it('gives an unrecognized submit error the existing failed copy and full-error disclosure, not a verdict', async () => {
    const unrecognized = 'Note is invalid';
    mockRowState = {
      row: makeTx({ status: ITransactionStatus.Failed, stage: 'submitting', type: 'consume', error: unrecognized }),
      loaded: true
    };
    const definite = await mount(<GeneratingTransactionPage txId="tx-1" />);
    expect(definite.container.querySelector('h2')?.textContent).toBe('transactionFailed');
    expect(definite.container.textContent).toContain(unrecognized);
    expect(definite.container.textContent).not.toMatch(/submission(Rejected|Interrupted|Unanswered)/);
    act(() => definite.root.unmount());

    mockRowState = {
      row: makeTx({
        status: ITransactionStatus.Failed,
        stage: 'submitting',
        type: 'consume',
        mayHaveSubmitted: true,
        error: unrecognized
      }),
      loaded: true
    };
    const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);
    expect(container.querySelector('h2')?.textContent).toBe('notConfirmed');
    expect(container.textContent).toContain('transactionUndeterminedHint');
    expect(container.textContent).not.toMatch(/submission(Rejected|Interrupted|Unanswered)/);
    expect(container.textContent).not.toContain(unrecognized);
    const showFullError = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'showFullError');
    expect(showFullError).toBeTruthy();
    await act(async () => {
      showFullError!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain(unrecognized);
    act(() => root.unmount());
  });

  it("keeps a not-confirmed row's own error one tap away behind Show full error", async () => {
    mockRowState = { row: makeTx({ status: 3, mayHaveSubmitted: true, error: 'Error: 503' }), loaded: true };

    const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

    expect(container.textContent).toContain('transactionUndeterminedHint');
    expect(container.textContent).not.toContain('Error: 503');
    const showFullError = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'showFullError');
    expect(showFullError).toBeTruthy();
    await act(async () => {
      showFullError!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('Error: 503');
    act(() => root.unmount());
  });

  describe('an Unconfirmed row (#1081)', () => {
    const unconfirmedRow = (entry: Record<string, unknown> = checkableEntry) =>
      makeTx({
        status: ITransactionStatus.Unconfirmed,
        stage: 'submitting',
        mayHaveSubmitted: true,
        error: 'Error: 503',
        submitEvidence: [entry]
      });

    it('stops the spinner and shows the not-confirmed header, its hint and Retry', async () => {
      mockRowState = { row: unconfirmedRow(), loaded: true };

      const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

      expect(container.querySelector('h2')?.textContent).toBe('notConfirmed');
      expect(container.textContent).toContain('transactionNotConfirmedHint');
      expect(container.textContent).not.toContain('doNotCloseWindowAutoClose');
      expect(container.querySelector('.size-16 > .bg-status-pending')).not.toBeNull();
      expect(buttonLabelled(container, 'retry')).toBeTruthy();
      act(() => root.unmount());
    });

    it('says the wallet is not checking it once its only entry is unresolvable', async () => {
      mockRowState = { row: unconfirmedRow({ ...checkableEntry, verdict: 'unresolvable' }), loaded: true };

      const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

      expect(container.querySelector('h2')?.textContent).toBe('notConfirmed');
      expect(container.textContent).toContain('transactionUndeterminedHint');
      expect(container.textContent).not.toContain('transactionNotConfirmedHint');
      act(() => root.unmount());
    });
  });

  it('picks the step set from the tracked tx account, not the current account', async () => {
    // Current account is standard, but the row's account (acc-1) is a Guardian
    // account — the step set must follow the tx, not the globally-current account.
    mockWalletStoreState.currentAccount = { type: WalletType.OnChain };
    mockWalletStoreState.accounts = [{ publicKey: 'acc-1', type: WalletType.Guardian }];
    mockRowState = { row: makeTx({ status: 1, stage: 'submitting' }), loaded: true };

    const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

    const ids = Array.from(container.querySelectorAll('[data-transaction-step]')).map(el =>
      el.getAttribute('data-transaction-step')
    );
    expect(ids).toEqual(['guardian-approving', 'generating-proof', 'submitting', 'syncing-guardian']);
    act(() => root.unmount());
  });

  it('wires onViewExplorer to openExternalUrl when an explorer url is available', async () => {
    mockRowState = { row: makeTx({ status: 2, transactionId: '0xhash' }), loaded: true };
    mockWalletStoreState.lastCompletedTxHash = '0xhash';
    getExplorerTxUrlMock.mockReturnValue('https://devnet.midenscan.com/tx/0xhash');

    const { container, root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

    expect(getExplorerTxUrlMock).toHaveBeenCalledWith('0xhash');

    // The success receipt (which owns the "View on Midenscan" button) is shown
    // after SUCCESS_RECEIPT_DELAY_MS (1500ms).
    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    await flush();

    const button = Array.from(container.querySelectorAll('button')).find(
      btn => btn.getAttribute('aria-label') === 'viewOnMidenscan'
    ) as HTMLButtonElement | undefined;
    expect(button).toBeTruthy();
    act(() => {
      button!.click();
    });

    expect(openExternalUrlMock).toHaveBeenCalledWith({
      url: 'https://devnet.midenscan.com/tx/0xhash',
      title: 'Midenscan'
    });
    act(() => root.unmount());
  });

  // The success receipt's hash (and its "View on Midenscan" link) must come
  // from the row this page tracks, not from the module-global store slot: that
  // slot is written only for a row that HAS a transactionId and is cleared only
  // on entering /send or the swap flow, so a receipt dismissed with Done leaves
  // the previous transaction's hash behind for the next one to inherit.
  it("prefers the tracked row's transactionId over a leftover store hash", async () => {
    mockRowState = { row: makeTx({ status: 2, transactionId: '0xrow' }), loaded: true };
    mockWalletStoreState.lastCompletedTxHash = '0xpreviousSend';
    getExplorerTxUrlMock.mockReturnValue('https://devnet.midenscan.com/tx/0xrow');

    const { root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

    expect(getExplorerTxUrlMock).toHaveBeenCalledWith('0xrow');
    expect(getExplorerTxUrlMock).not.toHaveBeenCalledWith('0xpreviousSend');
    act(() => root.unmount());
  });

  // A consume completed by a path with no TransactionResult to stamp an id from
  // leaves `transactionId` undefined; without this clear, the receipt would fall
  // back to the previous transaction's hash.
  it('clears a leftover completed-tx hash when it starts tracking a row', async () => {
    mockRowState = { row: makeTx({ status: 1, stage: 'submitting' }), loaded: true };
    mockWalletStoreState.lastCompletedTxHash = '0xpreviousSend';

    const { root } = await mount(<GeneratingTransactionPage txId="tx-consume" />);

    expect(mockWalletStoreState.setLastCompletedTxHash).toHaveBeenCalledWith(null);
    act(() => root.unmount());
  });

  it('does not auto-navigate home when the row reaches a terminal state', async () => {
    navigateMock.mockClear();
    window.location.hash = '#/generating-transaction/tx-1';
    mockRowState = { row: makeTx({ stage: 'submitting' }), loaded: true };

    const { root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

    mockRowState = { row: makeTx({ status: 2, transactionId: '0xhash' }), loaded: true };
    await act(async () => {
      root.render(<GeneratingTransactionPage txId="tx-1" />);
    });
    await flush();

    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    await flush();

    expect(navigateMock).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});

describe('GeneratingTransaction stage + state rendering', () => {
  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  const renderInto = async (element: React.ReactElement) => {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(element);
    });
    return { container, root };
  };

  it.each([
    ['syncing', undefined, 'transactionStageSyncing', 'transactionStageSyncingDescription'],
    ['sending', 'send', 'transactionStageSending', 'transactionStageSendingDescription'],
    ['sending', 'consume', 'transactionStageClaiming', 'transactionStageSendingDescription'],
    ['sending', 'execute', 'transactionStageExecuting', 'transactionStageSendingDescription'],
    ['sending', 'switch-guardian', 'transactionStageSwitching', 'transactionStageSendingDescription'],
    ['creating-proposal', 'send', 'transactionStageCreatingProposal', 'transactionStageCreatingProposalDescription'],
    ['signing-proposal', 'send', 'transactionStageSigningProposal', 'transactionStageSigningProposalDescription'],
    ['submitting', 'send', 'transactionStageSubmitting', 'transactionStageSubmittingDescription'],
    ['confirming', undefined, 'transactionStageConfirming', 'transactionStageConfirmingDescription'],
    [
      'registering-guardian',
      'switch-guardian',
      'transactionStageRegisteringGuardian',
      'transactionStageRegisteringGuardianDescription'
    ],
    ['delivering', undefined, 'transactionStageDelivering', 'transactionStageDeliveringDescription']
  ])('renders stage %s (type=%s) with correct labels', async (stage, type, titleKey, descKey) => {
    const { container, root } = await renderInto(
      <GeneratingTransaction
        isGuardian={true}
        onDoneClick={() => {}}
        transactionComplete={false}
        activeStage={stage as any}
        activeType={type as any}
      />
    );
    expect(container.textContent).toContain(titleKey);
    expect(container.textContent).toContain(descKey);
    act(() => root.unmount());
  });

  // `transactionSuccessDescription` reads "successfully processed and CONFIRMED
  // ON THE NETWORK" — the one fact an unconfirmed rotation means the wallet
  // never established. This screen holds it in an announced live region for the
  // 1.5s before the careful receipt mounts, so the receipt's qualification was
  // being contradicted by the screen the user was already reading.
  it('does not claim network confirmation for a guardian switch that was only submitted', async () => {
    const { container, root } = await renderInto(
      <GeneratingTransaction
        isGuardian={true}
        onDoneClick={() => {}}
        transactionComplete={true}
        activeType="switch-guardian"
        activeTransaction={
          // Completed status: the flag is only ever written by the completion
          // handler, and the verdict this screen consults keys on it.
          { type: 'switch-guardian', status: 2, extraInputs: { commitUnconfirmed: true } } as never
        }
      />
    );
    expect(container.textContent).toContain('transactionSubmittedUnconfirmedDescription');
    expect(container.textContent).not.toContain('transactionSuccessDescription');
    act(() => root.unmount());
  });

  it('still claims confirmation for a guardian switch whose commit WAS confirmed', async () => {
    const { container, root } = await renderInto(
      <GeneratingTransaction
        isGuardian={true}
        onDoneClick={() => {}}
        transactionComplete={true}
        activeType="switch-guardian"
        activeTransaction={{ type: 'switch-guardian', extraInputs: { commitUnconfirmed: false } } as never}
      />
    );
    expect(container.textContent).toContain('transactionSuccessDescription');
    expect(container.textContent).not.toContain('transactionSubmittedUnconfirmedDescription');
    act(() => root.unmount());
  });

  it('renders fallback labels when no activeStage', async () => {
    const { container, root } = await renderInto(
      <GeneratingTransaction isGuardian={true} onDoneClick={() => {}} transactionComplete={false} />
    );
    expect(container.textContent).toContain('generatingTransaction');
    expect(container.textContent).toContain('generatingTransactionDescription');
    const helper = Array.from(container.querySelectorAll('p')).find(
      paragraph =>
        paragraph.textContent === 'generatingTransactionDescription' && paragraph.classList.contains('font-bold')
    );
    expect(helper).toHaveClass('text-ink');
    expect(helper).not.toHaveClass('dark:text-white');
    act(() => root.unmount());
  });

  it('renders the backend step immediately when the backend stage starts ahead', async () => {
    const { container, root } = await renderInto(
      <GeneratingTransaction
        isGuardian={true}
        onDoneClick={() => {}}
        transactionComplete={false}
        activeStage="submitting"
      />
    );
    const stepStates = () =>
      Array.from(container.querySelectorAll('[data-transaction-step]')).map(row => row.getAttribute('data-state'));
    const activeSpinner = () =>
      container.querySelector('[data-transaction-step][data-state="active"] [data-testid="flow-spinner"]');

    expect(stepStates()).toEqual(['complete', 'complete', 'active', 'pending']);
    // The spin is a CSS transform animation on the HTML wrapper, so WebKit runs it on the GPU.
    expect(activeSpinner()?.className).toContain('animate-[spin_0.9s_linear_infinite]');
    act(() => root.unmount());
  });

  it('a Queued row waiting on a busy Guardian says so, and its first step waits instead of spinning (#312)', async () => {
    const { container, root } = await renderInto(
      <GeneratingTransaction
        isGuardian={true}
        onDoneClick={() => {}}
        transactionComplete={false}
        activeStage="creating-proposal"
        activeType="send"
        activeTransaction={
          makeTx({ status: ITransactionStatus.Queued, stage: 'creating-proposal', guardianBusy: true }) as never
        }
      />
    );
    const rows = Array.from(container.querySelectorAll('[data-transaction-step]'));

    expect(rows.map(row => row.getAttribute('data-state'))).toEqual(['pending', 'pending', 'pending', 'pending']);
    expect(rows[0]?.textContent).toContain('guardianBusyStep');
    expect(container.querySelector('[data-transaction-step] [data-testid="flow-spinner"]')).toBeNull();
    const helper = Array.from(container.querySelectorAll('p')).find(paragraph =>
      paragraph.classList.contains('font-bold')
    );
    expect(helper?.textContent).toBe('guardianBusyDescription');
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain('guardianBusyDescription');
    expect(container.textContent).not.toContain('generatingTransactionDescription');
    act(() => root.unmount());
  });

  it('a row being processed shows the working step and the usual copy, whatever its busy mark says (#312)', async () => {
    const { container, root } = await renderInto(
      <GeneratingTransaction
        isGuardian={true}
        onDoneClick={() => {}}
        transactionComplete={false}
        activeStage="creating-proposal"
        activeType="send"
        activeTransaction={
          makeTx({
            status: ITransactionStatus.GeneratingTransaction,
            stage: 'creating-proposal',
            guardianBusy: true
          }) as never
        }
      />
    );
    const rows = Array.from(container.querySelectorAll('[data-transaction-step]'));

    expect(rows.map(row => row.getAttribute('data-state'))).toEqual(['active', 'pending', 'pending', 'pending']);
    expect(rows[0]?.textContent).toContain('transactionStepGuardianApproved');
    expect(container.textContent).toContain('generatingTransactionDescription');
    expect(container.textContent).not.toContain('guardianBusy');
    act(() => root.unmount());
  });

  // The commit wait and relay of a private send ran under "Syncing with Guardian", which read as a 5 s Guardian
  // sync (#1492). They are a step of their own, and the sync finishing ticks the sync step only.
  it.each(['guardian-synced', 'confirming', 'delivering'])(
    'shows a private Guardian send at %s on its delivery step, past a finished Guardian sync (#1492)',
    async stage => {
      const { container, root } = await renderInto(
        <GeneratingTransaction
          isGuardian={true}
          onDoneClick={() => {}}
          transactionComplete={false}
          activeStage={stage as any}
          activeType="send"
          activeTransaction={makeTx({ stage, noteType: 'private' }) as never}
        />
      );
      const rows = Array.from(container.querySelectorAll('[data-transaction-step]'));

      expect(rows.map(row => row.getAttribute('data-transaction-step'))).toEqual([
        'guardian-approving',
        'generating-proof',
        'submitting',
        'syncing-guardian',
        'delivering-note'
      ]);
      expect(rows.map(row => row.getAttribute('data-state'))).toEqual([
        'complete',
        'complete',
        'complete',
        'complete',
        'active'
      ]);
      expect(rows[4]?.textContent).toContain('transactionStepDeliveringNote');
      act(() => root.unmount());
    }
  );

  it('reads each step in seconds with one fraction digit (#2060)', async () => {
    const { container, root } = await renderInto(
      <GeneratingTransaction
        isGuardian={true}
        onDoneClick={() => {}}
        transactionComplete
        activeType="consume"
        activeTransaction={
          makeTx({
            status: ITransactionStatus.Completed,
            stage: 'complete',
            stageTimestamps: {
              'creating-proposal': 0,
              executing: 2_345,
              proving: 3_000,
              submitting: 4_000,
              'guardian-syncing': 5_000,
              complete: 6_000
            }
          }) as never
        }
      />
    );
    const rows = Array.from(container.querySelectorAll('[data-transaction-step]'));

    expect(rows[0]?.textContent).toContain('transactionStepDurationSec 2.3');
    expect(rows[1]?.textContent).toContain('transactionStepDurationSec 1.7');
    act(() => root.unmount());
  });

  it('times both the Guardian sync and the delivery of a completed private send', async () => {
    const { container, root } = await renderInto(
      <GeneratingTransaction
        isGuardian={true}
        onDoneClick={() => {}}
        transactionComplete
        activeType="send"
        activeTransaction={
          makeTx({
            status: ITransactionStatus.Completed,
            stage: 'complete',
            noteType: 'private',
            stageTimestamps: { 'guardian-syncing': 2_600, confirming: 2_950, complete: 8_300 }
          }) as never
        }
      />
    );
    const rows = Array.from(container.querySelectorAll('[data-transaction-step]'));

    expect(rows).toHaveLength(5);
    expect(rows[3]?.textContent).toContain('transactionStepDurationSec');
    expect(rows[4]?.textContent).toContain('transactionStepDurationSec');
    act(() => root.unmount());
  });

  it('keeps a public Guardian send on the four steps, with the Guardian sync last', async () => {
    const { container, root } = await renderInto(
      <GeneratingTransaction
        isGuardian={true}
        onDoneClick={() => {}}
        transactionComplete={false}
        activeStage="guardian-syncing"
        activeType="send"
        activeTransaction={makeTx({ stage: 'guardian-syncing', noteType: 'public' }) as never}
      />
    );
    const rows = Array.from(container.querySelectorAll('[data-transaction-step]'));

    expect(rows.map(row => row.getAttribute('data-transaction-step'))).toEqual([
      'guardian-approving',
      'generating-proof',
      'submitting',
      'syncing-guardian'
    ]);
    expect(rows.map(row => row.getAttribute('data-state'))).toEqual(['complete', 'complete', 'complete', 'active']);
    act(() => root.unmount());
  });

  // An execute with private outputs waits for the commit and relays its notes after the Guardian sync too, and its
  // stamps say so when the best-effort delivery record was not written.
  it.each([undefined, 'pending'])(
    'shows a Guardian execute row at confirming on its delivery step (noteDelivery %s)',
    async noteDelivery => {
      const { container, root } = await renderInto(
        <GeneratingTransaction
          isGuardian={true}
          onDoneClick={() => {}}
          transactionComplete={false}
          activeStage="confirming"
          activeType="execute"
          activeTransaction={
            makeTx({ type: 'execute', stage: 'confirming', stageTimestamps: { confirming: 1 }, noteDelivery }) as never
          }
        />
      );
      const rows = Array.from(container.querySelectorAll('[data-transaction-step]'));

      expect(rows.map(row => row.getAttribute('data-transaction-step'))).toEqual([
        'guardian-approving',
        'generating-proof',
        'submitting',
        'syncing-guardian',
        'delivering-note'
      ]);
      expect(rows.map(row => row.getAttribute('data-state'))).toEqual([
        'complete',
        'complete',
        'complete',
        'complete',
        'active'
      ]);
      act(() => root.unmount());
    }
  );

  // A rotation waits for its own commit at 'confirming' and relays nothing, so that wait stays its last step.
  it('keeps a replace-hot-key row waiting for its commit on the four steps', async () => {
    const { container, root } = await renderInto(
      <GeneratingTransaction
        isGuardian={true}
        onDoneClick={() => {}}
        transactionComplete={false}
        activeStage="confirming"
        activeType="replace-hot-key"
        activeTransaction={
          makeTx({ type: 'replace-hot-key', stage: 'confirming', stageTimestamps: { confirming: 1 } }) as never
        }
      />
    );
    const rows = Array.from(container.querySelectorAll('[data-transaction-step]'));

    expect(rows.map(row => row.getAttribute('data-transaction-step'))).toEqual([
      'guardian-approving',
      'generating-proof',
      'submitting',
      'syncing-guardian'
    ]);
    expect(rows.map(row => row.getAttribute('data-state'))).toEqual(['complete', 'complete', 'complete', 'active']);
    act(() => root.unmount());
  });

  it.each(['confirming', 'delivering'])('keeps a standard row at %s on its last step', async stage => {
    const { container, root } = await renderInto(
      <GeneratingTransaction
        onDoneClick={() => {}}
        transactionComplete={false}
        isGuardian={false}
        activeStage={stage as any}
        activeType="send"
        activeTransaction={makeTx({ stage, noteType: 'private' }) as never}
      />
    );
    const rows = Array.from(container.querySelectorAll('[data-transaction-step]'));

    expect(rows.map(r => r.getAttribute('data-transaction-step'))).toEqual(['generating-proof', 'submitting']);
    expect(rows.map(r => r.getAttribute('data-state'))).toEqual(['complete', 'active']);
    act(() => root.unmount());
  });

  it('non-guardian send shows only the generic proof + submit steps', async () => {
    const { container, root } = await renderInto(
      <GeneratingTransaction
        onDoneClick={() => {}}
        transactionComplete={false}
        isGuardian={false}
        activeStage="submitting"
      />
    );
    const rows = Array.from(container.querySelectorAll('[data-transaction-step]'));
    expect(rows.map(r => r.getAttribute('data-transaction-step'))).toEqual(['generating-proof', 'submitting']);
    expect(rows.map(r => r.getAttribute('data-state'))).toEqual(['complete', 'active']);
    act(() => root.unmount());
  });

  const stepsCardFor = async (activeType: 'earn-deposit' | 'send') => {
    const { container, root } = await renderInto(
      <GeneratingTransaction
        onDoneClick={() => {}}
        transactionComplete={false}
        isGuardian={false}
        activeStage="submitting"
        activeType={activeType}
      />
    );
    const card = container.querySelector('[data-transaction-step]')?.parentElement;
    expect(card).toBeTruthy();
    return { card: card!, root };
  };

  it("draws an earn-deposit row's steps on the outline surface, in the heading face", async () => {
    const { card, root } = await stepsCardFor('earn-deposit');

    expect(card).toHaveClass('bg-page', 'border', 'border-hairline', 'face-heading');
    expect(card).not.toHaveClass('bg-fill');
    act(() => root.unmount());
  });

  it("keeps a send row's steps on the fill card, in the default face", async () => {
    const { card, root } = await stepsCardFor('send');

    expect(card).toHaveClass('bg-fill');
    expect(card).not.toHaveClass('bg-page');
    expect(card).not.toHaveClass('border-hairline');
    expect(card).not.toHaveClass('face-heading');
    act(() => root.unmount());
  });

  it('renders per-step durations from persisted stage timestamps (no fabricated zero)', async () => {
    const { container, root } = await renderInto(
      <GeneratingTransaction
        onDoneClick={() => {}}
        transactionComplete
        isGuardian={false}
        activeTransaction={
          { type: 'send', stageTimestamps: { proving: 1_000, submitting: 3_000, complete: 3_500 } } as any
        }
      />
    );
    const rows = Array.from(container.querySelectorAll('[data-transaction-step]'));
    // generating-proof: submitting(3000) - proving(1000); submitting: complete(3500) - submitting(3000).
    // The mocked t() echoes the key, so a rendered duration surfaces as 'transactionStepDurationSec'.
    expect(rows[0]?.textContent).toContain('transactionStepDurationSec');
    expect(rows[1]?.textContent).toContain('transactionStepDurationSec');
    act(() => root.unmount());
  });

  it('omits a step duration when a boundary stamp is missing (never shows 0 sec)', async () => {
    const { container, root } = await renderInto(
      <GeneratingTransaction
        onDoneClick={() => {}}
        transactionComplete
        isGuardian={false}
        // No `proving` stamp → generating-proof has no start boundary; only submit is timed.
        activeTransaction={{ type: 'send', stageTimestamps: { submitting: 3_000, complete: 3_500 } } as any}
      />
    );
    const rows = Array.from(container.querySelectorAll('[data-transaction-step]'));
    expect(rows[0]?.textContent).not.toContain('transactionStepDurationSec');
    expect(rows[1]?.textContent).toContain('transactionStepDurationSec');
    act(() => root.unmount());
  });

  it('renders success state when transactionComplete + no errors', async () => {
    const { container, root } = await renderInto(
      <GeneratingTransaction isGuardian={true} onDoneClick={() => {}} transactionComplete hasErrors={false} />
    );
    // No completed transaction data → the generic success title (send-typed
    // transactions get "Payment Sent!"). The redesigned screen has no header
    // title and no description paragraph.
    expect(container.textContent).toContain('transactionComplete');
    act(() => root.unmount());
  });

  it('renders failure state with single-failure description', async () => {
    const { container, root } = await renderInto(
      <GeneratingTransaction isGuardian={true} onDoneClick={() => {}} transactionComplete hasErrors />
    );
    expect(container.textContent).toContain('transactionFailed');
    expect(container.textContent).toContain('transactionErrorDescription');
    act(() => root.unmount());
  });

  // #483 — a failed tx must offer a direct route to its Activity detail, like
  // the success views already do; success routes through TransactionSuccess.
  it('links a failed transaction to its Activity detail', async () => {
    const navigateMock = jest.requireMock('lib/woozie').navigate as jest.Mock;
    navigateMock.mockClear();
    const { container, root } = await renderInto(
      <GeneratingTransaction
        isGuardian={false}
        onDoneClick={() => {}}
        transactionComplete
        hasErrors
        completedTransaction={{ id: 'tx-failed-1', type: 'swap' } as never}
      />
    );
    const viewBtn = Array.from(container.querySelectorAll('button')).find(button =>
      button.textContent?.includes('viewInActivities')
    );
    expect(viewBtn).toBeDefined();
    act(() => viewBtn!.click());
    expect(navigateMock).toHaveBeenCalledWith('/history-details/tx-failed-1');
    act(() => root.unmount());
  });

  it("labels Done in the secondary button's own color once Retry takes the primary slot", async () => {
    const { container, root } = await renderInto(
      <GeneratingTransaction
        isGuardian={false}
        onDoneClick={() => {}}
        transactionComplete
        hasErrors
        canRetry
        onRetry={() => {}}
      />
    );
    const doneBtn = Array.from(container.querySelectorAll('button')).find(button =>
      button.textContent?.includes('done')
    );
    expect(doneBtn).toHaveAttribute('data-variant', 'secondary');
    // White would vanish on the light secondary fill; the label is plain text now, styled by
    // the variant itself (no wrapping span carrying a stray white-text override), and the
    // className the caller passes carries no color override of its own — className is now
    // forwarded by the mock, so this actually exercises the real prop.
    expect(doneBtn?.querySelector('span')).toBeNull();
    expect(doneBtn?.className ?? '').not.toMatch(/text-pure-white/);
    act(() => root.unmount());
  });

  it('does not show the Activity link on a successful (non-failed) transaction', async () => {
    const { container, root } = await renderInto(
      <GeneratingTransaction isGuardian={false} onDoneClick={() => {}} transactionComplete hasErrors={false} />
    );
    const viewBtn = Array.from(container.querySelectorAll('button')).find(button =>
      button.textContent?.includes('viewInActivities')
    );
    expect(viewBtn).toBeUndefined();
    act(() => root.unmount());
  });

  it('renders the View on Midenscan button and wires it to onViewExplorer on success', async () => {
    jest.useFakeTimers();
    const onViewExplorer = jest.fn();
    const { container, root } = await renderInto(
      <GeneratingTransaction
        isGuardian={true}
        onDoneClick={() => {}}
        transactionComplete
        hasErrors={false}
        completedTxHash="0x84e3d459"
        onViewExplorer={onViewExplorer}
      />
    );

    // The success receipt is shown after SUCCESS_RECEIPT_DELAY_MS (1500ms).
    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });

    const button = Array.from(container.querySelectorAll('button')).find(
      btn => btn.getAttribute('aria-label') === 'viewOnMidenscan'
    ) as HTMLButtonElement;
    expect(button).not.toBeNull();
    act(() => {
      button.click();
    });
    expect(onViewExplorer).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    jest.useRealTimers();
  });

  it('omits the View on Midenscan button when no onViewExplorer is provided', async () => {
    const { container, root } = await renderInto(
      <GeneratingTransaction isGuardian={true} onDoneClick={() => {}} transactionComplete hasErrors={false} />
    );
    expect(container.textContent).not.toContain('viewOnMidenscan');
    act(() => root.unmount());
  });

  it('omits the View on Midenscan button on failure even when onViewExplorer is provided', async () => {
    const { container, root } = await renderInto(
      <GeneratingTransaction
        isGuardian={true}
        onDoneClick={() => {}}
        transactionComplete
        hasErrors
        onViewExplorer={jest.fn()}
      />
    );
    expect(container.textContent).not.toContain('viewOnMidenscan');
    act(() => root.unmount());
  });

  it('renders the "navigate home" warning alert when keepOpen is true (desktop, in-flight)', async () => {
    const { container, root } = await renderInto(
      <GeneratingTransaction isGuardian={true} onDoneClick={() => {}} transactionComplete={false} keepOpen />
    );
    expect(container.textContent).toContain('doNotCloseWindowNavigateHome');
    act(() => root.unmount());
  });

  it('renders the "auto-close" warning alert when keepOpen is false (desktop, in-flight)', async () => {
    const { container, root } = await renderInto(
      <GeneratingTransaction isGuardian={true} onDoneClick={() => {}} transactionComplete={false} keepOpen={false} />
    );
    expect(container.textContent).toContain('doNotCloseWindowAutoClose');
    act(() => root.unmount());
  });
});

describe('user-visible transaction errors', () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;
  beforeEach(() => {
    jest.useFakeTimers();
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    jest.mocked(reportUserVisibleError).mockClear();
    safeGenerateTransactionsLoopMock.mockReturnValue(true);
    requeueFailedTransactionMock.mockReset();
    isRequeueableTransactionMock.mockReturnValue(true);
    mockAcknowledgementOf.mockReturnValue(null);
    mockRowState = { row: makeTx({ status: ITransactionStatus.Queued }), loaded: true };
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    jest.useRealTimers();
    jest.restoreAllMocks();
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  });
  const renderPage = async () => {
    await act(async () => {
      root.render(<GeneratingTransactionPage txId="tx-1" />);
    });
  };
  it('carries the current unanswered branch through the status screen', async () => {
    mockRowState = {
      row: makeTx({
        status: ITransactionStatus.Unconfirmed,
        stage: 'submitting',
        error: 'Guardian request to https://private.invalid timed out after 10 ms'
      }),
      loaded: true
    };
    await renderPage();
    act(() => jest.advanceTimersByTime(1000));
    expect(reportUserVisibleError).toHaveBeenCalledWith('submissionUnanswered', 'status_screen', {
      kind: 'submission_feedback',
      submissionFeedbackBranch: 'guardian_unanswered'
    });
  });
  it('reports the latest selected branch without restarting an unanswered dwell', async () => {
    mockRowState = {
      row: makeTx({
        status: ITransactionStatus.Unconfirmed,
        stage: 'submitting',
        error: 'Guardian request to https://private.invalid timed out after 10 ms'
      }),
      loaded: true
    };
    await renderPage();
    act(() => jest.advanceTimersByTime(999));
    mockRowState = {
      row: makeTx({ status: ITransactionStatus.Unconfirmed, stage: 'submitting', error: 'timed out' }),
      loaded: true
    };
    await renderPage();
    act(() => jest.advanceTimersByTime(1));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([
      ['submissionUnanswered', 'status_screen', { kind: 'submission_feedback', submissionFeedbackBranch: 'no_answer' }]
    ]);
  });
  const failRow = () => {
    mockRowState = {
      row: makeTx({
        status: ITransactionStatus.Failed,
        error: 'private row reason 123 https://private.invalid',
        rawError: 'private raw detail'
      }),
      loaded: true
    };
  };
  const expectDwell = (id: string, surface: string) => {
    act(() => jest.advanceTimersByTime(999));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([[id, surface]]);
    act(() => jest.advanceTimersByTime(1000));
    expect(reportUserVisibleError).toHaveBeenCalledTimes(1);
  };

  it('reports a mounted Queued to Failed transition once for its visible and announced presentations', async () => {
    await renderPage();
    failRow();
    await renderPage();
    expect(container.textContent).toContain('transactionFailed');
    expect(container.textContent).toContain('private row reason 123 https://private.invalid');
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain('private row reason');
    expectDwell('raw_transaction_failed', 'status_screen');
    mockRowState.row = { ...mockRowState.row, error: 'changed private reason' };
    await renderPage();
    act(() => jest.advanceTimersByTime(2000));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['raw_transaction_failed', 'status_screen']]);
  });

  it.each(['initial', 'asynchronous', 'reopen'])('does not report a persisted failed row: %s', async mode => {
    if (mode === 'asynchronous') {
      mockRowState = { row: undefined, loaded: false };
      await renderPage();
      act(() => jest.advanceTimersByTime(2000));
    }
    failRow();
    await renderPage();
    if (mode === 'reopen') {
      act(() => root.unmount());
      root = createRoot(container);
      await renderPage();
    }
    expect(container.textContent).toContain('transactionFailed');
    act(() => jest.advanceTimersByTime(2000));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });

  it('reports when the first asynchronously loaded nonfailed row subsequently fails', async () => {
    mockRowState = { row: undefined, loaded: false };
    await renderPage();
    mockRowState = { row: makeTx({ status: ITransactionStatus.Queued }), loaded: true };
    await renderPage();
    failRow();
    await renderPage();
    expect(container.textContent).toContain('transactionFailed');
    expectDwell('raw_transaction_failed', 'status_screen');
  });

  it.each(['clear', 'unmount'])('does not report a watched failure removed before dwell: %s', async mode => {
    await renderPage();
    failRow();
    await renderPage();
    expect(container.textContent).toContain('transactionFailed');
    act(() => jest.advanceTimersByTime(999));
    if (mode === 'clear') {
      mockRowState = { row: makeTx({ status: ITransactionStatus.Queued }), loaded: true };
      await renderPage();
    } else {
      act(() => root.unmount());
      root = createRoot(container);
    }
    act(() => jest.advanceTimersByTime(2000));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });

  it.each(['loading', 'missing', 'queued', 'unconfirmed', 'completed'])('keeps %s state silent', async mode => {
    const statuses: Record<string, ITransactionStatus> = {
      queued: ITransactionStatus.Queued,
      unconfirmed: ITransactionStatus.Unconfirmed,
      completed: ITransactionStatus.Completed
    };
    mockRowState =
      mode === 'loading' || mode === 'missing'
        ? { row: undefined, loaded: mode === 'missing' }
        : { row: makeTx({ status: statuses[mode] }), loaded: true };
    await renderPage();
    act(() => jest.advanceTimersByTime(2000));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });

  it('cancels a retry failure report when a second retry starts before dwell', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    requeueFailedTransactionMock.mockRejectedValueOnce(new Error('private retry'));
    failRow();
    await renderPage();
    const retry = () => Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'retry');
    await act(async () => {
      retry()!.click();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('private retry');
    act(() => jest.advanceTimersByTime(999));
    requeueFailedTransactionMock.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => {
      retry()!.click();
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    act(() => jest.advanceTimersByTime(2000));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });

  it('reports neither a failure nor a refusal for a refused row it shows as not confirmed (#2060)', async () => {
    await renderPage();
    mockRowState = {
      row: makeTx({
        status: ITransactionStatus.Failed,
        stage: 'submitting',
        mayHaveSubmitted: true,
        error: networkRefusal,
        submitEvidence: [checkableEntry]
      }),
      loaded: true
    };
    await renderPage();
    expect(container.querySelector('h2')?.textContent).toBe('notConfirmed');
    act(() => jest.advanceTimersByTime(2000));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });

  it('reports no failure for a Failed row it shows as not confirmed (#2060)', async () => {
    await renderPage();
    mockRowState = {
      row: makeTx({ status: ITransactionStatus.Failed, stage: 'sending', error: TRANSACTION_STUCK_ERROR }),
      loaded: true
    };
    await renderPage();
    expect(container.querySelector('h2')?.textContent).toBe('notConfirmed');
    act(() => jest.advanceTimersByTime(2000));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });

  it('reports the refusal and the failure it shows once the row turns Failed (#2060)', async () => {
    await renderPage();
    const refused = makeTx({
      status: ITransactionStatus.Failed,
      stage: 'submitting',
      mayHaveSubmitted: true,
      error: networkRefusal
    });
    mockRowState = {
      row: { ...refused, submitEvidence: [checkableEntry] },
      loaded: true
    };
    await renderPage();
    act(() => jest.advanceTimersByTime(2000));
    mockRowState = {
      row: { ...refused, submitEvidence: [{ ...checkableEntry, verdict: 'never-committed' }] },
      loaded: true
    };
    await renderPage();
    expect(container.querySelector('h2')?.textContent).toBe('transactionFailed');
    act(() => jest.advanceTimersByTime(2000));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual(
      expect.arrayContaining([
        ['raw_transaction_failed', 'status_screen'],
        ['submissionRejectedByNetwork', 'status_screen']
      ])
    );
  });

  it('reports the reason attached to the displayed status retry refusal', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const { annotatePendingRetry } = jest.requireActual<typeof import('lib/telemetry/ui-producer-diagnostics')>(
      'lib/telemetry/ui-producer-diagnostics'
    );
    const failure = new Error('private retry failure');
    annotatePendingRetry(failure, 'guardian_hold');
    requeueFailedTransactionMock.mockRejectedValueOnce(failure);
    failRow();
    await renderPage();
    const retry = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'retry');
    await act(async () => {
      retry!.click();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('private retry failure');
    act(() => jest.advanceTimersByTime(1000));
    expect(reportUserVisibleError).toHaveBeenCalledWith('raw_transaction_retry_failed', 'inline', {
      kind: 'transaction_retry',
      retryNoticeOrigin: 'status_screen',
      pendingRetryReason: 'guardian_hold'
    });
    expect(requeueFailedTransactionMock).toHaveBeenCalledTimes(1);
  });

  it('does not report retry evidence from a previous transaction after switching rows', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    requeueFailedTransactionMock.mockRejectedValueOnce(new Error('previous row refusal'));
    failRow();
    await renderPage();
    const retry = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'retry');
    await act(async () => {
      retry!.click();
    });
    act(() => jest.advanceTimersByTime(999));
    mockRowState = { row: makeTx({ id: 'tx-2', status: ITransactionStatus.Failed }), loaded: true };
    await act(async () => {
      root.render(<GeneratingTransactionPage txId="tx-2" />);
    });
    act(() => jest.advanceTimersByTime(2000));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });

  it.each(['raw', 'fee', 'fallback'])(
    'reports a user-triggered %s retry failure on a persisted failed row',
    async kind => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const { ClaimFeeRefusedError } = jest.requireActual<typeof import('lib/miden/transaction/initiate')>(
        'lib/miden/transaction/initiate'
      );
      mockFeeCopy = 'private translated fee refusal';
      const failure =
        kind === 'fee'
          ? new ClaimFeeRefusedError()
          : kind === 'raw'
            ? new Error('private retry https://private.invalid 123')
            : 'private untyped refusal';
      requeueFailedTransactionMock.mockRejectedValueOnce(failure);
      failRow();
      await renderPage();
      act(() => jest.advanceTimersByTime(2000));
      expect(reportUserVisibleError).not.toHaveBeenCalled();
      const retry = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'retry');
      expect(retry).toBeDefined();
      await act(async () => {
        retry!.click();
      });
      const text =
        kind === 'fee' ? mockFeeCopy : kind === 'raw' ? 'private retry https://private.invalid 123' : 'smthWentWrong';
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(text);
      act(() => jest.advanceTimersByTime(1000));
      const args =
        kind === 'raw'
          ? [
              'raw_transaction_retry_failed',
              'inline',
              { kind: 'transaction_retry', retryNoticeOrigin: 'status_screen', pendingRetryReason: 'unexpected' }
            ]
          : [kind === 'fee' ? 'insufficientFeeAsset' : 'smthWentWrong', 'inline'];
      expect(reportUserVisibleError).toHaveBeenCalledWith(...args);
    }
  );
});
