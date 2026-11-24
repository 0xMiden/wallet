import React from 'react';

import { act, render, screen, waitFor } from '@testing-library/react';

import { resetActivityHiddenNotes } from 'app/hooks/useActivityHiddenNotes';
import { HistoryEntryType, type IHistoryEntry } from 'app/templates/history/IHistoryEntry';
import type { PendingActivityItem } from 'app/templates/history/PendingActivityCard';
import type { ClaimableNoteWithMetadata } from 'lib/miden/front/claimable-notes';
import { fetchFromStorage, registerStorageReread } from 'lib/miden/front/storage';

import { CommandRecentActions } from './CommandRecentActions';

const scope = { accountId: 'account-a', network: 'testnet', rpcUrl: 'https://rpc.test' };
const note = (id: string): PendingActivityItem => ({
  note: {
    id,
    faucetId: 'faucet-one',
    amount: '1000000',
    senderAddress: `${id}-sender`,
    isBeingClaimed: false,
    fromCache: false,
    type: 'unknown',
    metadata: { symbol: id === 'declined' ? 'PRIVATE' : 'VISIBLE', name: 'Token', decimals: 6 }
  },
  txId: id === 'visible' ? 'linked-visible' : undefined,
  status: 'pending'
});
const mockNotes = [note('declined'), note('visible')];
const mockAccept = jest.fn();
const mockHistoryMount = jest.fn();
const mockEntries: IHistoryEntry[] = [
  {
    key: 'linked-visible',
    txId: 'linked-visible',
    address: 'account-a',
    timestamp: 20,
    type: HistoryEntryType.CompletedTransaction,
    txType: 'consume',
    message: 'Duplicate claim row'
  },
  {
    key: 'independent',
    txId: 'independent',
    address: 'account-a',
    timestamp: 10,
    type: HistoryEntryType.CompletedTransaction,
    txType: 'send',
    message: 'Visible receipt'
  }
];

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('app/hooks/useActivityClaims', () => ({
  useActivityClaims: () => ({
    items: mockNotes,
    account: { publicKey: 'account-a' },
    isLoadingNotes: false,
    accept: mockAccept,
    acceptMany: jest.fn(),
    retryHeld: jest.fn(),
    cannotPayFee: jest.fn()
  })
}));
jest.mock('app/templates/history/History', () => ({
  __esModule: true,
  default: ({
    renderEntries
  }: {
    renderEntries: (view: {
      entries: IHistoryEntry[];
      initialLoading: boolean;
      loadError: boolean;
      onRetry: () => void;
      hasMore: boolean;
      loadMore: () => Promise<void>;
    }) => React.ReactNode;
  }) => {
    mockHistoryMount();
    return renderEntries({
      entries: mockEntries,
      initialLoading: false,
      loadError: false,
      onRetry: () => {},
      hasMore: false,
      loadMore: async () => {}
    });
  }
}));
jest.mock('app/templates/history/HistoryItem', () => ({
  __esModule: true,
  default: ({ entry }: { entry: IHistoryEntry }) => <div>{entry.message}</div>
}));
jest.mock('app/templates/history/PendingActivityCard', () => ({
  PendingActivityCard: ({
    item,
    onAccept
  }: {
    item: PendingActivityItem;
    onAccept: (note: ClaimableNoteWithMetadata) => void;
  }) => (
    <button type="button" data-testid={`pending-note-${item.note.id}`} onClick={() => onAccept(item.note)}>
      Review {item.note.id}
    </button>
  )
}));
jest.mock('lib/miden/front/storage', () => ({
  fetchFromStorage: jest.fn(),
  putToStorage: jest.fn(),
  inStorageTurn: jest.requireActual('lib/miden/front/storage').inStorageTurn,
  onStorageChanged: jest.fn(() => () => {}),
  registerStorageReread: jest.fn()
}));
jest.mock('lib/remote-config/token-labels', () => ({
  midenTokenLabel: (_config: unknown, _id: string, symbol: string) => symbol
}));
jest.mock('lib/remote-config/use-feature-availability', () => ({ useBridgeConfigSnapshot: () => ({ config: null }) }));
jest.mock('lib/ui/dialog', () => ({ useConfirm: () => jest.fn() }));
jest.mock('lib/woozie', () => ({ navigate: jest.fn() }));
jest.mock('./useCommandPrivacy', () => ({ useCommandPrivacy: () => [false, jest.fn()] }));

beforeEach(() => {
  resetActivityHiddenNotes();
  mockAccept.mockClear();
  mockHistoryMount.mockClear();
  jest.mocked(fetchFromStorage).mockReset();
});

it('withholds claim cards and their linked rows until declined-note storage is readable, and withholds them again after a failed reread', async () => {
  let resolveFirst!: (ids: unknown) => void;
  let rejectSecond!: (reason: Error) => void;
  const first = new Promise<unknown>(resolve => {
    resolveFirst = resolve;
  });
  const second = new Promise<unknown>((_resolve, reject) => {
    rejectSecond = reject;
  });
  jest.mocked(fetchFromStorage).mockReturnValueOnce(first).mockReturnValueOnce(second);
  const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const view = render(<CommandRecentActions scope={scope} />);
  await waitFor(() => expect(fetchFromStorage).toHaveBeenCalledWith('activity-hidden-notes:account-a'));
  expect(mockHistoryMount).not.toHaveBeenCalled();
  expect(screen.queryByText('Duplicate claim row')).not.toBeInTheDocument();
  expect(screen.queryByText('Visible receipt')).not.toBeInTheDocument();
  expect(screen.queryByText('PRIVATE')).not.toBeInTheDocument();
  expect(screen.queryByTestId('pending-note-declined')).not.toBeInTheDocument();
  expect(screen.queryByTestId('pending-note-visible')).not.toBeInTheDocument();
  expect(screen.queryByText('commandNoRecentActions')).not.toBeInTheDocument();

  await act(async () => resolveFirst(['declined']));
  expect(screen.queryByTestId('pending-note-declined')).not.toBeInTheDocument();
  expect(screen.getByTestId('pending-note-visible')).toHaveTextContent('Review visible');
  expect(screen.queryByText('Duplicate claim row')).not.toBeInTheDocument();
  expect(screen.getByText('Visible receipt')).toBeInTheDocument();
  const reread = jest.mocked(registerStorageReread).mock.calls[0]?.[0];
  if (!reread) throw new Error('Hidden-note reread was not registered');
  act(() => {
    void reread();
  });
  expect(screen.queryByTestId('pending-note-visible')).not.toBeInTheDocument();
  expect(screen.queryByText('Visible receipt')).not.toBeInTheDocument();
  await waitFor(() => expect(fetchFromStorage).toHaveBeenCalledTimes(2));
  await act(async () => rejectSecond(new Error('Storage unavailable')));
  expect(screen.getByRole('alert')).toHaveTextContent('activityHiddenNotesError');
  expect(screen.queryByTestId('pending-note-visible')).not.toBeInTheDocument();
  expect(screen.queryByText('Visible receipt')).not.toBeInTheDocument();
  expect(mockAccept).not.toHaveBeenCalled();
  view.unmount();
  warning.mockRestore();
});
