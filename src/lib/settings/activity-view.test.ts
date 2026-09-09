import { getActivityView, setActivityView } from './activity-view';
import { ACTIVITY_VIEW_STORAGE_KEY } from './constants';

describe('activity view preference', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to the chronological feed', () => {
    expect(getActivityView()).toBe('time');
  });

  it('reads back a stored view', () => {
    localStorage.setItem(ACTIVITY_VIEW_STORAGE_KEY, 'group');
    expect(getActivityView()).toBe('group');
  });

  it('ignores a value that is not a known view', () => {
    localStorage.setItem(ACTIVITY_VIEW_STORAGE_KEY, 'sideways');
    expect(getActivityView()).toBe('time');
  });

  it('persists the choice so leaving and returning keeps the view', () => {
    setActivityView('group');
    // A fresh read is what a remounted Activity page does after a drill-in.
    expect(getActivityView()).toBe('group');
    expect(localStorage.getItem(ACTIVITY_VIEW_STORAGE_KEY)).toBe('group');
  });

  it('falls back to the default when localStorage.getItem throws', () => {
    const spy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(getActivityView()).toBe('time');
    spy.mockRestore();
  });

  it('does not throw when localStorage.setItem throws', () => {
    const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => setActivityView('group')).not.toThrow();
    spy.mockRestore();
  });
});
