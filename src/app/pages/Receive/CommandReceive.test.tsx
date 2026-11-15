import React from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { Receive } from 'app/pages/Receive';
import { CommandShell } from 'screens/command/CommandShell';

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
  mockClaimItems = [mockNote];
  mockHiddenNotesFailed = false;
});

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('app/pages/Receive/AddressTab', () => ({
  AddressTab: ({ address }: { address: string }) => <div data-testid="receive-current-address">{address}</div>
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
    hidden: { failed: mockHiddenNotesFailed },
    renderPendingItem: () => <div>Native review</div>,
    isLoadingNotes: false
  })
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
jest.mock('screens/command/CommandHomePrompts', () => ({ CommandHomePrompts: () => null }));
jest.mock('screens/command/CommandPortfolio', () => ({ CommandPortfolio: () => null }));

it('shows the real receiving address before incoming notes, with asset guidance beneath incoming', () => {
  render(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'receive' }}>
      <Receive />
    </CommandShell>
  );
  const address = screen.getByTestId('receive-current-address');
  const incoming = screen.getByTestId('receive-note-note-one');
  const guidance = screen.getByTestId('receive-asset-picker');
  expect(address.compareDocumentPosition(incoming) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(incoming.compareDocumentPosition(guidance) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
