import { renderHook } from '@testing-library/react';

import { holdNavbarHidden, useHideNavbarWhileOpen } from './useHideNavbarWhileOpen';

describe('useHideNavbarWhileOpen', () => {
  // The counter is module state: a hold a failing test leaks would skew every later test.
  const holds: Array<() => void> = [];
  const hold = () => {
    const release = holdNavbarHidden();
    holds.push(release);
    return release;
  };

  beforeEach(() => {
    document.body.removeAttribute('data-hide-navbar');
  });

  afterEach(() => {
    holds.splice(0).forEach(release => release());
  });

  it('does nothing when closed', () => {
    const { unmount } = renderHook(() => useHideNavbarWhileOpen(false));

    expect(document.body).not.toHaveAttribute('data-hide-navbar');

    unmount();

    expect(document.body).not.toHaveAttribute('data-hide-navbar');
  });

  it('keeps the navbar hidden until all open callers unmount', () => {
    const first = renderHook(() => useHideNavbarWhileOpen(true));
    const second = renderHook(() => useHideNavbarWhileOpen(true));

    expect(document.body).toHaveAttribute('data-hide-navbar');

    first.unmount();
    expect(document.body).toHaveAttribute('data-hide-navbar');

    second.unmount();
    expect(document.body).not.toHaveAttribute('data-hide-navbar');
  });

  it('counts a hold and an open caller on one counter', () => {
    const release = hold();
    const caller = renderHook(() => useHideNavbarWhileOpen(true));

    release();
    expect(document.body).toHaveAttribute('data-hide-navbar');
    // A second release of the same hold must not spend the open caller's.
    release();
    expect(document.body).toHaveAttribute('data-hide-navbar');
    caller.unmount();
    expect(document.body).not.toHaveAttribute('data-hide-navbar');
  });
});
