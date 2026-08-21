import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import PendingNotes from './PendingNotes';

// PendingNotes composes the claim hook + the PendingTab list; none of that is
// under test here. We only exercise the header's back affordance, which must
// stay usable when the page is opened cold in a fresh tab (e.g. via a
// received-note notification, which has no history to pop) — see #467.

const mockGoBack = jest.fn();
const mockNavigate = jest.fn();

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/woozie', () => ({
  goBack: (...args: unknown[]) => mockGoBack(...args),
  navigate: (...args: unknown[]) => mockNavigate(...args)
}));

jest.mock('lib/platform', () => ({
  isMobile: () => false
}));

jest.mock('app/env', () => ({
  useAppEnv: () => ({ fullPage: true, sidePanel: false })
}));

/** Reports an attempt at claiming a note, supplied by the page under test. */
type ReportClaim = <T>(attempt: () => Promise<T>) => Promise<T>;

let pendingTabProps: { reportClaim?: ReportClaim } = {};

jest.mock('app/pages/Receive/PendingTab', () => ({
  PendingTab: (props: { reportClaim?: ReportClaim }) => {
    pendingTabProps = props;
    return <div data-testid="pending-tab" />;
  }
}));

const useClaimNotesMock = jest.fn((_reportClaim?: ReportClaim) => ({
  safeClaimableNotes: [],
  unclaimedNotes: [],
  account: { publicKey: 'mtst1account' },
  isDelegatedProvingEnabled: false,
  claimingNoteIds: new Set(),
  retriableNoteIds: new Set(),
  invalidNoteIds: new Set(),
  checkingNoteIds: new Set(),
  handleClaimingStateChange: jest.fn(),
  handleClaimAll: jest.fn(),
  handleClaimGroup: jest.fn()
}));

jest.mock('app/hooks/useClaimNotes', () => ({
  useClaimNotes: (reportClaim?: ReportClaim) => useClaimNotesMock(reportClaim)
}));

type TelemetryHandle = { complete: jest.Mock; cancel: jest.Mock; fail: jest.Mock };
const telemetryHandles: TelemetryHandle[] = [];
const beginFlowMock = jest.fn((_flow: string) => {
  const handle: TelemetryHandle = { complete: jest.fn(), cancel: jest.fn(), fail: jest.fn() };
  telemetryHandles.push(handle);
  return handle;
});
const classifyErrorMock = jest.fn((_error: unknown) => 'rpc');

jest.mock('lib/telemetry', () => ({
  beginFlow: (flow: string) => beginFlowMock(flow),
  classifyError: (error: unknown) => classifyErrorMock(error)
}));

function setHistoryLength(length: number) {
  Object.defineProperty(window.history, 'length', { configurable: true, value: length });
}

describe('PendingNotes back affordance', () => {
  beforeEach(() => {
    mockGoBack.mockClear();
    mockNavigate.mockClear();
  });

  it('pops history when there is a previous screen to return to', () => {
    setHistoryLength(3);
    render(<PendingNotes />);

    fireEvent.click(screen.getByLabelText('back'));

    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('routes home instead of leaving a dead back button when opened cold (no history)', () => {
    // A received-note notification opens a fresh tab (history length 1), where
    // history.go(-1) is a no-op — so back must fall back to the home route.
    setHistoryLength(1);
    render(<PendingNotes />);

    fireEvent.click(screen.getByLabelText('back'));

    expect(mockNavigate).toHaveBeenCalledWith('/');
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it('horizontally insets the header (px-4) so it lines up with the px-4 body (#460)', () => {
    // The PendingTab body is `px-4`; the ScreenHeader carries no horizontal
    // inset of its own, so — like every other ScreenHeader consumer — it must be
    // wrapped in a `px-4` container. Without it the back arrow + title sit 16px
    // left of every row below, reading as misaligned.
    render(<PendingNotes />);

    const header = screen.getByLabelText('back').closest('.px-4');
    expect(header).not.toBeNull();
  });
});

describe('PendingNotes - note_handle telemetry', () => {
  /** Throwing accessor so a missing handle names how many flows were begun. */
  const handleAt = (index: number): TelemetryHandle => {
    const handle = telemetryHandles[index];
    if (!handle) throw new Error(`no flow was begun at index ${index} (begun: ${telemetryHandles.length})`);
    return handle;
  };

  /** Everything this suite handed to telemetry, for the privacy assertions. */
  const telemetryPayload = () =>
    JSON.stringify({
      begun: beginFlowMock.mock.calls,
      classified: classifyErrorMock.mock.calls,
      settled: telemetryHandles.map(handle => [
        handle.complete.mock.calls,
        handle.cancel.mock.calls,
        handle.fail.mock.calls
      ])
    });

  /** The reporter the page handed to the claim hook. */
  const reporter = (): ReportClaim => {
    const [reportClaim] = useClaimNotesMock.mock.calls.at(-1) ?? [];
    if (!reportClaim) throw new Error('the page did not give useClaimNotes a claim reporter');
    return reportClaim;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    telemetryHandles.length = 0;
    pendingTabProps = {};
    setHistoryLength(3);
  });

  it('does not begin a flow merely for opening the screen', () => {
    render(<PendingNotes />);

    // Browsing pending notes is not handling one — a flow per visit would
    // report every look-and-leave as an abandoned claim.
    expect(beginFlowMock).not.toHaveBeenCalled();
  });

  it('begins one note_handle flow per claim attempt', async () => {
    render(<PendingNotes />);

    await act(async () => {
      await reporter()(() => Promise.resolve('queued'));
    });

    expect(beginFlowMock).toHaveBeenCalledTimes(1);
    expect(beginFlowMock).toHaveBeenCalledWith('note_handle');
  });

  it('completes the flow when the claim is accepted', async () => {
    render(<PendingNotes />);

    await act(async () => {
      await reporter()(() => Promise.resolve('queued'));
    });

    expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
    expect(handleAt(0).fail).not.toHaveBeenCalled();
  });

  it('passes the claim result through untouched', async () => {
    render(<PendingNotes />);

    const result = await act(async () => reporter()(() => Promise.resolve('note-tx-1')));

    expect(result).toBe('note-tx-1');
  });

  it('reports a broad error kind when the claim fails', async () => {
    render(<PendingNotes />);

    const failure = new Error('rpc unreachable');
    await act(async () => {
      await expect(reporter()(() => Promise.reject(failure))).rejects.toThrow('rpc unreachable');
    });

    expect(classifyErrorMock).toHaveBeenCalledWith(failure);
    expect(handleAt(0).fail).toHaveBeenCalledWith('rpc');
    expect(handleAt(0).complete).not.toHaveBeenCalled();
  });

  it('gives a retry after a failed claim its own flow', async () => {
    render(<PendingNotes />);

    await act(async () => {
      await expect(reporter()(() => Promise.reject(new Error('rpc unreachable')))).rejects.toThrow();
    });
    await act(async () => {
      await reporter()(() => Promise.resolve('queued'));
    });

    expect(beginFlowMock).toHaveBeenCalledTimes(2);
    expect(handleAt(1).complete).toHaveBeenCalledTimes(1);
  });

  it('cancels a claim still in flight when the user leaves', async () => {
    const { unmount } = render(<PendingNotes />);

    let release = () => {};
    const pending = new Promise<string>(resolve => {
      release = () => resolve('queued');
    });
    let attempt: Promise<string> | null = null;
    await act(async () => {
      attempt = reporter()(() => pending);
    });

    unmount();
    expect(handleAt(0).cancel).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
      await attempt;
    });
    // The handle is idempotent, so a late resolve cannot resurrect the flow.
    expect(handleAt(0).complete).not.toHaveBeenCalled();
  });

  it('does not re-report a settled claim when the user leaves', async () => {
    const { unmount } = render(<PendingNotes />);

    await act(async () => {
      await reporter()(() => Promise.resolve('queued'));
    });

    unmount();

    expect(handleAt(0).cancel).not.toHaveBeenCalled();
    expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
  });

  it('hands the same reporter to the per-note claim buttons', () => {
    render(<PendingNotes />);

    const hookReporter = reporter();
    expect(pendingTabProps.reportClaim).toBeInstanceOf(Function);
    expect(pendingTabProps.reportClaim).toBe(hookReporter);
  });

  it('never passes a note id or the account address to telemetry', async () => {
    render(<PendingNotes />);

    await act(async () => {
      await reporter()(() => Promise.resolve('0xnote-secret'));
    });

    expect(beginFlowMock.mock.calls.length).toBeGreaterThan(0);
    expect(telemetryPayload()).not.toContain('0xnote-secret');
    expect(telemetryPayload()).not.toContain('mtst1account');
  });
});
