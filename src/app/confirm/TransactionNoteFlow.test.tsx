import React from 'react';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { fetchTokenMetadata } from 'lib/miden/metadata/fetch';

import { TransactionNoteFlow } from './TransactionNoteFlow';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: { name?: string }) => (vars?.name ? `${key}:${vars.name}` : key)
  })
}));
jest.mock('utils/string', () => ({ truncateAddress: (value: string) => `short:${value.slice(0, 5)}` }));
jest.mock('lib/miden/metadata/fetch', () => ({ fetchTokenMetadata: jest.fn() }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveRpcUrl: () => 'https://rpc.example' }));
jest.mock('lib/miden/metadata/scale', () => ({ hasKnownScale: () => true }));
jest.mock('lib/shared/format', () => ({ formatAmount: (amount: bigint) => amount.toString() }));

function openNotes() {
  fireEvent.click(screen.getByRole('button', { name: 'showNotes' }));
}

it('shows a zero-input flow into the account and exact output note labels', () => {
  render(
    <TransactionNoteFlow
      account="account-address"
      flow={{
        inputCount: 0,
        inputs: [],
        outputs: [
          { id: 'fee-id', kind: 'fee', visibility: 'public', assets: [] },
          { id: 'payment-id', kind: 'P2ID', visibility: 'private', assets: [] },
          { id: 'swap-id', kind: 'PSWAP', visibility: 'unknown' }
        ]
      }}
    />
  );
  openNotes();

  expect(screen.getByText('noInputNotes')).toBeInTheDocument();
  expect(screen.getByTestId('tx-note-account')).toHaveTextContent('short:accou');
  expect(within(screen.getByTestId('tx-note-account')).getByTitle('account-address')).toBeInTheDocument();
  expect(within(screen.getByTestId('tx-note-outputs')).getAllByRole('listitem')).toHaveLength(3);
  expect(screen.getByText('transactionFeeNote')).toBeInTheDocument();
  expect(screen.getByText('P2ID')).toBeInTheDocument();
  expect(screen.getByText('PSWAP')).toBeInTheDocument();
  expect(screen.getByText('noteDetailsUnavailable')).toBeInTheDocument();
});

it('names a standard note from StandardNote and calls a tx fee note the transaction fee', () => {
  render(
    <TransactionNoteFlow
      flow={{
        inputCount: 0,
        inputs: [],
        outputs: [
          { id: 'sponsor', kind: 'FEE_SPONSORSHIP', visibility: 'public', assets: [] },
          { id: 'tx-fee', kind: 'TX_FEE', visibility: 'public', assets: [] },
          { id: 'swap', kind: 'SWAP', visibility: 'public', assets: [] }
        ]
      }}
    />
  );
  openNotes();
  expect(screen.getByText('standardNoteLabel:Fee sponsorship')).toBeInTheDocument();
  expect(screen.getByText('transactionFeeNote')).toBeInTheDocument();
  expect(screen.getByText('standardNoteLabel:SWAP')).toBeInTheDocument();
  expect(screen.getByText(/outputNotesIncludingFee/)).toBeInTheDocument();
});

it('shows multiple inputs, unknown scripts and unlisted input details without claiming no inputs', () => {
  render(
    <TransactionNoteFlow
      flow={{
        inputCount: 3,
        inputs: [
          { id: 'in-1', kind: 'P2IDE', visibility: 'public', assets: [] },
          { id: 'in-2', kind: 'custom', visibility: 'unknown', assets: [] }
        ],
        outputs: []
      }}
    />
  );
  openNotes();
  expect(within(screen.getByTestId('tx-note-inputs')).getAllByRole('listitem')).toHaveLength(2);
  expect(screen.getByText('otherNoteScript')).toBeInTheDocument();
  expect(screen.getByText('additionalInputDetailsUnavailable')).toBeInTheDocument();
  expect(screen.queryByText('noInputNotes')).not.toBeInTheDocument();
  expect(screen.getByText('noOutputNotes')).toBeInTheDocument();
  expect(screen.getByText('storageDetailsUnavailable')).toBeInTheDocument();
});

it('keeps a long note identifier readable without clipping its value', () => {
  const id = `0x${'a'.repeat(128)}`;
  render(
    <TransactionNoteFlow
      flow={{ inputCount: 0, inputs: [], outputs: [{ id, kind: 'unknown', visibility: 'unknown' }] }}
    />
  );
  openNotes();
  const identifier = screen.getByTitle(id);
  expect(identifier).toHaveTextContent(id);
  expect(identifier).toHaveClass('break-all');
});

it('shows named storage operations and entry counts without raw values', () => {
  render(
    <TransactionNoteFlow
      flow={{
        inputCount: 0,
        inputs: [],
        outputs: [],
        storageChanges: [
          { slotName: 'counter', kind: 'value', operation: 'update' },
          { slotName: 'balances', kind: 'map', operation: 'create', entryCount: 2 }
        ]
      }}
    />
  );
  openNotes();
  const storage = screen.getByTestId('tx-storage-details');
  expect(storage).toHaveTextContent('counter');
  expect(storage).toHaveTextContent('balances');
  expect(storage).toHaveTextContent('2');
  expect(storage).not.toHaveTextContent('private-key');
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
      { id: 'note', kind: 'P2ID' as const, visibility: 'public' as const, assets: [{ faucetId: 'faucet', amount }] }
    ]
  });
  const { rerender } = render(<TransactionNoteFlow account="account" flow={flow(1n)} />);
  openNotes();
  await waitFor(() => expect(screen.getByText('1 FIRST')).toBeInTheDocument());
  rerender(<TransactionNoteFlow account="account" flow={flow(2n)} />);
  expect(screen.queryByText('1 FIRST')).not.toBeInTheDocument();
  expect(screen.getByText(/2 baseUnits/)).toBeInTheDocument();
  resolveSecond({ decimals: 6, symbol: 'SECOND' });
  await waitFor(() => expect(screen.getByText('2 SECOND')).toBeInTheDocument());
});
