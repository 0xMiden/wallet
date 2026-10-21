import React from 'react';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';

import { ProtectorProbeErrorNotice } from './ProtectorProbeErrorNotice';
import en from '../../public/_locales/en/en.json';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => (['couldNotCheckUnlockMethod'].includes(key) ? `Visible ${key}` : key) })
}));

afterEach(cleanup);

it('shows the failure notice with an enabled Retry that calls onRetry', () => {
  const onRetry = jest.fn();
  render(<ProtectorProbeErrorNotice onRetry={onRetry} retrying={false} />);

  expect(screen.getByTestId('protector-probe-error')).toHaveTextContent('couldNotCheckUnlockMethod');
  const retry = screen.getByTestId('protector-probe-retry');
  expect(retry).toBeEnabled();
  expect(retry).not.toHaveAttribute('aria-busy');

  fireEvent.click(retry);
  expect(onRetry).toHaveBeenCalledTimes(1);
});

// #1241: while a retry is in flight the notice stays up and the button is disabled and loading, so the
// page never looks idle mid-attempt.
it('keeps the notice up and disables Retry with aria-busy while a retry is in flight', () => {
  render(<ProtectorProbeErrorNotice onRetry={jest.fn()} retrying />);

  expect(screen.getByTestId('protector-probe-error')).toBeInTheDocument();
  const retry = screen.getByTestId('protector-probe-retry');
  expect(retry).toBeDisabled();
  expect(retry).toHaveAttribute('aria-busy', 'true');
});

// #1241: Button's default width caps at `max-w-92.5`, which left Retry left-aligned and narrower
// than the full-width Notice above it wherever the notice renders, including RotateGuardianReview's
// stacked footer next to a `max-w-none` Continue.
it('spans the full notice width, uncapped, everywhere it renders', () => {
  render(<ProtectorProbeErrorNotice onRetry={jest.fn()} retrying={false} />);

  expect(screen.getByTestId('protector-probe-retry')).toHaveClass('max-w-none');
});

// #1241: the probe is two local storage reads, so the copy cannot name a network cause it never has.
it('names no network cause in its English copy', () => {
  const copy = en.couldNotCheckUnlockMethod;

  expect(copy).not.toMatch(/connection|network|internet/i);
});

jest.mock('lib/telemetry/user-visible-error', () => ({
  ...jest.requireActual('lib/telemetry/user-visible-error'),
  reportUserVisibleError: jest.fn()
}));

const mockReport = jest.mocked(reportUserVisibleError);

describe('user-visible protector-probe errors', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockReport.mockClear();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([false, true])(
    'reports couldNotCheckUnlockMethod once while its notice remains visible, retrying=%s',
    retrying => {
      const view = render(<ProtectorProbeErrorNotice onRetry={jest.fn()} retrying={retrying} />);
      expect(screen.getByRole('alert')).toHaveTextContent('Visible couldNotCheckUnlockMethod');
      act(() => jest.advanceTimersByTime(999));
      expect(mockReport.mock.calls).toEqual([]);
      act(() => jest.advanceTimersByTime(1));
      expect(mockReport.mock.calls).toEqual([['couldNotCheckUnlockMethod', 'notice']]);
      view.rerender(<ProtectorProbeErrorNotice onRetry={jest.fn()} retrying={!retrying} />);
      act(() => jest.advanceTimersByTime(1000));
      expect(mockReport.mock.calls).toEqual([['couldNotCheckUnlockMethod', 'notice']]);
    }
  );

  it('does not report a probe notice removed at 999 ms', () => {
    const view = render(<ProtectorProbeErrorNotice onRetry={jest.fn()} retrying={false} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    act(() => jest.advanceTimersByTime(999));
    view.unmount();
    act(() => jest.advanceTimersByTime(1000));
    expect(mockReport.mock.calls).toEqual([]);
  });
});
