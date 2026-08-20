import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';

import {
  clearGuardianNoteRecoveryProgress,
  fetchGuardianNoteRecoveryProgress,
  GUARDIAN_NOTE_RECOVERY_PROGRESS_STALE_MS,
  GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY,
  isGuardianNoteRecoveryProgressStale,
  normalizeGuardianNoteRecoveryProgress,
  reportGuardianNoteRecoveryProgress
} from './guardian-note-recovery-progress';

jest.mock('lib/miden/front/storage', () => ({
  fetchFromStorage: jest.fn(),
  putToStorage: jest.fn()
}));

const mockFetchFromStorage = jest.mocked(fetchFromStorage);
const mockPutToStorage = jest.mocked(putToStorage);

describe('guardian note recovery progress', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPutToStorage.mockResolvedValue(undefined);
    mockFetchFromStorage.mockResolvedValue(null);
  });

  it('normalizes valid progress and drops malformed optional block values', () => {
    expect(
      normalizeGuardianNoteRecoveryProgress({
        accountId: '0xabc',
        step: 'public',
        startBlock: 10,
        syncedToBlock: Number.NaN,
        latestBlock: '20'
      })
    ).toEqual({
      accountId: '0xabc',
      step: 'public',
      startBlock: 10,
      syncedToBlock: undefined,
      latestBlock: undefined,
      updatedAt: undefined
    });
  });

  it.each([null, {}, { accountId: '', step: 'transport' }, { accountId: '0xabc', step: 'unknown' }])(
    'rejects invalid progress %#',
    value => {
      expect(normalizeGuardianNoteRecoveryProgress(value)).toBeNull();
    }
  );

  it('fetches and normalizes the stored record', async () => {
    mockFetchFromStorage.mockResolvedValue({ accountId: '0xabc', step: 'proposals' });

    await expect(fetchGuardianNoteRecoveryProgress()).resolves.toEqual({
      accountId: '0xabc',
      step: 'proposals',
      startBlock: undefined,
      syncedToBlock: undefined,
      latestBlock: undefined,
      updatedAt: undefined
    });
    expect(mockFetchFromStorage).toHaveBeenCalledWith(GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY);
  });

  it('stamps every write so an abandoned record can be aged out', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

    await reportGuardianNoteRecoveryProgress({ accountId: '0xabc', step: 'transport' });

    expect(mockPutToStorage).toHaveBeenCalledWith(GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY, {
      accountId: '0xabc',
      step: 'transport',
      updatedAt: 1_700_000_000_000
    });
    jest.spyOn(Date, 'now').mockRestore();
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

  it('clears the record when it belongs to the finishing account', async () => {
    mockFetchFromStorage.mockResolvedValue({ accountId: '0xabc', step: 'public' });

    await clearGuardianNoteRecoveryProgress('0xabc');

    expect(mockPutToStorage).toHaveBeenCalledWith(GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY, null);
  });

  it('leaves another account\u2019s in-flight record alone', async () => {
    mockFetchFromStorage.mockResolvedValue({ accountId: '0xother', step: 'public' });

    await clearGuardianNoteRecoveryProgress('0xabc');

    expect(mockPutToStorage).not.toHaveBeenCalled();
  });

  it('keeps storage write failures best-effort', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockPutToStorage.mockRejectedValue(new Error('storage unavailable'));

    await expect(
      reportGuardianNoteRecoveryProgress({ accountId: '0xabc', step: 'transport' })
    ).resolves.toBeUndefined();
    await expect(clearGuardianNoteRecoveryProgress('0xabc')).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
