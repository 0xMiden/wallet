import { onNotesRefresh, requestNotesRefresh } from './note-refresh';

describe('note-refresh event bus', () => {
  it('calls every subscribed listener on requestNotesRefresh', () => {
    const a = jest.fn();
    const b = jest.fn();
    const offA = onNotesRefresh(a);
    const offB = onNotesRefresh(b);

    requestNotesRefresh();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    offA();
    offB();
  });

  it('stops calling a listener after it unsubscribes', () => {
    const a = jest.fn();
    const off = onNotesRefresh(a);

    requestNotesRefresh();
    off();
    requestNotesRefresh();

    expect(a).toHaveBeenCalledTimes(1);
  });

  it('keeps notifying other listeners when one throws', () => {
    const bad = jest.fn(() => {
      throw new Error('boom');
    });
    const good = jest.fn();
    const offBad = onNotesRefresh(bad);
    const offGood = onNotesRefresh(good);

    expect(() => requestNotesRefresh()).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);

    offBad();
    offGood();
  });
});
