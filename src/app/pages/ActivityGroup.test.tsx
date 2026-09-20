import React from 'react';

import { render, screen } from '@testing-library/react';

import { HistoryEntryType, IHistoryEntry } from 'app/templates/history/IHistoryEntry';

import { ActivityGroupPage } from './ActivityGroup';

const FAUCET = 'miden-native-faucet';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/miden-chain/native-asset', () => ({ getNativeAssetIdSync: () => FAUCET }));

const mockBack = jest.fn();
const backFallback = { path: '' };
jest.mock('app/hooks/useBackWithFallback', () => ({
  useBackWithFallback: (fallback: string) => {
    backFallback.path = fallback;
    return mockBack;
  }
}));

jest.mock('lib/miden/front', () => ({ useAccount: () => ({ publicKey: '0xme' }) }));

const contacts = { value: [{ address: 'mtst1aliceaddress0000', name: 'Alice' }] };
jest.mock('lib/miden/front/use-filtered-contacts.hook', () => ({
  useFilteredContacts: () => ({ allContacts: contacts.value, contacts: contacts.value })
}));

jest.mock('lib/woozie', () => ({
  Redirect: ({ to }: { to: string }) => <div data-testid="redirect" data-to={to} />
}));

// The page's whole job is to hand `History` a predicate; the list itself has its own suite.
let historyProps: Record<string, unknown> = {};
jest.mock('app/templates/history/History', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    historyProps = props;
    return <div data-testid="history" />;
  }
}));

const entry = (over: Partial<IHistoryEntry> = {}): IHistoryEntry => ({
  key: 'entry-1',
  address: 'me',
  timestamp: 1_000,
  message: 'Sent',
  type: HistoryEntryType.CompletedTransaction,
  txType: 'send',
  ...over
});

const predicate = () => historyProps.predicate as (entry: IHistoryEntry) => boolean;

describe('ActivityGroupPage', () => {
  beforeEach(() => {
    historyProps = {};
    jest.clearAllMocks();
  });

  it('names a known counterparty in the header, with its avatar', () => {
    render(<ActivityGroupPage kind="address" id="mtst1aliceaddress0000" />);

    expect(screen.getByRole('heading', { name: 'Alice' })).toBeTruthy();
    expect(screen.getByTestId('contact-avatar')).toBeTruthy();
  });

  it('falls back to the ellipsised address for a counterparty nobody has named', () => {
    render(<ActivityGroupPage kind="address" id="mtst1strangeraddress0" />);

    expect(screen.getByRole('heading', { name: 'mtst1s…ess0' })).toBeTruthy();
    expect(screen.getByTestId('contact-avatar')).toBeTruthy();
  });

  it('names a category group and shows no avatar', () => {
    render(<ActivityGroupPage kind="swap" />);

    expect(screen.getByRole('heading', { name: 'activityGroupSwaps' })).toBeTruthy();
    expect(screen.queryByTestId('contact-avatar')).toBeNull();
  });

  it('shows the same list, narrowed to this group and paging off the body it scrolls in', () => {
    render(<ActivityGroupPage kind="address" id="mtst1aliceaddress0000" />);

    expect(screen.getByTestId('history')).toBeTruthy();
    expect(historyProps.address).toBe('0xme');
    expect(historyProps.fullHistory).toBe(true);
    expect(historyProps.scrollParentRef).toBeTruthy();

    expect(predicate()(entry({ secondaryAddress: 'MTST1ALICEADDRESS0000' }))).toBe(true);
    expect(predicate()(entry({ secondaryAddress: 'mtst1someoneelse' }))).toBe(false);
    expect(predicate()(entry({ txType: 'swap' }))).toBe(false);
  });

  it('keeps a category page to its own kind', () => {
    render(<ActivityGroupPage kind="guardian" />);

    expect(predicate()(entry({ txType: 'switch-guardian' }))).toBe(true);
    expect(predicate()(entry({ txType: 'replace-hot-key' }))).toBe(true);
    expect(predicate()(entry({ secondaryAddress: 'mtst1alice' }))).toBe(false);
  });

  it('keeps the rows still in flight, which is how the pending badge stays honest', () => {
    render(<ActivityGroupPage kind="address" id="mtst1alice" />);

    expect(predicate()(entry({ type: HistoryEntryType.PendingTransaction, secondaryAddress: 'mtst1alice' }))).toBe(
      true
    );
  });

  it('goes back to the Activity tab when there is nothing to go back to', () => {
    render(<ActivityGroupPage kind="swap" />);
    expect(backFallback.path).toBe('/history');
  });

  it('sends an unknown kind back to the tab rather than showing an empty list', () => {
    render(<ActivityGroupPage kind="bridges" />);

    expect(screen.getByTestId('redirect')).toHaveAttribute('data-to', '/history');
    expect(screen.queryByTestId('history')).toBeNull();
  });

  it('sends an address group with no address back too', () => {
    render(<ActivityGroupPage kind="address" />);

    expect(screen.getByTestId('redirect')).toHaveAttribute('data-to', '/history');
    expect(screen.queryByTestId('history')).toBeNull();
  });
});
