import React, { useState } from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MotionConfig } from 'framer-motion';

import { HistoryEntryType, type IHistoryEntry } from 'app/templates/history/IHistoryEntry';
import { FlowLayout } from 'components/flow/FlowLayout';
import { ReviewLayout } from 'components/review';
import { AlertSheet } from 'components/ui/AlertSheet';
import { ITransactionStatus } from 'lib/miden/db/types';
import { goBack, navigate } from 'lib/woozie';
import { CommandSendReview } from 'screens/send-flow/CommandSendReview';

import { useCommandDrafts } from './command-drafts';
import { CommandShell } from './CommandShell';
import { useCommandWorkbenchSlots } from './CommandWorkbench';

let mockHidden = false;
let mockRecentEntries: IHistoryEntry[] = [];
let mockHistoryInputs: { address: string; numItems?: number; pendingItems?: unknown[] } | undefined;
let mockClaimItems: { note: { id: string; receivedAt: number }; status: string; txId?: string }[] = [];
jest.mock('app/templates/history/History', () => ({
  __esModule: true,
  default: ({
    renderEntries,
    address,
    numItems,
    pendingItems
  }: {
    renderEntries: (view: {
      entries: IHistoryEntry[];
      initialLoading: boolean;
      loadError: boolean;
      onRetry: () => void;
      hasMore: boolean;
      loadMore: () => Promise<void>;
    }) => React.ReactNode;
    address: string;
    numItems?: number;
    pendingItems?: unknown[];
  }) => {
    mockHistoryInputs = { address, numItems, pendingItems };
    return renderEntries({
      entries: mockRecentEntries,
      initialLoading: false,
      loadError: false,
      onRetry: () => {},
      hasMore: false,
      loadMore: async () => {}
    });
  }
}));
jest.mock('app/templates/history/useActivityClaimList', () => ({
  useActivityClaimList: () => ({
    account: { publicKey: 'account-a' },
    hidden: { loaded: true, failed: false },
    representedItems: mockClaimItems,
    listItems: mockClaimItems,
    renderPendingItem: (item: { note: { id: string } }) => <button>{item.note.id}</button>
  })
}));
jest.mock('app/templates/history/HistoryItem', () => ({
  __esModule: true,
  default: ({ entry }: { entry: IHistoryEntry }) => (
    <div data-testid="recent-entry" data-row-id={entry.txId} data-status={entry.status}>
      {entry.message} {entry.amount}
    </div>
  )
}));
jest.mock('lib/miden/front', () => ({
  ...jest.requireActual('lib/miden/front'),
  useAccount: () => ({ publicKey: 'account-a' })
}));
jest.mock('lib/miden/front/claimable-notes', () => ({
  useClaimableNotes: () => ({ data: [], isFallback: false, mutate: jest.fn() })
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getEffectiveNetworkName: () => 'testnet',
  getEffectiveRpcUrl: () => 'https://rpc.test'
}));
jest.mock('./useCommandPrivacy', () => ({ useCommandPrivacy: () => [mockHidden, jest.fn()] }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('components/NetworkModeSheet', () => ({ NetworkModeSheet: () => null }));
jest.mock('./CommandHomePrompts', () => ({
  CommandHomePrompts: () => <div data-testid="command-home-prompts" />
}));
jest.mock('./CommandPortfolio', () => ({
  CommandPortfolio: ({ prompts, recentActions }: { prompts: React.ReactNode; recentActions: React.ReactNode }) => (
    <div data-testid="command-portfolio">
      Live wallet portfolio
      {prompts}
      {recentActions}
    </div>
  )
}));
jest.mock('lib/woozie', () => ({
  navigate: jest.fn(),
  goBack: jest.fn(),
  createLocationState: () => ({ historyPosition: 1, href: '/send' }),
  listen: () => () => {},
  HistoryAction: { Replace: 'REPLACE' }
}));

const scope = { accountId: 'account-a', network: 'testnet', rpcUrl: 'https://rpc.test' };

beforeEach(() => {
  jest.clearAllMocks();
  mockHidden = false;
  mockRecentEntries = [];
  mockHistoryInputs = undefined;
  mockClaimItems = [];
});

it('renders one active workbench and navigates via the five dock destinations', () => {
  const { rerender } = render(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'send' }}>
      <div>Real send controller</div>
    </CommandShell>
  );
  expect(screen.getAllByTestId('command-workbench')).toHaveLength(1);
  expect(screen.getByRole('main')).toContainElement(screen.getByTestId('command-workbench'));
  expect(screen.getByText('Real send controller')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'back' }));
  expect(goBack).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'receive' }));
  expect(navigate).toHaveBeenCalledWith('/receive');
  rerender(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'swap' }}>
      <div>Real swap controller</div>
    </CommandShell>
  );
  expect(screen.getAllByTestId('command-shell')).toHaveLength(1);
  expect(screen.getByText('Real swap controller')).toBeInTheDocument();
  expect(screen.queryByText('Real send controller')).not.toBeInTheDocument();
});

it('offers the existing account history as recent actions on the dashboard', () => {
  render(
    <CommandShell scope={scope} route={{ kind: 'dashboard' }}>
      {null}
    </CommandShell>
  );
  expect(screen.getByTestId('command-portfolio')).toHaveTextContent('Live wallet portfolio');
  expect(screen.getByRole('heading', { name: 'commandRecentActions' })).toBeInTheDocument();
});

it('shows newest local rows and claim cards once, bounded to the dashboard, without turning source completion into delivery', () => {
  mockRecentEntries = Array.from(
    { length: 9 },
    (_, index): IHistoryEntry => ({
      key: `completed-${index}`,
      txId: `tx-${index}`,
      address: 'account-a',
      timestamp: 100 - index,
      type: HistoryEntryType.CompletedTransaction,
      txType: index === 0 ? 'bridged-send' : 'send',
      message: index === 0 ? 'Burn confirmed' : `sent-${index}`,
      amount: String(index)
    })
  );
  mockRecentEntries.splice(2, 0, {
    key: 'pending-consume',
    txId: 'claim-row',
    address: 'account-a',
    timestamp: 99,
    type: HistoryEntryType.ProcessingTransaction,
    txType: 'consume',
    message: 'same claim'
  });
  mockClaimItems = [{ note: { id: 'note-1', receivedAt: 105 }, status: 'claiming', txId: 'claim-row' }];
  render(
    <CommandShell scope={scope} route={{ kind: 'dashboard' }}>
      {null}
    </CommandShell>
  );
  // Do not pre-truncate History: a linked claim among the first five must not hide an eligible sixth row.
  expect(mockHistoryInputs).toEqual({ address: 'account-a', numItems: undefined, pendingItems: mockClaimItems });
  expect(screen.getByRole('button', { name: 'note-1' })).toBeInTheDocument();
  expect(screen.queryByText('same claim')).not.toBeInTheDocument();
  expect(screen.getAllByTestId('recent-entry')).toHaveLength(4);
  expect(screen.getAllByTestId('recent-entry').map(entry => entry.getAttribute('data-row-id'))).toEqual([
    'tx-0',
    'tx-1',
    'tx-2',
    'tx-3'
  ]);
  expect(screen.getByText(/Burn confirmed/)).toBeInTheDocument();
  expect(screen.queryByText(/Delivered/)).not.toBeInTheDocument();
});

it('retains an accepted consume without a claim card and does not repeat a failed claim row', () => {
  mockRecentEntries = [
    {
      key: 'accepted',
      txId: 'accepted',
      address: 'account-a',
      timestamp: 60,
      type: HistoryEntryType.CompletedTransaction,
      txType: 'consume',
      message: 'Accepted payment'
    },
    {
      key: 'failed-claim',
      txId: 'failed-claim',
      address: 'account-a',
      timestamp: 59,
      type: HistoryEntryType.CompletedTransaction,
      status: ITransactionStatus.Failed,
      txType: 'consume',
      message: 'Failed payment'
    }
  ];
  mockClaimItems = [{ note: { id: 'failed-note', receivedAt: 59 }, status: 'failed', txId: 'failed-claim' }];
  render(
    <CommandShell scope={scope} route={{ kind: 'dashboard' }}>
      {null}
    </CommandShell>
  );
  expect(screen.getByText('Accepted payment')).toBeInTheDocument();
  expect(screen.queryByText('Failed payment')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'failed-note' })).toBeInTheDocument();
});

it('keeps dated history before same-time claim cards and leaves unknown-dated claims last', () => {
  mockRecentEntries = [
    {
      key: 'older',
      txId: 'older',
      address: 'account-a',
      timestamp: 40,
      type: HistoryEntryType.CompletedTransaction,
      txType: 'send',
      message: 'older'
    },
    {
      key: 'newer',
      txId: 'newer',
      address: 'account-a',
      timestamp: 50,
      type: HistoryEntryType.CompletedTransaction,
      txType: 'send',
      message: 'newer'
    }
  ];
  mockClaimItems = [
    { note: { id: 'tie', receivedAt: 50 }, status: 'pending' },
    { note: { id: 'unknown', receivedAt: Number.NaN }, status: 'pending' }
  ];
  render(
    <CommandShell scope={scope} route={{ kind: 'dashboard' }}>
      {null}
    </CommandShell>
  );
  const panel = screen.getByRole('heading', { name: 'commandRecentActions' }).closest('section');
  expect(panel?.textContent).toMatch(/newer.*tie.*older.*unknown/s);
});

it('does not put recent amounts or claim metadata in the DOM while Command privacy is on', () => {
  mockHidden = true;
  mockRecentEntries = [
    {
      key: 'private',
      txId: 'private-row',
      address: 'account-a',
      timestamp: 100,
      type: HistoryEntryType.CompletedTransaction,
      txType: 'send',
      message: 'private account',
      amount: '1234.56'
    }
  ];
  mockClaimItems = [{ note: { id: 'secret-note', receivedAt: 101 }, status: 'pending' }];
  render(
    <CommandShell scope={scope} route={{ kind: 'dashboard' }}>
      {null}
    </CommandShell>
  );
  expect(screen.queryByText(/1234.56|private account|secret-note/)).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'commandRecentActions' })).toBeInTheDocument();
});

it('places the active Send review footer in the workbench footer and clears it on route replacement', () => {
  const { rerender } = render(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'send' }}>
      <CommandSendReview title="Review" onBack={jest.fn()} footer={<button>Submit payment</button>}>
        <p>Transaction preview</p>
      </CommandSendReview>
    </CommandShell>
  );
  const submit = screen.getByRole('button', { name: 'Submit payment' });
  expect(submit.closest('footer')).toHaveAttribute('data-command-footer', 'true');
  expect(screen.getAllByRole('button', { name: 'Submit payment' })).toHaveLength(1);
  rerender(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'receive' }}>
      <p>Receive</p>
    </CommandShell>
  );
  expect(screen.queryByRole('button', { name: 'Submit payment' })).not.toBeInTheDocument();
  expect(screen.queryByTestId('command-footer')).not.toBeInTheDocument();
});

it('holds Command header Back while Swap review is submitting rather than falling through to history', () => {
  render(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'swap' }}>
      <ReviewLayout
        hero={<span>Swap terms</span>}
        primary={{ label: 'Swap', onPress: jest.fn(), loading: true }}
        secondary={{ label: 'Back', onPress: jest.fn(), disabled: true }}
      >
        <span>Rate and payout</span>
      </ReviewLayout>
    </CommandShell>
  );
  fireEvent.click(screen.getByRole('button', { name: 'back' }));
  expect(goBack).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
});

it('returns to the still-mounted Swap composer footer when the review step unmounts', () => {
  function Composer() {
    return useCommandWorkbenchSlots(<button>Review swap</button>);
  }
  function Review() {
    return useCommandWorkbenchSlots(<button>Place swap</button>);
  }
  const { rerender } = render(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'swap' }}>
      <Composer />
      <Review />
    </CommandShell>
  );
  expect(screen.getByTestId('command-footer')).toContainElement(screen.getByRole('button', { name: 'Place swap' }));
  rerender(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'swap' }}>
      <Composer />
    </CommandShell>
  );
  expect(screen.getByTestId('command-footer')).toContainElement(screen.getByRole('button', { name: 'Review swap' }));
  expect(screen.queryByRole('button', { name: 'Place swap' })).not.toBeInTheDocument();
});

it('updates one live Send footer and one secondary-details disclosure, then clears both with the owner', () => {
  const onReview = jest.fn();
  function Flow({ label }: { label: string }) {
    const outlets = useCommandWorkbenchSlots(<button onClick={onReview}>{label}</button>, <p>{label} route</p>);
    return (
      <>
        <p>Recipient and amount</p>
        {outlets}
      </>
    );
  }
  const { rerender, unmount } = render(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'send' }}>
      <Flow label="Review first" />
    </CommandShell>
  );
  const workbench = screen.getByTestId('command-workbench');
  expect(workbench.querySelectorAll('footer')).toHaveLength(1);
  expect(workbench.querySelectorAll('details')).toHaveLength(1);
  expect(screen.getByText('Review first route').closest('details')).toHaveAttribute('data-testid', 'command-details');
  expect(screen.getByText('Review first').closest('footer')).toHaveAttribute('data-command-footer', 'true');
  expect(
    screen.getByText('Recipient and amount').compareDocumentPosition(screen.getByTestId('command-details')) &
      Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();
  rerender(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'send' }}>
      <Flow key="new" label="Review current" />
    </CommandShell>
  );
  expect(screen.queryByRole('button', { name: 'Review first' })).not.toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'Review current' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Review current' }));
  expect(onReview).toHaveBeenCalledTimes(1);
  rerender(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'send' }}>
      <p>Other stage</p>
    </CommandShell>
  );
  expect(screen.queryByTestId('command-footer')).not.toBeInTheDocument();
  expect(screen.queryByTestId('command-details')).not.toBeInTheDocument();
  unmount();
});

it('uses the active flow step Back, then falls back to route history after the step unmounts', () => {
  const stepBack = jest.fn();
  const { rerender } = render(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'send' }}>
      <FlowLayout title="Amount" onBack={stepBack} footer={<button>Continue</button>}>
        <p>Amount step</p>
      </FlowLayout>
    </CommandShell>
  );
  fireEvent.click(screen.getByRole('button', { name: 'back' }));
  expect(stepBack).toHaveBeenCalledTimes(1);
  expect(goBack).not.toHaveBeenCalled();

  rerender(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'receive' }}>
      <div>Receive controller</div>
    </CommandShell>
  );
  fireEvent.click(screen.getByRole('button', { name: 'back' }));
  expect(stepBack).toHaveBeenCalledTimes(1);
  expect(goBack).toHaveBeenCalledTimes(1);
});

it.each([
  ['send', '/send'],
  ['receive', '/receive'],
  ['swap', '/swap'],
  ['earn', '/earn'],
  ['commandBridge', '/bridge/deposit']
])('opens %s through the real Command dock', (label, path) => {
  render(
    <CommandShell scope={scope} route={{ kind: 'dashboard' }}>
      {null}
    </CommandShell>
  );
  fireEvent.click(screen.getByRole('button', { name: label }));
  expect(navigate).toHaveBeenCalledWith(path);
});

it('mounts the existing home notices only in the ready Command dashboard, not in a workbench', () => {
  const { rerender } = render(
    <CommandShell scope={scope} route={{ kind: 'dashboard' }}>
      {null}
    </CommandShell>
  );
  expect(screen.getByTestId('command-home-prompts')).toBeVisible();
  expect(screen.getByTestId('command-portfolio')).toBeVisible();
  rerender(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'send' }}>
      <div>Send controller</div>
    </CommandShell>
  );
  expect(screen.queryByTestId('command-home-prompts')).not.toBeInTheDocument();
});

it('keeps the existing Profile route visible in a narrow Command tab', () => {
  render(
    <CommandShell scope={scope} route={{ kind: 'dashboard' }}>
      {null}
    </CommandShell>
  );
  const profile = screen.getByRole('button', { name: /profile/i });
  fireEvent.click(profile);
  expect(navigate).toHaveBeenCalledWith('/me');
});

it('keeps existing Explore reachable from the keyboard palette', () => {
  render(
    <CommandShell scope={scope} route={{ kind: 'dashboard' }}>
      {null}
    </CommandShell>
  );
  fireEvent.click(screen.getByRole('button', { name: 'commandSearch' }));
  const input = screen.getByRole('combobox', { name: 'commandSearch' });
  fireEvent.change(input, { target: { value: 'explore' } });
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(navigate).toHaveBeenCalledWith('/browser');
});

it('keeps a provider consumer’s unsigned literal draft on minimize and clears it on scope change', () => {
  function Probe() {
    const { readDraft, writeDraft } = useCommandDrafts();
    return (
      <>
        <button
          onClick={() => writeDraft('send', { amount: '7.123456', recipientAddress: 'recipient', tokenId: 'token' })}
        >
          Save amount
        </button>
        <output>{readDraft('send')?.amount ?? 'empty'}</output>
      </>
    );
  }
  const { rerender } = render(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'send' }}>
      <Probe />
    </CommandShell>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save amount' }));
  fireEvent.click(screen.getByRole('button', { name: 'minimize' }));
  expect(navigate).toHaveBeenCalledWith('/');
  rerender(
    <CommandShell scope={scope} route={{ kind: 'dashboard' }}>
      {null}
    </CommandShell>
  );
  rerender(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'send' }}>
      <Probe />
    </CommandShell>
  );
  expect(screen.getByText('7.123456')).toBeInTheDocument();
  rerender(
    <CommandShell scope={{ ...scope, accountId: 'account-b' }} route={{ kind: 'flow', action: 'send' }}>
      <Probe />
    </CommandShell>
  );
  expect(screen.getByText('empty')).toBeInTheDocument();
});

it('scopes the FullPage root dimensions and restores the original inline defaults on exit', () => {
  const previousMinWidth = document.documentElement.style.minWidth;
  const previousMargin = document.body.style.marginTop;
  const previousHtmlHeight = document.documentElement.style.height;
  const root = document.createElement('div');
  root.id = 'root';
  document.body.append(root);
  document.documentElement.style.minWidth = '640px';
  document.body.style.marginTop = '24px';
  try {
    const { unmount } = render(
      <CommandShell scope={scope} route={{ kind: 'dashboard' }}>
        {null}
      </CommandShell>
    );
    expect(document.documentElement.style.minWidth).toBe('0px');
    expect(document.body.style.marginTop).toBe('0px');
    expect(document.documentElement.style.height).toBe('100%');
    expect(root.style.height).toBe('100%');
    unmount();
    expect(document.documentElement.style.minWidth).toBe('640px');
    expect(document.body.style.marginTop).toBe('24px');
    expect(document.documentElement.style.height).toBe(previousHtmlHeight);
    expect(root.style.height).toBe('');
  } finally {
    root.remove();
    document.documentElement.style.minWidth = previousMinWidth;
    document.documentElement.style.height = previousHtmlHeight;
    document.body.style.marginTop = previousMargin;
  }
});

it('keeps the shell while replacing the operation controller for a different transaction ID', () => {
  function Operation({ id }: { id: string }) {
    const [mountedId] = useState(id);
    return <output>{mountedId}</output>;
  }
  const { rerender } = render(
    <CommandShell scope={scope} route={{ kind: 'operation', id: 'tx1' }}>
      <Operation id="tx1" />
    </CommandShell>
  );
  const shell = screen.getByTestId('command-shell');
  rerender(
    <CommandShell scope={scope} route={{ kind: 'operation', id: 'tx2' }}>
      <Operation id="tx2" />
    </CommandShell>
  );
  expect(screen.getByTestId('command-shell')).toBe(shell);
  expect(screen.getByText('tx2')).toBeInTheDocument();
  expect(screen.queryByText('tx1')).not.toBeInTheDocument();
});

it('reopens the same persisted operation by ID after a cold Command shell mount', () => {
  const view = render(
    <CommandShell scope={scope} route={{ kind: 'operation', id: 'original' }}>
      <output>Existing row receipt</output>
    </CommandShell>
  );
  expect(screen.getByText('Existing row receipt')).toBeInTheDocument();
  view.unmount();
  render(
    <CommandShell scope={scope} route={{ kind: 'operation', id: 'original' }}>
      <output>Existing row receipt</output>
    </CommandShell>
  );
  expect(screen.getByText('Existing row receipt')).toBeInTheDocument();
  expect(navigate).not.toHaveBeenCalled();
});

it('withholds an existing operation and all of its actions while Command privacy is on, then restores the original view', () => {
  mockHidden = true;
  const view = render(
    <CommandShell scope={scope} route={{ kind: 'operation', id: 'original' }}>
      <button aria-label="Secret 1,234.56 USD">Retry original</button>
    </CommandShell>
  );
  expect(screen.queryByText('Retry original')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Secret 1,234.56 USD')).not.toBeInTheDocument();
  mockHidden = false;
  view.rerender(
    <CommandShell scope={scope} route={{ kind: 'operation', id: 'original' }}>
      <button aria-label="Secret 1,234.56 USD">Retry original</button>
    </CommandShell>
  );
  expect(screen.getByRole('button', { name: 'Secret 1,234.56 USD' })).toBeInTheDocument();
});

it('minimizes only the active workbench when Escape has no higher dialog', () => {
  render(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'send' }}>
      <div>Controller</div>
    </CommandShell>
  );
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(navigate).toHaveBeenCalledWith('/');
});

it('keeps the workbench mounted when an intervening security confirmation takes Escape', () => {
  function SecurityStep() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Confirm spend</button>
        <AlertSheet
          open={open}
          title="Confirm spend"
          actionLabel="Proceed"
          onAction={() => setOpen(false)}
          onCancel={() => setOpen(false)}
          cancelLabel="Cancel"
        >
          Review the amount
        </AlertSheet>
      </>
    );
  }
  render(
    <CommandShell scope={scope} route={{ kind: 'flow', action: 'send' }}>
      <SecurityStep />
    </CommandShell>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Confirm spend' }));
  expect(screen.getByRole('alertdialog', { name: 'Confirm spend' })).toBeInTheDocument();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.getByRole('alertdialog', { name: 'Confirm spend', hidden: true })).toHaveAttribute(
    'data-state',
    'closed'
  );
  expect(screen.getByTestId('command-workbench')).toBeInTheDocument();
  expect(navigate).not.toHaveBeenCalledWith('/');
});

it('keeps Command controls functional with reduced motion', () => {
  const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    render(
      <MotionConfig reducedMotion="always">
        <CommandShell scope={scope} route={{ kind: 'dashboard' }}>
          <div>Dashboard slot</div>
        </CommandShell>
      </MotionConfig>
    );
    fireEvent.click(screen.getByRole('button', { name: 'commandSearch' }));
    expect(screen.getByRole('dialog', { name: 'commandSearch' })).toBeInTheDocument();
  } finally {
    warning.mockRestore();
  }
});

it('opens an accessible palette, selects with arrows and Enter, Escape closes and returns focus', async () => {
  render(
    <CommandShell scope={scope} route={{ kind: 'dashboard' }}>
      <div>Dashboard slot</div>
    </CommandShell>
  );
  const trigger = screen.getByRole('button', { name: 'commandSearch' });
  trigger.focus();
  fireEvent.click(trigger);
  expect(screen.getByRole('dialog', { name: 'commandSearch' })).toBeInTheDocument();
  const input = screen.getByRole('combobox', { name: 'commandSearch' });
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(navigate).toHaveBeenCalledWith('/send');
  trigger.focus();
  fireEvent.click(trigger);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'commandSearch' })).not.toBeInTheDocument();
  await waitFor(() => expect(trigger).toHaveFocus());
});
