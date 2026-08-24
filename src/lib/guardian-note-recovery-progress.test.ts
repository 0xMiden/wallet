import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';

import {
  clearGuardianNoteRecoveryProgress,
  fetchGuardianNoteRecoveryProgress,
  GUARDIAN_NOTE_RECOVERY_PROGRESS_STALE_MS,
  GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY,
  isGuardianNoteRecoveryProgressStale,
  normalizeGuardianNoteRecoveryProgress,
  normalizeGuardianNoteRecoveryProgressMap,
  reportGuardianNoteRecoveryProgress
} from './guardian-note-recovery-progress';

jest.mock('lib/miden/front/storage', () => ({
  fetchFromStorage: jest.fn(),
  putToStorage: jest.fn()
}));

const mockFetchFromStorage = jest.mocked(fetchFromStorage);
const mockPutToStorage = jest.mocked(putToStorage);

/** What the last write put in storage. */
function written() {
  return mockPutToStorage.mock.calls[mockPutToStorage.mock.calls.length - 1]?.[1] as Record<string, unknown> | null;
}

describe('guardian note recovery progress', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPutToStorage.mockResolvedValue(undefined);
    mockFetchFromStorage.mockResolvedValue(null);
  });

  it('normalizes a valid entry and drops malformed optional block values', () => {
    expect(
      normalizeGuardianNoteRecoveryProgress(
        {
          '0xabc': {
            accountId: '0xabc',
            step: 'public',
            startBlock: 10,
            syncedToBlock: Number.NaN,
            latestBlock: '20'
          }
        },
        '0xabc'
      )
    ).toEqual({
      accountId: '0xabc',
      step: 'public',
      startBlock: 10,
      syncedToBlock: undefined,
      latestBlock: undefined,
      updatedAt: undefined
    });
  });

  it.each([
    ['not an object', null],
    ['an empty map', {}],
    ['an entry with no account id', { '0xabc': { accountId: '', step: 'transport' } }],
    ['an unknown step', { '0xabc': { accountId: '0xabc', step: 'unknown' } }],
    // A key that disagrees with the entry it holds was not written by this
    // module, and resuming from it would apply one account's watermark to
    // another.
    ['a key that disagrees with its entry', { '0xabc': { accountId: '0xother', step: 'public' } }]
  ])('rejects %s', (_label, value) => {
    expect(normalizeGuardianNoteRecoveryProgress(value, '0xabc')).toBeNull();
  });

  it('keeps the sound entries in a map that also holds a broken one', () => {
    expect(
      normalizeGuardianNoteRecoveryProgressMap({
        '0xgood': { accountId: '0xgood', step: 'public', syncedToBlock: 5 },
        '0xbad': { accountId: '0xbad', step: 'nonsense' }
      })
    ).toEqual({
      '0xgood': {
        accountId: '0xgood',
        step: 'public',
        startBlock: undefined,
        syncedToBlock: 5,
        latestBlock: undefined,
        updatedAt: undefined
      }
    });
  });

  it('reads only the requested account out of the stored map', async () => {
    mockFetchFromStorage.mockResolvedValue({
      '0xabc': { accountId: '0xabc', step: 'proposals' },
      '0xother': { accountId: '0xother', step: 'public', syncedToBlock: 99 }
    });

    await expect(fetchGuardianNoteRecoveryProgress('0xabc')).resolves.toMatchObject({
      accountId: '0xabc',
      step: 'proposals'
    });
    await expect(fetchGuardianNoteRecoveryProgress('0xmissing')).resolves.toBeNull();
    expect(mockFetchFromStorage).toHaveBeenCalledWith(GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY);
  });

  it('stamps every write so an abandoned record can be aged out', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

    await reportGuardianNoteRecoveryProgress({ accountId: '0xabc', step: 'transport' });

    expect(mockPutToStorage).toHaveBeenCalledWith(GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY, {
      '0xabc': { accountId: '0xabc', step: 'transport', updatedAt: 1_700_000_000_000 }
    });
    jest.spyOn(Date, 'now').mockRestore();
  });

  // Seed recovery flags every adopted account, so one account's run writing
  // progress while another's is checkpointed is the normal case — and erasing
  // that checkpoint would make the other account restart from scratch, every
  // time, forever.
  it('does not disturb another account\u2019s checkpoint when writing progress', async () => {
    const checkpoint = { accountId: '0xother', step: 'public', syncedToBlock: 200_000, updatedAt: 1 };
    mockFetchFromStorage.mockResolvedValue({ '0xother': checkpoint });

    await reportGuardianNoteRecoveryProgress({ accountId: '0xabc', step: 'transport' });

    expect(written()?.['0xother']).toMatchObject({ accountId: '0xother', syncedToBlock: 200_000 });
    expect(written()?.['0xabc']).toMatchObject({ accountId: '0xabc', step: 'transport' });
  });

  it('treats a record as stale only once it outlives the refresh window', () => {
    const now = 1_700_000_000_000;
    const progress = { accountId: '0xabc', step: 'transport' } as const;

    expect(isGuardianNoteRecoveryProgressStale({ ...progress, updatedAt: now }, now)).toBe(false);
    expect(
      isGuardianNoteRecoveryProgressStale(
        { ...progress, updatedAt: now - GUARDIAN_NOTE_RECOVERY_PROGRESS_STALE_MS },
        now
      )
    ).toBe(false);
    expect(
      isGuardianNoteRecoveryProgressStale(
        { ...progress, updatedAt: now - GUARDIAN_NOTE_RECOVERY_PROGRESS_STALE_MS - 1 },
        now
      )
    ).toBe(true);
  });

  it('ages out a record with no timestamp, since every live writer stamps one', () => {
    expect(isGuardianNoteRecoveryProgressStale({ accountId: '0xabc', step: 'transport' })).toBe(true);
  });

  it('clears only the finishing account, leaving the rest of the map', async () => {
    mockFetchFromStorage.mockResolvedValue({
      '0xabc': { accountId: '0xabc', step: 'public' },
      '0xother': { accountId: '0xother', step: 'public', syncedToBlock: 7 }
    });

    await clearGuardianNoteRecoveryProgress('0xabc');

    expect(written()).toEqual({
      '0xother': {
        accountId: '0xother',
        step: 'public',
        startBlock: undefined,
        syncedToBlock: 7,
        latestBlock: undefined,
        updatedAt: undefined
      }
    });
  });

  it('empties the key entirely once the last account is done', async () => {
    mockFetchFromStorage.mockResolvedValue({ '0xabc': { accountId: '0xabc', step: 'public' } });

    await clearGuardianNoteRecoveryProgress('0xabc');

    expect(mockPutToStorage).toHaveBeenCalledWith(GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY, null);
  });

  it('writes nothing when the account has no record to clear', async () => {
    mockFetchFromStorage.mockResolvedValue({ '0xother': { accountId: '0xother', step: 'public' } });

    await clearGuardianNoteRecoveryProgress('0xabc');

    expect(mockPutToStorage).not.toHaveBeenCalled();
  });

  it('evicts the least recently updated account past the cap, never the one being written', async () => {
    // 20 tracked accounts plus a new one: the oldest goes, the new one stays.
    const stored: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) {
      stored[`0x${i}`] = { accountId: `0x${i}`, step: 'public', updatedAt: 1_000 + i };
    }
    mockFetchFromStorage.mockResolvedValue(stored);

    await reportGuardianNoteRecoveryProgress({ accountId: '0xnew', step: 'transport' });

    const result = written()!;
    expect(Object.keys(result)).toHaveLength(20);
    expect(result['0x0']).toBeUndefined();
    expect(result['0xnew']).toBeDefined();
    expect(result['0x19']).toBeDefined();
  });

  it('keeps storage write failures best-effort', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetchFromStorage.mockResolvedValue({ '0xabc': { accountId: '0xabc', step: 'public' } });
    mockPutToStorage.mockRejectedValue(new Error('storage unavailable'));

    await expect(
      reportGuardianNoteRecoveryProgress({ accountId: '0xabc', step: 'transport' })
    ).resolves.toBeUndefined();
    await expect(clearGuardianNoteRecoveryProgress('0xabc')).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
