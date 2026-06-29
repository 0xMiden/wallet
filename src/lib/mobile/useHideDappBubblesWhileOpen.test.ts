/**
 * @jest-environment jsdom
 */
import { renderHook } from '@testing-library/react';

import { isMobile } from 'lib/platform';

import { useHideDappBubblesWhileOpen } from './useHideDappBubblesWhileOpen';

jest.mock('lib/platform', () => ({
  isMobile: jest.fn()
}));

const mockIsMobile = isMobile as jest.MockedFunction<typeof isMobile>;

describe('useHideDappBubblesWhileOpen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    document.body.removeAttribute('data-drawer-open');
  });

  it('is a no-op on desktop / extension', () => {
    mockIsMobile.mockReturnValue(false);

    renderHook(({ open }) => useHideDappBubblesWhileOpen(open), { initialProps: { open: true } });

    expect(document.body.hasAttribute('data-drawer-open')).toBe(false);
  });

  it('sets the drawer-open body flag when opened and clears it on unmount', () => {
    mockIsMobile.mockReturnValue(true);

    const { unmount } = renderHook(({ open }) => useHideDappBubblesWhileOpen(open), {
      initialProps: { open: true }
    });

    expect(document.body.hasAttribute('data-drawer-open')).toBe(true);

    unmount();

    expect(document.body.hasAttribute('data-drawer-open')).toBe(false);
  });

  it('clears the flag when `open` flips from true to false', () => {
    mockIsMobile.mockReturnValue(true);

    const { rerender } = renderHook(({ open }) => useHideDappBubblesWhileOpen(open), {
      initialProps: { open: true }
    });

    expect(document.body.hasAttribute('data-drawer-open')).toBe(true);

    rerender({ open: false });

    expect(document.body.hasAttribute('data-drawer-open')).toBe(false);
  });

  it('does not set the flag while `open` stays false', () => {
    mockIsMobile.mockReturnValue(true);

    renderHook(({ open }) => useHideDappBubblesWhileOpen(open), { initialProps: { open: false } });

    expect(document.body.hasAttribute('data-drawer-open')).toBe(false);
  });

  it('keeps the flag while a second modal remains open, then clears after both close', () => {
    mockIsMobile.mockReturnValue(true);

    const first = renderHook(({ open }) => useHideDappBubblesWhileOpen(open), { initialProps: { open: true } });
    const second = renderHook(({ open }) => useHideDappBubblesWhileOpen(open), { initialProps: { open: true } });

    expect(document.body.hasAttribute('data-drawer-open')).toBe(true);

    first.unmount();
    expect(document.body.hasAttribute('data-drawer-open')).toBe(true);

    second.unmount();
    expect(document.body.hasAttribute('data-drawer-open')).toBe(false);
  });
});
