/**
 * Behavior tests for the note spam list (lib/miden/note-spam.ts).
 */
import {
  applySpamAction,
  applySpamActionToState,
  EMPTY_NOTE_SPAM_STATE,
  getNoteSpamState,
  isNoteSpam,
  isNoteSpamStateEmpty,
  NOTE_SPAM_STORAGE_KEY,
  NoteSpamState,
  parseNoteSpamState,
  removeSpamEntry,
  revertSpamAction,
  revertSpamActionFromState,
  toNoteSpamSets
} from 'lib/miden/note-spam';

const STORE: Record<string, unknown> = {};

const mockFetchFromStorage = jest.fn(async (key: string) => (key in STORE ? STORE[key] : null));
const mockPutToStorage = jest.fn(async (key: string, value: unknown) => {
  STORE[key] = value;
});

jest.mock('lib/miden/front/storage', () => ({
  fetchFromStorage: (key: string) => mockFetchFromStorage(key),
  putToStorage: (key: string, value: unknown) => mockPutToStorage(key, value)
}));

const NOW = 10_000_000_000;
const note = (id: string, faucetId = 'faucet-a', senderAddress = 'mtst1sender') => ({ id, faucetId, senderAddress });

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  for (const k of Object.keys(STORE)) delete STORE[k];
  mockFetchFromStorage.mockImplementation(async (key: string) => (key in STORE ? STORE[key] : null));
  mockPutToStorage.mockImplementation(async (key: string, value: unknown) => {
    STORE[key] = value;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('getNoteSpamState', () => {
  it('is empty when nothing is stored', async () => {
    expect(await getNoteSpamState()).toEqual(EMPTY_NOTE_SPAM_STATE);
  });

  it('drops malformed entries and unknown shapes instead of throwing', async () => {
    STORE[NOTE_SPAM_STORAGE_KEY] = {
      hiddenNoteIds: [{ value: 'n1', at: 1 }, { value: '', at: 2 }, 'n2', { value: 'n3' }, null],
      blockedFaucetIds: 'nope',
      blockedSenders: [{ value: 's1', at: 5 }]
    };
    expect(await getNoteSpamState()).toEqual({
      hiddenNoteIds: [{ value: 'n1', at: 1 }],
      blockedFaucetIds: [],
      blockedSenders: [{ value: 's1', at: 5 }]
    });
  });

  it('is empty when the read throws', async () => {
    mockFetchFromStorage.mockRejectedValueOnce(new Error('boom'));
    expect(await getNoteSpamState()).toEqual(EMPTY_NOTE_SPAM_STATE);
  });

  it('parseNoteSpamState treats non-objects as empty', () => {
    expect(parseNoteSpamState(null)).toEqual(EMPTY_NOTE_SPAM_STATE);
    expect(parseNoteSpamState(42)).toEqual(EMPTY_NOTE_SPAM_STATE);
  });
});

describe('applySpamAction / revertSpamAction', () => {
  it('hide-note persists the id and returns the new state', async () => {
    const next = await applySpamAction({ kind: 'hide-note', noteId: 'n1' });
    expect(next.hiddenNoteIds).toEqual([{ value: 'n1', at: NOW }]);
    expect(STORE[NOTE_SPAM_STORAGE_KEY]).toEqual(next);
  });

  it('block-faucet / block-sender / block-sender-and-faucet each land in the right list', async () => {
    await applySpamAction({ kind: 'block-faucet', faucetId: 'f1' });
    await applySpamAction({ kind: 'block-sender', senderAddress: 's1' });
    const next = await applySpamAction({ kind: 'block-sender-and-faucet', senderAddress: 's2', faucetId: 'f2' });
    expect(next.blockedFaucetIds.map(e => e.value)).toEqual(['f1', 'f2']);
    expect(next.blockedSenders.map(e => e.value)).toEqual(['s1', 's2']);
    expect(next.hiddenNoteIds).toEqual([]);
  });

  it('dedupes by value, refreshing the timestamp', async () => {
    await applySpamAction({ kind: 'block-faucet', faucetId: 'f1' });
    jest.spyOn(Date, 'now').mockReturnValue(NOW + 10);
    const next = await applySpamAction({ kind: 'block-faucet', faucetId: 'f1' });
    expect(next.blockedFaucetIds).toEqual([{ value: 'f1', at: NOW + 10 }]);
  });

  it('caps hidden notes at 500 by dropping the oldest', async () => {
    let state: NoteSpamState = EMPTY_NOTE_SPAM_STATE;
    for (let i = 0; i < 501; i++) {
      state = applySpamActionToState(state, { kind: 'hide-note', noteId: `n${i}` }, NOW + i);
    }
    expect(state.hiddenNoteIds).toHaveLength(500);
    expect(state.hiddenNoteIds[0]!.value).toBe('n1');
    expect(state.hiddenNoteIds[499]!.value).toBe('n500');
  });

  it('revert is the exact inverse for every action kind', async () => {
    const actions = [
      { kind: 'hide-note', noteId: 'n1' },
      { kind: 'block-faucet', faucetId: 'f1' },
      { kind: 'block-sender', senderAddress: 's1' },
      { kind: 'block-sender-and-faucet', senderAddress: 's2', faucetId: 'f2' }
    ] as const;
    for (const action of actions) {
      await applySpamAction(action);
    }
    for (const action of actions) {
      await revertSpamAction(action);
    }
    expect(await getNoteSpamState()).toEqual(EMPTY_NOTE_SPAM_STATE);
  });

  it('revert of a combined block leaves an independently-blocked sibling alone', () => {
    let state = applySpamActionToState(EMPTY_NOTE_SPAM_STATE, { kind: 'block-faucet', faucetId: 'f1' }, NOW);
    state = applySpamActionToState(
      state,
      { kind: 'block-sender-and-faucet', senderAddress: 's1', faucetId: 'f2' },
      NOW
    );
    state = revertSpamActionFromState(state, { kind: 'block-sender-and-faucet', senderAddress: 's1', faucetId: 'f2' });
    expect(state.blockedFaucetIds.map(e => e.value)).toEqual(['f1']);
    expect(state.blockedSenders).toEqual([]);
  });

  it('removeSpamEntry restores one entry by kind', async () => {
    await applySpamAction({ kind: 'block-sender-and-faucet', senderAddress: 's1', faucetId: 'f1' });
    const next = await removeSpamEntry('blocked-sender', 's1');
    expect(next.blockedSenders).toEqual([]);
    expect(next.blockedFaucetIds.map(e => e.value)).toEqual(['f1']);
  });

  it('serializes overlapping writes so neither is lost', async () => {
    // Hold the first read open so the second mutator would otherwise read the same snapshot.
    let releaseFirstRead: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      releaseFirstRead = resolve;
    });
    mockFetchFromStorage.mockImplementationOnce(async () => {
      await gate;
      return STORE[NOTE_SPAM_STORAGE_KEY] ?? null;
    });
    const first = applySpamAction({ kind: 'block-faucet', faucetId: 'f1' });
    const second = applySpamAction({ kind: 'block-sender', senderAddress: 's1' });
    releaseFirstRead();
    await Promise.all([first, second]);
    const persisted = await getNoteSpamState();
    expect(persisted.blockedFaucetIds.map(e => e.value)).toEqual(['f1']);
    expect(persisted.blockedSenders.map(e => e.value)).toEqual(['s1']);
  });

  it('a failed read rejects the mutation and leaves storage untouched', async () => {
    STORE[NOTE_SPAM_STORAGE_KEY] = {
      hiddenNoteIds: [{ value: 'n1', at: 1 }],
      blockedFaucetIds: [],
      blockedSenders: []
    };
    mockFetchFromStorage.mockRejectedValueOnce(new Error('read failed'));
    await expect(applySpamAction({ kind: 'hide-note', noteId: 'n2' })).rejects.toThrow('read failed');
    expect(mockPutToStorage).not.toHaveBeenCalled();
  });
});

describe('isNoteSpam', () => {
  const state: NoteSpamState = {
    hiddenNoteIds: [{ value: 'hidden', at: 1 }],
    blockedFaucetIds: [{ value: 'bad-faucet', at: 1 }],
    blockedSenders: [{ value: 'bad-sender', at: 1 }]
  };
  const sets = toNoteSpamSets(state);

  it('matches on hidden id, blocked faucet, or blocked sender', () => {
    expect(isNoteSpam(note('hidden'), sets)).toBe(true);
    expect(isNoteSpam(note('x', 'bad-faucet'), sets)).toBe(true);
    expect(isNoteSpam(note('x', 'faucet-a', 'bad-sender'), sets)).toBe(true);
  });

  it('is false otherwise, and the empty state hides nothing', () => {
    expect(isNoteSpam(note('x'), sets)).toBe(false);
    expect(isNoteSpam(note('hidden'), toNoteSpamSets(EMPTY_NOTE_SPAM_STATE))).toBe(false);
    expect(isNoteSpamStateEmpty(EMPTY_NOTE_SPAM_STATE)).toBe(true);
    expect(isNoteSpamStateEmpty(state)).toBe(false);
  });
});
