import React from 'react';

import { act, render, screen } from '@testing-library/react';

import type { FeatureAvailability } from 'lib/remote-config/availability';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';

import { FeatureUnavailableNotice, isFeatureBlocked } from './FeatureUnavailable';
import en from '../../public/_locales/en/en.json';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (['bridgeFeatureUnavailableBody'].includes(key) ? `Visible ${key}` : key)
  })
}));

const AVAILABLE: FeatureAvailability = { state: 'available' };
const LOADING: FeatureAvailability = { state: 'loading' };
const DOWN: FeatureAvailability = { state: 'unavailable', reason: 'service-down', detail: 'allocator /health: 503' };
const RESTRICTED: FeatureAvailability = { state: 'unavailable', reason: 'restricted', detail: 'blocked by a geo rule' };
const PENDING: FeatureAvailability = {
  state: 'unavailable',
  reason: 'pending',
  detail: 'startup feature eligibility is pending'
};

describe('FeatureUnavailableNotice', () => {
  it('says the built-in copy as a warning, never the cause', () => {
    render(<FeatureUnavailableNotice availability={DOWN} variant="inline" className="mt-4" />);

    const notice = screen.getByTestId('feature-unavailable-notice');
    expect(notice).toHaveAttribute('data-tone', 'warning');
    expect(notice).toHaveAttribute('data-variant', 'inline');
    expect(notice).toHaveClass('mt-4');
    expect(notice).toHaveTextContent('bridgeFeatureUnavailableTitle');
    expect(notice).toHaveTextContent('bridgeFeatureUnavailableBody');
    expect(notice).not.toHaveTextContent('allocator');
  });

  it.each([
    [DOWN, 'service-down'],
    [RESTRICTED, 'restricted'],
    [PENDING, 'pending']
  ])('names the reason of %o for the e2e harness', (availability, reason) => {
    render(<FeatureUnavailableNotice availability={availability} />);
    expect(screen.getByTestId('feature-unavailable-notice')).toHaveAttribute('data-reason', reason);
  });

  it('shows the generic copy while the startup decision is pending', () => {
    render(<FeatureUnavailableNotice availability={PENDING} />);
    const notice = screen.getByTestId('feature-unavailable-notice');
    expect(notice).toHaveTextContent('bridgeFeatureUnavailableTitle');
    expect(notice).not.toHaveTextContent('geoRestrictedTitle');
    expect(notice).not.toHaveTextContent('startup feature eligibility');
  });

  it.each([AVAILABLE, LOADING])('renders nothing for %o', availability => {
    const { container } = render(<FeatureUnavailableNotice availability={availability} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('ships the exact English copy', () => {
    expect(en.bridgeFeatureUnavailableTitle).toBe('Temporarily unavailable');
    expect(en.bridgeFeatureUnavailableBody).toBe('This external service is currently down. Please try again later.');
    expect(en.geoRestrictedTitle).toBe('Not available where you are');
    expect(en.geoRestrictedBody).toBe('This feature is not offered in your location.');
  });

  it('says a place block is the location, not a service outage', () => {
    const restricted: FeatureAvailability = {
      state: 'unavailable',
      reason: 'restricted',
      detail: 'blocked by a geo rule'
    };
    render(<FeatureUnavailableNotice availability={restricted} />);
    const notice = screen.getByTestId('feature-unavailable-notice');
    expect(notice).toHaveTextContent('geoRestrictedTitle');
    expect(notice).toHaveTextContent('geoRestrictedBody');
    expect(notice).not.toHaveTextContent('bridgeFeatureUnavailableTitle');
    expect(notice).not.toHaveTextContent('blocked by a geo rule');
  });
});

it.each<[FeatureAvailability, boolean]>([
  [AVAILABLE, false],
  [LOADING, true],
  [DOWN, true]
])('isFeatureBlocked(%o) is %s', (availability, blocked) => {
  expect(isFeatureBlocked(availability)).toBe(blocked);
});

jest.mock('lib/telemetry/user-visible-error', () => ({
  ...jest.requireActual('lib/telemetry/user-visible-error'),
  reportUserVisibleError: jest.fn()
}));

const mockReport = jest.mocked(reportUserVisibleError);

describe('user-visible unavailable-feature errors', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockReport.mockClear();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports bridgeFeatureUnavailableBody once for an unavailable service despite warning styling', () => {
    const view = render(<FeatureUnavailableNotice availability={DOWN} />);
    expect(screen.getByTestId('feature-unavailable-notice')).toHaveTextContent('Visible bridgeFeatureUnavailableBody');
    act(() => jest.advanceTimersByTime(999));
    expect(mockReport.mock.calls).toEqual([]);
    act(() => jest.advanceTimersByTime(1));
    expect(mockReport.mock.calls).toEqual([
      [
        'bridgeFeatureUnavailableBody',
        'notice',
        { kind: 'feature_unavailable', featureUnavailableFeature: 'unknown', featureUnavailableReason: 'service-down' }
      ]
    ]);
    view.rerender(<FeatureUnavailableNotice availability={{ ...DOWN, detail: 'another private cause' }} />);
    act(() => jest.advanceTimersByTime(1000));
    expect(mockReport.mock.calls).toEqual([
      [
        'bridgeFeatureUnavailableBody',
        'notice',
        { kind: 'feature_unavailable', featureUnavailableFeature: 'unknown', featureUnavailableReason: 'service-down' }
      ]
    ]);
  });

  it.each([AVAILABLE, LOADING])('does not report hidden %o state', availability => {
    const view = render(<FeatureUnavailableNotice availability={availability} />);
    expect(view.container).toBeEmptyDOMElement();
    act(() => jest.advanceTimersByTime(1000));
    expect(mockReport.mock.calls).toEqual([]);
  });

  it('keeps a visible geographic restriction quiet', () => {
    render(<FeatureUnavailableNotice availability={RESTRICTED} />);
    expect(screen.getByTestId('feature-unavailable-notice')).toHaveTextContent('geoRestrictedBody');
    act(() => jest.advanceTimersByTime(5000));
    expect(mockReport.mock.calls).toEqual([]);
  });

  it('keeps a pending startup decision quiet', () => {
    render(<FeatureUnavailableNotice availability={PENDING} />);
    expect(screen.getByTestId('feature-unavailable-notice')).toHaveTextContent('Visible bridgeFeatureUnavailableBody');
    act(() => jest.advanceTimersByTime(5000));
    expect(mockReport.mock.calls).toEqual([]);
  });

  it('cancels an outage dwell when a geographic restriction replaces it', () => {
    const view = render(<FeatureUnavailableNotice availability={DOWN} />);
    expect(screen.getByTestId('feature-unavailable-notice')).toHaveTextContent('Visible bridgeFeatureUnavailableBody');
    act(() => jest.advanceTimersByTime(999));
    view.rerender(<FeatureUnavailableNotice availability={RESTRICTED} />);
    expect(screen.getByTestId('feature-unavailable-notice')).toHaveTextContent('geoRestrictedBody');
    act(() => jest.advanceTimersByTime(5000));
    expect(mockReport.mock.calls).toEqual([]);
  });

  it('starts a full outage dwell after a geographic restriction clears', () => {
    const view = render(<FeatureUnavailableNotice availability={RESTRICTED} />);
    act(() => jest.advanceTimersByTime(5000));
    view.rerender(<FeatureUnavailableNotice availability={DOWN} />);
    expect(screen.getByTestId('feature-unavailable-notice')).toHaveTextContent('Visible bridgeFeatureUnavailableBody');
    act(() => jest.advanceTimersByTime(999));
    expect(mockReport.mock.calls).toEqual([]);
    act(() => jest.advanceTimersByTime(1));
    expect(mockReport.mock.calls).toEqual([
      [
        'bridgeFeatureUnavailableBody',
        'notice',
        { kind: 'feature_unavailable', featureUnavailableFeature: 'unknown', featureUnavailableReason: 'service-down' }
      ]
    ]);
  });

  it.each([AVAILABLE, LOADING])('drops an unavailable episode cleared at 999 ms by %o', availability => {
    const view = render(<FeatureUnavailableNotice availability={DOWN} />);
    expect(screen.getByTestId('feature-unavailable-notice')).toBeInTheDocument();
    act(() => jest.advanceTimersByTime(999));
    view.rerender(<FeatureUnavailableNotice availability={availability} />);
    expect(view.container).toBeEmptyDOMElement();
    act(() => jest.advanceTimersByTime(1000));
    expect(mockReport.mock.calls).toEqual([]);
  });
});

it('defaults a composite feature to unknown without rerunning availability or restarting the outage dwell', () => {
  jest.useFakeTimers();
  mockReport.mockClear();
  const view = render(<FeatureUnavailableNotice availability={DOWN} />);
  act(() => jest.advanceTimersByTime(500));
  view.rerender(<FeatureUnavailableNotice availability={{ ...DOWN, detail: 'private-other' }} />);
  act(() => jest.advanceTimersByTime(500));
  expect(mockReport).toHaveBeenCalledTimes(1);
  expect(mockReport).toHaveBeenCalledWith('bridgeFeatureUnavailableBody', 'notice', {
    kind: 'feature_unavailable',
    featureUnavailableFeature: 'unknown',
    featureUnavailableReason: 'service-down'
  });
  jest.useRealTimers();
});
