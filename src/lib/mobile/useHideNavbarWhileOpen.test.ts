/**
 * @jest-environment jsdom
 */
import { renderHook } from '@testing-library/react';

import { InAppBrowser } from '@miden/dapp-browser';
import { isMobile } from 'lib/platform';

import { useHideNavbarWhileOpen } from './useHideNavbarWhileOpen';

jest.mock('@miden/dapp-browser', () => ({
  InAppBrowser: {
    morphNavbarOut: jest.fn(),
    morphNavbarIn: jest.fn()
  }
}));

jest.mock('lib/platform', () => ({
  isMobile: jest.fn()
}));

const mockIsMobile = isMobile as jest.MockedFunction<typeof isMobile>;
const mockMorphOut = InAppBrowser.morphNavbarOut as jest.Mock;
const mockMorphIn = InAppBrowser.morphNavbarIn as jest.Mock;

const flushMicrotasks = () => new Promise(resolve => setTimeout(resolve, 0));

describe('useHideNavbarWhileOpen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    document.body.removeAttribute('data-drawer-open');
    mockMorphOut.mockResolvedValue(undefined);
    mockMorphIn.mockResolvedValue(undefined);
  });

  it('is a no-op on desktop / extension', () => {
    mockIsMobile.mockReturnValue(false);

    renderHook(({ open }) => useHideNavbarWhileOpen(open), { initialProps: { open: true } });

    expect(mockMorphOut).not.toHaveBeenCalled();
    expect(mockMorphIn).not.toHaveBeenCalled();
    expect(document.body.hasAttribute('data-drawer-open')).toBe(false);
  });

  it('morphs the navbar out when opened and back in on unmount (mobile)', async () => {
    mockIsMobile.mockReturnValue(true);

    const { unmount } = renderHook(({ open }) => useHideNavbarWhileOpen(open), { initialProps: { open: true } });

    expect(document.body.hasAttribute('data-drawer-open')).toBe(true);
    await flushMicrotasks();
    expect(mockMorphOut).toHaveBeenCalledTimes(1);

    unmount();

    expect(document.body.hasAttribute('data-drawer-open')).toBe(false);
    await flushMicrotasks();
    expect(mockMorphIn).toHaveBeenCalledTimes(1);
  });

  it('morphs back in when `open` flips from true to false', async () => {
    mockIsMobile.mockReturnValue(true);

    const { rerender } = renderHook(({ open }) => useHideNavbarWhileOpen(open), { initialProps: { open: true } });
    await flushMicrotasks();
    expect(mockMorphOut).toHaveBeenCalledTimes(1);

    rerender({ open: false });

    expect(document.body.hasAttribute('data-drawer-open')).toBe(false);
    await flushMicrotasks();
    expect(mockMorphIn).toHaveBeenCalledTimes(1);
  });

  it('does not morph out while `open` stays false', () => {
    mockIsMobile.mockReturnValue(true);

    renderHook(({ open }) => useHideNavbarWhileOpen(open), { initialProps: { open: false } });

    expect(mockMorphOut).not.toHaveBeenCalled();
    expect(mockMorphIn).not.toHaveBeenCalled();
    expect(document.body.hasAttribute('data-drawer-open')).toBe(false);
  });

  it('keeps the navbar out while a second modal opens, restores only after both close', async () => {
    mockIsMobile.mockReturnValue(true);

    const first = renderHook(({ open }) => useHideNavbarWhileOpen(open), { initialProps: { open: true } });
    await flushMicrotasks();
    expect(mockMorphOut).toHaveBeenCalledTimes(1);

    const second = renderHook(({ open }) => useHideNavbarWhileOpen(open), { initialProps: { open: true } });
    await flushMicrotasks();
    // Count still 1 — we do not re-morph when already out.
    expect(mockMorphOut).toHaveBeenCalledTimes(1);

    first.unmount();
    await flushMicrotasks();
    // First modal gone, second still open → no morph-in yet.
    expect(mockMorphIn).not.toHaveBeenCalled();

    second.unmount();
    await flushMicrotasks();
    expect(mockMorphIn).toHaveBeenCalledTimes(1);
  });

  it('swallows morphNavbarOut / morphNavbarIn rejections', async () => {
    mockIsMobile.mockReturnValue(true);
    mockMorphOut.mockRejectedValueOnce(new Error('plugin missing'));
    mockMorphIn.mockRejectedValueOnce(new Error('plugin missing'));

    const { unmount } = renderHook(({ open }) => useHideNavbarWhileOpen(open), { initialProps: { open: true } });
    await flushMicrotasks();
    unmount();
    await flushMicrotasks();

    // No uncaught rejection → test passes by reaching this line.
    expect(mockMorphOut).toHaveBeenCalled();
    expect(mockMorphIn).toHaveBeenCalled();
  });
});
