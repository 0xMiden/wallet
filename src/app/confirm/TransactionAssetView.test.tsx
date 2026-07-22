import React from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { getTokenMetadata } from 'lib/miden/metadata/utils';

import { TransactionAssetView } from './TransactionAssetView';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('lib/miden/metadata/utils', () => ({ getTokenMetadata: jest.fn() }));
jest.mock('lib/shared/format', () => ({ formatAmount: (a: bigint, d: number) => `${a}/${d}` }));
jest.mock('utils/string', () => ({ truncateAddress: (s: string) => `trunc(${s})` }));
jest.mock('app/icons/v2', () => ({ Icon: () => <i />, IconName: { Globe: 'globe', WarningFill: 'warn' } }));

const view = {
  account: 'mtst1acct',
  outgoing: [{ faucetId: 'fA', amount: 10n }],
  incoming: [{ faucetId: 'fB', amount: 3n }],
  inputNotesConsumed: 1,
  outputNotesCreated: 2,
  storageChanged: false
};

beforeEach(() => {
  (getTokenMetadata as jest.Mock).mockImplementation(async (id: string) => ({
    decimals: 6,
    symbol: id === 'fA' ? 'miZK' : 'rETH'
  }));
});

it('renders outgoing and incoming asset rows with symbol + amount (verified)', async () => {
  render(<TransactionAssetView view={view as any} mode="verified" />);
  await waitFor(() => expect(screen.getByText('10/6 miZK')).toBeInTheDocument());
  expect(screen.getByText('3/6 rETH')).toBeInTheDocument();
  expect(screen.getByText('trunc(mtst1acct)')).toBeInTheDocument();
  expect(screen.getByText('outputNotesCreated')).toBeInTheDocument();
});

it('shows the declared/unverified label in declared mode', () => {
  render(<TransactionAssetView view={{ ...view, account: undefined } as any} mode="declared" />);
  expect(screen.getByText('declaredBySiteVerifying')).toBeInTheDocument();
});

it('shows the storage-changed warning when storageChanged is true (verified)', () => {
  render(<TransactionAssetView view={{ ...view, storageChanged: true } as any} mode="verified" />);
  expect(screen.getByText('yes')).toBeInTheDocument();
  expect(screen.queryByText('no')).not.toBeInTheDocument();
});

it('does not show the storage row at all in declared mode', () => {
  render(<TransactionAssetView view={{ ...view, account: undefined, storageChanged: true } as any} mode="declared" />);
  expect(screen.queryByText('storageChanged')).not.toBeInTheDocument();
});

it('renders a download button and invokes onDownload when clicked', () => {
  const onDownload = jest.fn();
  render(
    <TransactionAssetView
      view={{ ...view, outgoing: [], incoming: [] } as any}
      mode="verified"
      onDownload={onDownload}
    />
  );
  fireEvent.click(screen.getByText('downloadFullSummary'));
  expect(onDownload).toHaveBeenCalledTimes(1);
  // Empty outgoing/incoming => no asset-changes section.
  expect(screen.queryByText('assetChanges')).not.toBeInTheDocument();
});

it('falls back to the unknown label when a resolved asset has no symbol', async () => {
  (getTokenMetadata as jest.Mock).mockResolvedValueOnce({ decimals: 6, symbol: undefined });
  render(
    <TransactionAssetView
      view={{ ...view, outgoing: [{ faucetId: 'fA', amount: 10n }], incoming: [] } as any}
      mode="verified"
    />
  );
  await waitFor(() => expect(screen.getByText('10/6 unknown')).toBeInTheDocument());
});
