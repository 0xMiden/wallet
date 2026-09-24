import React from 'react';

import { render } from '@testing-library/react';

import { Route } from './Route';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

describe('Route', () => {
  it('tags its confirm footer as a flow footer, so main.css snaps its navbar cushion', () => {
    const { container } = render(
      <Route route="epoch" onRouteChange={jest.fn()} fastQuoteLoading={false} onConfirm={jest.fn()} />
    );

    const footer = container.querySelector('[data-navbar-cushion="true"]');
    expect(footer).not.toBeNull();
    expect(footer).toHaveAttribute('data-flow-footer');
  });
});
