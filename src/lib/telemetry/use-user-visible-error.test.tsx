import React from 'react';

import { act, render } from '@testing-library/react';

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
