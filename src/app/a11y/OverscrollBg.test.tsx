import React from 'react';

import { fireEvent, render } from '@testing-library/react';

import OverscrollBg from './OverscrollBg';

// The component captures `document.documentElement` at module load and toggles
// classes on it depending on the current scroll position. jsdom hard-codes
// scrollTop / scrollHeight / clientHeight to 0, so we shadow them on the same
// element instance with configurable getters we can steer from each test.
const doc = document.documentElement;

let scrollTopValue = 0;
let scrollHeightValue = 0;
let clientHeightValue = 0;

const setScroll = ({ scrollTop = 0, scrollHeight = 0, clientHeight = 0 }) => {
  scrollTopValue = scrollTop;
  scrollHeightValue = scrollHeight;
  clientHeightValue = clientHeight;
};

const TOP = 'overscroll-top';
const BOTTOM = 'overscroll-bottom';

beforeAll(() => {
  Object.defineProperty(doc, 'scrollTop', { configurable: true, get: () => scrollTopValue });
  Object.defineProperty(doc, 'scrollHeight', { configurable: true, get: () => scrollHeightValue });
  Object.defineProperty(doc, 'clientHeight', { configurable: true, get: () => clientHeightValue });
});

beforeEach(() => {
  setScroll({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 });
  doc.className = '';
});

afterEach(() => {
  jest.restoreAllMocks();
  doc.className = '';
});

const renderBg = () => render(<OverscrollBg topClassName={TOP} bottomClassName={BOTTOM} />);

describe('OverscrollBg', () => {
  it('renders nothing (returns null)', () => {
    const { container } = renderBg();

    expect(container).toBeEmptyDOMElement();
  });

  it('applies the top class on mount when in the top half of the scroll road', () => {
    // road = 900, half = 450, scrollTop 0 => top
    setScroll({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });

    renderBg();

    expect(doc.classList.contains(TOP)).toBe(true);
    expect(doc.classList.contains(BOTTOM)).toBe(false);
  });

  it('switches to the bottom class when scrolled past the halfway point', () => {
    setScroll({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });
    renderBg();
    expect(doc.classList.contains(TOP)).toBe(true);

    // road = 900, half = 450, scrollTop 600 => bottom (removes top, adds bottom)
    setScroll({ scrollTop: 600, scrollHeight: 1000, clientHeight: 100 });
    fireEvent.scroll(window);

    expect(doc.classList.contains(BOTTOM)).toBe(true);
    expect(doc.classList.contains(TOP)).toBe(false);
  });

  it('switches back to the top class when scrolling up past the halfway point', () => {
    setScroll({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });
    renderBg();

    // go to bottom first
    setScroll({ scrollTop: 800, scrollHeight: 1000, clientHeight: 100 });
    fireEvent.scroll(window);
    expect(doc.classList.contains(BOTTOM)).toBe(true);

    // then back up to the top half (removes bottom, adds top)
    setScroll({ scrollTop: 100, scrollHeight: 1000, clientHeight: 100 });
    fireEvent.scroll(window);

    expect(doc.classList.contains(TOP)).toBe(true);
    expect(doc.classList.contains(BOTTOM)).toBe(false);
  });

  it('does nothing when the target class is already applied', () => {
    setScroll({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });
    renderBg();
    expect(doc.classList.contains(TOP)).toBe(true);

    const addSpy = jest.spyOn(doc.classList, 'add');
    const removeSpy = jest.spyOn(doc.classList, 'remove');

    // Different scrollTop (so the `!==` guard passes) but still the top half,
    // where `top` is already present => the contains() guard short-circuits.
    setScroll({ scrollTop: 50, scrollHeight: 1000, clientHeight: 100 });
    fireEvent.scroll(window);

    expect(addSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(doc.classList.contains(TOP)).toBe(true);
    expect(doc.classList.contains(BOTTOM)).toBe(false);
  });

  it('ignores scroll events when scrollTop is unchanged', () => {
    setScroll({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });
    renderBg();

    const addSpy = jest.spyOn(doc.classList, 'add');
    const removeSpy = jest.spyOn(doc.classList, 'remove');

    // scrollTop stays 0 (equal to the ref) => the whole body is skipped.
    fireEvent.scroll(window);

    expect(addSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it('removes both classes on unmount (layout-effect cleanup)', () => {
    setScroll({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });
    const { unmount } = renderBg();
    expect(doc.classList.contains(TOP)).toBe(true);

    unmount();

    expect(doc.classList.contains(TOP)).toBe(false);
    expect(doc.classList.contains(BOTTOM)).toBe(false);
  });

  it('registers and unregisters the window scroll listener', () => {
    const addSpy = jest.spyOn(window, 'addEventListener');
    const removeSpy = jest.spyOn(window, 'removeEventListener');

    const { unmount } = renderBg();

    expect(addSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
    const listener = addSpy.mock.calls.find(([type]) => (type as string) === 'scroll')?.[1];

    unmount();

    expect(removeSpy).toHaveBeenCalledWith('scroll', listener);
  });

  it('re-applies classes with the new names when the class-name props change', () => {
    setScroll({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });
    const { rerender } = renderBg();
    expect(doc.classList.contains(TOP)).toBe(true);

    // Move scrollTop so the re-run of handleScroll passes the `!==` guard
    // (the ref persists across re-renders of the same instance).
    setScroll({ scrollTop: 50, scrollHeight: 1000, clientHeight: 100 });
    rerender(<OverscrollBg topClassName="new-top" bottomClassName="new-bottom" />);

    // old classes cleaned up by the effect teardown, new top class applied
    expect(doc.classList.contains(TOP)).toBe(false);
    expect(doc.classList.contains('new-top')).toBe(true);
  });
});
