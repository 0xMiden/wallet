import { cleanup, renderHook, waitFor } from '@testing-library/react';

import { __resetClaimChecksForTest, useClaimNotes } from 'app/hooks/useClaimNotes';
import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { transactions } from 'lib/miden/repo';
import { resetActivityReadState } from 'lib/settings/activity-read';
import { ACTIVITY_READ_STORAGE_KEY } from 'lib/settings/constants';

import { useHasUnreadActivity } from './useHasUnreadActivity';

// The rows come from the real History loaders over a seeded Dexie table; only the note-side
// collaborators and the SDK are stubbed.
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({ PswapLineageState: {}, InputNoteState: { Invalid: 'Invalid' } }));
jest.mock('lib/miden/back/miden-client-proxy', () => ({ midenClientProxy: {} }));
jest.mock('lib/miden/sdk/miden-client', () => ({ withWasmClientLock: (fn: () => unknown) => fn() }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// Counts the live query's deliveries, so a test can wait for a read to land rather than a timer.
const mockDeliveries = { value: 0 };
jest.mock('lib/dexie-live-query', () => {
  const actual = jest.requireActual('lib/dexie-live-query');
  return {
    subscribeToLiveQuery: (query: () => unknown, observer: { next: (value: unknown) => void; error: () => void }) =>
      actual.subscribeToLiveQuery(query, {
        ...observer,
        next: (value: unknown) => {
          observer.next(value);
          mockDeliveries.value += 1;
        }
      })
  };
});

const A = 'mtst1accounta';
const B = 'mtst1accountb';
const mockAccount = { publicKey: A };
jest.mock('lib/miden/front', () => ({ useAccount: () => mockAccount }));

interface MockNote {
  id: string;
  receivedAt?: number;
}
const mockNotes: { value: MockNote[] } = { value: [] };
jest.mock('lib/miden/front/auto-managed-notes', () => ({
  useManuallyClaimableNotes: () => ({ data: mockNotes.value })
}));
jest.mock('lib/miden/front/claimable-notes', () => ({
  useClaimableNotes: () => ({ data: mockNotes.value, mutate: jest.fn(), isLoading: false })
}));
jest.mock('app/hooks/useActivityHiddenNotes', () => ({
  useActivityHiddenNotes: () => ({ ids: new Set<string>() })
}));

// The claim check runs on its extension path, which asks the service worker for note states.
const mockInvalidNoteIds: { value: string[] } = { value: [] };
jest.mock('lib/platform', () => ({ isExtension: () => true, isMobile: () => false }));
jest.mock('lib/store', () => ({
  getIntercom: () => ({
    request: async () => ({
      type: 'GET_INPUT_NOTE_DETAILS_RESPONSE',
      notes: mockInvalidNoteIds.value.map(noteId => ({ noteId, state: 'Invalid' }))
    })
  })
}));

function tx(id: string, overrides: Partial<ITransaction> = {}): ITransaction {
  return {
    id,
    accountId: A,
    initiatedAt: 100,
    completedAt: 100,
    status: ITransactionStatus.Completed,
    type: 'send',
    displayIcon: 'SEND',
    ...overrides
  };
}

/** Every stamp is above the mark, so a row is read only when its id is listed here. */
function setRead(...keys: string[]) {
  resetActivityReadState();
  localStorage.setItem(
    ACTIVITY_READ_STORAGE_KEY,
    JSON.stringify({ seenBefore: 0, ids: Object.fromEntries(keys.map(key => [key, 1])) })
  );
}
const txKey = (id: string) => `tx:${id}`;

/** Renders the hook and waits for the live query's first read, so the answer is not the initial state. */
async function renderUnread() {
  const delivered = mockDeliveries.value;
  const rendered = renderHook(() => useHasUnreadActivity());
  await waitFor(() => expect(mockDeliveries.value).toBeGreaterThan(delivered));
  return rendered.result;
}

beforeEach(async () => {
  mockAccount.publicKey = A;
  mockNotes.value = [];
  mockInvalidNoteIds.value = [];
  __resetClaimChecksForTest();
  setRead();
  await transactions.clear();
});

afterEach(async () => {
  cleanup();
  await transactions.clear();
});

describe('useHasUnreadActivity - the account feed rows', () => {
  it('does not light for an unread row of another account', async () => {
    await transactions.add(tx('other', { accountId: B }));
    expect((await renderUnread()).current).toBe(false);
  });

  it('lights for one unread row of this account behind 50 newer rows of another', async () => {
    const others = Array.from({ length: 50 }, (_, i) => tx(`b${i}`, { accountId: B, completedAt: 200 + i }));
    await transactions.bulkAdd([tx('mine', { initiatedAt: 10, completedAt: 10 }), ...others]);
    setRead(...others.map(row => txKey(row.id)));
    expect((await renderUnread()).current).toBe(true);
  });

  it('lights for an old unread uncompleted row behind more than 50 newer completed rows', async () => {
    const completed = Array.from({ length: 60 }, (_, i) => tx(`c${i}`, { initiatedAt: 200 + i, completedAt: 300 + i }));
    const queued = tx('queued', { initiatedAt: 10, completedAt: undefined, status: ITransactionStatus.Queued });
    await transactions.bulkAdd([queued, ...completed]);
    setRead(...completed.map(row => txKey(row.id)));
    expect((await renderUnread()).current).toBe(true);
  });

  it('lights for an unread failed row of this account behind more than 50 newer failed rows of another', async () => {
    const others = Array.from({ length: 60 }, (_, i) =>
      tx(`f${i}`, { accountId: B, status: ITransactionStatus.Failed, initiatedAt: 200 + i, completedAt: 300 + i })
    );
    await transactions.bulkAdd([
      tx('mine', { status: ITransactionStatus.Failed, initiatedAt: 10, completedAt: 20 }),
      ...others
    ]);
    setRead(...others.map(row => txKey(row.id)));
    expect((await renderUnread()).current).toBe(true);
  });

  it('does not light for a completed settlement consume linked to a swap', async () => {
    await transactions.bulkAdd([
      tx('swap', { type: 'swap', displayIcon: 'SWAP', completedAt: 50 }),
      tx('settle', { type: 'consume', displayIcon: 'RECEIVE', extraInputs: { swapOrderTxId: 'swap' } })
    ]);
    setRead(txKey('swap'));
    expect((await renderUnread()).current).toBe(false);
  });

  it('does not light for an uncompleted settlement consume linked to a swap', async () => {
    await transactions.bulkAdd([
      tx('swap', { type: 'swap', displayIcon: 'SWAP', completedAt: 50 }),
      tx('settle', {
        type: 'consume',
        displayIcon: 'RECEIVE',
        status: ITransactionStatus.Queued,
        completedAt: undefined,
        extraInputs: { swapOrderTxId: 'swap' }
      })
    ]);
    setRead(txKey('swap'));
    expect((await renderUnread()).current).toBe(false);
  });

  it('lights for an unread ordinary row behind more than 50 newer raw rows, most of them settlement consumes', async () => {
    const consumes = Array.from({ length: 55 }, (_, i) =>
      tx(`settle${i}`, {
        type: 'consume',
        displayIcon: 'RECEIVE',
        initiatedAt: 200 + i,
        completedAt: 300 + i,
        extraInputs: { swapOrderTxId: 'swap' }
      })
    );
    const reads = [tx('swap', { type: 'swap', displayIcon: 'SWAP', initiatedAt: 150, completedAt: 400 })];
    await transactions.bulkAdd([tx('mine', { initiatedAt: 10, completedAt: 20 }), ...reads, ...consumes]);
    // Read, so only suppression keeps them out of the newest-50 window.
    setRead(...[...reads, ...consumes].map(row => txKey(row.id)));
    expect((await renderUnread()).current).toBe(true);
  });

  it('lights for more than RECENT_ROWS uncompleted rows with only the oldest unread', async () => {
    const queued = Array.from({ length: 51 }, (_, i) =>
      tx(`q${i}`, { initiatedAt: 100 + i, completedAt: undefined, status: ITransactionStatus.Queued })
    );
    await transactions.bulkAdd(queued);
    setRead(...queued.slice(1).map(row => txKey(row.id)));
    expect((await renderUnread()).current).toBe(true);
  });

  it('does not light when the newest RECENT_ROWS completed rows are read and only an older one is not', async () => {
    const completed = Array.from({ length: 51 }, (_, i) => tx(`c${i}`, { initiatedAt: 100 + i, completedAt: 200 + i }));
    await transactions.bulkAdd(completed);
    setRead(...completed.slice(1).map(row => txKey(row.id)));
    expect((await renderUnread()).current).toBe(false);
  });

  it('follows the account when it switches while the hook stays mounted', async () => {
    await transactions.bulkAdd([tx('a-unread'), tx('b-read', { accountId: B })]);
    setRead(txKey('b-read'));
    const { result, rerender } = renderHook(() => useHasUnreadActivity());
    await waitFor(() => expect(result.current).toBe(true));

    mockAccount.publicKey = B;
    rerender();
    await waitFor(() => expect(result.current).toBe(false));

    mockAccount.publicKey = A;
    rerender();
    await waitFor(() => expect(result.current).toBe(true));
  });
});

describe('useHasUnreadActivity - transfers the claim check found unavailable', () => {
  it('does not light for a note the check marked invalid for this account', async () => {
    mockNotes.value = [{ id: 'n1', receivedAt: 100 }];
    mockInvalidNoteIds.value = ['n1'];
    const delivered = mockDeliveries.value;
    const { result } = renderHook(() => ({ unread: useHasUnreadActivity(), claim: useClaimNotes() }));
    await waitFor(() => expect(result.current.claim.invalidNoteIds.has('n1')).toBe(true));
    await waitFor(() => expect(mockDeliveries.value).toBeGreaterThan(delivered));
    expect(result.current.unread).toBe(false);
  });

  it('lights for the same note marked invalid only for another account', async () => {
    mockNotes.value = [{ id: 'n1', receivedAt: 100 }];
    mockInvalidNoteIds.value = ['n1'];
    mockAccount.publicKey = B;
    const claim = renderHook(() => useClaimNotes());
    await waitFor(() => expect(claim.result.current.invalidNoteIds.has('n1')).toBe(true));
    claim.unmount();

    mockAccount.publicKey = A;
    expect((await renderUnread()).current).toBe(true);
  });

  it('lights for a claimable note before any check has run for the account', async () => {
    mockNotes.value = [{ id: 'n1', receivedAt: 100 }];
    expect((await renderUnread()).current).toBe(true);
  });
});
