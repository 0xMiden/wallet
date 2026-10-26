import React from 'react';

import { act, render } from '@testing-library/react';

import { PageActiveContext } from 'app/layouts/page-active';

import { useUserVisibleError } from './use-user-visible-error';
import { reportUserVisibleError, UserErrorId, UserErrorSurface } from './user-visible-error';

jest.mock('./user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));

function Display({
  id,
  surface = 'inline',
  children
}: React.PropsWithChildren<{ id?: UserErrorId | null; surface?: UserErrorSurface }>) {
  useUserVisibleError(id, surface);
  return <>{children}</>;
}

const advance = (ms: number) => act(() => jest.advanceTimersByTime(ms));

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});

it('reports once after the message has shown for 1000 ms', () => {
  render(<Display id="usdcxFaucetUnavailable">Unavailable</Display>);
  advance(999);
  expect(reportUserVisibleError).not.toHaveBeenCalled();
  advance(1);
  expect(reportUserVisibleError).toHaveBeenCalledTimes(1);
  expect(reportUserVisibleError).toHaveBeenCalledWith('usdcxFaucetUnavailable', 'inline');
  advance(5000);
  expect(reportUserVisibleError).toHaveBeenCalledTimes(1);
});

it('sends nothing when the message clears before 1000 ms', () => {
  const { rerender } = render(<Display id="usdcxFaucetUnavailable" />);
  advance(999);
  rerender(<Display id={null} />);
  advance(1000);
  expect(reportUserVisibleError).not.toHaveBeenCalled();
});

it('keeps one episode while the text changes under one id', () => {
  const { rerender } = render(<Display id="usdcxFaucetUnavailable">Retry 1</Display>);
  advance(500);
  rerender(<Display id="usdcxFaucetUnavailable">Retry 2</Display>);
  advance(500);
  expect(reportUserVisibleError).toHaveBeenCalledTimes(1);
  rerender(<Display id="usdcxFaucetUnavailable">Retry 3</Display>);
  advance(5000);
  expect(reportUserVisibleError).toHaveBeenCalledTimes(1);
});

it('starts a new episode when the id changes', () => {
  const { rerender } = render(<Display id="usdcxFaucetUnavailable" />);
  advance(1000);
  rerender(<Display id="raw_send_submit_failed" />);
  advance(999);
  expect(reportUserVisibleError).toHaveBeenCalledTimes(1);
  advance(1);
  expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([
    ['usdcxFaucetUnavailable', 'inline'],
    ['raw_send_submit_failed', 'inline']
  ]);
});

it('starts a new episode after a clear', () => {
  const { rerender } = render(<Display id="usdcxFaucetUnavailable" />);
  advance(1000);
  rerender(<Display id={null} />);
  advance(1000);
  rerender(<Display id="usdcxFaucetUnavailable" />);
  advance(1000);
  expect(reportUserVisibleError).toHaveBeenCalledTimes(2);
});

it('sends nothing after unmount within the dwell', () => {
  const { unmount } = render(<Display id="usdcxFaucetUnavailable" />);
  advance(999);
  unmount();
  advance(1000);
  expect(reportUserVisibleError).not.toHaveBeenCalled();
});

it.each([undefined, null])('sends nothing for an absent id: %p', id => {
  render(<Display id={id} />);
  advance(1000);
  expect(reportUserVisibleError).not.toHaveBeenCalled();
});

it('restarts the dwell when the surface changes', () => {
  const { rerender } = render(<Display id="usdcxFaucetUnavailable" />);
  advance(999);
  rerender(<Display id="usdcxFaucetUnavailable" surface="review" />);
  advance(999);
  expect(reportUserVisibleError).not.toHaveBeenCalled();
  advance(1);
  expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['usdcxFaucetUnavailable', 'review']]);
});

it('cancels the old dwell when the id changes before it finishes', () => {
  const { rerender } = render(<Display id="usdcxFaucetUnavailable" />);
  advance(999);
  rerender(<Display id="raw_send_submit_failed" />);
  advance(999);
  expect(reportUserVisibleError).not.toHaveBeenCalled();
  advance(1);
  expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['raw_send_submit_failed', 'inline']]);
});

describe('retained page activity', () => {
  const pane = (active: boolean) => (
    <div aria-hidden={!active || undefined} style={{ visibility: active ? 'visible' : 'hidden' }}>
      <PageActiveContext.Provider value={active}>
        <Display id="deadletteredNotesBodyOne">
          <span>Retained error</span>
        </Display>
      </PageActiveContext.Provider>
    </div>
  );

  it('keeps an inactive retained page silent until a full reveal dwell', () => {
    const { getByText, rerender } = render(pane(false));
    const message = getByText('Retained error');
    expect(message).toBeInTheDocument();
    expect(message.parentElement).toHaveStyle({ visibility: 'hidden' });
    advance(1000);
    expect(reportUserVisibleError).not.toHaveBeenCalled();

    rerender(pane(true));
    expect(getByText('Retained error')).toBe(message);
    expect(message.parentElement).toHaveStyle({ visibility: 'visible' });
    advance(999);
    expect(reportUserVisibleError).not.toHaveBeenCalled();
    advance(1);
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['deadletteredNotesBodyOne', 'inline']]);
  });

  it('cancels a retained page dwell at 999 ms and starts a full dwell on reveal', () => {
    const { getByText, rerender } = render(pane(true));
    const message = getByText('Retained error');
    expect(message).toBeInTheDocument();
    advance(999);
    expect(reportUserVisibleError).not.toHaveBeenCalled();

    rerender(pane(false));
    expect(getByText('Retained error')).toBe(message);
    expect(message.parentElement).toHaveStyle({ visibility: 'hidden' });
    advance(1000);
    expect(reportUserVisibleError).not.toHaveBeenCalled();

    rerender(pane(true));
    expect(getByText('Retained error')).toBe(message);
    expect(message.parentElement).toHaveStyle({ visibility: 'visible' });
    advance(999);
    expect(reportUserVisibleError).not.toHaveBeenCalled();
    advance(1);
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['deadletteredNotesBodyOne', 'inline']]);
  });

  it('does not repeat a reported episode when the retained page is hidden and revealed', () => {
    const { getByText, rerender } = render(pane(true));
    const message = getByText('Retained error');
    advance(1000);
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['deadletteredNotesBodyOne', 'inline']]);

    rerender(pane(false));
    expect(getByText('Retained error')).toBe(message);
    expect(message.parentElement).toHaveStyle({ visibility: 'hidden' });
    advance(1000);
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['deadletteredNotesBodyOne', 'inline']]);

    rerender(pane(true));
    expect(getByText('Retained error')).toBe(message);
    expect(message.parentElement).toHaveStyle({ visibility: 'visible' });
    advance(1000);
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['deadletteredNotesBodyOne', 'inline']]);
    advance(5000);
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['deadletteredNotesBodyOne', 'inline']]);
  });
});

it('keeps dwell stable across fresh evidence objects and sends the latest branch', () => {
  function EvidenceDisplay({ branch }: { branch: string }) {
    Reflect.apply(useUserVisibleError, undefined, [
      'submissionUnanswered',
      'status_screen',
      undefined,
      { kind: 'submission_feedback', submissionFeedbackBranch: branch }
    ]);
    return null;
  }
  const { rerender } = render(<EvidenceDisplay branch="grpc_unknown" />);
  advance(500);
  rerender(<EvidenceDisplay branch="guardian_unanswered" />);
  advance(500);
  expect(reportUserVisibleError).toHaveBeenCalledTimes(1);
  expect(reportUserVisibleError).toHaveBeenCalledWith('submissionUnanswered', 'status_screen', {
    kind: 'submission_feedback',
    submissionFeedbackBranch: 'guardian_unanswered'
  });
});

it('keeps the visible branch when a replacement render suspends before commit', async () => {
  const never = new Promise<void>(() => {});
  let replace: (() => void) | undefined;
  function DisplayEvidence() {
    const [pending, setPending] = React.useState(false);
    replace = () => React.startTransition(() => setPending(true));
    useUserVisibleError('submissionUnanswered', 'status_screen', undefined, {
      kind: 'submission_feedback',
      submissionFeedbackBranch: pending ? 'guardian_unanswered' : 'grpc_unknown'
    });
    if (pending) throw never;
    return <span>Committed message</span>;
  }
  const view = render(
    <React.Suspense fallback={<span>Pending</span>}>
      <DisplayEvidence />
    </React.Suspense>
  );
  advance(999);
  await act(async () => {
    replace?.();
  });
  expect(view.getByText('Committed message')).toBeVisible();
  advance(1);
  expect(reportUserVisibleError).toHaveBeenCalledWith('submissionUnanswered', 'status_screen', {
    kind: 'submission_feedback',
    submissionFeedbackBranch: 'grpc_unknown'
  });
});
