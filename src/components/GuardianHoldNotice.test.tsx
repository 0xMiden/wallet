import React from 'react';

import { act, render, screen } from '@testing-library/react';

import { formatHoldDeadline } from 'lib/i18n/hold-deadline';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';

import { GuardianHoldNotice } from './GuardianHoldNotice';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, substitutions?: Record<string, string>) =>
      substitutions === undefined ? key : `${key} ${JSON.stringify(substitutions)}`
  })
}));
jest.mock('lib/i18n/core', () => ({ ...jest.requireActual('lib/i18n/core'), getCurrentLocale: () => 'de' }));
jest.mock('lib/telemetry/user-visible-error', () => ({
  ...jest.requireActual('lib/telemetry/user-visible-error'),
  reportUserVisibleError: jest.fn()
}));

const NOW_SEC = 1_800_000_000;

describe('GuardianHoldNotice (#2060)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW_SEC * 1000);
    jest.mocked(reportUserVisibleError).mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('names the deadline in the wallet locale and the time left as mm:ss', () => {
    render(<GuardianHoldNotice clearsAtSec={NOW_SEC + 75} />);

    const time = formatHoldDeadline(NOW_SEC + 75, { locale: 'de' });
    expect(screen.getByTestId('guardian-hold-notice')).toHaveTextContent(
      `guardianHoldNotice ${JSON.stringify({ time })}`
    );
    expect(screen.getByTestId('guardian-hold-countdown')).toHaveTextContent('01:15');
    expect(screen.getByTestId('guardian-hold-countdown')).toHaveAttribute('dateTime', 'PT75S');
    expect(screen.getByTestId('guardian-hold-countdown')).toHaveClass('tabular-nums');
  });

  it('announces the deadline and keeps the countdown out of the live region', () => {
    render(<GuardianHoldNotice clearsAtSec={NOW_SEC + 75} />);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('guardianHoldNotice');
    expect(status).not.toContainElement(screen.getByTestId('guardian-hold-countdown'));
    expect(
      screen.getByTestId('guardian-hold-countdown').closest('[aria-live], [role="status"], [role="alert"]')
    ).toBeNull();
  });

  it('ticks without the parent rendering, and is gone at the deadline', () => {
    let parentRenders = 0;
    const Parent = () => {
      parentRenders += 1;
      return <GuardianHoldNotice clearsAtSec={NOW_SEC + 2} />;
    };
    render(<Parent />);

    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    expect(screen.getByTestId('guardian-hold-countdown')).toHaveTextContent('00:01');
    expect(parentRenders).toBe(1);

    act(() => {
      jest.advanceTimersByTime(999);
    });
    expect(screen.getByTestId('guardian-hold-countdown')).toHaveTextContent('00:01');

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(screen.queryByTestId('guardian-hold-notice')).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  // A disabled Retry never reaches the `guardian_hold` refusal, so this is what keeps the frequency visible.
  it('reports its showing once, through the closed id, with nothing else in it', () => {
    render(<GuardianHoldNotice clearsAtSec={NOW_SEC + 75} />);

    act(() => {
      jest.advanceTimersByTime(5_000);
    });

    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['guardianHoldNotice', 'notice']]);
  });
});
