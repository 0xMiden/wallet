import React from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { Receive } from 'app/pages/Receive';
import { CommandShell } from 'screens/command/CommandShell';

// The global Jest mock returns full addresses; this test needs the real privacy formatter.
jest.unmock('utils/string');

const scope = { accountId: 'a', network: 'testnet', rpcUrl: 'rpc-a' };
const mockNote = {
  note: {
    id: 'note-one',
    faucetId: 'faucet-one',
    amount: '1000000',
    senderAddress: 'sender',
    isBeingClaimed: false,
    fromCache: false,
    type: 'unknown',
    metadata: { symbol: 'ONE', name: 'One', decimals: 6 }
  },
  status: 'pending',
  held: false
};
let mockClaimItems = [mockNote];
let mockHiddenNotesFailed = false;
beforeEach(() => {
  mockNearIntentsConfig = null;
  mockClaimItems = [mockNote];
  mockHiddenNotesFailed = false;
});

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('app/pages/Receive/AddressTab', () => ({
  AddressTab: ({ address }: { address: string }) => <div data-testid="receive-current-address">{address}</div>,
  ReceiveBridgeTile: () => <button data-testid="receive-cross-chain">Bridge</button>
}));
jest.mock('lib/miden/front', () => ({
  useAccount: () => ({ publicKey: 'account-address' }),
  useAllTokensBaseMetadata: () => ({}),
  useAllBalances: () => ({
    data: [
      { tokenId: 'faucet-one', metadata: { symbol: 'ONE', decimals: 6 }, balance: 0 },
      { tokenId: 'faucet-two', metadata: { symbol: 'TWO', decimals: 6 }, balance: 0 }
    ]
  })
}));
jest.mock('app/templates/history/useActivityClaimList', () => ({
  useActivityClaimList: () => ({
    listItems: mockClaimItems,
    hidden: { loaded: true, failed: mockHiddenNotesFailed },
    renderPendingItem: () => <div>Native review</div>,
    isLoadingNotes: false
  })
}));
jest.mock('lib/remote-config/use-feature-availability', () => ({ useBridgeConfigSnapshot: () => ({ config: {} }) }));
jest.mock('lib/usdcx/use-bridge-in-availability', () => ({
  useBridgeInAvailability: () => ({ state: 'available' }),
  isBridgeInOfferedOnNetwork: () => true
}));
jest.mock('lib/telemetry', () => ({ beginFlow: () => ({ complete: () => {}, cancel: () => {} }) }));
jest.mock('lib/woozie', () => ({
  navigate: jest.fn(),
  goBack: jest.fn(),
  createLocationState: () => ({ historyPosition: 1, href: '/receive' }),
  listen: () => () => {},
  HistoryAction: { Replace: 'REPLACE' },
  useLocation: () => ({ pathname: '/receive' })
}));
let mockNearIntentsConfig: object | null = null;
jest.mock('lib/one-click/config', () => ({ useNearIntentsConfig: () => mockNearIntentsConfig }));
jest.mock('screens/near-intents-flow/NearIntentsTab', () => ({
  __esModule: true,
  default: ({ tabs }: { tabs?: React.ReactNode }) => (
    <div data-testid="near-intents-form">
      {tabs}
      <button data-testid="near-intents-get-deposit-address">Get</button>
    </div>
  )
}));
jest.mock('screens/command/CommandHomePrompts', () => ({ CommandHomePrompts: () => null }));
jest.mock('screens/command/CommandPortfolio', () => ({ CommandPortfolio: () => null }));
jest.mock('screens/command/CommandRecentActions', () => ({ CommandRecentActions: () => null }));

it('shows the real receiving address before incoming notes, with asset guidance beneath incoming', () => {
  render(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'receive' }}>
      <Receive />
    </CommandShell>
  );
  const address = screen.getByTestId('receive-current-address');
  const incoming = screen.getByTestId('receive-note-note-one');
  const guidance = screen.getByTestId('receive-asset-picker');
  const bridge = screen.getByTestId('receive-cross-chain');
  expect(address.compareDocumentPosition(incoming) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(incoming.compareDocumentPosition(guidance) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(guidance.compareDocumentPosition(bridge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('names a pending incoming note with its real amount, asset and native status', () => {
  render(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'receive' }}>
      <Receive />
    </CommandShell>
  );
  expect(screen.getByTestId('receive-note-note-one')).toHaveTextContent('1 ONE');
  expect(screen.getByTestId('receive-note-note-one')).toHaveTextContent('pending');
});

it('uses the existing privacy-safe sender label rather than exposing the entire sender address', () => {
  const senderAddress = 'mtst1aplqzwh6s4gvcyzsvx726y6xvsgt5qv5_qruqqypuyph';
  mockClaimItems = [{ ...mockNote, note: { ...mockNote.note, senderAddress } }];
  render(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'receive' }}>
      <Receive />
    </CommandShell>
  );
  expect(screen.getByTestId('receive-note-note-one')).toHaveTextContent('mtst1apl...5qv5');
  expect(screen.getByTestId('receive-note-note-one')).not.toHaveTextContent(senderAddress);
});

it('distinguishes native in-progress claims from held attempts awaiting confirmation', () => {
  mockClaimItems = [{ ...mockNote, status: 'claiming' }];
  const view = render(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'receive' }}>
      <Receive />
    </CommandShell>
  );
  expect(screen.getByTestId('receive-note-note-one')).toHaveTextContent('inProgress');
  mockClaimItems = [{ ...mockNote, status: 'claiming', held: true }];
  view.rerender(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'receive' }}>
      <Receive />
    </CommandShell>
  );
  expect(screen.getByTestId('receive-note-note-one')).toHaveTextContent('notConfirmed');
});

it('does not display an unverified cached note as ready to accept', () => {
  mockClaimItems = [{ ...mockNote, note: { ...mockNote.note, fromCache: true } }];
  render(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'receive' }}>
      <Receive />
    </CommandShell>
  );
  expect(screen.getByTestId('receive-note-note-one')).toHaveTextContent('guardianCheckingLabel');
});

it('does not silently hide a failed declined-notes read', () => {
  mockHiddenNotesFailed = true;
  render(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'receive' }}>
      <Receive />
    </CommandShell>
  );
  expect(screen.getByRole('alert')).toHaveTextContent('activityHiddenNotesError');
});

it('does not claim there are no incoming notes when declined-notes privacy failed to load', () => {
  mockClaimItems = [];
  mockHiddenNotesFailed = true;
  render(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'receive' }}>
      <Receive />
    </CommandShell>
  );
  expect(screen.getByRole('alert')).toHaveTextContent('activityHiddenNotesError');
  expect(screen.queryByText('receiveNoPendingTransfers')).not.toBeInTheDocument();
});

it('shows a truthful empty state when no canonical incoming notes exist', () => {
  mockClaimItems = [];
  render(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'receive' }}>
      <Receive />
    </CommandShell>
  );
  expect(screen.getByText('receiveNoPendingTransfers')).toBeInTheDocument();
});

it('closes the asset picker on Escape and returns focus to its trigger without changing the address', async () => {
  render(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'receive' }}>
      <Receive />
    </CommandShell>
  );
  const trigger = screen.getByTestId('receive-asset-picker');
  trigger.focus();
  fireEvent.click(trigger);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(document.querySelector('[data-slot="drawer-content"]')).toHaveAttribute('data-state', 'closed');
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(screen.getByTestId('receive-current-address')).toHaveTextContent('account-address');
});

it('retains only the selected faucet over minimize and clears it on account, network, RPC and lock remount', () => {
  const makeShell = (identity: typeof scope, open = true) => (
    <CommandShell scope={identity} route={open ? { kind: 'flow', action: 'receive' } : { kind: 'dashboard' }}>
      {open && <Receive />}
    </CommandShell>
  );
  const view = render(makeShell(scope));
  fireEvent.click(screen.getByTestId('receive-asset-picker'));
  fireEvent.click(screen.getByTestId('receive-asset-faucet-two'));
  expect(screen.getByTestId('receive-selected-asset')).toHaveTextContent('TWO');
  view.rerender(makeShell(scope, false));
  view.rerender(makeShell(scope));
  expect(screen.getByTestId('receive-selected-asset')).toHaveTextContent('TWO');
  for (const changed of [
    { ...scope, accountId: 'b' },
    { ...scope, network: 'devnet' },
    { ...scope, rpcUrl: 'rpc-b' },
    scope
  ]) {
    view.rerender(makeShell(changed));
    expect(screen.getByTestId('receive-selected-asset')).toHaveTextContent('selectAToken');
  }
  view.unmount();
  render(makeShell(scope));
  expect(screen.getByTestId('receive-selected-asset')).toHaveTextContent('selectAToken');
});

it('uses the real workbench Back for the selected note, not route history', () => {
  const { goBack } = jest.requireMock<typeof import('lib/woozie')>('lib/woozie');
  jest.mocked(goBack).mockClear();
  const view = render(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'receive' }}>
      <Receive />
    </CommandShell>
  );
  fireEvent.click(screen.getByTestId('receive-asset-picker'));
  fireEvent.click(screen.getByTestId('receive-asset-faucet-two'));
  view.rerender(
    <CommandShell scope={scope} route={{ kind: 'dashboard' }}>
      <></>
    </CommandShell>
  );
  view.rerender(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'receive' }}>
      <Receive />
    </CommandShell>
  );
  fireEvent.click(screen.getByTestId('receive-note-note-one'));
  expect(screen.getByTestId('receive-note-review')).toHaveTextContent('Native review');
  fireEvent.click(screen.getByRole('button', { name: 'back' }));
  expect(screen.queryByTestId('receive-note-review')).not.toBeInTheDocument();
  expect(screen.getByTestId('receive-note-note-one')).toBeInTheDocument();
  expect(screen.getByTestId('receive-selected-asset')).toHaveTextContent('TWO');
  expect(goBack).not.toHaveBeenCalled();
});

describe('NEAR Intents tab', () => {
  const renderReceive = () =>
    render(
      <CommandShell scope={scope} route={{ kind: 'flow', action: 'receive' }}>
        <Receive />
      </CommandShell>
    );

  it('shows no tabs when NEAR Intents is not enabled', () => {
    renderReceive();
    expect(screen.queryByTestId('receive-tabs')).not.toBeInTheDocument();
    expect(screen.queryByTestId('receive-tab-near-intents')).not.toBeInTheDocument();
    expect(screen.getByTestId('command-receive')).toBeInTheDocument();
  });

  it('shows the tabs on the address view when enabled, with the address tab selected', () => {
    mockNearIntentsConfig = { pairs: [] };
    renderReceive();
    expect(screen.getByTestId('receive-tab-miden')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('receive-tab-near-intents')).toBeInTheDocument();
    expect(screen.getByTestId('receive-current-address')).toBeInTheDocument();
    expect(screen.queryByTestId('near-intents-form')).not.toBeInTheDocument();
  });

  it('switches to the NEAR Intents form and back to the address', async () => {
    mockNearIntentsConfig = { pairs: [] };
    renderReceive();
    fireEvent.click(screen.getByTestId('receive-tab-near-intents'));
    expect(await screen.findByTestId('near-intents-form')).toBeInTheDocument();
    expect(screen.getByTestId('near-intents-get-deposit-address')).toBeInTheDocument();
    expect(screen.queryByTestId('receive-current-address')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('receive-tab-miden'));
    expect(screen.getByTestId('receive-current-address')).toBeInTheDocument();
    expect(screen.queryByTestId('near-intents-form')).not.toBeInTheDocument();
  });
});
