import React from 'react';

import { render, screen } from '@testing-library/react';

import { SeedPhraseGrid, SeedPhrasePlaceholder, SeedPhrasePrivacyHero } from './SeedPhraseGrid';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const WORDS = ['alpha', 'beta', 'gamma', 'delta'];

it('numbers the words on the group fill, in the phrase own casing', () => {
  render(<SeedPhraseGrid words={WORDS} data-testid="grid" />);

  const grid = screen.getByTestId('grid');
  expect(grid).toHaveClass('rounded-2xl', 'bg-fill');
  expect(screen.getByTestId('seed-word-0')).toHaveTextContent('alpha');
  expect(screen.getByTestId('seed-word-3')).toHaveTextContent('delta');
  expect(grid).toHaveTextContent('1.');
  expect(grid).toHaveTextContent('4.');
});

it('draws twelve blank bars for the placeholder, hidden from assistive tech', () => {
  const { container } = render(<SeedPhrasePlaceholder />);

  const card = container.firstElementChild!;
  expect(card).toHaveAttribute('aria-hidden', 'true');
  expect(card).toHaveClass('rounded-2xl', 'bg-fill');
  expect(card.querySelectorAll('.bg-fill-pressed')).toHaveLength(12);
  // The placeholder shows no words at all.
  expect(card).toHaveTextContent('');
});

it('names the privacy warning both screens open on', () => {
  render(<SeedPhrasePrivacyHero />);
  expect(screen.getByText('viewThisInPrivatePlace')).toBeInTheDocument();
  expect(screen.getByText('anyoneWithRecoveryPhrase')).toBeInTheDocument();
});
