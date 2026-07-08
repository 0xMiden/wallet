import { renderHook } from '@testing-library/react';

import { useHideNavbarWhileOpen } from './useHideNavbarWhileOpen';

describe('useHideNavbarWhileOpen', () => {
  beforeEach(() => {
    document.body.removeAttribute('data-hide-navbar');
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
});
