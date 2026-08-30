import React from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { fetchTokenMetadata } from 'lib/miden/metadata/fetch';

import { TransactionAssetView } from './TransactionAssetView';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('lib/miden/metadata/fetch', () => ({ fetchTokenMetadata: jest.fn() }));
jest.mock('lib/shared/format', () => ({ formatAmount: (a: bigint, d: number) => `${a}/${d}` }));
jest.mock('utils/string', () => ({ truncateAddress: (s: string) => `trunc(${s})` }));
jest.mock('app/icons/v2', () => ({
  Icon: () => <i />,
  IconName: { Globe: 'globe', WarningFill: 'warn', Download: 'Download' }
}));
jest.mock('components/Button', () => ({
  ButtonVariant: { Ghost: 'ghost' },
  Button: ({ children, onClick }: any) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  )
}));

const view = {
  account: 'mtst1acct',
  outgoing: [{ faucetId: 'fA', amount: 10n }],
  incoming: [{ faucetId: 'fB', amount: 3n }],
  inputNotesConsumed: 1,
  outputNotesCreated: 2,
  storageChanged: false
};

beforeEach(() => {
  (fetchTokenMetadata as jest.Mock).mockImplementation(async (id: string) => ({
    base: { decimals: 6, symbol: id === 'fA' ? 'miZK' : 'rETH' }
  }));
});

it('renders outgoing and incoming asset rows with symbol + amount (verified)', async () => {
  render(<TransactionAssetView view={view as any} mode="verified" />);
  await waitFor(() => expect(screen.getByText('10/6 miZK')).toBeInTheDocument());
  expect(screen.getByText('3/6 rETH')).toBeInTheDocument();
  expect(screen.getByText('trunc(mtst1acct)')).toBeInTheDocument();
  expect(screen.getByText('outputNotesCreated')).toBeInTheDocument();

  // Outgoing row shows a leading minus, incoming row shows a leading plus.
  const outgoingRow = screen.getByText('10/6 miZK').closest('div');
  expect(outgoingRow).toHaveTextContent('-10/6 miZK');
  const incomingRow = screen.getByText('3/6 rETH').closest('div');
  expect(incomingRow).toHaveTextContent('+3/6 rETH');

  // Verified amounts carry the confident, verified styling marker.
  expect(screen.getByText('10/6 miZK')).toHaveAttribute('data-verified', 'true');
  expect(screen.getByText('3/6 rETH')).toHaveAttribute('data-verified', 'true');
  expect(screen.queryByText('unverified')).not.toBeInTheDocument();
});

it('renders the network fee as its own row, outside the asset totals', async () => {
  // A cost the user pays. `decode.ts` deliberately keeps it OUT of `outgoing` on both paths,
  // so if this row is missing the fee is not on the sheet at all — which is what shipped
  // before: the value was decoded, threaded through `TxAssetView.fee`, and rendered nowhere.
  render(<TransactionAssetView view={{ ...view, fee: { faucetId: 'fN', amount: 2n } } as any} mode="verified" />);

  await waitFor(() => expect(screen.getByTestId('tx-network-fee')).toHaveTextContent('2/6 rETH'));
  expect(screen.getByText('networkFee')).toBeInTheDocument();
  // Not folded into the transfer: the outgoing row is still exactly what the user is sending.
  expect(screen.getByText('10/6 miZK')).toBeInTheDocument();
});

it('renders no fee row when the transaction pays none', async () => {
  render(<TransactionAssetView view={view as any} mode="verified" />);
  await waitFor(() => expect(screen.getByText('10/6 miZK')).toBeInTheDocument());
  // An empty pill on a zero-fee chain is worse than no pill.
  expect(screen.queryByTestId('tx-network-fee')).not.toBeInTheDocument();
  expect(screen.queryByText('networkFee')).not.toBeInTheDocument();
});

it('renders declared (unverified) amounts with muted styling, not the confident verified styling', async () => {
  render(<TransactionAssetView view={{ ...view, account: undefined } as any} mode="declared" />);
  await waitFor(() => expect(screen.getByText('10/6 miZK')).toBeInTheDocument());

  const outgoingAmount = screen.getByText('10/6 miZK');
  const incomingAmount = screen.getByText('3/6 rETH');

  expect(outgoingAmount).toHaveAttribute('data-verified', 'false');
  expect(incomingAmount).toHaveAttribute('data-verified', 'false');
  // Muted class present, confident verified classes absent.
  expect(outgoingAmount.className).toContain('text-text-muted');
  expect(outgoingAmount.className).not.toContain('text-black-500');
  expect(outgoingAmount.className).not.toContain('font-semibold');
  expect(incomingAmount.className).toContain('text-text-muted');
  expect(incomingAmount.className).not.toContain('text-green-500');
  expect(incomingAmount.className).not.toContain('font-semibold');

  // An inline unverified marker accompanies each declared amount row.
  expect(screen.getAllByText('unverified').length).toBe(2);
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
  (fetchTokenMetadata as jest.Mock).mockResolvedValueOnce({ base: { decimals: 6, symbol: undefined } });
  render(
    <TransactionAssetView
      view={{ ...view, outgoing: [{ faucetId: 'fA', amount: 10n }], incoming: [] } as any}
      mode="verified"
    />
  );
  await waitFor(() => expect(screen.getByText('10/6 unknown')).toBeInTheDocument());
});

it('falls back to the unknown label for an incoming asset with no symbol', async () => {
  (fetchTokenMetadata as jest.Mock).mockResolvedValueOnce({ base: { decimals: 6, symbol: undefined } });
  render(
    <TransactionAssetView
      view={{ ...view, outgoing: [], incoming: [{ faucetId: 'fB', amount: 5n }] } as any}
      mode="verified"
    />
  );
  await waitFor(() => expect(screen.getByText('5/6 unknown')).toBeInTheDocument());
});

it('still renders (with the unknown fallback) when fetchTokenMetadata rejects for one asset', async () => {
  (fetchTokenMetadata as jest.Mock).mockImplementation(async (id: string) => {
    if (id === 'fA') throw new Error('metadata service down');
    return { base: { decimals: 6, symbol: 'rETH' } };
  });

  expect(() => render(<TransactionAssetView view={view as any} mode="verified" />)).not.toThrow();

  // The failed lookup falls back to the unknown symbol; the sibling asset
  // (whose lookup succeeded) still renders correctly — the rejection is
  // isolated, not fatal to the whole row set.
  await waitFor(() => expect(screen.getByText('3/6 rETH')).toBeInTheDocument());
  expect(screen.getByText(/unknown/)).toBeInTheDocument();
});

it('shows the "Unknown" label (not native MIDEN) for an on-chain-resolved unknown token', async () => {
  // fetchTokenMetadata degrades an unrecognized, uncached faucet to
  // DEFAULT_TOKEN_METADATA ("Unknown") rather than MIDEN_METADATA — this
  // guards against a never-held token being mislabeled as native MIDEN.
  //
  // The placeholder's 6 decimals are a guess, so the quantity is withheld: this
  // is the screen a user approves a dApp's transfer from, and "7" here would be
  // an authoritative claim about an amount that could be off by a factor of a
  // trillion. The asset is still named, so the row is not a mystery.
  (fetchTokenMetadata as jest.Mock).mockResolvedValueOnce({
    base: { decimals: 6, symbol: 'Unknown', name: 'Unknown', scaleIsUnknown: true }
  });
  render(
    <TransactionAssetView
      view={{ ...view, outgoing: [{ faucetId: 'fUnrecognized', amount: 7n }], incoming: [] } as any}
      mode="verified"
    />
  );
  await waitFor(() => expect(screen.getByText('? Unknown')).toBeInTheDocument());
  expect(screen.queryByText(/7/)).not.toBeInTheDocument();
  expect(screen.queryByText(/MIDEN/)).not.toBeInTheDocument();
});

it('withholds the quantity when the metadata lookup fails outright', async () => {
  // A rejected lookup knows nothing about this faucet's decimals — the old code
  // fell through to `formatAmount`'s own default and printed a number anyway.
  (fetchTokenMetadata as jest.Mock).mockRejectedValueOnce(new Error('metadata service down'));
  render(
    <TransactionAssetView
      view={{ ...view, outgoing: [{ faucetId: 'fA', amount: 10n }], incoming: [] } as any}
      mode="verified"
    />
  );
  await waitFor(() => expect(screen.getByText('? unknown')).toBeInTheDocument());
});
