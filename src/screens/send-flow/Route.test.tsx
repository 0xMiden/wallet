import React from 'react';

import { render, screen } from '@testing-library/react';

import { useSlideOnReflow } from 'components/flow/useSlideOnReflow';

import { Route } from './Route';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('lib/platform', () => ({ isMobile: () => true, isAndroid: () => false }));
jest.mock('components/flow/useSlideOnReflow', () => ({ useSlideOnReflow: jest.fn() }));

describe('Route', () => {
  it('pins its CTA in a flow footer that slides and snaps its cushion, like every flow page', () => {
    render(<Route route="epoch" onRouteChange={jest.fn()} fastQuoteLoading={false} onConfirm={jest.fn()} />);

    const footer = screen.getByTestId('bridge-route-confirm').parentElement!;
    expect(footer).toHaveAttribute('data-navbar-cushion', 'true');
    expect(footer).toHaveAttribute('data-flow-footer');
    expect(useSlideOnReflow).toHaveBeenCalledWith(expect.objectContaining({ current: footer }));
  });

  it('applies the default footer padding, and a footerClassName override', () => {
    const { rerender } = render(
      <Route route="epoch" onRouteChange={jest.fn()} fastQuoteLoading={false} onConfirm={jest.fn()} />
    );
    let footer = screen.getByTestId('bridge-route-confirm').parentElement!;
    expect(footer).toHaveClass('pt-4');
    expect(footer).toHaveClass('pb-24');

    rerender(
      <Route
        route="epoch"
        onRouteChange={jest.fn()}
        fastQuoteLoading={false}
        onConfirm={jest.fn()}
        footerClassName="pt-2 pb-6"
      />
    );
    footer = screen.getByTestId('bridge-route-confirm').parentElement!;
    expect(footer).toHaveClass('pb-6');
    expect(footer.className).not.toContain('pb-24');
  });
});
