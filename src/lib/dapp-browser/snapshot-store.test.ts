/* eslint-disable import/first */
/**
 * Tests for the in-memory snapshot store + captureSnapshot wrapper.
 *
 * captureSnapshot is the ONLY production path that drives the native
 * InAppBrowser.snapshot() plugin method, so we mock the plugin and
 * assert we pass the sessionId through (PR-6 multi-instance fix —
 * before that change the native call always targeted the legacy
 * "default" slot, producing wrong images).
 */

const mockSnapshot = jest.fn();
jest.mock('@miden/dapp-browser', () => ({
  InAppBrowser: {
    snapshot: (...args: unknown[]) => mockSnapshot(...args)
  }
}));

import {
  captureSnapshot,
  clearAllSnapshots,
  clearSnapshot,
  getSnapshot,
  snapshotStoreInternals,
  subscribeSnapshots
} from './snapshot-store';

const DATA_URL = 'data:image/jpeg;base64,AAAAA';

beforeEach(() => {
  mockSnapshot.mockReset();
  clearAllSnapshots();
});

describe('captureSnapshot', () => {
  it('forwards the sessionId + scale + quality to the native plugin', async () => {
    mockSnapshot.mockResolvedValue({ data: DATA_URL });
    await captureSnapshot('dapp-abc', 0.5, 0.7);
    expect(mockSnapshot).toHaveBeenCalledWith({ id: 'dapp-abc', scale: 0.5, quality: 0.7 });
  });

  it('uses default scale 0.5 and quality 0.7 when not specified', async () => {
    mockSnapshot.mockResolvedValue({ data: DATA_URL });
    await captureSnapshot('dapp-abc');
    expect(mockSnapshot).toHaveBeenCalledWith({ id: 'dapp-abc', scale: 0.5, quality: 0.7 });
  });

  it('stores the returned data URL and returns it', async () => {
    mockSnapshot.mockResolvedValue({ data: DATA_URL });
    const result = await captureSnapshot('dapp-abc');
    expect(result).toBe(DATA_URL);
    expect(getSnapshot('dapp-abc')).toBe(DATA_URL);
  });

  it('returns null and does not store when the plugin returns empty data', async () => {
    mockSnapshot.mockResolvedValue({ data: '' });
    const result = await captureSnapshot('dapp-abc');
    expect(result).toBeNull();
    expect(getSnapshot('dapp-abc')).toBeUndefined();
  });

  it('returns null when the plugin call rejects', async () => {
    mockSnapshot.mockRejectedValue(new Error('native bridge down'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await captureSnapshot('dapp-abc');
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('notifies subscribers on successful capture', async () => {
    mockSnapshot.mockResolvedValue({ data: DATA_URL });
    const listener = jest.fn();
    const unsub = subscribeSnapshots(listener);
    await captureSnapshot('dapp-abc');
    expect(listener).toHaveBeenCalled();
    unsub();
  });
});

describe('getSnapshot', () => {
  it('returns undefined for an unknown session id', () => {
    expect(getSnapshot('ghost')).toBeUndefined();
  });
});

describe('clearSnapshot', () => {
  it('removes the snapshot and notifies subscribers', async () => {
    mockSnapshot.mockResolvedValue({ data: DATA_URL });
    await captureSnapshot('dapp-a');
    const listener = jest.fn();
    subscribeSnapshots(listener);
    clearSnapshot('dapp-a');
    expect(getSnapshot('dapp-a')).toBeUndefined();
    expect(listener).toHaveBeenCalled();
  });

  it('does not notify when the session id was not present', () => {
    const listener = jest.fn();
    subscribeSnapshots(listener);
    clearSnapshot('never-stored');
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('clearAllSnapshots', () => {
  it('clears every entry and notifies when state actually changed', async () => {
    mockSnapshot.mockResolvedValue({ data: DATA_URL });
    await captureSnapshot('a');
    await captureSnapshot('b');
    const listener = jest.fn();
    subscribeSnapshots(listener);
    clearAllSnapshots();
    expect(getSnapshot('a')).toBeUndefined();
    expect(getSnapshot('b')).toBeUndefined();
    expect(listener).toHaveBeenCalled();
  });

  it('is a no-op when the store is already empty', () => {
    const listener = jest.fn();
    subscribeSnapshots(listener);
    clearAllSnapshots();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('snapshotStoreInternals.setRaw (PR-6 cold-bubble rehydration)', () => {
  it('inserts a snapshot without calling the native plugin', () => {
    snapshotStoreInternals.setRaw('dapp-cold', DATA_URL);
    expect(getSnapshot('dapp-cold')).toBe(DATA_URL);
    expect(mockSnapshot).not.toHaveBeenCalled();
  });

  it('notifies subscribers after a raw insert', () => {
    const listener = jest.fn();
    subscribeSnapshots(listener);
    snapshotStoreInternals.setRaw('dapp-cold', DATA_URL);
    expect(listener).toHaveBeenCalled();
  });
});

describe('subscribeSnapshots', () => {
  it('returns an unsubscribe that stops notifications', async () => {
    mockSnapshot.mockResolvedValue({ data: DATA_URL });
    const listener = jest.fn();
    const unsub = subscribeSnapshots(listener);
    unsub();
    await captureSnapshot('dapp-a');
    expect(listener).not.toHaveBeenCalled();
  });

  it('isolates a failing listener so other subscribers still run', () => {
    const throwing = () => {
      throw new Error('subscriber blew up');
    };
    const good = jest.fn();
    subscribeSnapshots(throwing);
    subscribeSnapshots(good);
    snapshotStoreInternals.setRaw('dapp-a', DATA_URL);
    expect(good).toHaveBeenCalled();
  });
});
