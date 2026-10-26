import React from 'react';

import { render, screen, waitFor, within } from '@testing-library/react';

import { fetchTokenMetadata } from 'lib/miden/metadata/fetch';

import { TransactionNoteFlow } from './TransactionNoteFlow';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('utils/string', () => ({ truncateAddress: (value: string) => `short:${value.slice(0, 5)}` }));
jest.mock('lib/miden/metadata/fetch', () => ({ fetchTokenMetadata: jest.fn() }));
jest.mock('lib/miden/metadata/scale', () => ({ hasKnownScale: () => true }));
jest.mock('lib/shared/format', () => ({ formatAmount: (amount: bigint) => amount.toString() }));

it('shows a zero-input flow into the account and exact output note labels', () => {
  render(
    <TransactionNoteFlow
      account="account-address"
      flow={{
        inputCount: 0,
        inputs: [],
        outputs: [
          { id: 'fee-id', kind: 'fee', visibility: 'public', assets: [] },
          { id: 'payment-id', kind: 'p2id', visibility: 'private', assets: [] },
          { id: 'swap-id', kind: 'pswap', visibility: 'unknown' }
        ]
      }}
    />
  );

  expect(screen.getByText('noInputNotes')).toBeInTheDocument();
  expect(screen.getByTestId('tx-note-account')).toHaveTextContent('short:accou');
  expect(within(screen.getByTestId('tx-note-account')).getByTitle('account-address')).toBeInTheDocument();
  expect(within(screen.getByTestId('tx-note-outputs')).getAllByRole('listitem')).toHaveLength(3);
  expect(screen.getByText('transactionFeeNote')).toBeInTheDocument();
  expect(screen.getByText('P2ID')).toBeInTheDocument();
  expect(screen.getByText('PSWAP')).toBeInTheDocument();
  expect(screen.getByText('noteDetailsUnavailable')).toBeInTheDocument();
});

it('shows multiple inputs, unknown scripts and unlisted input details without claiming no inputs', () => {
  render(
    <TransactionNoteFlow
      flow={{
        inputCount: 3,
        inputs: [
          { id: 'in-1', kind: 'p2ide', visibility: 'public', assets: [] },
          { id: 'in-2', kind: 'custom', visibility: 'unknown', assets: [] }
        ],
        outputs: []
      }}
    />
  );
  expect(within(screen.getByTestId('tx-note-inputs')).getAllByRole('listitem')).toHaveLength(2);
  expect(screen.getByText('otherNoteScript')).toBeInTheDocument();
  expect(screen.getByText('additionalInputDetailsUnavailable')).toBeInTheDocument();
  expect(screen.queryByText('noInputNotes')).not.toBeInTheDocument();
  expect(screen.getByText('noOutputNotes')).toBeInTheDocument();
});

it('keeps a long note identifier readable without clipping its value', () => {
  const id = `0x${'a'.repeat(128)}`;
  render(
    <TransactionNoteFlow
      flow={{ inputCount: 0, inputs: [], outputs: [{ id, kind: 'unknown', visibility: 'unknown' }] }}
    />
  );
  const identifier = screen.getByTitle(id);
  expect(identifier).toHaveTextContent(id);
  expect(identifier).toHaveClass('break-all');
});

it('does not show an old asset label while a different note asset resolves', async () => {
  let resolveSecond!: (metadata: { decimals: number; symbol: string }) => void;
  (fetchTokenMetadata as jest.Mock).mockResolvedValueOnce({ decimals: 6, symbol: 'FIRST' }).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        resolveSecond = resolve;
      })
  );
  const flow = (amount: bigint) => ({
    inputCount: 0,
    inputs: [],
    outputs: [
      { id: 'note', kind: 'p2id' as const, visibility: 'public' as const, assets: [{ faucetId: 'faucet', amount }] }
    ]
  });
  const { rerender } = render(<TransactionNoteFlow account="account" flow={flow(1n)} />);
  await waitFor(() => expect(screen.getByText('1 FIRST')).toBeInTheDocument());
  rerender(<TransactionNoteFlow account="account" flow={flow(2n)} />);
  expect(screen.queryByText('1 FIRST')).not.toBeInTheDocument();
  expect(screen.getByText(/2 baseUnits/)).toBeInTheDocument();
  resolveSecond({ decimals: 6, symbol: 'SECOND' });
  await waitFor(() => expect(screen.getByText('2 SECOND')).toBeInTheDocument());
});
