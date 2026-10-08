import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { GUARDIAN_INTRO_POINTS, GuardianIntroScreen } from './GuardianIntro';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/mobile/haptics', () => ({ hapticSelection: jest.fn(), hapticLight: jest.fn() }));

describe('GuardianIntroScreen', () => {
  it('says what a Guardian is: its title, explainer and illustration, before naming any operator', () => {
    render(<GuardianIntroScreen />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('guardianIntroTitle');
    expect(screen.getByText('guardianIntroDescription')).toBeInTheDocument();
    expect(screen.getByTestId('onboarding-guardian-intro').querySelector('img')).toHaveAttribute('alt', '');
    expect(screen.queryByTestId('guardian-logo-tile')).toBeNull();
  });

  it('lists the three benefits, each on its own card, in order', () => {
    render(<GuardianIntroScreen />);
    expect(GUARDIAN_INTRO_POINTS.map(point => point.id)).toEqual(['recover', 'funds', 'switch']);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    GUARDIAN_INTRO_POINTS.forEach((point, index) => {
      expect(items[index]).toHaveAttribute('data-testid', `guardian-intro-point-${point.id}`);
      expect(items[index]).toHaveTextContent(point.titleKey);
      expect(items[index]).toHaveTextContent(point.bodyKey);
    });
  });

  it('goes on with Continue, with nothing to tick first', () => {
    const onContinue = jest.fn();
    render(<GuardianIntroScreen onContinue={onContinue} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    const button = screen.getByTestId('guardian-intro-continue');
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});
