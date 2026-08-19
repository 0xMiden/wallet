import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';

import {
  clearGuardianNoteRecoveryProgress,
  fetchGuardianNoteRecoveryProgress,
  GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY,
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
      latestBlock: undefined
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
      latestBlock: undefined
    });
    expect(mockFetchFromStorage).toHaveBeenCalledWith(GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY);
  });

  it('stores progress and clears it with the shared storage key', async () => {
    const progress = { accountId: '0xabc', step: 'transport' } as const;

    await reportGuardianNoteRecoveryProgress(progress);
    await clearGuardianNoteRecoveryProgress();

    expect(mockPutToStorage).toHaveBeenNthCalledWith(1, GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY, progress);
    expect(mockPutToStorage).toHaveBeenNthCalledWith(2, GUARDIAN_NOTE_RECOVERY_PROGRESS_STORAGE_KEY, null);
  });

  it('keeps storage write failures best-effort', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockPutToStorage.mockRejectedValue(new Error('storage unavailable'));

    await expect(
      reportGuardianNoteRecoveryProgress({ accountId: '0xabc', step: 'transport' })
    ).resolves.toBeUndefined();
    await expect(clearGuardianNoteRecoveryProgress()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
