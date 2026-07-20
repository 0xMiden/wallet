/**
 * DisableOutlinesForClick — a mount-only effect component that toggles a
 * "focus-disabled" class on <html> to suppress focus outlines while the user
 * is in "mouse mode" (mousedown / touchstart) and restore them on the next
 * Tab keydown ("keyboard mode"). It renders nothing.
 *
 * The component imports a `.module.css` file, which jest cannot transform
 * (there is no css transform/mapper in jest.config.ts — importing it raw
 * throws `SyntaxError: Unexpected token '.'`). We mock the css module so the
 * source's `styles['focus-disabled']` resolves to a stable class string.
 */
import React from 'react';

import { render } from '@testing-library/react';

// Mock the co-located CSS module so `styles['focus-disabled']` is a known
// value and jest never tries to evaluate the raw CSS as JavaScript.
jest.mock('./DisableOutlinesForClick.module.css', () => ({
  __esModule: true,
  default: { 'focus-disabled': 'focus-disabled' }
}));

import DisableOutlinesForClick from './DisableOutlinesForClick';

const FOCUS_DISABLED = 'focus-disabled';
const html = () => document.documentElement;

const mousedown = () => html().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
const touchstart = () => html().dispatchEvent(new Event('touchstart', { bubbles: true }));
const keydown = (key: string) => html().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

beforeEach(() => {
  html().classList.remove(FOCUS_DISABLED);
});

describe('DisableOutlinesForClick', () => {
  it('renders nothing to the DOM', () => {
    const { container } = render(<DisableOutlinesForClick />);
    expect(container.firstChild).toBeNull();
  });

  it('does not add the focus-disabled class until a pointer interaction happens', () => {
    render(<DisableOutlinesForClick />);
    expect(html().classList.contains(FOCUS_DISABLED)).toBe(false);
  });

  it('adds the focus-disabled class on mousedown (mouse mode)', () => {
    render(<DisableOutlinesForClick />);

    mousedown();

    expect(html().classList.contains(FOCUS_DISABLED)).toBe(true);
  });

  it('adds the focus-disabled class on touchstart (touch mode)', () => {
    render(<DisableOutlinesForClick />);

    touchstart();

    expect(html().classList.contains(FOCUS_DISABLED)).toBe(true);
  });

  it('keeps the class on a non-Tab keydown (still in mouse mode)', () => {
    render(<DisableOutlinesForClick />);

    mousedown();
    keydown('Enter');

    expect(html().classList.contains(FOCUS_DISABLED)).toBe(true);
  });

  it('removes the class on Tab keydown (switches back to keyboard mode)', () => {
    render(<DisableOutlinesForClick />);

    mousedown();
    expect(html().classList.contains(FOCUS_DISABLED)).toBe(true);

    keydown('Tab');

    expect(html().classList.contains(FOCUS_DISABLED)).toBe(false);
  });

  it('re-arms pointer listeners after a Tab keydown so a later mousedown re-adds the class', () => {
    render(<DisableOutlinesForClick />);

    // Enter mouse mode, then Tab back to keyboard mode.
    mousedown();
    keydown('Tab');
    expect(html().classList.contains(FOCUS_DISABLED)).toBe(false);

    // A subsequent pointer interaction should be handled again — proving the
    // Tab branch re-registered the mousedown/touchstart listeners.
    mousedown();
    expect(html().classList.contains(FOCUS_DISABLED)).toBe(true);
  });

  it('ignores repeated pointer events while already in mouse mode (listeners were removed by reset)', () => {
    render(<DisableOutlinesForClick />);

    mousedown();
    expect(html().classList.contains(FOCUS_DISABLED)).toBe(true);

    // handlePointerDown removed the pointer listeners via reset(), so a second
    // mousedown is a no-op; the class simply stays applied.
    mousedown();
    expect(html().classList.contains(FOCUS_DISABLED)).toBe(true);
  });

  it('cleans up on unmount: removes the class and detaches listeners', () => {
    const { unmount } = render(<DisableOutlinesForClick />);

    mousedown();
    expect(html().classList.contains(FOCUS_DISABLED)).toBe(true);

    unmount();

    // Cleanup (reset) removed the class...
    expect(html().classList.contains(FOCUS_DISABLED)).toBe(false);

    // ...and detached the pointer listeners, so further events do nothing.
    mousedown();
    expect(html().classList.contains(FOCUS_DISABLED)).toBe(false);
    touchstart();
    expect(html().classList.contains(FOCUS_DISABLED)).toBe(false);
  });
});
