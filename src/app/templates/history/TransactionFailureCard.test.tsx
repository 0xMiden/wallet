import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { REMOTE_PROVER_FAILED_ERROR } from 'lib/miden/transaction/constants';

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

  it('titles the card "notConfirmed" with the hint as its body and the reason behind the disclosure', () => {
    render(
      <TransactionFailureCard errorMessage="Transaction took too long to process and was cancelled" isUnconfirmed />
    );

    expect(screen.getByText('notConfirmed')).toBeInTheDocument();
    expect(screen.queryByTestId('history-failure-reason')).not.toBeInTheDocument();
    expect(screen.getByTestId('history-unconfirmed-hint')).toHaveTextContent('transactionNotConfirmedHint');
    expect(screen.queryByText('Transaction took too long to process and was cancelled')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('showFullError'));
    expect(screen.getByText('Transaction took too long to process and was cancelled')).toBeInTheDocument();
  });

  // Classifier copy claims a failure ("No funds moved") the wallet cannot make for this row (#1250).
  it('shows no classifier copy on a not-confirmed card and reveals the raw error on demand', () => {
    render(
      <TransactionFailureCard errorMessage={REMOTE_PROVER_FAILED_ERROR} rawErrorMessage="Error: 503" isUnconfirmed />
    );

    expect(screen.queryByText(REMOTE_PROVER_FAILED_ERROR)).not.toBeInTheDocument();
    expect(screen.getByTestId('history-unconfirmed-hint')).toBeInTheDocument();
    fireEvent.click(screen.getByText('showFullError'));
    expect(screen.getByText('Error: 503')).toBeInTheDocument();
    expect(screen.queryByText(REMOTE_PROVER_FAILED_ERROR)).not.toBeInTheDocument();
  });

  it.each(['transactionNotConfirmedHint', 'transactionUndeterminedHint', 'transactionRestoredHint'] as const)(
    'an unconfirmed row shows the %s hint it is given (#1081)',
    hintKey => {
      render(<TransactionFailureCard errorMessage="boom" isUnconfirmed hintKey={hintKey} />);
      expect(screen.getByTestId('history-unconfirmed-hint')).toHaveTextContent(hintKey);
    }
  );

  it('lets isUnconfirmed outrank isCancelled: a stamped user cancel is both', () => {
    render(<TransactionFailureCard errorMessage="Transaction was cancelled by user" isUnconfirmed isCancelled />);

    expect(screen.getByText('notConfirmed')).toBeInTheDocument();
    expect(screen.queryByText('cancelled')).not.toBeInTheDocument();
    expect(screen.getByTestId('history-unconfirmed-hint')).toBeInTheDocument();
  });
});
