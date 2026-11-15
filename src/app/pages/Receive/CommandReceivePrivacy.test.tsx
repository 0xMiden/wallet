import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { resetActivityHiddenNotes } from 'app/hooks/useActivityHiddenNotes';
import { Receive } from 'app/pages/Receive';
import type { PendingActivityItem } from 'app/templates/history/PendingActivityCard';
import type { ClaimableNoteWithMetadata } from 'lib/miden/front/claimable-notes';
import { fetchFromStorage, registerStorageReread } from 'lib/miden/front/storage';
import { CommandShell } from 'screens/command/CommandShell';

const scope = { accountId: 'account-address', network: 'testnet', rpcUrl: 'rpc-a' };
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
  status: 'pending'
});
let mockItems = [note('declined'), note('visible')];
const mockAccept = jest.fn();

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('app/hooks/useActivityClaims', () => ({
  useActivityClaims: () => ({
    items: mockItems,
    account: { publicKey: 'account-address' },
    isLoadingNotes: false,
    accept: mockAccept,
    acceptMany: jest.fn(),
    retryHeld: jest.fn(),
    cannotPayFee: jest.fn()
  })
}));
jest.mock('app/templates/history/PendingActivityCard', () => ({
  PendingActivityCard: ({
    item,
    onAccept
  }: {
    item: PendingActivityItem;
    onAccept: (note: ClaimableNoteWithMetadata) => void;
  }) => (
    <button type="button" data-testid="native-review-action" onClick={() => onAccept(item.note)}>
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
jest.mock('app/pages/Receive/AddressTab', () => ({
  AddressTab: ({ address }: { address: string }) => <div data-testid="receive-current-address">{address}</div>,
  ReceiveBridgeTile: () => null
}));
jest.mock('lib/miden/front', () => ({
  useAccount: () => ({ publicKey: 'account-address' }),
  useAllTokensBaseMetadata: () => ({}),
  useAllBalances: () => ({ data: [{ tokenId: 'faucet-one', metadata: { symbol: 'VISIBLE', decimals: 6 } }] })
}));
jest.mock('lib/remote-config/token-labels', () => ({
  midenTokenLabel: (_config: unknown, _id: string, symbol: string) => symbol
}));
jest.mock('lib/remote-config/use-feature-availability', () => ({ useBridgeConfigSnapshot: () => ({ config: null }) }));
jest.mock('lib/usdcx/use-bridge-in-availability', () => ({
  useBridgeInAvailability: () => ({ state: 'available' }),
  isBridgeInOfferedOnNetwork: () => false
}));
jest.mock('lib/ui/dialog', () => ({ useConfirm: () => jest.fn() }));
jest.mock('lib/telemetry', () => ({ beginFlow: () => ({ complete: () => {}, cancel: () => {} }) }));
jest.mock('lib/woozie', () => ({
  navigate: jest.fn(),
  goBack: jest.fn(),
  createLocationState: () => ({ historyPosition: 1, href: '/receive' }),
  listen: () => () => {},
  HistoryAction: { Replace: 'REPLACE' },
  useLocation: () => ({ pathname: '/receive' })
}));
jest.mock('screens/command/CommandHomePrompts', () => ({ CommandHomePrompts: () => null }));
jest.mock('screens/command/CommandPortfolio', () => ({ CommandPortfolio: () => null }));

const renderReceive = () =>
  render(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'receive' }}>
      <Receive />
    </CommandShell>
  );

beforeEach(() => {
  resetActivityHiddenNotes();
  jest.mocked(fetchFromStorage).mockReset();
  mockAccept.mockClear();
  mockItems = [note('declined'), note('visible')];
});

it('blocks incoming and selected review while the hidden read is pending or fails', async () => {
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
  const view = renderReceive();
  await waitFor(() => expect(fetchFromStorage).toHaveBeenCalledWith('activity-hidden-notes:account-address'));
  expect(screen.getByTestId('receive-current-address')).toHaveTextContent('account-address');
  expect(screen.getByTestId('receive-asset-picker')).toBeInTheDocument();
  expect(screen.queryByTestId('receive-note-declined')).not.toBeInTheDocument();
  expect(screen.queryByTestId('receive-note-visible')).not.toBeInTheDocument();
  expect(screen.queryByText('PRIVATE')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /declined-sender/i })).not.toBeInTheDocument();
  expect(screen.queryByText('receiveNoPendingTransfers')).not.toBeInTheDocument();

  await act(async () => resolveFirst(['declined']));
  expect(screen.queryByTestId('receive-note-declined')).not.toBeInTheDocument();
  expect(screen.getByTestId('receive-note-visible')).toHaveTextContent('1 VISIBLE');
  fireEvent.click(screen.getByTestId('receive-note-visible'));
  expect(screen.getByTestId('receive-note-review')).toHaveTextContent('Review visible');

  const reread = jest.mocked(registerStorageReread).mock.calls[0][0];
  act(() => {
    void reread();
  });
  expect(screen.queryByTestId('receive-note-declined')).not.toBeInTheDocument();
  expect(screen.queryByTestId('receive-note-visible')).not.toBeInTheDocument();
  expect(screen.queryByTestId('receive-note-review')).not.toBeInTheDocument();
  expect(screen.queryByTestId('native-review-action')).not.toBeInTheDocument();
  expect(screen.queryByText('PRIVATE')).not.toBeInTheDocument();
  expect(mockAccept).not.toHaveBeenCalled();

  await waitFor(() => expect(fetchFromStorage).toHaveBeenCalledTimes(2));
  await act(async () => rejectSecond(new Error('Storage unavailable')));
  expect(screen.getByRole('alert')).toHaveTextContent('activityHiddenNotesError');
  expect(screen.queryByTestId('receive-note-declined')).not.toBeInTheDocument();
  expect(screen.queryByTestId('receive-note-visible')).not.toBeInTheDocument();
  expect(screen.queryByText('PRIVATE')).not.toBeInTheDocument();
  expect(screen.queryByText('receiveNoPendingTransfers')).not.toBeInTheDocument();
  expect(mockAccept).not.toHaveBeenCalled();
  view.unmount();
  warning.mockRestore();
});

it('only shows a genuine no-incoming state once the hidden-note read completes', async () => {
  let resolve!: (ids: unknown) => void;
  mockItems = [];
  jest.mocked(fetchFromStorage).mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done;
      })
  );
  const view = renderReceive();
  await waitFor(() => expect(fetchFromStorage).toHaveBeenCalledWith('activity-hidden-notes:account-address'));
  expect(screen.queryByText('receiveNoPendingTransfers')).not.toBeInTheDocument();
  await act(async () => resolve([]));
  expect(screen.getByText('receiveNoPendingTransfers')).toBeInTheDocument();
  view.unmount();
});
