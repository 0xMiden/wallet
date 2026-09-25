import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { TransactionFailureCard } from './TransactionFailureCard';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// Unmocked: renders through the real `DetailSection` → `DetailCard` (`divide-y`),
// which is exactly what the structural assertions below depend on.
describe('TransactionFailureCard', () => {
  it('renders the message and toggle as ONE card body, not two hairline-divided rows', () => {
    render(
      <TransactionFailureCard errorMessage="Prover timed out" rawErrorMessage="Error: fetch timeout after 30000ms" />
    );

    // The card (`DetailCard`'s own root, identified by its `divide-y` class — the
    // section also has a sibling SectionHeader) has exactly one child: the
    // wrapper that holds both the message and the toggle. Two children would
    // mean `divide-y` draws a hairline between the message and the toggle.
    const card = screen.getByText('Prover timed out').closest('section')!.querySelector('.divide-y')!;
    expect(card.children).toHaveLength(1);

    // The toggle lives INSIDE that one child, alongside the message.
    const body = card.children[0];
    expect(body).toContainElement(screen.getByText('Prover timed out'));
    expect(body).toContainElement(screen.getByText('showFullError'));
  });

  it('hides the raw error until the disclosure is toggled', () => {
    render(<TransactionFailureCard errorMessage="Prover timed out" rawErrorMessage="Error: fetch timeout" />);

    expect(screen.queryByText('Error: fetch timeout')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('showFullError'));
    expect(screen.getByText('Error: fetch timeout')).toBeInTheDocument();
    fireEvent.click(screen.getByText('hideFullError'));
    expect(screen.queryByText('Error: fetch timeout')).not.toBeInTheDocument();
  });

  it('renders no toggle when there is no raw error', () => {
    render(<TransactionFailureCard errorMessage="Prover timed out" />);
    expect(screen.queryByText('showFullError')).not.toBeInTheDocument();
  });

  it('titles the card "cancelled" and mutes the message when the tx was user-cancelled', () => {
    render(<TransactionFailureCard errorMessage="Transaction was cancelled by user" isCancelled />);

    expect(screen.getByText('cancelled')).toBeInTheDocument();
    expect(screen.getByText('Transaction was cancelled by user')).toHaveClass('text-gray-500');
  });

  it('titles the card "error" and reads the message in negative ink otherwise', () => {
    render(<TransactionFailureCard errorMessage="Prover timed out" />);

    expect(screen.getByText('error')).toBeInTheDocument();
    expect(screen.getByText('Prover timed out')).toHaveClass('text-status-negative');
  });
});
