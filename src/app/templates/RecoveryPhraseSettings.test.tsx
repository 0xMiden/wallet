import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';
import { navigate } from 'lib/woozie';

import RecoveryPhraseSettings from './RecoveryPhraseSettings';

// RecoveryPhraseSettings is the Recovery Phrase section: two ListRows in one
// ListGroup on the shared SubPageLayout, one for the reveal and one for the
// removal. The Settings menu hides the section once the phrase is gone, so the
// page itself has no gate. Every collaborator is stubbed.

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid="icon" data-name={name} />,
  IconName: { ChevronLeft: 'chevron-left', Close: 'close' }
}));

jest.mock('lib/woozie', () => ({
  navigate: jest.fn(),
  Link: () => null
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

const mockNavigate = navigate as jest.Mock;
const mockHapticLight = hapticLight as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('RecoveryPhraseSettings', () => {
  it('renders the reveal and remove rows in one ListGroup on SubPageLayout', () => {
    render(<RecoveryPhraseSettings />);

    const page = screen.getByTestId('recovery-phrase-settings');
    expect(page.querySelector('[data-slot="body"]')).toHaveClass('px-4', 'gap-5', 'overflow-y-auto');

    const reveal = screen.getByTestId('recovery-phrase-reveal');
    const remove = screen.getByTestId('recovery-phrase-remove');
    expect(reveal.parentElement).toBe(remove.parentElement);
    expect(reveal.parentElement).toHaveClass('bg-fill', 'rounded-2xl');
    expect(reveal.querySelector('[data-slot="title"]')).toHaveTextContent('revealRecoveryPhrase');
    expect(remove.querySelector('[data-slot="title"]')).toHaveTextContent('removeSeedPhrase');
    expect(remove.querySelector('[data-slot="chevron"]')).not.toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(2);
    // No page footer: both actions are rows.
    expect(page.querySelector('[data-slot="footer"]')).toBeNull();
  });

  it('navigates each row to its own page with a single haptic per tap', () => {
    render(<RecoveryPhraseSettings />);

    fireEvent.click(screen.getByText('revealRecoveryPhrase'));
    expect(mockNavigate).toHaveBeenLastCalledWith('/settings/reveal-seed-phrase');

    fireEvent.click(screen.getByText('removeSeedPhrase'));
    expect(mockNavigate).toHaveBeenLastCalledWith('/settings/remove-seed-phrase');

    expect(mockHapticLight).toHaveBeenCalledTimes(2);
  });
});
