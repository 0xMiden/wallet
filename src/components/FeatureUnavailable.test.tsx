import React from 'react';

import { render, screen } from '@testing-library/react';

import type { FeatureAvailability } from 'lib/remote-config/availability';

import { FeatureUnavailableNotice, isFeatureBlocked } from './FeatureUnavailable';
import en from '../../public/_locales/en/en.json';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const AVAILABLE: FeatureAvailability = { state: 'available' };
const LOADING: FeatureAvailability = { state: 'loading' };
const DOWN: FeatureAvailability = { state: 'unavailable', reason: 'service-down', detail: 'allocator /health: 503' };

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

  it.each([AVAILABLE, LOADING])('renders nothing for %o', availability => {
    const { container } = render(<FeatureUnavailableNotice availability={availability} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('ships the exact English copy', () => {
    expect(en.bridgeFeatureUnavailableTitle).toBe('Temporarily unavailable');
    expect(en.bridgeFeatureUnavailableBody).toBe('This external service is currently down. Please try again later.');
  });
});

it.each<[FeatureAvailability, boolean]>([
  [AVAILABLE, false],
  [LOADING, true],
  [DOWN, true]
])('isFeatureBlocked(%o) is %s', (availability, blocked) => {
  expect(isFeatureBlocked(availability)).toBe(blocked);
});
