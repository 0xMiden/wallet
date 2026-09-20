import React from 'react';

import { render, screen } from '@testing-library/react';

import { ActivityGroupedHistory } from './ActivityGroupedHistory';
import { HistoryEntryType, IHistoryEntry } from './IHistoryEntry';

const entry = (over: Partial<IHistoryEntry> = {}): IHistoryEntry => ({
  key: 'entry-1',
  address: 'me',
  timestamp: 1_000,
  message: 'Sent',
  type: HistoryEntryType.CompletedTransaction,
  txType: 'send',
  ...over
});

// The loaded entries this view rolls up, plus the props it hands `History`.
const loaded: IHistoryEntry[] = [];
let historyProps: Record<string, unknown> = {};

jest.mock('./History', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    historyProps = props;
    const render = props.renderEntries as (view: unknown) => React.ReactNode;
    return (
      <div data-testid="history">
        {render({ entries: loaded, initialLoading: false, hasMore: false, loadMore: jest.fn() })}
      </div>
    );
  }
}));

// The list itself has its own suite; here it only has to report what it was handed.
jest.mock('./ActivityGroupList', () => ({
  ActivityGroupList: (props: { entries: IHistoryEntry[]; nameOf: (address: string) => string | undefined }) => (
    <div
      data-testid="group-list"
      data-count={String(props.entries.length)}
      data-alice={props.nameOf('MTST1ALICE') ?? ''}
      data-stranger={props.nameOf('mtst1stranger') ?? ''}
    />
  )
}));

jest.mock('lib/miden/front', () => ({ useAccount: () => ({ publicKey: '0xme' }) }));

const contacts = {
  value: [
    { address: 'mtst1alice', name: 'Alice' },
    { address: 'mtst1blank', name: '   ' }
  ] as Array<{ address: string; name: string }>
};
jest.mock('lib/miden/front/use-filtered-contacts.hook', () => ({
  useFilteredContacts: () => ({ allContacts: contacts.value, contacts: contacts.value })
}));

describe('ActivityGroupedHistory', () => {
  beforeEach(() => {
    loaded.length = 0;
    historyProps = {};
  });

  it('rolls up the loaded entries and passes the search straight through', () => {
    loaded.push(entry(), entry({ key: 'entry-2' }));
    render(<ActivityGroupedHistory search="usdc" programId="prog-1" />);

    expect(screen.getByTestId('group-list')).toHaveAttribute('data-count', '2');
    expect(historyProps.searchQuery).toBe('usdc');
    expect(historyProps.programId).toBe('prog-1');
    expect(historyProps.address).toBe('0xme');
  });

  it('narrows by nothing else: grouping the whole history is what this view filters by', () => {
    render(<ActivityGroupedHistory search="" />);

    expect(historyProps.filter).toBeUndefined();
    expect(historyProps.predicate).toBeUndefined();
  });

  it('keeps the rows still in flight, so a group can report them', () => {
    loaded.push(entry({ type: HistoryEntryType.PendingTransaction }), entry({ key: 'entry-2' }));
    render(<ActivityGroupedHistory search="" />);

    expect(screen.getByTestId('group-list')).toHaveAttribute('data-count', '2');
  });

  it('resolves a counterparty to its contact, whatever the case, and ignores a blank name', () => {
    render(<ActivityGroupedHistory search="" />);

    const list = screen.getByTestId('group-list');
    expect(list).toHaveAttribute('data-alice', 'Alice');
    expect(list).toHaveAttribute('data-stranger', '');
  });
});
