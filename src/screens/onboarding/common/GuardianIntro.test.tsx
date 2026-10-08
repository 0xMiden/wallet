import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';
import fs from 'fs';
import path from 'path';

import { GUARDIAN_INTRO_POINTS, GuardianIntroScreen } from './GuardianIntro';

// Echoes the key by default; a test that reads the copy itself swaps in the English source.
let mockTranslate = (key: string) => key;
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => mockTranslate(key) })
}));

const english: Record<string, string> = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../../../public/_locales/en/en.json'), 'utf8')
);

jest.mock('lib/mobile/haptics', () => ({ hapticSelection: jest.fn(), hapticLight: jest.fn() }));

// The explainer has its own test; here it only reports whether it is open.
jest.mock('./GuardianInfoDrawer', () => ({
  GuardianInfoDrawer: ({ open }: { open: boolean }) => (
    <div data-testid="guardian-info-drawer" data-open={String(open)} />
  )
}));

beforeEach(() => {
  mockTranslate = key => key;
});

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

  it('opens the Guardian explainer from More about Guardians, which is closed until asked for', () => {
    render(<GuardianIntroScreen />);
    expect(screen.getByTestId('guardian-info-drawer')).toHaveAttribute('data-open', 'false');
    const more = screen.getByTestId('guardian-intro-more-about');
    expect(more).toHaveTextContent('guardianIntroMoreAbout');
    fireEvent.click(more);
    expect(screen.getByTestId('guardian-info-drawer')).toHaveAttribute('data-open', 'true');
  });

  // The phrase restores the keys and the Guardian's backup the account, so neither alone is enough and the
  // phrase is still the user's to keep: the intro says so, and promises nothing about a lost phone.
  it("states the recovery model: the phrase restores the keys, the Guardian's backup the account", () => {
    mockTranslate = key => english[key] ?? key;
    render(<GuardianIntroScreen />);
    const recover = screen.getByTestId('guardian-intro-point-recover');
    expect(recover).toHaveTextContent(/recovery phrase restores your keys/i);
    expect(recover).toHaveTextContent(/Guardian's backup/i);
    expect(recover).toHaveTextContent(/keep the phrase safe/i);
    expect(screen.getByTestId('onboarding-guardian-intro')).not.toHaveTextContent(/losing your (phone|wallet)/i);
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
