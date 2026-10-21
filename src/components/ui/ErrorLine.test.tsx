import React from 'react';

import { act, render, screen } from '@testing-library/react';

import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';

import { ErrorLine } from './ErrorLine';

jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));

it('announces the message as a 13px negative line, inset like a section label and selectable', () => {
  render(<ErrorLine data-testid="error">Could not save</ErrorLine>);

  const line = screen.getByRole('alert');
  expect(line).toHaveTextContent('Could not save');
  expect(line).toHaveAttribute('data-testid', 'error');
  expect(line).toHaveClass('px-1', 'text-caption', 'text-negative-ink', 'select-text');
});

it('renders nothing without a message, so a caller can pass its error state straight in', () => {
  const { container } = render(<ErrorLine>{undefined}</ErrorLine>);
  expect(container).toBeEmptyDOMElement();
});

it('takes layout classes from the caller', () => {
  render(<ErrorLine className="mt-3">Nope</ErrorLine>);
  expect(screen.getByRole('alert')).toHaveClass('mt-3');
});

it('can be a standing note rather than an alert', () => {
  render(<ErrorLine role="note">Decimals unknown</ErrorLine>);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByText('Decimals unknown')).toHaveClass('text-negative-ink');
});

describe('user-visible error reporting', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  it('reports its displayed error once on the inline surface after the dwell', () => {
    render(<ErrorLine errorId="usdcxFaucetUnavailable">Failed</ErrorLine>);
    act(() => jest.advanceTimersByTime(999));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));
    expect(reportUserVisibleError).toHaveBeenCalledTimes(1);
    expect(reportUserVisibleError).toHaveBeenCalledWith('usdcxFaucetUnavailable', 'inline');
    act(() => jest.advanceTimersByTime(5000));
    expect(reportUserVisibleError).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null])('does not report an error without an identifier: %p', errorId => {
    render(<ErrorLine errorId={errorId}>Failed</ErrorLine>);
    act(() => jest.advanceTimersByTime(1000));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });

  it('does not report when it is not showing an error', () => {
    render(<ErrorLine errorId="usdcxFaucetUnavailable" />);
    act(() => jest.advanceTimersByTime(1000));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });

  it('cancels reporting when the error clears within the dwell', () => {
    const { rerender } = render(<ErrorLine errorId="usdcxFaucetUnavailable">Failed</ErrorLine>);
    act(() => jest.advanceTimersByTime(999));
    rerender(<ErrorLine errorId="usdcxFaucetUnavailable" />);
    act(() => jest.advanceTimersByTime(1000));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });
});
