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
  navigate: jest.fn(),
  Redirect: ({ to }: { to: string }) => <div data-testid="redirect">redirect:{to}</div>
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

// The container drives the FIFO loop via safeGenerateTransactionsLoop (unchanged
// behaviour). That's the only thing it still pulls from lib/miden/activity.
const safeGenerateTransactionsLoopMock = jest.fn();
jest.mock('lib/miden/activity', () => ({
  safeGenerateTransactionsLoop: (...args: any[]) => safeGenerateTransactionsLoopMock(...args)
}));

// The container observes the tracked row through this hook. Tests drive the row
// (status/stage/transactionId) via `mockRowState` instead of touching Dexie.
let mockRowState: { row: any; loaded: boolean } = { row: undefined, loaded: false };
jest.mock('./useTransactionRow', () => ({
  useTransactionRow: () => mockRowState
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
    safeGenerateTransactionsLoopMock.mockReset();
    safeGenerateTransactionsLoopMock.mockReturnValue(true);
    mockRowState = { row: undefined, loaded: false };
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

  it('redirects home when the id is unknown (loaded, no row)', async () => {
    mockRowState = { row: undefined, loaded: true };

    const { container, root } = await mount(<GeneratingTransactionPage txId="tx-missing" />);

    expect(container.querySelector('[data-testid="redirect"]')?.textContent).toBe('redirect:/');
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

  it('auto-closes (navigate home) when the row fails and auto-close is enabled', async () => {
    isAutoCloseEnabledMock.mockReturnValue(true);
    navigateMock.mockClear();
    window.location.hash = '#/generating-transaction/tx-1';
    mockRowState = { row: makeTx({ stage: 'submitting' }), loaded: true };

    const { root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

    // Row transitions to Failed → schedules auto-close.
    mockRowState = { row: makeTx({ status: 3, transactionId: '0xhash' }), loaded: true };
    await act(async () => {
      root.render(<GeneratingTransactionPage txId="tx-1" />);
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

  it('does not auto-close after a successful completion when auto-close is enabled', async () => {
    isAutoCloseEnabledMock.mockReturnValue(true);
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
      jest.advanceTimersByTime(10_000);
    });
    await flush();

    expect(navigateMock).not.toHaveBeenCalled();
    isAutoCloseEnabledMock.mockReturnValue(false);
    act(() => root.unmount());
  });

  it('does not navigate on auto-close when the hash is not on the generating-transaction route', async () => {
    // onClose early-returns when the hash does not include 'generating-transaction'.
    isAutoCloseEnabledMock.mockReturnValue(true);
    navigateMock.mockClear();
    window.location.hash = '#/some-other-route/tx-1';
    mockRowState = { row: makeTx({ stage: 'submitting' }), loaded: true };

    const { root } = await mount(<GeneratingTransactionPage txId="tx-1" />);

    mockRowState = { row: makeTx({ status: 2, transactionId: '0xhash' }), loaded: true };
    await act(async () => {
      root.render(<GeneratingTransactionPage txId="tx-1" />);
    });
    await flush();

    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    await flush();

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
    const helper = Array.from(container.querySelectorAll('p')).find(
      paragraph =>
        paragraph.textContent === 'generatingTransactionDescription' && paragraph.classList.contains('font-bold')
    );
    expect(helper).toHaveClass('text-heading-gray');
    expect(helper).not.toHaveClass('dark:text-white');
    act(() => root.unmount());
  });

  it('renders the backend step immediately when the backend stage starts ahead', async () => {
    const { container, root } = await renderInto(
      <GeneratingTransaction onDoneClick={() => {}} transactionComplete={false} activeStage="submitting" />
    );
    const stepStates = () =>
      Array.from(container.querySelectorAll('[data-transaction-step]')).map(row => row.getAttribute('data-state'));
    const activeSpinner = () =>
      container.querySelector('[data-transaction-step][data-state="active"] svg') as SVGElement | null;

    expect(stepStates()).toEqual(['complete', 'complete', 'active', 'pending']);
    expect(activeSpinner()).toHaveClass('animate-spin');
    act(() => root.unmount());
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
    jest.useFakeTimers();
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
