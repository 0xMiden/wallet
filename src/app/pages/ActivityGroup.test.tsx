import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { HistoryEntryType, IHistoryEntry } from 'app/templates/history/IHistoryEntry';
import type { PendingActivityItem } from 'app/templates/history/PendingActivityCard';

import { ActivityGroupPage } from './ActivityGroup';

const FAUCET = 'miden-native-faucet';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (options?.count === undefined ? key : `${key}:${options.count}`)
  })
}));
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

const claimNote = (id: string, senderAddress: string, faucetId = 'token-faucet') => ({
  id,
  faucetId,
  amount: '1000000',
  senderAddress,
  isBeingClaimed: false,
  type: 'unknown' as const,
  metadata: { name: 'Token', symbol: 'TOK', decimals: 6 }
});
const mockClaims: { items: PendingActivityItem[] } = { items: [] };
const mockHidden = { ids: new Set<string>(), loaded: true, failed: false, hide: jest.fn(), restore: jest.fn() };
jest.mock('app/hooks/useActivityClaims', () => ({
  useActivityClaims: () => ({
    items: mockClaims.items,
    accept: jest.fn(),
    acceptMany: jest.fn(),
    account: { publicKey: '0xme' },
    isLoadingNotes: false
  })
}));
jest.mock('app/hooks/useActivityHiddenNotes', () => ({ useActivityHiddenNotes: () => mockHidden }));
jest.mock('lib/ui/dialog', () => ({ useConfirm: () => jest.fn() }));
jest.mock('components/Button', () => ({
  ButtonVariant: { Secondary: 'secondary' },
  Button: ({ title, onClick }: { title: string; onClick: () => void }) => (
    <button type="button" onClick={onClick}>
      {title}
    </button>
  )
}));

const contacts = {
  value: [
    { address: 'mtst1aliceaddress0000', name: 'Alice' },
    { address: 'mtst1blankaddress0000', name: '   ' }
  ]
};
jest.mock('lib/miden/front/use-filtered-contacts.hook', () => ({
  useFilteredContacts: () => ({ allContacts: contacts.value, contacts: contacts.value })
}));

jest.mock('lib/woozie', () => ({
  Redirect: ({ to }: { to: string }) => <div data-testid="redirect" data-to={to} />
}));

// Undefined leaves the real labels in place; a test sets sentinels to prove whose map the heading reads.
const mockLabels: { value?: Record<string, string> } = {};
jest.mock('app/templates/history/activityGroups', () => {
  const actual = jest.requireActual('app/templates/history/activityGroups');
  return {
    ...actual,
    get ACTIVITY_GROUP_LABELS() {
      return mockLabels.value ?? actual.ACTIVITY_GROUP_LABELS;
    }
  };
});

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
    mockLabels.value = undefined;
    mockClaims.items = [];
    mockHidden.ids = new Set();
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

  it('falls back to the ellipsised address for a contact saved with a blank name', () => {
    render(<ActivityGroupPage kind="address" id="mtst1blankaddress0000" />);

    expect(screen.getByRole('heading', { name: 'mtst1b…0000' })).toBeTruthy();
  });

  it('names every category page from the shared label map', () => {
    mockLabels.value = { swap: 'label-swap', faucet: 'label-faucet', guardian: 'label-guardian', other: 'label-other' };

    for (const kind of ['swap', 'faucet', 'guardian', 'other']) {
      const { unmount } = render(<ActivityGroupPage kind={kind} />);
      expect(screen.getByRole('heading', { name: `label-${kind}` })).toBeTruthy();
      unmount();
    }
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

  describe('the claims of this group', () => {
    const drawn = () => ((historyProps.drawnPendingItems ?? []) as PendingActivityItem[]).map(item => item.note.id);
    const represented = () => ((historyProps.pendingItems ?? []) as PendingActivityItem[]).map(item => item.note.id);

    it('draws the claim card of a note from this address and keeps its consume row out', () => {
      mockClaims.items = [{ note: claimNote('from-alice', 'MTST1ALICEADDRESS0000'), status: 'claimed', txId: 'tx' }];
      render(<ActivityGroupPage kind="address" id="mtst1aliceaddress0000" />);

      expect(drawn()).toEqual(['from-alice']);
      expect(represented()).toEqual(['from-alice']);
      expect(historyProps.renderPendingItem).toEqual(expect.any(Function));
    });

    it('draws no card for a claim from another address', () => {
      mockClaims.items = [{ note: claimNote('from-bob', 'mtst1bobaddress'), status: 'pending' }];
      render(<ActivityGroupPage kind="address" id="mtst1aliceaddress0000" />);

      expect(drawn()).toEqual([]);
      // Still represented, as in the Activity views, so its consume row stays out wherever it would land.
      expect(represented()).toEqual(['from-bob']);
    });

    it('draws a faucet claim on the faucet page and not on the faucet address page', () => {
      mockClaims.items = [
        { note: claimNote('minted', FAUCET, FAUCET), status: 'pending' },
        { note: claimNote('from-alice', 'mtst1aliceaddress0000'), status: 'pending' }
      ];
      const { unmount } = render(<ActivityGroupPage kind="faucet" />);
      expect(drawn()).toEqual(['minted']);
      unmount();

      render(<ActivityGroupPage kind="address" id={FAUCET} />);
      expect(drawn()).toEqual([]);
    });

    it('counts and restores only the declined claims of this group', () => {
      mockClaims.items = [
        { note: claimNote('alice-declined', 'mtst1aliceaddress0000'), status: 'pending' },
        { note: claimNote('alice-failed', 'mtst1aliceaddress0000'), status: 'failed' },
        { note: claimNote('bob-declined', 'mtst1bobaddress'), status: 'pending' }
      ];
      mockHidden.ids = new Set(['alice-declined', 'alice-failed', 'bob-declined']);
      render(<ActivityGroupPage kind="address" id="mtst1aliceaddress0000" />);

      expect(screen.getByText('activityHiddenTransfers:2')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'activityRestoreTransfers' }));
      expect(mockHidden.restore).toHaveBeenCalledWith(['alice-declined', 'alice-failed']);
    });
  });
});
