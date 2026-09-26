import { act, renderHook } from '@testing-library/react';

import {
  getActivityReadState,
  isActivityRead,
  markActivityRead,
  resetActivityReadState,
  useActivityReadState
} from './activity-read';
import { ACTIVITY_READ_MAX_IDS, ACTIVITY_READ_STORAGE_KEY } from './constants';

const NOW_MS = 1_700_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

const stored = () => JSON.parse(localStorage.getItem(ACTIVITY_READ_STORAGE_KEY) ?? 'null');

beforeEach(() => {
  localStorage.clear();
  resetActivityReadState();
  jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});

afterEach(() => jest.restoreAllMocks());

describe('first run', () => {
  it('seeds the high-water mark at now, so an existing history does not arrive as a wall of dots', () => {
    const state = getActivityReadState();

    expect(state.seenBefore).toBe(NOW_S);
    expect(isActivityRead(state, 'tx:old', NOW_S - 86_400)).toBe(true);
    expect(isActivityRead(state, 'tx:new', NOW_S + 10)).toBe(false);
  });

  it('PERSISTS the seed rather than holding it in memory', () => {
    // A seed that only lived in memory would be re-taken at a later `now` after a reload, and
    // everything that arrived in between would silently become read.
    getActivityReadState();
    expect(stored()).toEqual({ seenBefore: NOW_S, ids: {} });

    resetActivityReadState();
    localStorage.setItem(ACTIVITY_READ_STORAGE_KEY, JSON.stringify({ seenBefore: NOW_S, ids: {} }));
    jest.spyOn(Date, 'now').mockReturnValue(NOW_MS + 60_000);
    expect(getActivityReadState().seenBefore).toBe(NOW_S);
  });

  it('re-seeds rather than trusting a corrupt or foreign value', () => {
    localStorage.setItem(ACTIVITY_READ_STORAGE_KEY, 'not json');
    expect(getActivityReadState()).toEqual({ seenBefore: NOW_S, ids: {} });
  });
});

describe('marking read', () => {
  it('reads one activity and survives a reload', () => {
    getActivityReadState();
    markActivityRead('tx:a', NOW_S + 10);

    expect(isActivityRead(getActivityReadState(), 'tx:a', NOW_S + 10)).toBe(true);
    expect(isActivityRead(getActivityReadState(), 'tx:b', NOW_S + 10)).toBe(false);

    // The reload: nothing in memory, everything read back off the device.
    resetActivityReadState();
    localStorage.setItem(ACTIVITY_READ_STORAGE_KEY, JSON.stringify({ seenBefore: NOW_S, ids: { 'tx:a': NOW_S + 10 } }));
    expect(isActivityRead(getActivityReadState(), 'tx:a', NOW_S + 10)).toBe(true);
  });

  it('keeps an id whose timestamp is unusable, since the mark can say nothing about it', () => {
    getActivityReadState();
    expect(isActivityRead(getActivityReadState(), 'note:x', Number.NaN)).toBe(false);

    markActivityRead('note:x', Number.NaN);
    expect(isActivityRead(getActivityReadState(), 'note:x', Number.NaN)).toBe(true);
  });

  it('stores nothing for an id the mark already covers', () => {
    getActivityReadState();
    markActivityRead('tx:ancient', NOW_S - 500);

    expect(stored().ids).toEqual({});
  });
});

describe('bounding', () => {
  it('advances the mark over the oldest reads instead of letting the set grow', () => {
    getActivityReadState();
    for (let i = 1; i <= ACTIVITY_READ_MAX_IDS + 20; i++) markActivityRead(`tx:${i}`, NOW_S + i);

    const state = getActivityReadState();
    expect(Object.keys(state.ids).length).toBeLessThanOrEqual(ACTIVITY_READ_MAX_IDS);
    // The oldest reads became the mark, so they are still read — nothing that was read comes back.
    for (let i = 1; i <= ACTIVITY_READ_MAX_IDS + 20; i++) {
      expect(isActivityRead(state, `tx:${i}`, NOW_S + i)).toBe(true);
    }
    // And the newest is still individually recorded, not merely under the mark.
    expect(state.ids[`tx:${ACTIVITY_READ_MAX_IDS + 20}`]).toBe(NOW_S + ACTIVITY_READ_MAX_IDS + 20);
  });
});

const writeFromOtherWindow = (state: { seenBefore: number; ids: Record<string, number> }) =>
  localStorage.setItem(ACTIVITY_READ_STORAGE_KEY, JSON.stringify(state));

const storageEvent = (key: string | null, newValue: string | null) =>
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', { key, newValue }));
  });

describe('several windows (#1106)', () => {
  it('keeps a read another window stored when this window marks something, even without its event', () => {
    getActivityReadState();
    markActivityRead('tx:a', NOW_S + 10);
    // The side panel read tx:b; this window never saw the event.
    writeFromOtherWindow({ seenBefore: NOW_S, ids: { 'tx:a': NOW_S + 10, 'tx:b': NOW_S + 20 } });

    markActivityRead('tx:c', NOW_S + 30);

    expect(stored().ids).toEqual({ 'tx:a': NOW_S + 10, 'tx:b': NOW_S + 20, 'tx:c': NOW_S + 30 });
    expect(isActivityRead(getActivityReadState(), 'tx:b', NOW_S + 20)).toBe(true);
  });

  it('takes the later mark and the later read time when both windows hold one', () => {
    getActivityReadState();
    markActivityRead('tx:a', NOW_S + 10);
    writeFromOtherWindow({ seenBefore: NOW_S + 15, ids: { 'tx:b': NOW_S + 40 } });

    markActivityRead('tx:c', NOW_S + 50);

    // tx:a sits under the other window's later mark now, so compaction drops its own row.
    expect(stored()).toEqual({ seenBefore: NOW_S + 15, ids: { 'tx:b': NOW_S + 40, 'tx:c': NOW_S + 50 } });
  });

  it('keeps the later read time of a row both windows marked, so the later mark cannot drop it', () => {
    getActivityReadState();
    // A row with no usable timestamp is recorded at the time it was read, so two windows can
    // hold it at different times; this one read it at NOW_S + 9.
    jest.spyOn(Date, 'now').mockReturnValue(NOW_MS + 9_000);
    markActivityRead('note:x', Number.NaN);
    writeFromOtherWindow({ seenBefore: NOW_S + 7, ids: { 'note:x': NOW_S + 5 } });

    markActivityRead('tx:c', NOW_S + 50);

    expect(stored()).toEqual({ seenBefore: NOW_S + 7, ids: { 'note:x': NOW_S + 9, 'tx:c': NOW_S + 50 } });
  });

  it("picks up another window's read the moment its write lands", () => {
    getActivityReadState();
    const { result } = renderHook(() => useActivityReadState());
    expect(isActivityRead(result.current, 'tx:b', NOW_S + 20)).toBe(false);

    const next = JSON.stringify({ seenBefore: NOW_S, ids: { 'tx:b': NOW_S + 20 } });
    localStorage.setItem(ACTIVITY_READ_STORAGE_KEY, next);
    storageEvent(ACTIVITY_READ_STORAGE_KEY, next);

    expect(isActivityRead(result.current, 'tx:b', NOW_S + 20)).toBe(true);
  });

  it('keeps its own reads when another window writes an older copy', () => {
    getActivityReadState();
    markActivityRead('tx:a', NOW_S + 10);

    storageEvent(ACTIVITY_READ_STORAGE_KEY, JSON.stringify({ seenBefore: NOW_S, ids: { 'tx:b': NOW_S + 20 } }));

    const state = getActivityReadState();
    expect(isActivityRead(state, 'tx:a', NOW_S + 10)).toBe(true);
    expect(isActivityRead(state, 'tx:b', NOW_S + 20)).toBe(true);
  });

  it('ignores a write to another key', () => {
    getActivityReadState();
    const { result } = renderHook(() => useActivityReadState());
    const before = result.current;

    storageEvent('some_other_setting', '{}');

    expect(result.current).toBe(before);
  });

  it('forgets its copy when another window clears storage, and reads the device again', () => {
    getActivityReadState();
    markActivityRead('tx:a', NOW_S + 10);
    localStorage.clear();
    writeFromOtherWindow({ seenBefore: NOW_S + 100, ids: {} });

    storageEvent(null, null);

    expect(getActivityReadState()).toEqual({ seenBefore: NOW_S + 100, ids: {} });
  });

  it('re-renders nobody when an already-read activity is marked again', () => {
    getActivityReadState();
    markActivityRead('tx:a', NOW_S + 10);
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useActivityReadState();
    });
    const before = renders;

    act(() => markActivityRead('tx:a', NOW_S + 10));

    expect(renders).toBe(before);
  });

  it('re-renders nobody when another window writes what this one already holds', () => {
    getActivityReadState();
    markActivityRead('tx:a', NOW_S + 10);
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useActivityReadState();
    });
    const before = renders;

    storageEvent(ACTIVITY_READ_STORAGE_KEY, localStorage.getItem(ACTIVITY_READ_STORAGE_KEY));

    expect(renders).toBe(before);
  });
});
