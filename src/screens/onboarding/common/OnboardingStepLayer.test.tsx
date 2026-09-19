import React from 'react';

import { render, screen } from '@testing-library/react';
import { PresenceContext } from 'framer-motion';

import { pageSlideEntrance } from 'lib/animation';

import OnboardingStepLayerDefault, { OnboardingStepLayer } from './OnboardingStepLayer';

const leaving = (custom: string) => ({
  id: 'leaving',
  isPresent: false,
  custom,
  register: () => () => undefined,
  onExitComplete: () => undefined,
  initial: false as const
});

const layer = () => screen.getByTestId('content').parentElement;

describe('OnboardingStepLayer', () => {
  it('exports the component as the default export', () => {
    expect(OnboardingStepLayerDefault).toBe(OnboardingStepLayer);
  });

  it('draws a present step in reach, in the shared grid cell, on the page surface', () => {
    render(
      <OnboardingStepLayer direction="forward" transition={pageSlideEntrance}>
        <div data-testid="content" />
      </OnboardingStepLayer>
    );
    expect(layer()).toHaveAttribute('data-onboarding-step-layer', 'present');
    expect(layer()).toHaveClass('col-start-1', 'row-start-1', 'bg-app-bg');
    expect(layer()).not.toHaveAttribute('aria-hidden');
    expect(layer()).toHaveStyle({ zIndex: '2', pointerEvents: 'auto' });
  });

  it('takes a leaving step out of reach, under the next step going forward', () => {
    render(
      <PresenceContext.Provider value={leaving('forward')}>
        <OnboardingStepLayer direction="forward" transition={pageSlideEntrance}>
          <div data-testid="content" />
        </OnboardingStepLayer>
      </PresenceContext.Provider>
    );
    expect(layer()).toHaveAttribute('data-onboarding-step-layer', 'leaving');
    expect(layer()).toHaveAttribute('aria-hidden', 'true');
    expect(layer()).toHaveStyle({ zIndex: '1', pointerEvents: 'none' });
  });

  it('keeps a leaving step over the one it uncovers going back', () => {
    render(
      <PresenceContext.Provider value={leaving('backward')}>
        <OnboardingStepLayer direction="forward" transition={pageSlideEntrance}>
          <div data-testid="content" />
        </OnboardingStepLayer>
      </PresenceContext.Provider>
    );
    expect(layer()).toHaveStyle({ zIndex: '3' });
  });
});
