import React, { useState } from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import MobilePageLayers from 'app/layouts/MobilePageLayers';
import { initiateSendTransaction } from 'lib/miden/activity';
import { HistoryAction } from 'lib/woozie/history';
import { LocationProvider, LocationState } from 'lib/woozie/location';

import { ReviewTransaction } from './ReviewTransaction';
import { clearSendDraft } from './send-draft';
import { beginSendSubmitting, hasActiveSendSession, hasOpenSendFlow, settleSendFlow } from './send-telemetry';
import { SendFlow } from './SendManager';

type TelemetryHandle = {
  flowId: string;
  runId: string;
  complete: jest.Mock;
  cancel: jest.Mock;
  fail: jest.Mock;
  step: jest.Mock;
};

const telemetryHandles: TelemetryHandle[] = [];
const reportTelemetryEventMock = jest.fn();
const beginFlowMock = jest.fn((_flow: string) => {
  const handle: TelemetryHandle = {
    flowId: `flow-layer-${telemetryHandles.length + 1}`,
    runId: 'run-layer-12345678901',
    complete: jest.fn(),
    cancel: jest.fn(),
    fail: jest.fn(),
    step: jest.fn()
  };
  telemetryHandles.push(handle);
  return handle;
});
const classifyErrorMock = jest.fn((_error: unknown) => 'rpc');

const layerMotionProps: Record<string, any> = {};
let mockAnimated = true;

jest.mock('framer-motion', () => {
  const actual = jest.requireActual<typeof import('framer-motion')>('framer-motion');
  const R = jest.requireActual<typeof import('react')>('react');
  const div = R.forwardRef(
    (
      { initial: _i, animate: _a, exit: _e, transition: _t, onAnimationComplete, ...props }: any,
      ref: React.Ref<HTMLDivElement>
    ) => {
      const fullProps = { ...props, onAnimationComplete };
      if (props['data-page-layer']) {
        layerMotionProps[props['data-page-layer']] = fullProps;
      }
      return R.createElement('div', { ...props, ref });
    }
  );
  const span = R.forwardRef((props: any, ref: React.Ref<HTMLSpanElement>) =>
    R.createElement('span', { ...props, ref })
  );
  return {
    ...actual,
    motion: new Proxy(actual.motion, {
      get: (target, key) => (key === 'div' ? div : key === 'span' ? span : Reflect.get(target, key))
    }),
    useReducedMotion: () => !mockAnimated
  };
});

jest.mock('lib/telemetry', () => ({
  beginFlow: (flow: string) => beginFlowMock(flow),
  classifyError: (error: unknown) => classifyErrorMock(error)
}));
jest.mock('lib/telemetry/report-flow', () => ({
  reportTelemetryEvent: (event: unknown) => reportTelemetryEventMock(event)
}));

let mockLocation: LocationState = {
  pathname: '/send',
  search: '',
  hash: '',
  state: null,
  trigger: HistoryAction.Push,
  historyLength: 1,
  historyPosition: 1
};
let setAppRoute: ((next: LocationState) => void) | null = null;

function buildLocation(
  pathname: string,
  search = '',
  trigger = HistoryAction.Push,
  historyPosition = 1
): LocationState {
  return {
    pathname,
    search,
    hash: '',
    state: null,
    trigger,
    historyLength: 1,
    historyPosition
  };
}

const navigateMock = jest.fn((to: string) => {
  const [pathname = '/', search = ''] = to.split('?');
  mockLocation = buildLocation(pathname, search, HistoryAction.Push, mockLocation.historyPosition + 1);
  setAppRoute?.(mockLocation);
});
let mockPopPathname = '/send';
const goBackMock = jest.fn(() => {
  mockLocation = buildLocation(mockPopPathname, '', HistoryAction.Pop, Math.max(0, mockLocation.historyPosition - 1));
  setAppRoute?.(mockLocation);
});

jest.mock('lib/woozie', () => {
  const actualLocation = jest.requireActual<typeof import('lib/woozie/location')>('lib/woozie/location');
  const actualHistory = jest.requireActual<typeof import('lib/woozie/history')>('lib/woozie/history');
  return {
    ...actualLocation,
    HistoryAction: actualHistory.HistoryAction,
    listen: actualHistory.listen,
    createLocationState: () => mockLocation,
    navigate: (to: string) => navigateMock(to),
    goBack: () => goBackMock(),
    Redirect: ({ to }: { to: string }) => <div data-testid="redirect">redirect:{to}</div>
  };
});

const mockTranslation = { t: (key: string) => key };
const mockAppEnv = { fullPage: false };
const mockHiddenTokens = { loaded: true, isHidden: () => false };
const mockAccount = { publicKey: 'mtst1sender' };
const mockAllAccounts: never[] = [];
const mockBalancesResult = {
  data: [{ tokenId: 'tok1', metadata: { symbol: 'MDN', decimals: 2, name: 'MDN' }, balance: 100 }],
  isLoading: false,
  readFailed: false,
  balanceReadInFlight: false,
  mutate: jest.fn()
};
const mockTokensBaseMetadata = {};
const mockMidenContext = { estimateUsdcxBurnFee: jest.fn(), signTransaction: jest.fn() };
const mockClaimableNotes = { data: undefined };
const mockFilteredContacts = { contacts: [] };
const mockNativeMetadata = { symbol: 'MDN', decimals: 2 };
const mockFeatureAvailability = { state: 'available' as const };
const mockRecentRecipients: never[] = [];
const mockEpochQuoteResult = { loading: false, error: null };
const mockNearIntentsQuoteResult = { status: 'idle' as const };
const mockBurnFeeReserveResult = { status: 'idle' as const };

jest.mock('react-i18next', () => ({
  useTranslation: () => mockTranslation
}));
jest.mock('app/env', () => ({
  useAppEnv: () => mockAppEnv
}));
jest.mock('app/hooks/useHiddenTokens', () => ({
  useHiddenTokens: () => mockHiddenTokens
}));
jest.mock('app/hooks/useNativeFeeFaucetId', () => ({ __esModule: true, default: () => 'mtst1native' }));
jest.mock('app/hooks/useVerificationBaseFee', () => ({ __esModule: true, default: () => 0 }));
jest.mock('app/hooks/useBackWithFallback', () => ({
  useBackWithFallback: jest.requireActual<typeof import('app/hooks/useBackWithFallback')>(
    'app/hooks/useBackWithFallback'
  ).useBackWithFallback
}));
jest.mock('app/layouts/HomeGroupPane', () => ({
  HomeGroupPaneRoot: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}));
jest.mock('app/layouts/useHideHomeActionsWhileOpen', () => ({ useHideHomeActionsWhileOpen: jest.fn() }));
jest.mock('lib/mobile/useHideNavbarWhileOpen', () => ({ useHideNavbarWhileOpen: jest.fn() }));
jest.mock('lib/mobile/useMobileBackHandler', () => ({ useMobileBackHandler: jest.fn() }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('lib/mobile/webview-state', () => ({ isReturningFromWebview: () => false }));
jest.mock('lib/platform', () => ({
  isExtension: () => false,
  isMobile: () => true,
  isDesktop: () => false,
  isIOS: () => false,
  isAndroid: () => false
}));
jest.mock('lib/biometric', () => ({ confirmSensitiveAction: jest.fn(async () => true) }));
jest.mock('lib/miden/back/protector-probe', () => ({ probeHardwareProtector: jest.fn() }));
jest.mock('lib/miden/activity', () => ({
  initiateSendTransaction: jest.fn(async () => 'tx-1'),
  requestSWTransactionProcessing: jest.fn()
}));
jest.mock('lib/miden/front', () => ({
  useAccount: () => mockAccount,
  useAllAccounts: () => mockAllAccounts,
  useAllBalances: () => mockBalancesResult,
  useAllTokensBaseMetadata: () => mockTokensBaseMetadata
}));
jest.mock('lib/miden/front/client', () => ({
  useMidenContext: () => mockMidenContext
}));
jest.mock('lib/miden/front/guardian-sync', () => ({ zustandProvider: {} }));
jest.mock('lib/miden/front/claimable-notes', () => ({ useClaimableNotes: () => mockClaimableNotes }));
jest.mock('lib/miden/front/use-filtered-contacts.hook', () => ({
  useFilteredContacts: () => mockFilteredContacts
}));
jest.mock('lib/miden/sdk/helpers', () => ({
  accountIdStringToSdk: (id: string) => ({ toString: () => id }),
  sameWalletAccountId: (a: string, b: string) => a === b
}));
jest.mock('lib/miden/name/config', () => ({ isMidenNameSupported: () => false }));
jest.mock('lib/miden/name/resolver', () => ({ resolveMidenName: jest.fn() }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getEffectiveRpcUrl: () => 'https://rpc.example',
  getEffectiveNetworkName: () => 'devnet',
  subscribeEffectiveEndpoints: () => () => undefined
}));
jest.mock('lib/miden-chain/native-asset', () => ({
  ...jest.requireActual('lib/miden-chain/native-asset'),
  getNativeAssetIdSync: () => 'mtst1native',
  getSdkSyncedNativeAssetIdSync: () => 'mtst1native',
  cacheScope: () => 'https://rpc.example|devnet',
  getNativeAssetMetadataSync: () => mockNativeMetadata
}));
jest.mock('lib/miden/swap/bridge-price-allowlist');
jest.mock('lib/remote-config/runtime', () => {
  const bridge = jest.requireActual<typeof import('lib/epoch/testing/bridge-config')>(
    'lib/epoch/testing/bridge-config'
  );
  const snapshot = bridge.TEST_BRIDGE_CONFIG_SNAPSHOT;
  return bridge.remoteConfigRuntimeMock(() => snapshot);
});
jest.mock('lib/remote-config/use-feature-availability', () => {
  const snapshot = jest.requireActual<typeof import('lib/epoch/testing/bridge-config')>(
    'lib/epoch/testing/bridge-config'
  ).TEST_BRIDGE_CONFIG_SNAPSHOT;
  return {
    useFeatureAvailability: () => mockFeatureAvailability,
    useBridgeConfigSnapshot: () => snapshot
  };
});
const mockWalletStoreState = {
  tokenPrices: {},
  isTransactionModalOpen: false,
  lastCompletedTxHash: null,
  closeTransactionModal: jest.fn(),
  setLastCompletedTxHash: jest.fn(),
  assessSpendingLimit: jest.fn(async () => undefined),
  readSpendingLimit: jest.fn(async () => undefined)
};
jest.mock('lib/store', () => ({
  useWalletStore: Object.assign(
    (selector?: (s: typeof mockWalletStoreState) => unknown) =>
      selector ? selector(mockWalletStoreState) : mockWalletStoreState,
    { getState: () => mockWalletStoreState }
  )
}));
jest.mock('lib/i18n/numbers', () => ({
  ...jest.requireActual('lib/i18n/numbers'),
  stringToBigInt: (v: string, decimals: number) =>
    BigInt(Math.round((parseFloat(v || '0') || 0) * Math.pow(10, decimals)))
}));
jest.mock('utils/miden', () => ({
  MidenAddressError: class extends Error {},
  isValidMidenAddress: (a: string) => Boolean(a && a.startsWith('mtst1')),
  isValidEthereumAddress: () => false,
  isValidRecipientAddress: (a: string) => Boolean(a && a.startsWith('mtst1')),
  detectAddressChain: () => 'miden'
}));
jest.mock('components/Navigator', () => {
  const actual = jest.requireActual<typeof import('components/Navigator')>('components/Navigator');
  return actual;
});
const clearSendDraftMock = jest.fn();
jest.mock('./send-draft', () => {
  const actual = jest.requireActual<typeof import('./send-draft')>('./send-draft');
  return {
    ...actual,
    clearSendDraft: () => {
      clearSendDraftMock();
      actual.clearSendDraft();
    }
  };
});
jest.mock('./SelectRecipient', () => ({
  SelectRecipient: (props: any) => (
    <div data-testid="select-recipient">
      <textarea data-testid="sr-input" onChange={props.onAddressChange} />
      <button type="button" data-testid="sr-confirm" onClick={props.onConfirm}>
        next
      </button>
    </div>
  )
}));
jest.mock('./SendAmount', () => ({
  SendAmount: (props: any) => (
    <div data-testid="select-amount">
      <input data-testid="sa-input" onChange={e => props.onAmountChange(e.target.value)} />
      <button type="button" data-testid="sa-confirm" onClick={props.onConfirm}>
        review
      </button>
    </div>
  )
}));
jest.mock('./SendRoute', () => ({ SendRoute: () => <div data-testid="select-route" /> }));
jest.mock('./SelectToken', () => ({ SelectTokenDrawer: () => null }));
jest.mock('./AccountsList', () => ({ AccountsListDrawer: () => null }));
jest.mock('./AddContactDrawer', () => ({ AddContactDrawer: () => null }));
jest.mock('./ScanQrDrawer', () => ({ ScanQrDrawer: () => null }));
jest.mock('./SendStepLayout', () => ({
  SendStepLayout: ({ onBack, onClose, footer }: any) => (
    <div data-testid="review-screen">
      <button type="button" data-testid="review-back" onClick={onBack}>
        back
      </button>
      <button type="button" data-testid="review-close" onClick={onClose}>
        close
      </button>
      {footer}
    </div>
  )
}));
jest.mock('./RecallCalendarDrawer', () => ({
  combineDateAndTime: () => new Date(0),
  dateTimeToRecallBlocks: () => 100,
  RecallCalendarDrawer: () => null,
  SECONDS_PER_BLOCK: 3
}));
jest.mock('./TransferTypeDrawer', () => ({ TransferTypeDrawer: () => null }));
jest.mock('./useRecentRecipients', () => ({ useRecentRecipients: () => mockRecentRecipients }));
jest.mock('./useEpochQuote', () => ({ useEpochQuote: () => mockEpochQuoteResult }));
jest.mock('./useNearIntentsSendQuote', () => ({
  nearIntentsErrorCode: () => undefined,
  useNearIntentsSendQuote: () => mockNearIntentsQuoteResult
}));
jest.mock('./useIsNewRecipient', () => ({ useIsNewRecipient: () => false }));
jest.mock('lib/usdcx/use-burn-fee-reserve', () => ({
  useBurnFeeReserve: () => mockBurnFeeReserveResult
}));
jest.mock('lib/usdcx/use-burn-minimum', () => ({ useBurnMinimum: () => undefined }));
jest.mock('components/NetworkModeSheet', () => ({ NetworkModeSheet: () => null }));
jest.mock('components/NetworkChip', () => ({ NetworkLogo: () => null }));
jest.mock('components/SpendingLimitChallenge', () => ({ SpendingLimitChallenge: () => null }));
jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary' },
  Button: ({ title, variant: _v, isLoading: _l, ...rest }: any) => (
    <button type="button" {...rest}>
      {title}
    </button>
  )
}));

function TestMobileApp() {
  const [route, setRoute] = useState<LocationState>(mockLocation);
  setAppRoute = setRoute;
  const isReview = route.pathname === '/send/review';
  const isOverlaySlide = route.pathname === '/overlay-slide';
  const pageKey = isOverlaySlide ? 'overlay-slide' : isReview ? 'send-review' : 'tabs';

  return (
    <LocationProvider>
      <MobilePageLayers location={route} pageKey={pageKey} slide={isReview || isOverlaySlide}>
        {isOverlaySlide ? (
          <div data-testid="overlay-slide-screen">overlay</div>
        ) : isReview ? (
          <ReviewTransaction />
        ) : (
          <SendFlow isLoading={false} />
        )}
      </MobilePageLayers>
    </LocationProvider>
  );
}

describe('SendFlow + ReviewTransaction under MobilePageLayers telemetry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    jest.mocked(initiateSendTransaction).mockResolvedValue('tx-1');
    clearSendDraft();
    clearSendDraftMock.mockClear();
    settleSendFlow(flow => flow.cancel());
    telemetryHandles.length = 0;
    reportTelemetryEventMock.mockReset();
    for (const k of Object.keys(layerMotionProps)) delete layerMotionProps[k];
    mockAnimated = true;
    mockPopPathname = '/send';
    mockLocation = buildLocation('/send', '', HistoryAction.Push, 1);
  });

  afterEach(() => {
    setAppRoute = null;
    settleSendFlow(flow => flow.cancel());
    jest.useRealTimers();
  });

  const flushMicrotasks = () =>
    act(async () => {
      jest.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
    });

  async function advanceToReview(dwellFirst: boolean) {
    render(<TestMobileApp />);
    if (dwellFirst) {
      act(() => void jest.advanceTimersByTime(650));
    }
    fireEvent.change(screen.getByTestId('sr-input'), { target: { value: 'mtst1recipient' } });
    fireEvent.click(screen.getByTestId('sr-confirm'));
    await flushMicrotasks();
    expect(screen.getByTestId('sa-input')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('sa-input'), { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('sa-confirm'));
    await flushMicrotasks();
    expect(screen.getByTestId('review-screen')).toBeInTheDocument();
  }

  it('clears handoff guard on retained MobilePageLayers return despite frozen LocationProvider snapshot so second goToReview succeeds and failed submit reopens', async () => {
    await advanceToReview(true);

    // SendFlow layer stayed mounted with frozen pathname '/send' and pageActive=false.
    fireEvent.click(screen.getByTestId('review-back'));
    await flushMicrotasks();
    expect(hasOpenSendFlow()).toBe(true);

    // Delayed slide-out completes cleanly.
    act(() => void layerMotionProps['/send/review']?.onAnimationComplete?.());

    // Second Continue must NOT be blocked by stale reviewHandoffRef.current.
    fireEvent.click(screen.getByTestId('sa-confirm'));
    await flushMicrotasks();
    expect(screen.getByTestId('review-screen')).toBeInTheDocument();
    expect(navigateMock).toHaveBeenCalledTimes(2);
    expect(beginFlowMock).toHaveBeenCalledTimes(1);

    // Simulate submit failure followed by return to retained SendFlow.
    act(() => {
      beginSendSubmitting(false);
      settleSendFlow(flow => flow.fail('rpc'));
    });
    fireEvent.click(screen.getByTestId('review-back'));
    await flushMicrotasks();
    expect(beginFlowMock).toHaveBeenCalledTimes(2);
    expect(hasOpenSendFlow()).toBe(true);

    // Leaving Send tab later cancels flow-layer-2 cleanly.
    act(() => {
      mockLocation = buildLocation('/', '', HistoryAction.Replace, 1);
      setAppRoute?.(mockLocation);
    });
    expect(telemetryHandles[1]?.cancel).toHaveBeenCalledTimes(1);
    expect(reportTelemetryEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ flowId: 'flow-layer-2', step: 'select_amount', stepAction: 'leave', complete: true })
    );
  });

  it('handles browser popstate immediately before uncover animation unmount and prevents delayed unmount from corrupting new routes or flows', async () => {
    await advanceToReview(true);

    // Browser popstate moves live route to /send before onAnimationComplete finishes.
    act(() => {
      mockLocation = buildLocation('/send', '', HistoryAction.Pop, 1);
      setAppRoute?.(mockLocation);
    });
    const oldReviewComplete = layerMotionProps['/send/review']?.onAnimationComplete;
    expect(typeof oldReviewComplete).toBe('function');
    // Uncover animation keeps old review layer mounted until onAnimationComplete runs.
    expect(screen.getByTestId('review-screen')).toBeInTheDocument();

    const events = reportTelemetryEventMock.mock.calls.map(([e]) => e);
    const reviewBackIdx = events.findIndex(e => e.step === 'review' && e.stepAction === 'back');
    expect(reviewBackIdx).toBeGreaterThanOrEqual(0);
    expect(hasOpenSendFlow()).toBe(true);

    // Delayed unmount finishes after SendManager already re-entered select_amount: must NOT double-back or cancel.
    const countBeforeComplete = reportTelemetryEventMock.mock.calls.length;
    act(() => void oldReviewComplete?.());
    expect(screen.queryByTestId('review-screen')).not.toBeInTheDocument();
    expect(telemetryHandles[0]?.cancel).not.toHaveBeenCalled();
    expect(reportTelemetryEventMock.mock.calls.length).toBe(countBeforeComplete);

    // Re-push /send/review, pop back to /send, and navigate straight to '/' while second review layer is still uncovering.
    fireEvent.click(screen.getByTestId('sa-confirm'));
    await flushMicrotasks();
    expect(screen.getByTestId('review-screen')).toBeInTheDocument();

    act(() => {
      mockLocation = buildLocation('/send', '', HistoryAction.Pop, 1);
      setAppRoute?.(mockLocation);
    });
    const secondReviewComplete = layerMotionProps['/send/review']?.onAnimationComplete;
    expect(typeof secondReviewComplete).toBe('function');
    act(() => {
      mockLocation = buildLocation('/', '', HistoryAction.Replace, 1);
      setAppRoute?.(mockLocation);
    });
    act(() => void secondReviewComplete?.());
    expect(telemetryHandles[0]?.cancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('review-screen')).not.toBeInTheDocument();
  });

  it('opens a stepped flow when advancing to review before the 600ms dwell gate expires', async () => {
    await advanceToReview(false);

    // Advancing timers past 600ms while on /send/review leaves the flow properly stepped, never stepless.
    act(() => void jest.advanceTimersByTime(700));
    fireEvent.click(screen.getByTestId('review-close'));

    expect(beginFlowMock).toHaveBeenCalledTimes(1);
    expect(reportTelemetryEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: 'flow-layer-1',
        step: 'select_amount',
        stepAction: 'continue',
        complete: true
      })
    );
    expect(reportTelemetryEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: 'flow-layer-1',
        step: 'review',
        stepAction: 'close',
        complete: true
      })
    );
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it('ignores a late submit resolution from a covered retained Review layer without settling telemetry or navigating', async () => {
    await advanceToReview(true);
    const pendingTx = deferred<string>();
    jest.mocked(initiateSendTransaction).mockReturnValueOnce(pendingTx.promise);

    fireEvent.click(screen.getByTestId('send-review-submit'));
    await waitFor(() => expect(initiateSendTransaction).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('review-back'));
    await flushMicrotasks();
    expect(screen.getByTestId('review-screen')).toBeInTheDocument();
    expect(hasOpenSendFlow()).toBe(true);

    await act(async () => {
      pendingTx.resolve('tx-late');
      await pendingTx.promise;
    });

    expect(telemetryHandles[0]?.complete).not.toHaveBeenCalled();
    expect(reportTelemetryEventMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ step: 'submitting', stepAction: 'continue' })
    );
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(clearSendDraftMock).not.toHaveBeenCalled();
    expect(hasOpenSendFlow()).toBe(true);

    act(() => void layerMotionProps['/send/review']?.onAnimationComplete?.());
    jest.mocked(initiateSendTransaction).mockResolvedValueOnce('tx-fresh');
    fireEvent.click(screen.getByTestId('sa-confirm'));
    await flushMicrotasks();
    expect(screen.getByTestId('review-screen')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('send-review-submit'));
    await waitFor(() => expect(telemetryHandles[0]?.complete).toHaveBeenCalledTimes(1));
    expect(clearSendDraftMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/generating-transaction/tx-fresh');
    expect(beginFlowMock).toHaveBeenCalledTimes(1);
  });

  it('ignores a late submit rejection from a covered retained Review layer without failing telemetry or tainting retry state', async () => {
    await advanceToReview(true);
    const pendingTx = deferred<string>();
    jest.mocked(initiateSendTransaction).mockReturnValueOnce(pendingTx.promise);

    fireEvent.click(screen.getByTestId('send-review-submit'));
    await waitFor(() => expect(initiateSendTransaction).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('review-back'));
    await flushMicrotasks();
    const eventsAfterBack = reportTelemetryEventMock.mock.calls.length;

    await act(async () => {
      pendingTx.reject(new Error('late rpc failure'));
      await pendingTx.promise.catch(() => undefined);
    });

    expect(telemetryHandles[0]?.fail).not.toHaveBeenCalled();
    expect(telemetryHandles[0]?.cancel).not.toHaveBeenCalled();
    expect(hasOpenSendFlow()).toBe(true);
    expect(reportTelemetryEventMock.mock.calls.length).toBe(eventsAfterBack);
    expect(screen.queryByText('late rpc failure')).not.toBeInTheDocument();

    act(() => void layerMotionProps['/send/review']?.onAnimationComplete?.());
    jest.mocked(initiateSendTransaction).mockResolvedValueOnce('tx-after-departed-error');
    fireEvent.click(screen.getByTestId('sa-confirm'));
    await flushMicrotasks();

    fireEvent.click(screen.getByTestId('send-review-submit'));
    await waitFor(() => expect(telemetryHandles[0]?.complete).toHaveBeenCalledTimes(1));
    expect(beginFlowMock).toHaveBeenCalledTimes(1);
    const submitActions = reportTelemetryEventMock.mock.calls
      .map(([event]) => event)
      .filter(event => event?.step === 'review' && (event?.stepAction === 'submit' || event?.stepAction === 'retry'));
    expect(submitActions).toEqual([
      expect.objectContaining({ flowId: 'flow-layer-1', step: 'review', stepAction: 'submit' }),
      expect.objectContaining({ flowId: 'flow-layer-1', step: 'review', stepAction: 'submit' })
    ]);
  });

  it('settles open flow and clears postFailureDwell when Back from direct review returns to / under MobilePageLayers', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockPopPathname = '/';
      mockLocation = buildLocation('/send/review', 'amount=5&to=mtst1recipient&tokenId=tok1', HistoryAction.Push, 2);
      const pendingTx = deferred<string>();
      jest.mocked(initiateSendTransaction).mockReturnValueOnce(pendingTx.promise);

      const firstView = render(<TestMobileApp />);
      await flushMicrotasks();
      fireEvent.click(screen.getByTestId('send-review-submit'));
      await waitFor(() => expect(initiateSendTransaction).toHaveBeenCalledTimes(1));

      fireEvent.click(screen.getByTestId('review-back'));
      await flushMicrotasks();

      expect(telemetryHandles[0]?.cancel).toHaveBeenCalledTimes(1);
      expect(hasOpenSendFlow()).toBe(false);
      expect(hasActiveSendSession()).toBe(false);
      firstView.unmount();

      // Failed submit followed by Back to '/' must not leave hasActiveSendSession() true for a subsequent swipe past /send.
      jest.mocked(initiateSendTransaction).mockRejectedValueOnce(new Error('rpc failure'));
      mockLocation = buildLocation('/send/review', 'amount=5&to=mtst1recipient&tokenId=tok1', HistoryAction.Push, 2);
      const secondView = render(<TestMobileApp />);
      await flushMicrotasks();
      fireEvent.click(screen.getByTestId('send-review-submit'));
      await waitFor(() => expect(telemetryHandles[1]?.fail).toHaveBeenCalledWith('rpc'));
      expect(hasActiveSendSession()).toBe(true);

      fireEvent.click(screen.getByTestId('review-back'));
      await flushMicrotasks();

      expect(hasActiveSendSession()).toBe(false);
      expect(telemetryHandles[1]?.cancel).not.toHaveBeenCalled();

      const flowsBeforeSwipe = beginFlowMock.mock.calls.length;
      act(() => {
        mockLocation = buildLocation('/send', '', HistoryAction.Replace, 1);
        setAppRoute?.(mockLocation);
      });
      expect(screen.getByTestId('select-recipient')).toBeInTheDocument();
      act(() => {
        jest.advanceTimersByTime(100);
      });
      act(() => {
        mockLocation = buildLocation('/', '', HistoryAction.Replace, 1);
        setAppRoute?.(mockLocation);
      });
      expect(beginFlowMock).toHaveBeenCalledTimes(flowsBeforeSwipe);

      // Positive control: committing /send and dwelling past the 600ms threshold starts a send flow.
      act(() => {
        mockLocation = buildLocation('/send', '', HistoryAction.Replace, 1);
        setAppRoute?.(mockLocation);
      });
      expect(screen.getByTestId('select-recipient')).toBeInTheDocument();
      act(() => {
        jest.advanceTimersByTime(650);
      });
      expect(beginFlowMock).toHaveBeenCalledTimes(flowsBeforeSwipe + 1);
      expect(hasOpenSendFlow()).toBe(true);
      act(() => {
        mockLocation = buildLocation('/', '', HistoryAction.Replace, 1);
        setAppRoute?.(mockLocation);
      });
      expect(hasOpenSendFlow()).toBe(false);
      secondView.unmount();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('recovers Confirm and suppresses stale pre-cover submission after retained Review layer is covered and revealed', async () => {
    await advanceToReview(true);
    const staleTx = deferred<string>();
    jest.mocked(initiateSendTransaction).mockReturnValueOnce(staleTx.promise);

    fireEvent.click(screen.getByTestId('send-review-submit'));
    await waitFor(() => expect(initiateSendTransaction).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('send-review-submit')).toBeDisabled();

    // Push a slide page over Review, cancelling flow-layer-1 while Review remains retained underneath.
    act(() => {
      mockLocation = buildLocation('/overlay-slide', '', HistoryAction.Push, 3);
      setAppRoute?.(mockLocation);
    });
    expect(screen.getByTestId('overlay-slide-screen')).toBeInTheDocument();
    expect(telemetryHandles[0]?.cancel).toHaveBeenCalledTimes(1);
    expect(hasOpenSendFlow()).toBe(false);

    // Pop back to retained Review: departure state resets and a fresh flow reopens at review.
    act(() => {
      mockLocation = buildLocation('/send/review', 'amount=5&to=mtst1recipient&tokenId=tok1', HistoryAction.Pop, 2);
      setAppRoute?.(mockLocation);
    });
    await flushMicrotasks();

    expect(beginFlowMock).toHaveBeenCalledTimes(2);
    expect(hasOpenSendFlow()).toBe(true);
    expect(screen.getByTestId('send-review-submit')).toBeEnabled();

    // Pre-cover submission settling after reveal remains invalidated and cannot complete or redirect.
    await act(async () => {
      staleTx.resolve('tx-stale-before-cover');
      await staleTx.promise;
    });
    await flushMicrotasks();

    expect(telemetryHandles[0]?.complete).not.toHaveBeenCalled();
    expect(telemetryHandles[1]?.complete).not.toHaveBeenCalled();
    expect(clearSendDraftMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalledWith('/generating-transaction/tx-stale-before-cover');
    expect(screen.getByTestId('send-review-submit')).toBeEnabled();

    // Fresh Confirm on revealed Review submits and completes flow-layer-2 cleanly.
    jest.mocked(initiateSendTransaction).mockResolvedValueOnce('tx-after-reveal');
    fireEvent.click(screen.getByTestId('send-review-submit'));
    await waitFor(() => expect(telemetryHandles[1]?.complete).toHaveBeenCalledTimes(1));
    expect(navigateMock).toHaveBeenCalledWith('/generating-transaction/tx-after-reveal');
    expect(clearSendDraftMock).toHaveBeenCalledTimes(1);
  });

  it('keeps Back responsive on a retained Review layer after cover-and-reveal', async () => {
    await advanceToReview(true);

    act(() => {
      mockLocation = buildLocation('/overlay-slide', '', HistoryAction.Push, 3);
      setAppRoute?.(mockLocation);
    });
    act(() => {
      mockLocation = buildLocation('/send/review', 'amount=5&to=mtst1recipient&tokenId=tok1', HistoryAction.Pop, 2);
      setAppRoute?.(mockLocation);
    });
    await flushMicrotasks();

    fireEvent.click(screen.getByTestId('review-back'));
    await flushMicrotasks();

    expect(goBackMock).toHaveBeenCalledTimes(1);
    expect(hasOpenSendFlow()).toBe(true);
    expect(telemetryHandles[1]?.cancel).not.toHaveBeenCalled();
    expect(reportTelemetryEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ flowId: 'flow-layer-2', step: 'review', stepAction: 'back', complete: true })
    );
  });

  it('keeps Close responsive on a retained Review layer after cover-and-reveal', async () => {
    await advanceToReview(true);

    act(() => {
      mockLocation = buildLocation('/overlay-slide', '', HistoryAction.Push, 3);
      setAppRoute?.(mockLocation);
    });
    act(() => {
      mockLocation = buildLocation('/send/review', 'amount=5&to=mtst1recipient&tokenId=tok1', HistoryAction.Pop, 2);
      setAppRoute?.(mockLocation);
    });
    await flushMicrotasks();

    fireEvent.click(screen.getByTestId('review-close'));
    await flushMicrotasks();

    expect(navigateMock).toHaveBeenCalledWith('/');
    expect(clearSendDraftMock).toHaveBeenCalledTimes(1);
    expect(hasOpenSendFlow()).toBe(false);
    expect(telemetryHandles[1]?.cancel).toHaveBeenCalledTimes(1);
    expect(reportTelemetryEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: 'flow-layer-2',
        step: 'review',
        stepAction: 'close',
        complete: true
      })
    );
  });
});
