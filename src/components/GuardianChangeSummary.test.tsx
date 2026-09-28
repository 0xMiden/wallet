import React from 'react';

import { cleanup, render, screen } from '@testing-library/react';

import GuardianChangeSummaryDefault, { GuardianChangeSummary } from './GuardianChangeSummary';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'unknown' ? 'Unknown' : key)
  })
}));

afterEach(cleanup);

describe('GuardianChangeSummary', () => {
  it('exports the component as the default export', () => {
    expect(GuardianChangeSummaryDefault).toBe(GuardianChangeSummary);
  });

  it('stacks both providers on brand tiles, old above new, with From/To labels', () => {
    render(
      <GuardianChangeSummary
        kind="switch"
        previousEndpoint="https://miden-guardian.lambdaclass.com"
        newEndpoint="https://guardian.openzeppelin.com"
        className="mt-2"
      />
    );

    const summary = screen.getByTestId('guardian-change-summary');
    // Vertical: the two providers stack, the arrow between them points down.
    expect(summary).toHaveClass('mt-2', 'flex-col', 'items-center', 'rounded-2xl', 'bg-fill');
    expect(summary).toHaveAttribute('data-kind', 'switch');

    // The old provider is drawn first, so it reads top down.
    const [previous, next] = screen.getAllByTestId('guardian-change-side');
    expect(previous).toHaveTextContent('LambdaClass');
    expect(next).toHaveTextContent('OpenZeppelin');

    // One tile per side, and the provider names come from the canonical brand mapping.
    expect(screen.getAllByTestId('guardian-logo-tile')).toHaveLength(2);
    expect(screen.getAllByTestId('guardian-operator-logo')).toHaveLength(2);
    expect(screen.getByText('LambdaClass')).toHaveClass('text-row-title', 'text-ink');
    expect(screen.getByText('OpenZeppelin')).toHaveClass('text-row-title', 'text-ink');

    expect(screen.getByText('from')).toHaveClass('text-caption', 'text-muted');
    expect(screen.getByText('to')).toHaveClass('text-caption', 'text-muted');

    // The labels say which way it reads, so the arrow is decorative.
    const arrow = screen.getByTestId('guardian-change-arrow');
    expect(arrow).toHaveAttribute('aria-hidden', 'true');
    expect(arrow).toHaveAttribute('name', 'arrow-down');
  });

  it('names a custom endpoint by its host and falls back to the generic avatar', () => {
    render(<GuardianChangeSummary kind="switch" newEndpoint="https://custom.guardian.example/path" />);

    // A legacy row with no previous endpoint still reads as a transition.
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.getByText('custom.guardian.example')).toBeInTheDocument();
    expect(screen.getAllByTestId('guardian-avatar')).toHaveLength(2);
  });

  it('draws the guardian once for a device-key rotation, with no arrow', () => {
    render(<GuardianChangeSummary kind="single" endpoint="https://guardian.openzeppelin.com" />);

    expect(screen.getByTestId('guardian-change-summary')).toHaveAttribute('data-kind', 'single');
    expect(screen.getAllByTestId('guardian-change-side')).toHaveLength(1);
    expect(screen.getByText('guardianBadge')).toHaveClass('text-caption', 'text-muted');
    expect(screen.getByText('OpenZeppelin')).toBeInTheDocument();
    expect(screen.queryByTestId('guardian-change-arrow')).toBeNull();
    expect(screen.queryByText('from')).toBeNull();
    expect(screen.queryByText('to')).toBeNull();
  });
});
