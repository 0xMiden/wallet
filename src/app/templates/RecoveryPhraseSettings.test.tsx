import React from 'react';

import { render, screen } from '@testing-library/react';

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

// A routed ListRow renders the wallet Link; stand it in with a plain anchor
// that carries the route, so a row is observable as a link to its page.
jest.mock('lib/woozie', () => ({
  Link: ({ to, testID: _testID, children, ...rest }: { to: string; testID?: string } & React.ComponentProps<'a'>) => (
    <a href={to} {...rest}>
      {children}
    </a>
  )
}));

describe('RecoveryPhraseSettings', () => {
  it('renders the reveal and remove rows in one plain ListGroup on SubPageLayout', () => {
    render(<RecoveryPhraseSettings />);

    const page = screen.getByTestId('recovery-phrase-settings');
    expect(page.querySelector('[data-slot="body"]')).toHaveClass('px-4', 'gap-5', 'overflow-y-auto');

    const reveal = screen.getByTestId('recovery-phrase-reveal');
    const remove = screen.getByTestId('recovery-phrase-remove');
    expect(reveal.parentElement).toBe(remove.parentElement);
    // The page IS the list: a `plain` group, no surface, rows on the page margin.
    expect(reveal.parentElement).toHaveClass('[&>*]:px-0', '[&>*]:before:left-0');
    expect(reveal.parentElement).not.toHaveClass('bg-fill');
    expect(reveal.querySelector('[data-slot="title"]')).toHaveTextContent('revealRecoveryPhrase');
    expect(remove.querySelector('[data-slot="title"]')).toHaveTextContent('removeSeedPhrase');
    expect(remove.querySelector('[data-slot="chevron"]')).not.toBeNull();
    expect(screen.getAllByRole('link')).toHaveLength(2);
    // No page footer: both actions are rows.
    expect(page.querySelector('[data-slot="footer"]')).toBeNull();
  });

  it('renders each row as a link to its own page', () => {
    render(<RecoveryPhraseSettings />);

    const reveal = screen.getByTestId('recovery-phrase-reveal');
    expect(reveal.tagName).toBe('A');
    expect(reveal).toHaveAttribute('href', '/settings/reveal-seed-phrase');
    expect(screen.getByTestId('recovery-phrase-remove')).toHaveAttribute('href', '/settings/remove-seed-phrase');
  });
});
