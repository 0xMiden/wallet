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
const Harness: React.FC<{ empty?: boolean; onClose?: () => void }> = ({ empty, onClose }) => {
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
        align="end"
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
/** FloatingFocusManager's guards: the focusable spans either side of the panel that Tab lands on. */
const focusGuard = (side: 'before' | 'after') => {
  const guards = [...document.querySelectorAll<HTMLElement>('[data-floating-ui-focus-guard]')];
  const guard = side === 'before' ? guards[0] : guards[guards.length - 1];
  if (!guard || guards.length < 2) throw new Error('no focus guards around the panel');
  return guard;
};

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

  it('is placed by floating-ui rather than measured by hand', async () => {
    render(<Harness />);
    openMenu();

    // floatingStyles set the strategy inline; the old measure() left it to the class and pinned a
    // 288px width. No jsdom pixel value is asserted: layout is floating-ui's to compute.
    await waitFor(() => {
      expect(panel().style.position).toBe('fixed');
      expect(panel().style.top).toMatch(/px$/);
      expect(panel().style.left).toMatch(/px$/);
    });
    expect(panel().style.width).toBe('');
    expect(panel().style.transformOrigin).toBe('top right');
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

    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('menu')).toBeNull());
  });

  it('moves focus to the first choice and back to the anchor on close', async () => {
    render(<Harness />);
    const anchor = screen.getByRole('button', { name: 'options' });
    openMenu();

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'first' })));

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(anchor));
  });

  // A synthetic Tab keydown moves nothing in jsdom; what a real Tab off either end reaches is the
  // focus manager's guard on that side, so focusing the guard is the wrap.
  it('cycles Tab inside the panel instead of letting focus escape behind it', async () => {
    render(<Harness />);
    openMenu();
    const first = screen.getByRole('button', { name: 'first' });
    const last = screen.getByRole('button', { name: 'last' });
    await waitFor(() => expect(document.activeElement).toBe(first));

    act(() => focusGuard('after').focus());
    await waitFor(() => expect(document.activeElement).toBe(first));

    act(() => focusGuard('before').focus());
    await waitFor(() => expect(document.activeElement).toBe(last));
  });

  it('moves focus onto a panel with nothing focusable in it', async () => {
    render(<Harness empty />);
    openMenu();

    await waitFor(() => expect(document.activeElement).toBe(panel()));
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
