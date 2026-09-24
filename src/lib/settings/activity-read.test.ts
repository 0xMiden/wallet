import { getActivityReadState, isActivityRead, markActivityRead, resetActivityReadState } from './activity-read';
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
