import {
  checkStorage,
  isStorageStalled,
  isStorageStalledError,
  isStorageStalledNow,
  probeStorage,
  resetStorageHealthForTests,
  STORAGE_PROBE_DEADLINE_MS,
  STORAGE_RECHECK_INTERVAL_MS,
  STORAGE_STALL_KEY,
  StorageStalledError
} from './storage-health';

const mockPutToStorage = jest.fn(async (..._args: unknown[]) => {});
jest.mock('lib/miden/front/storage', () => ({
  putToStorage: (...args: unknown[]) => mockPutToStorage(...args)
}));

type FakeRequest = {
  onsuccess?: () => void;
  onerror?: () => void;
  onblocked?: () => void;
  result: { close: jest.Mock };
};

let requests: FakeRequest[];
let answer: 'never' | 'success' | 'error';

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(console, 'warn').mockImplementation();
  mockPutToStorage.mockClear();
  resetStorageHealthForTests();
  requests = [];
  answer = 'never';
  (globalThis as any).indexedDB = {
    open: jest.fn(() => {
      const req: FakeRequest = { result: { close: jest.fn() } };
      requests.push(req);
      if (answer !== 'never') {
        void Promise.resolve().then(() => (answer === 'success' ? req.onsuccess?.() : req.onerror?.()));
      }
      return req;
    })
  };
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  delete (globalThis as any).indexedDB;
});

describe('probeStorage', () => {
  it('reports stalled when the open never answers within the deadline', async () => {
    const probe = probeStorage();
    await jest.advanceTimersByTimeAsync(STORAGE_PROBE_DEADLINE_MS);
    await expect(probe).resolves.toBe('stalled');
  });

  it('reports ok on success and closes the probe connection', async () => {
    answer = 'success';
    await expect(probeStorage()).resolves.toBe('ok');
    expect(requests[0]!.result.close).toHaveBeenCalled();
  });

  it('counts an error answer as alive: only silence is a stall', async () => {
    answer = 'error';
    await expect(probeStorage()).resolves.toBe('ok');
  });

  it('treats an unavailable indexedDB global as not stalled', async () => {
    (globalThis as any).indexedDB = {
      open: () => {
        throw new Error('SecurityError');
      }
    };
    await expect(probeStorage()).resolves.toBe('ok');
  });
});

describe('stall flag', () => {
  it('a silent probe sets the flag and mirrors it once; a later answer clears and mirrors it', async () => {
    const check = checkStorage();
    await jest.advanceTimersByTimeAsync(STORAGE_PROBE_DEADLINE_MS);
    await expect(check).resolves.toBe(true);
    expect(isStorageStalled()).toBe(true);
    expect(mockPutToStorage).toHaveBeenCalledWith(STORAGE_STALL_KEY, true);

    answer = 'success';
    await jest.advanceTimersByTimeAsync(STORAGE_RECHECK_INTERVAL_MS);
    await expect(isStorageStalledNow()).resolves.toBe(false);
    expect(mockPutToStorage).toHaveBeenLastCalledWith(STORAGE_STALL_KEY, false);
    expect(mockPutToStorage).toHaveBeenCalledTimes(2);
  });

  it('writes the first healthy result so a mirror left by a previous worker is replaced', async () => {
    answer = 'success';
    await checkStorage();
    expect(mockPutToStorage).toHaveBeenCalledWith(STORAGE_STALL_KEY, false);
  });

  it('while stalled, gates answer from the flag and probe at most once per recheck interval', async () => {
    const check = checkStorage();
    await jest.advanceTimersByTimeAsync(STORAGE_PROBE_DEADLINE_MS);
    await check;
    const opens = (globalThis as any).indexedDB.open.mock.calls.length;

    await expect(isStorageStalledNow()).resolves.toBe(true);
    await expect(isStorageStalledNow()).resolves.toBe(true);
    expect((globalThis as any).indexedDB.open).toHaveBeenCalledTimes(opens);

    await jest.advanceTimersByTimeAsync(STORAGE_RECHECK_INTERVAL_MS);
    const again = isStorageStalledNow();
    await jest.advanceTimersByTimeAsync(STORAGE_PROBE_DEADLINE_MS);
    await expect(again).resolves.toBe(true);
    expect((globalThis as any).indexedDB.open).toHaveBeenCalledTimes(opens + 1);
  });

  it('is free while healthy: no probe', async () => {
    await expect(isStorageStalledNow()).resolves.toBe(false);
    expect((globalThis as any).indexedDB.open).not.toHaveBeenCalled();
  });

  it('shares one probe between concurrent checks', async () => {
    const a = checkStorage();
    const b = checkStorage();
    await jest.advanceTimersByTimeAsync(STORAGE_PROBE_DEADLINE_MS);
    await Promise.all([a, b]);
    expect((globalThis as any).indexedDB.open).toHaveBeenCalledTimes(1);
  });
});

describe('StorageStalledError', () => {
  it('is recognised by class and by name', () => {
    expect(isStorageStalledError(new StorageStalledError())).toBe(true);
    expect(isStorageStalledError(Object.assign(new Error('x'), { name: 'StorageStalledError' }))).toBe(true);
    expect(isStorageStalledError(new Error('Sync timeout'))).toBe(false);
  });
});
