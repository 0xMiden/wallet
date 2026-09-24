import { renderHook } from '@testing-library/react';

import { setApprovalFlowReporter } from 'lib/dapp-browser/confirmation-store';

import { useApprovalPrompt, useDappApprovalTelemetry } from './useDappApprovalTelemetry';

const beginFlow = jest.fn();
jest.mock('lib/telemetry', () => ({ beginFlow: (flow: string) => beginFlow(flow) }));
jest.mock('lib/dapp-browser/confirmation-store', () => ({ setApprovalFlowReporter: jest.fn() }));

type Reporter = (type: 'connect' | 'sign' | 'transaction' | 'consume') => { step: jest.Mock };

/** The reporter the hook installed into the store. */
const installed = (): Reporter => {
  const reporter = jest.mocked(setApprovalFlowReporter).mock.calls[0]?.[0];
  if (!reporter) throw new Error('the hook installed no reporter');
  return reporter as unknown as Reporter;
};

describe('useDappApprovalTelemetry', () => {
  beforeEach(() => {
    // Cleared here rather than in `afterEach`: Testing Library's global cleanup
    // unmounts the hook after this suite's own hooks have run, so the uninstall
    // call from the previous test would otherwise land in the next test's log
    // and be read as the installed reporter.
    jest.clearAllMocks();
    beginFlow.mockImplementation(() => ({ step: jest.fn(), complete: jest.fn(), cancel: jest.fn(), fail: jest.fn() }));
  });

  it('installs a reporter, since the store cannot import telemetry itself', () => {
    renderHook(() => useDappApprovalTelemetry());

    expect(setApprovalFlowReporter).toHaveBeenCalledTimes(1);
  });

  it('reports a connect as the permission grant and everything else as a transaction approval', () => {
    renderHook(() => useDappApprovalTelemetry());
    const reporter = installed();

    reporter('connect');
    reporter('sign');
    reporter('transaction');
    reporter('consume');

    expect(beginFlow.mock.calls.flat()).toEqual(['dapp_connect', 'dapp_tx', 'dapp_tx', 'dapp_tx']);
  });

  it('marks the approval as awaiting a decision, so a prompt that is never answered still says so', () => {
    renderHook(() => useDappApprovalTelemetry());

    const flow = installed()('connect');

    expect(flow.step).toHaveBeenCalledWith('awaiting_approval');
  });

  it('uninstalls on unmount, so a torn-down UI cannot report on the store´s behalf', () => {
    const { unmount } = renderHook(() => useDappApprovalTelemetry());
    unmount();

    expect(setApprovalFlowReporter).toHaveBeenLastCalledWith(null);
  });
});

describe('useApprovalPrompt', () => {
  // The extension's half. `lib/miden/back/dapp.ts` guards the confirmation-store
  // calls with `!isExtension()`, so on the extension nothing above ever fires
  // and dApp approvals would have gone entirely unreported on the platform most
  // users are on.
  beforeEach(() => {
    jest.clearAllMocks();
    beginFlow.mockImplementation(() => ({ step: jest.fn(), complete: jest.fn(), cancel: jest.fn(), fail: jest.fn() }));
  });

  const handle = () => jest.mocked(beginFlow).mock.results[0]?.value as { [k: string]: jest.Mock };

  it('begins the flow on mount, because this page is only rendered to ask', () => {
    renderHook(() => useApprovalPrompt('connect'));

    expect(beginFlow).toHaveBeenCalledWith('dapp_connect');
    expect(handle().step).toHaveBeenCalledWith('awaiting_approval');
  });

  it('maps every non-connect request onto the transaction-approval flow', () => {
    renderHook(() => useApprovalPrompt('transaction'));

    expect(beginFlow).toHaveBeenCalledWith('dapp_tx');
  });

  it('completes on approval and cancels on refusal, so consent is not conflated with denial', () => {
    const approve = renderHook(() => useApprovalPrompt('sign'));
    approve.result.current(true);
    expect(handle().complete).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    const deny = renderHook(() => useApprovalPrompt('sign'));
    deny.result.current(false);
    expect(handle().cancel).toHaveBeenCalledTimes(1);
  });

  it('reports a dismissed popup as an abandoned approval, which no unmount would have caught', () => {
    // Destroying a browser window does not unmount a React tree, so an effect
    // cleanup cannot be what reports this — the original test asserted `unmount`
    // and passed while production emitted nothing at all.
    renderHook(() => useApprovalPrompt('connect'));

    window.dispatchEvent(new Event('pagehide'));

    expect(handle().cancel).toHaveBeenCalledTimes(1);
  });

  it('reports a route change away from the prompt too', () => {
    const { unmount } = renderHook(() => useApprovalPrompt('connect'));

    unmount();

    expect(handle().cancel).toHaveBeenCalledTimes(1);
  });

  it('reports nothing twice when the popup is dismissed after a decision', () => {
    const { result } = renderHook(() => useApprovalPrompt('connect'));
    result.current(true);

    window.dispatchEvent(new Event('pagehide'));

    expect(handle().complete).toHaveBeenCalledTimes(1);
    expect(handle().cancel).not.toHaveBeenCalled();
  });

  it('begins no flow for an approval the user is never shown', () => {
    // An already-permitted dApp reconnecting is auto-approved during render and
    // never reaches the settle callback, so a flow begun here could only ever
    // arrive as an unmatched `started` — a phantom refusal.
    renderHook(() => useApprovalPrompt('connect', false));

    expect(beginFlow).not.toHaveBeenCalled();
  });

  it('does not re-report on the unmount that follows a decision', () => {
    const { result, unmount } = renderHook(() => useApprovalPrompt('connect'));
    result.current(true);

    unmount();

    expect(handle().complete).toHaveBeenCalledTimes(1);
    expect(handle().cancel).not.toHaveBeenCalled();
  });
});
