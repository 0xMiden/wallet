import React, { useRef, useState } from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { Popover } from './Popover';

const mockReducedMotion = { value: false };
jest.mock('framer-motion', () => ({
  ...jest.requireActual('framer-motion'),
  useReducedMotion: () => mockReducedMotion.value
}));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

const ANCHOR_RECT = { top: 10, bottom: 54, left: 300, right: 344, width: 44, height: 44, x: 300, y: 10 };

/** A header-like anchor with a real rect, and a panel holding two focusable rows. */
const Harness: React.FC<{ align?: 'start' | 'end'; empty?: boolean; onClose?: () => void }> = ({
  align,
  empty,
  onClose
}) => {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => {
    setOpen(false);
    onClose?.();
  };
  return (
    <>
      <button ref={anchorRef} type="button" onClick={() => setOpen(true)}>
        options
      </button>
      <Popover
        open={open}
        onClose={close}
        anchorRef={anchorRef}
        align={align}
        aria-label="view options"
        data-testid="menu"
      >
        {empty ? (
          <p>nothing to choose</p>
        ) : (
          <>
            <button type="button">first</button>
            <button type="button">last</button>
          </>
        )}
      </Popover>
    </>
  );
};

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'options' }));
const panel = () => screen.getByTestId('menu');

describe('Popover', () => {
  beforeEach(() => {
    mockReducedMotion.value = false;
    jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return (
        this.textContent === 'options' ? ANCHOR_RECT : { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }
      ) as DOMRect;
    });
    window.innerWidth = 402;
    window.innerHeight = 874;
  });

  afterEach(() => jest.restoreAllMocks());

  it('renders nothing until it is opened', () => {
    render(<Harness />);
    expect(screen.queryByTestId('menu')).toBeNull();
  });

  it('opens as a named dialog holding its content', () => {
    render(<Harness />);
    openMenu();

    expect(panel()).toHaveAttribute('role', 'dialog');
    expect(panel()).toHaveAttribute('aria-modal', 'true');
    expect(panel()).toHaveAttribute('aria-label', 'view options');
    expect(screen.getByRole('button', { name: 'first' })).toBeTruthy();
  });

  it('hangs under the anchor, lined up with the edge `align` names', () => {
    const { unmount } = render(<Harness align="end" />);
    openMenu();

    // 8px under the anchor's bottom, right edges flush: 344 − 288.
    expect(panel().style.top).toBe('62px');
    expect(panel().style.left).toBe('56px');
    expect(panel().style.transformOrigin).toBe('top right');
    unmount();

    // Wide enough for the panel to actually start at the anchor's left edge; the narrow case is
    // the clamp, covered below.
    window.innerWidth = 700;
    render(<Harness align="start" />);
    openMenu();
    expect(panel().style.left).toBe('300px');
    expect(panel().style.transformOrigin).toBe('top left');
  });

  it('keeps the panel inside the page margin and lets it scroll rather than run off the bottom', () => {
    window.innerWidth = 320;
    window.innerHeight = 300;
    render(<Harness align="end" />);
    openMenu();

    // 344 − 288 = 56 would put the right edge past a 320px viewport; clamped to 320 − 288 − 16.
    expect(panel().style.left).toBe('16px');
    expect(panel().style.maxHeight).toBe('222px');
  });

  it('re-measures when the page scrolls under it', () => {
    render(<Harness />);
    openMenu();
    expect(panel().style.top).toBe('62px');

    ANCHOR_RECT.bottom = 20;
    act(() => {
      fireEvent.scroll(window);
    });
    expect(panel().style.top).toBe('28px');
    ANCHOR_RECT.bottom = 54;
  });

  it('closes on Escape', async () => {
    const onClose = jest.fn();
    render(<Harness onClose={onClose} />);
    openMenu();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
    // The panel plays its exit before it leaves the tree.
    await waitFor(() => expect(screen.queryByTestId('menu')).toBeNull());
  });

  it('closes on a tap outside, and not on a tap inside', async () => {
    const onClose = jest.fn();
    render(<Harness onClose={onClose} />);
    openMenu();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'first' }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(screen.getByTestId('menu-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('menu')).toBeNull());
  });

  it('moves focus to the first choice and back to the anchor on close', () => {
    render(<Harness />);
    const anchor = screen.getByRole('button', { name: 'options' });
    openMenu();

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'first' }));

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(anchor);
  });

  it('cycles Tab inside the panel instead of letting focus escape behind it', () => {
    render(<Harness />);
    openMenu();
    const first = screen.getByRole('button', { name: 'first' });
    const last = screen.getByRole('button', { name: 'last' });

    last.focus();
    fireEvent.keyDown(panel(), { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(panel(), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('holds focus on a panel with nothing focusable in it', () => {
    render(<Harness empty />);
    openMenu();

    expect(document.activeElement).toBe(panel());
    fireEvent.keyDown(panel(), { key: 'Tab' });
    expect(document.activeElement).toBe(panel());
  });

  it('leaves other keys alone', () => {
    const onClose = jest.fn();
    render(<Harness onClose={onClose} />);
    openMenu();

    fireEvent.keyDown(document, { key: 'a' });
    fireEvent.keyDown(panel(), { key: 'ArrowDown' });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('menu')).toBeTruthy();
  });

  it('settles instantly under reduced motion', async () => {
    mockReducedMotion.value = true;
    render(<Harness />);
    openMenu();

    // `useTabBarMotion` collapses the spring to a zero-duration tween, so the panel lands at rest
    // rather than scaling in over the spring's settle time.
    await waitFor(() => {
      expect(panel().style.transform).toBe('none');
      expect(panel().style.opacity).toBe('1');
    });
  });

  it('scales in from the anchor when motion is allowed', () => {
    render(<Harness />);
    openMenu();

    expect(panel().style.opacity).not.toBe('1');
  });
});
