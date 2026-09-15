import React from 'react';

import { cleanup, render, screen } from '@testing-library/react';

import { GuardianTransitionHero } from './GuardianTransitionHero';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => {
      if (key === 'unknown') return 'Unknown';
      if (key === 'guardianProviderRegion') return `${values?.provider} · ${values?.region}`;
      return key;
    }
  })
}));

jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid="transition-icon">{name}</span>,
  IconName: { ArrowDown: 'ArrowDown' }
}));

afterEach(cleanup);

it('renders provider names and a custom endpoint hostname between the supplied labels', () => {
  render(
    <GuardianTransitionHero
      previousEndpoint="https://miden-guardian.lambdaclass.com"
      newEndpoint="https://custom.guardian.example/path"
      previousLabel="Current"
      newLabel="New"
      className="history-hero"
    />
  );

  expect(screen.getByTestId('guardian-transition-hero')).toHaveClass('history-hero');
  expect(screen.getByText('Current')).toBeInTheDocument();
  expect(screen.getByText('LambdaClass')).toBeInTheDocument();
  expect(screen.getByTestId('transition-icon')).toHaveTextContent('ArrowDown');
  expect(screen.getByText('New')).toBeInTheDocument();
  expect(screen.getByText('custom.guardian.example')).toBeInTheDocument();
});

it('renders the localized fallback when either endpoint is absent', () => {
  render(
    <GuardianTransitionHero previousEndpoint={undefined} newEndpoint={undefined} previousLabel="From" newLabel="To" />
  );

  expect(screen.getAllByText('Unknown')).toHaveLength(2);
});

it('emphasizes the destination and keeps review labels readable in dark mode', () => {
  render(
    <GuardianTransitionHero
      previousEndpoint="https://miden-guardian.lambdaclass.com"
      newEndpoint="https://guardian.openzeppelin.com"
      previousLabel="Current"
      newLabel="New"
      variant="review"
    />
  );

  // `text-heading-gray`, not `text-text-muted`: the muted token is #ababab, which
  // is 2.3:1 on this card in light mode. Both chips now carry ink that clears AA
  // in both themes.
  expect(screen.getByText('Current')).toHaveClass('text-heading-gray');
  // Provider names come from the canonical brand mapping (#464).
  expect(screen.getByText('LambdaClass · EU-WEST')).toHaveClass('text-heading-gray');
  // Fixed dark grey on the fixed white pill so the chip stays readable in dark mode.
  expect(screen.getByText('New')).toHaveClass('text-grey-700');
  expect(screen.getByText('OpenZeppelin · US-EAST')).toHaveClass('text-pure-white');
  expect(screen.getByText('OpenZeppelin', { selector: 'h2' })).toHaveClass('text-pure-white');
});
