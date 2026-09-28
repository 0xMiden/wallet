import React from 'react';

import { render, screen } from '@testing-library/react';

import { stepFooterCushionClass } from 'components/flow/footer-cushion';
import { useSlideOnReflow } from 'components/flow/useSlideOnReflow';

import { Route } from './Route';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('lib/platform', () => ({ isMobile: () => true }));
jest.mock('components/flow/useSlideOnReflow', () => ({ useSlideOnReflow: jest.fn() }));

describe('Route', () => {
  it('pins its CTA in a flow footer that slides and snaps its cushion, like every flow page', () => {
    render(<Route route="epoch" onRouteChange={jest.fn()} fastQuoteLoading={false} onConfirm={jest.fn()} />);

    const footer = screen.getByTestId('bridge-route-confirm').parentElement!;
    expect(footer).toHaveAttribute('data-navbar-cushion', 'true');
    expect(footer).toHaveAttribute('data-flow-footer');
    expect(useSlideOnReflow).toHaveBeenCalledWith(expect.objectContaining({ current: footer }));
  });

  // #1109: the CTA's bottom padding is the shared cushion, never a literal of its own, so it follows the tab bar
  // (and drops to 1rem on the slide page this step lives on) instead of pinning a fixed 6rem.
  it('pins its CTA on the shared cushion', () => {
    render(<Route route="epoch" onRouteChange={jest.fn()} fastQuoteLoading={false} onConfirm={jest.fn()} />);

    const footer = screen.getByTestId('bridge-route-confirm').parentElement!;
    expect(footer).toHaveClass('pt-4');
    expect(footer).toHaveClass(stepFooterCushionClass());
    expect(footer.className).not.toContain('pb-24');
  });
});
