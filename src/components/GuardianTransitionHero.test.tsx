import React from 'react';

import { cleanup, render, screen } from '@testing-library/react';

import { GuardianTransitionHero } from './GuardianTransitionHero';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'unknown' ? 'Unknown' : key)
  })
}));

jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid="transition-icon">{name}</span>,
  IconName: { ArrowRight: 'ArrowRight' }
}));

afterEach(cleanup);

it('renders provider names and a custom endpoint hostname, left to right with an arrow between', () => {
  render(
    <GuardianTransitionHero
      previousEndpoint="https://miden-guardian.lambdaclass.com"
      newEndpoint="https://custom.guardian.example/path"
      previousLabel="Current"
      newLabel="New"
      className="review-hero"
    />
  );

  expect(screen.getByTestId('guardian-transition-hero')).toHaveClass('review-hero');
  expect(screen.getByText('LambdaClass')).toBeInTheDocument();
  expect(screen.getByTestId('transition-icon')).toHaveTextContent('ArrowRight');
  expect(screen.getByText('custom.guardian.example')).toBeInTheDocument();
  // The labels are not drawn, the ring and arrow carry them, but a screen reader still hears them.
  expect(screen.getByText('Current:', { exact: false })).toHaveClass('sr-only');
  expect(screen.getByText('New:', { exact: false })).toHaveClass('sr-only');
});

it('renders the localized fallback when either endpoint is absent', () => {
  render(
    <GuardianTransitionHero previousEndpoint={undefined} newEndpoint={undefined} previousLabel="From" newLabel="To" />
  );

  expect(screen.getAllByText('Unknown')).toHaveLength(2);
});

it('draws each provider on its round hero tile and rings only the destination', () => {
  render(
    <GuardianTransitionHero
      previousEndpoint="https://miden-guardian.lambdaclass.com"
      newEndpoint="https://guardian-testnet.openzeppelin.com"
      previousLabel="Current"
      newLabel="New"
    />
  );

  const [previousTile, newTile] = screen.getAllByTestId('guardian-logo-tile');
  expect(previousTile).toHaveClass('size-22', 'rounded-full');
  expect(previousTile).not.toHaveClass('ring-accent-primary');
  // Inset, as a chosen choice card's ring is, so the top of the scroller cannot clip it.
  expect(newTile).toHaveClass('ring-2', 'ring-inset', 'ring-accent-primary');
  // Provider names come from the canonical brand mapping (#464); the region sits under each.
  expect(screen.getByText('OpenZeppelin')).toHaveClass('text-row-title', 'text-ink');
  expect(screen.getByText('US-EAST')).toHaveClass('text-caption-heading', 'text-muted');
});
