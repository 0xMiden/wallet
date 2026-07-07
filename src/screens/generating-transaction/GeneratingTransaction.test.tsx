import React from 'react';

import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { GeneratingTransaction, GeneratingTransactionPage } from './GeneratingTransaction';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/platform', () => ({
  isMobile: jest.fn(() => false),
  isExtension: jest.fn(() => false)
}));

jest.mock('app/atoms/CircularProgress', () => () => null);
jest.mock('components/Alert', () => ({
  Alert: ({ title }: { title: string }) => <div data-testid="alert">{title}</div>,
  AlertVariant: { Warning: 'Warning' }
}));
jest.mock('components/Button', () => ({ Button: () => null, ButtonVariant: {} }));
jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: { Success: 'Success', Failed: 'Failed', InProgress: 'InProgress' }
}));

const mockWalletStoreState = {
  assetsMetadata: {} as Record<string, any>,
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
  navigate: jest.fn()
}));

jest.mock('lib/settings/helpers', () => ({
  isAutoCloseEnabled: jest.fn(() => false)
}));

jest.mock('lib/analytics', () => ({
  useAnalytics: () => ({ pageEvent: jest.fn(), trackEvent: jest.fn() })
}));

jest.mock('lib/miden/front', () => ({
  useMidenContext: () => ({ signTransaction: jest.fn() })
}));

jest.mock('lib/miden/front/guardian-sync', () => ({
  zustandProvider: {}
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

const mutateTxMock = jest.fn();
// Key-aware SWR mock: the container calls useRetryableSWR twice — once with
// key ['all-latest-generating-transactions'] (in-flight txs) and once with
// ['all-failed-transactions'] (failed txs). These mutable vars let individual
// tests drive each effect; they default to [] so the existing tests are
// unaffected.
let swrGeneratingTxs: any[] = [];
let swrFailedTxs: any[] = [];
jest.mock('lib/swr', () => ({
  useRetryableSWR: (key: any[]) => {
    const which = Array.isArray(key) ? key[0] : key;
    if (which === 'all-failed-transactions') {
      return { data: swrFailedTxs, mutate: jest.fn() };
    }
    return { data: swrGeneratingTxs, mutate: mutateTxMock };
  }
}));

const safeGenerateTransactionsLoopMock = jest.fn();
const getAllUncompletedTransactionsMock = jest.fn(async () => [] as any[]);
const getFailedTransactionsMock = jest.fn(async () => [] as any[]);
const getTransactionByIdMock = jest.fn(async (_id: string) => {
  throw new Error('Transaction not found');
});
const waitForTransactionCompletionMock = jest.fn(async (_id: string) => ({
  errorMessage: 'Transaction not found'
}));
jest.mock('lib/miden/activity', () => ({
  safeGenerateTransactionsLoop: (...args: any[]) => safeGenerateTransactionsLoopMock(...args),
  getAllUncompletedTransactions: (...args: any[]) => getAllUncompletedTransactionsMock(...(args as [])),
  getFailedTransactions: (...args: any[]) => getFailedTransactionsMock(...(args as [])),
  getTransactionById: (...args: any[]) => getTransactionByIdMock(...(args as [string])),
  waitForTransactionCompletion: (...args: any[]) => waitForTransactionCompletionMock(...(args as [string]))
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

describe('GeneratingTransactionPage interval cleanup', () => {
  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    jest.useFakeTimers();
    mockWalletStoreState.lastCompletedTxHash = null;
    mockWalletStoreState.setLastCompletedTxHash.mockClear();
    mutateTxMock.mockClear();
    safeGenerateTransactionsLoopMock.mockReset();
    swrGeneratingTxs = [];
    swrFailedTxs = [];
    getAllUncompletedTransactionsMock.mockClear();
    getFailedTransactionsMock.mockClear();
    getTransactionByIdMock.mockReset();
    getTransactionByIdMock.mockRejectedValue(new Error('Transaction not found'));
    waitForTransactionCompletionMock.mockReset();
    waitForTransactionCompletionMock.mockResolvedValue({ errorMessage: 'Transaction not found' } as any);
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
      root.render(<GeneratingTransactionPage />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(setIntervalSpy).toHaveBeenCalled();

    const callsBefore = safeGenerateTransactionsLoopMock.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    // New behavior: loop continues processing even after failure
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
      root.render(<GeneratingTransactionPage />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(setIntervalSpy).toHaveBeenCalled();

    const callsBefore = safeGenerateTransactionsLoopMock.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    // New behavior: loop continues processing even after errors
    expect(safeGenerateTransactionsLoopMock.mock.calls.length).toBeGreaterThan(callsBefore);

    act(() => root.unmount());
  });

  it('clears the polling interval on unmount', async () => {
    safeGenerateTransactionsLoopMock.mockReturnValue(true);
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(<GeneratingTransactionPage />);
    });

    act(() => root.unmount());
    expect(clearIntervalSpy).toHaveBeenCalled();
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
    mockWalletStoreState.setLastCompletedTxHash.mockClear();
    mutateTxMock.mockClear();
    safeGenerateTransactionsLoopMock.mockReset();
    safeGenerateTransactionsLoopMock.mockReturnValue(true);
    swrGeneratingTxs = [];
    swrFailedTxs = [];
    getAllUncompletedTransactionsMock.mockClear();
    getFailedTransactionsMock.mockClear();
    getTransactionByIdMock.mockReset();
    getTransactionByIdMock.mockRejectedValue(new Error('Transaction not found'));
    waitForTransactionCompletionMock.mockReset();
    waitForTransactionCompletionMock.mockResolvedValue({ errorMessage: 'Transaction not found' } as any);
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

  const navigateMock = jest.requireMock('lib/woozie').navigate as jest.Mock;
  const isAutoCloseEnabledMock = jest.requireMock('lib/settings/helpers').isAutoCloseEnabled as jest.Mock;

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

  it('parses txId from the hash so the tracked tx becomes active', async () => {
    window.location.hash = '#/generating-transaction?txId=tx-1';
    swrGeneratingTxs = [makeTx({ id: 'tx-other' }), makeTx({ id: 'tx-1', stage: 'submitting' })];
    waitForTransactionCompletionMock.mockResolvedValue({ txHash: '0xabc' } as any);

    const { root } = await mount(<GeneratingTransactionPage />);

    expect(waitForTransactionCompletionMock).toHaveBeenCalledWith('tx-1');
    act(() => root.unmount());
  });

  it('falls back to window.location.search when there is no hash', async () => {
    window.location.hash = '';
    // jsdom default search is '' so trackedTransactionId is null; just exercise the path.
    swrGeneratingTxs = [makeTx({ id: 'tx-implicit', stage: 'syncing' })];

    const { root } = await mount(<GeneratingTransactionPage />);

    // No tracked id → waitForTransactionCompletion should NOT be called.
    expect(waitForTransactionCompletionMock).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('returns empty search when the hash is a malformed URL (try/catch)', async () => {
    // A hash whose path is not parseable as a relative URL against the origin
    // (`new URL('//[', origin)` throws) → the catch returns '' → no txId.
    window.location.hash = '#//[';
    swrGeneratingTxs = [];

    const { root } = await mount(<GeneratingTransactionPage />);

    // Malformed hash → search '' → no txId → no completion wait.
    expect(waitForTransactionCompletionMock).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('sets the implicit transaction id from the active tx when no txId in URL', async () => {
    window.location.hash = '#/generating-transaction';
    swrGeneratingTxs = [makeTx({ id: 'tx-implicit', stage: 'syncing' })];

    const { root } = await mount(<GeneratingTransactionPage />);

    // Implicit path: no tracked id, so waitForTransactionCompletion is not called,
    // but the active lookup + setImplicitTransactionId effect runs without error.
    expect(waitForTransactionCompletionMock).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('records the completed tx hash when the tracked tx resolves with a txHash', async () => {
    window.location.hash = '#/generating-transaction?txId=tx-1';
    swrGeneratingTxs = [makeTx({ id: 'tx-1', stage: 'submitting' })];
    waitForTransactionCompletionMock.mockResolvedValue({ txHash: '0xdeadbeef' } as any);

    const { root } = await mount(<GeneratingTransactionPage />);

    expect(mockWalletStoreState.setLastCompletedTxHash).toHaveBeenCalledWith('0xdeadbeef');
    act(() => root.unmount());
  });

  it('does not record a hash when the tracked tx resolves with an errorMessage', async () => {
    window.location.hash = '#/generating-transaction?txId=tx-1';
    swrGeneratingTxs = [makeTx({ id: 'tx-1', stage: 'submitting' })];
    waitForTransactionCompletionMock.mockResolvedValue({ errorMessage: 'failed' } as any);

    const { root } = await mount(<GeneratingTransactionPage />);

    expect(mockWalletStoreState.setLastCompletedTxHash).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('marks a failed transaction when the tracked tx id is in the failed list', async () => {
    window.location.hash = '#/generating-transaction?txId=tx-1';
    // The tracked tx is NOT in flight (queue empty) but IS in the failed list →
    // transactionComplete && hasErrors → failed header renders.
    swrGeneratingTxs = [];
    swrFailedTxs = [makeTx({ id: 'tx-1', status: 3 })];

    const { container, root } = await mount(<GeneratingTransactionPage />);

    expect(container.textContent).toContain('transactionFailed');
    act(() => root.unmount());
  });

  it('seeds the initial failed count on first run when there is no tracked id', async () => {
    window.location.hash = '#/generating-transaction';
    swrGeneratingTxs = [makeTx({ id: 'tx-implicit', stage: 'syncing' })];
    swrFailedTxs = [makeTx({ id: 'old-failure', status: 3 })];

    const { container, root } = await mount(<GeneratingTransactionPage />);

    // initialFailedCountRef seeded with 1; no NEW failures → not flagged as error.
    expect(container.textContent).not.toContain('transactionFailed');
    act(() => root.unmount());
  });

  it('flags a failure when the failed count increases beyond the initial count', async () => {
    window.location.hash = '#/generating-transaction';
    // No tracked id and queue empty → transactionComplete becomes true once the
    // new failure pushes hasFailedTransaction true → failed header renders.
    swrGeneratingTxs = [];
    swrFailedTxs = [];

    const { container, root } = await mount(<GeneratingTransactionPage />);
    expect(container.textContent).not.toContain('transactionFailed');

    // A new failure appears after the initial seed; re-render to push it through
    // the `failedTxs.length > initialFailedCountRef.current` branch.
    swrFailedTxs = [makeTx({ id: 'new-failure', status: 3 })];
    await act(async () => {
      root.render(<GeneratingTransactionPage />);
    });
    await flush();

    expect(container.textContent).toContain('transactionFailed');
    act(() => root.unmount());
  });

  it('loads the receipt transaction and records its hash once the queue empties', async () => {
    window.location.hash = '#/generating-transaction?txId=tx-1';
    swrGeneratingTxs = [makeTx({ id: 'tx-1', stage: 'submitting' })];
    getTransactionByIdMock.mockReset();
    getTransactionByIdMock.mockResolvedValue(makeTx({ id: 'tx-1', transactionId: '0xreceipt' }) as any);

    const { root } = await mount(<GeneratingTransactionPage />);

    // Queue empties → transactionComplete true → getTransactionById runs.
    swrGeneratingTxs = [];
    await act(async () => {
      root.render(<GeneratingTransactionPage />);
    });
    await flush();

    expect(getTransactionByIdMock).toHaveBeenCalledWith('tx-1');
    expect(mockWalletStoreState.setLastCompletedTxHash).toHaveBeenCalledWith('0xreceipt');
    act(() => root.unmount());
  });

  it('wires onViewExplorer to openExternalUrl when an explorer url is available', async () => {
    // Tracked tx already complete (queue empty), no errors, with a known hash and
    // an explorer url → the container passes onViewExplorer down to
    // TransactionSuccess, which renders the "View on Midenscan" button.
    window.location.hash = '#/generating-transaction?txId=tx-1';
    swrGeneratingTxs = [];
    mockWalletStoreState.lastCompletedTxHash = '0xhash';
    getExplorerTxUrlMock.mockReturnValue('https://devnet.midenscan.com/tx/0xhash');
    getTransactionByIdMock.mockReset();
    getTransactionByIdMock.mockResolvedValue(makeTx({ id: 'tx-1', transactionId: '0xhash' }) as any);

    const { container, root } = await mount(<GeneratingTransactionPage />);

    expect(getExplorerTxUrlMock).toHaveBeenCalledWith('0xhash');

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

  it('auto-closes (navigate home) when the tracked tx leaves flight and auto-close is enabled', async () => {
    window.location.hash = '#/generating-transaction?txId=tx-1';
    isAutoCloseEnabledMock.mockReturnValue(true);
    navigateMock.mockClear();
    swrGeneratingTxs = [makeTx({ id: 'tx-1', stage: 'submitting' })];

    const { root } = await mount(<GeneratingTransactionPage />);

    // Tx leaves flight (queue empties) → prevInFlight true → schedules auto-close.
    swrGeneratingTxs = [];
    await act(async () => {
      root.render(<GeneratingTransactionPage />);
    });
    await flush();

    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    await flush();

    expect(navigateMock).toHaveBeenCalledWith('/');
    isAutoCloseEnabledMock.mockReturnValue(false);
    act(() => root.unmount());
  });

  it('does not navigate on close when the hash is not on the generating-transaction route', async () => {
    // onClose early-returns when the hash does not include 'generating-transaction'.
    window.location.hash = '#/some-other-route?txId=tx-1';
    isAutoCloseEnabledMock.mockReturnValue(true);
    navigateMock.mockClear();
    swrGeneratingTxs = [makeTx({ id: 'tx-1', stage: 'submitting' })];

    const { root } = await mount(<GeneratingTransactionPage />);

    swrGeneratingTxs = [];
    await act(async () => {
      root.render(<GeneratingTransactionPage />);
    });
    await flush();

    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    await flush();

    // trackEvent still fired, but onClose early-returned → no navigate.
    expect(navigateMock).not.toHaveBeenCalled();
    isAutoCloseEnabledMock.mockReturnValue(false);
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

  it('renders fallback labels when no activeStage', async () => {
    const { container, root } = await renderInto(
      <GeneratingTransaction onDoneClick={() => {}} transactionComplete={false} />
    );
    expect(container.textContent).toContain('generatingTransaction');
    expect(container.textContent).toContain('generatingTransactionDescription');
    act(() => root.unmount());
  });

  it('advances visual steps gradually when the backend stage starts ahead', async () => {
    jest.useFakeTimers();
    let root: ReturnType<typeof createRoot> | undefined;

    try {
      const rendered = await renderInto(
        <GeneratingTransaction onDoneClick={() => {}} transactionComplete={false} activeStage="submitting" />
      );
      const { container } = rendered;
      root = rendered.root;
      const stepStates = () =>
        Array.from(container.querySelectorAll('[data-transaction-step]')).map(row => row.getAttribute('data-state'));
      const activeSpinner = () =>
        container.querySelector('[data-transaction-step][data-state="active"] svg') as SVGElement | null;

      expect(stepStates()).toEqual(['active', 'pending', 'pending', 'pending']);
      expect(activeSpinner()).toHaveClass('animate-spin');

      await act(async () => {
        jest.advanceTimersByTime(1_500);
      });

      expect(stepStates()).toEqual(['complete', 'active', 'pending', 'pending']);
      expect(activeSpinner()).toHaveClass('animate-spin');

      await act(async () => {
        jest.advanceTimersByTime(1_500);
      });

      expect(stepStates()).toEqual(['complete', 'complete', 'active', 'pending']);
      expect(activeSpinner()).toHaveClass('animate-spin');
    } finally {
      if (root) {
        act(() => root!.unmount());
      }
      jest.useRealTimers();
    }
  });

  it('renders success state when transactionComplete + no errors', async () => {
    const { container, root } = await renderInto(
      <GeneratingTransaction onDoneClick={() => {}} transactionComplete hasErrors={false} />
    );
    // No completed transaction data → the generic success title (send-typed
    // transactions get "Payment Sent!"). The redesigned screen has no header
    // title and no description paragraph.
    expect(container.textContent).toContain('transactionComplete');
    act(() => root.unmount());
  });

  it('renders failure state with single-failure description', async () => {
    const { container, root } = await renderInto(
      <GeneratingTransaction onDoneClick={() => {}} transactionComplete hasErrors />
    );
    expect(container.textContent).toContain('transactionFailed');
    expect(container.textContent).toContain('transactionErrorDescription');
    act(() => root.unmount());
  });

  it('renders the View on Midenscan button and wires it to onViewExplorer on success', async () => {
    const onViewExplorer = jest.fn();
    const { container, root } = await renderInto(
      <GeneratingTransaction
        onDoneClick={() => {}}
        transactionComplete
        hasErrors={false}
        completedTxHash="0x84e3d459"
        onViewExplorer={onViewExplorer}
      />
    );

    const button = Array.from(container.querySelectorAll('button')).find(
      btn => btn.getAttribute('aria-label') === 'viewOnMidenscan'
    ) as HTMLButtonElement;
    expect(button).not.toBeNull();
    act(() => {
      button.click();
    });
    expect(onViewExplorer).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });

  it('omits the View on Midenscan button when no onViewExplorer is provided', async () => {
    const { container, root } = await renderInto(
      <GeneratingTransaction onDoneClick={() => {}} transactionComplete hasErrors={false} />
    );
    expect(container.textContent).not.toContain('viewOnMidenscan');
    act(() => root.unmount());
  });

  it('omits the View on Midenscan button on failure even when onViewExplorer is provided', async () => {
    const { container, root } = await renderInto(
      <GeneratingTransaction onDoneClick={() => {}} transactionComplete hasErrors onViewExplorer={jest.fn()} />
    );
    expect(container.textContent).not.toContain('viewOnMidenscan');
    act(() => root.unmount());
  });

  it('renders the "navigate home" warning alert when keepOpen is true (desktop, in-flight)', async () => {
    const { container, root } = await renderInto(
      <GeneratingTransaction onDoneClick={() => {}} transactionComplete={false} keepOpen />
    );
    expect(container.textContent).toContain('doNotCloseWindowNavigateHome');
    act(() => root.unmount());
  });

  it('renders the "auto-close" warning alert when keepOpen is false (desktop, in-flight)', async () => {
    const { container, root } = await renderInto(
      <GeneratingTransaction onDoneClick={() => {}} transactionComplete={false} keepOpen={false} />
    );
    expect(container.textContent).toContain('doNotCloseWindowAutoClose');
    act(() => root.unmount());
  });
});
