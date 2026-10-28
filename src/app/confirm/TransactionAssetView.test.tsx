import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { fetchTokenMetadata } from 'lib/miden/metadata/fetch';
import type { AssetMetadata } from 'lib/miden/metadata/types';
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';

import type { TxAssetView } from './decode';
import type { NoteFlow } from './note-flow';
import { TransactionAssetView } from './TransactionAssetView';
import { TransactionNoteFlow } from './TransactionNoteFlow';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('lib/miden/metadata/fetch', () => ({ fetchTokenMetadata: jest.fn() }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveRpcUrl: jest.fn() }));
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
  outgoingNfts: [],
  incomingNfts: [],
  unlistedAssets: 0,
  inputNotesConsumed: 1,
  outputNotesCreated: 2,
  storageChanged: false
};

beforeEach(() => {
  jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://rpc.example');
  (fetchTokenMetadata as jest.Mock).mockImplementation(async (id: string) => ({
    decimals: 6,
    symbol: id === 'fA' ? 'miZK' : 'rETH'
  }));
});

// The story chip repeats an amount. The asset row is the one that carries the verified marker.
const rowAmount = (text: string | RegExp) => screen.getByText(text, { selector: '[data-verified]' });

it('renders outgoing and incoming asset rows with symbol + amount (verified)', async () => {
  render(<TransactionAssetView view={view as any} mode="verified" />);
  await waitFor(() => expect(rowAmount('10/6 miZK')).toBeInTheDocument());
  expect(rowAmount('3/6 rETH')).toBeInTheDocument();
  expect(screen.getByText('trunc(mtst1acct)')).toBeInTheDocument();
  expect(screen.getByText('outputNotesCreated')).toBeInTheDocument();

  // Outgoing row shows a leading minus, incoming row shows a leading plus.
  const outgoingRow = rowAmount('10/6 miZK').closest('div');
  expect(outgoingRow).toHaveTextContent('-10/6 miZK');
  const incomingRow = rowAmount('3/6 rETH').closest('div');
  expect(incomingRow).toHaveTextContent('+3/6 rETH');

  // Verified amounts carry the confident, verified styling marker.
  expect(rowAmount('10/6 miZK')).toHaveAttribute('data-verified', 'true');
  expect(rowAmount('3/6 rETH')).toHaveAttribute('data-verified', 'true');
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
  expect(rowAmount('10/6 miZK')).toBeInTheDocument();
});

it('renders no fee row when the transaction pays none', async () => {
  render(<TransactionAssetView view={view as any} mode="verified" />);
  await waitFor(() => expect(rowAmount('10/6 miZK')).toBeInTheDocument());
  // An empty pill on a zero-fee chain is worse than no pill.
  expect(screen.queryByTestId('tx-network-fee')).not.toBeInTheDocument();
  expect(screen.queryByText('networkFee')).not.toBeInTheDocument();
});

it('renders declared (unverified) amounts with muted styling, not the confident verified styling', async () => {
  render(<TransactionAssetView view={{ ...view, account: undefined } as any} mode="declared" />);
  await waitFor(() => expect(rowAmount('10/6 miZK')).toBeInTheDocument());

  const outgoingAmount = rowAmount('10/6 miZK');
  const incomingAmount = rowAmount('3/6 rETH');

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
  (fetchTokenMetadata as jest.Mock).mockResolvedValueOnce({ decimals: 6, symbol: undefined });
  render(
    <TransactionAssetView
      view={{ ...view, outgoing: [{ faucetId: 'fA', amount: 10n }], incoming: [] } as any}
      mode="verified"
    />
  );
  await waitFor(() => expect(rowAmount('10/6 unknown')).toBeInTheDocument());
});

it('falls back to the unknown label for an incoming asset with no symbol', async () => {
  (fetchTokenMetadata as jest.Mock).mockResolvedValueOnce({ decimals: 6, symbol: undefined });
  render(
    <TransactionAssetView
      view={{ ...view, outgoing: [], incoming: [{ faucetId: 'fB', amount: 5n }] } as any}
      mode="verified"
    />
  );
  await waitFor(() => expect(rowAmount('5/6 unknown')).toBeInTheDocument());
});

it('still renders (with the unknown fallback) when fetchTokenMetadata rejects for one asset', async () => {
  (fetchTokenMetadata as jest.Mock).mockImplementation(async (id: string) => {
    if (id === 'fA') throw new Error('metadata service down');
    return { decimals: 6, symbol: 'rETH' };
  });

  expect(() => render(<TransactionAssetView view={view as any} mode="verified" />)).not.toThrow();

  // The failed lookup falls back to the unknown symbol; the sibling asset
  // (whose lookup succeeded) still renders correctly — the rejection is
  // isolated, not fatal to the whole row set.
  await waitFor(() => expect(rowAmount('3/6 rETH')).toBeInTheDocument());
  expect(rowAmount(/unknown/)).toBeInTheDocument();
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
    decimals: 6,
    symbol: 'Unknown',
    name: 'Unknown',
    scaleIsUnknown: true
  });
  render(
    <TransactionAssetView
      view={{ ...view, outgoing: [{ faucetId: 'fUnrecognized', amount: 7n }], incoming: [] } as any}
      mode="verified"
    />
  );
  await waitFor(() => expect(rowAmount('? Unknown')).toBeInTheDocument());
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
  await waitFor(() => expect(rowAmount('? unknown')).toBeInTheDocument());
});

it('exposes its mode and the output-note count to E2E', async () => {
  const { rerender } = render(<TransactionAssetView view={view as any} mode="verified" />);
  await waitFor(() => expect(rowAmount('10/6 miZK')).toBeInTheDocument());
  expect(screen.getByTestId('tx-asset-view')).toHaveAttribute('data-mode', 'verified');
  expect(screen.getByTestId('tx-output-notes-created')).toHaveTextContent('2');
  rerender(<TransactionAssetView view={view as any} mode="declared" />);
  expect(screen.getByTestId('tx-asset-view')).toHaveAttribute('data-mode', 'declared');
});

it('exposes the storage-changed value to E2E, in verified mode only', async () => {
  const verifiedView: TxAssetView = view;
  const { rerender } = render(<TransactionAssetView view={verifiedView} mode="verified" />);
  await waitFor(() => expect(rowAmount('10/6 miZK')).toBeInTheDocument());
  expect(screen.getByTestId('tx-storage-changed')).toHaveAttribute('data-changed', 'false');
  expect(screen.getByTestId('tx-storage-changed')).toHaveTextContent(/^no$/);
  rerender(<TransactionAssetView view={{ ...verifiedView, storageChanged: true }} mode="verified" />);
  expect(screen.getByTestId('tx-storage-changed')).toHaveAttribute('data-changed', 'true');
  expect(screen.getByTestId('tx-storage-changed')).toHaveTextContent(/^yes$/);
  rerender(<TransactionAssetView view={verifiedView} mode="declared" />);
  expect(screen.queryByTestId('tx-storage-changed')).not.toBeInTheDocument();
});

describe('NFTs and unlisted assets (#1600)', () => {
  // The asset hooks resolve metadata asynchronously, so let that settle inside act.
  const renderSettled = (ui: React.ReactElement) =>
    act(async () => {
      render(ui);
    });

  const nftOnly: TxAssetView = {
    account: 'mtst1acct',
    outgoing: [],
    incoming: [],
    outgoingNfts: [{ faucetId: 'mtst1nftfaucet', assetId: '0xaa11bb22…cc33dd' }],
    incomingNfts: [{ faucetId: 'mtst1otherfaucet', assetId: '0x01020304…050607' }],
    unlistedAssets: 0,
    inputNotesConsumed: 0,
    outputNotesCreated: 1,
    storageChanged: false
  };

  it('lists an NFT that leaves and one that enters, each with its asset id and faucet, when no token moves', async () => {
    await renderSettled(<TransactionAssetView view={nftOnly} mode="verified" />);

    expect(screen.getByText('assetChanges')).toBeInTheDocument();
    const [leaving, entering] = screen.getAllByTestId('tx-nft-row');
    expect(leaving).toHaveAttribute('data-direction', 'out');
    expect(leaving).toHaveTextContent('-nft 0xaa11bb22…cc33dd');
    expect(leaving).toHaveTextContent('nftFaucet trunc(mtst1nftfaucet)');
    expect(entering).toHaveAttribute('data-direction', 'in');
    expect(entering).toHaveTextContent('+nft 0x01020304…050607');
    expect(entering).toHaveTextContent('nftFaucet trunc(mtst1otherfaucet)');
    expect(screen.queryByTestId('tx-unlisted-assets')).not.toBeInTheDocument();
  });

  it('marks a declared NFT row unverified', async () => {
    await renderSettled(<TransactionAssetView view={nftOnly} mode="declared" />);

    expect(screen.getAllByText('unverified')).toHaveLength(2);
  });

  it('warns instead of staying silent when the vault change holds assets it cannot list', async () => {
    await renderSettled(
      <TransactionAssetView
        view={{ ...nftOnly, outgoingNfts: [], incomingNfts: [], unlistedAssets: 1 }}
        mode="verified"
      />
    );

    expect(screen.getByTestId('tx-unlisted-assets')).toHaveTextContent('unlistedAssetsWarning');
    expect(screen.getByText('assetChanges')).toBeInTheDocument();
  });
});

describe('confirmation metadata request sharing', () => {
  const metadata: AssetMetadata = { name: 'Shared token', symbol: 'SHARED', decimals: 6 };
  const sharedView: TxAssetView = { ...view, incoming: [] };
  const noteFlow = (amount: bigint): NoteFlow => ({
    inputCount: 0,
    inputs: [],
    outputs: [{ kind: 'P2ID', visibility: 'public', assets: [{ faucetId: 'fA', amount }] }]
  });
  const deferred = () => {
    let resolve!: (value: AssetMetadata) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<AssetMetadata>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  };

  beforeEach(() => {
    jest.mocked(fetchTokenMetadata).mockReset();
  });

  it('shares one pending lookup across summary and note rows while preserving each amount', async () => {
    const pending = deferred();
    jest.mocked(fetchTokenMetadata).mockReturnValue(pending.promise);
    render(<TransactionAssetView view={sharedView} mode="verified" noteFlow={noteFlow(2n)} />);
    expect(fetchTokenMetadata).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(metadata));
    expect(screen.getByText('10/6 SHARED')).toBeInTheDocument();
    expect(screen.getByText('2/6 SHARED')).toBeInTheDocument();
  });

  it('keeps equal faucets on different RPC URLs in separate pending requests', async () => {
    const first = deferred();
    const second = deferred();
    jest
      .mocked(getEffectiveRpcUrl)
      .mockReturnValueOnce('https://rpc-one.example')
      .mockReturnValue('https://rpc-two.example');
    jest.mocked(fetchTokenMetadata).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<TransactionAssetView view={sharedView} mode="verified" />);
    render(<TransactionNoteFlow flow={noteFlow(2n)} />);
    expect(fetchTokenMetadata).toHaveBeenCalledTimes(2);
    await act(async () => {
      first.resolve({ ...metadata, symbol: 'FIRST' });
      second.resolve({ ...metadata, symbol: 'SECOND' });
    });
    expect(rowAmount('10/6 FIRST')).toBeInTheDocument();
    expect(screen.getByText('2/6 SECOND')).toBeInTheDocument();
  });

  it('keeps a pending request available to a new subscriber after another unmounts', async () => {
    const pending = deferred();
    jest.mocked(fetchTokenMetadata).mockReturnValue(pending.promise);
    const { rerender } = render(<TransactionAssetView view={sharedView} mode="verified" noteFlow={noteFlow(2n)} />);
    expect(fetchTokenMetadata).toHaveBeenCalledTimes(1);
    rerender(<TransactionAssetView view={sharedView} mode="verified" />);
    render(<TransactionNoteFlow flow={noteFlow(3n)} />);
    expect(fetchTokenMetadata).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(metadata));
    expect(rowAmount('10/6 SHARED')).toBeInTheDocument();
    expect(screen.getByText('3/6 SHARED')).toBeInTheDocument();
    expect(screen.queryByText('2/6 SHARED')).not.toBeInTheDocument();
  });

  it('releases a rejected shared request so a subsequent lookup can recover', async () => {
    const pending = deferred();
    jest.mocked(fetchTokenMetadata).mockReturnValueOnce(pending.promise).mockResolvedValue(metadata);
    const first = render(<TransactionAssetView view={sharedView} mode="verified" noteFlow={noteFlow(2n)} />);
    expect(fetchTokenMetadata).toHaveBeenCalledTimes(1);
    await act(async () => pending.reject(new Error('metadata unavailable')));
    expect(screen.getByText('? unknown')).toBeInTheDocument();
    expect(screen.getByText(/2 baseUnits/)).toBeInTheDocument();
    first.unmount();
    render(<TransactionAssetView view={sharedView} mode="verified" noteFlow={noteFlow(2n)} />);
    await waitFor(() => expect(screen.getByText('10/6 SHARED')).toBeInTheDocument());
    expect(screen.getByText('2/6 SHARED')).toBeInTheDocument();
    expect(fetchTokenMetadata).toHaveBeenCalledTimes(2);
  });
});
