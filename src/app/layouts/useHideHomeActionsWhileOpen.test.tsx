import React from 'react';

import { renderHook } from '@testing-library/react';

import { PageActiveContext } from './page-active';
import { useHideHomeActionsWhileOpen } from './useHideHomeActionsWhileOpen';

it('hides home actions only for an open active flow and releases on back', () => {
  const { rerender, unmount } = renderHook(({ open }) => useHideHomeActionsWhileOpen(open), {
    initialProps: { open: false }
  });
  expect(document.body).not.toHaveAttribute('data-hide-home-actions');
  rerender({ open: true });
  expect(document.body).toHaveAttribute('data-hide-home-actions');
  rerender({ open: false });
  expect(document.body).not.toHaveAttribute('data-hide-home-actions');
  unmount();
});

it('releases a retained flow when another home page becomes active', () => {
  let active = true;
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <PageActiveContext.Provider value={active}>{children}</PageActiveContext.Provider>
  );
  const { rerender, unmount } = renderHook(() => useHideHomeActionsWhileOpen(true), {
    wrapper
  });
  expect(document.body).toHaveAttribute('data-hide-home-actions');
  active = false;
  rerender();
  expect(document.body).not.toHaveAttribute('data-hide-home-actions');
  active = true;
  rerender();
  expect(document.body).toHaveAttribute('data-hide-home-actions');
  unmount();
  expect(document.body).not.toHaveAttribute('data-hide-home-actions');
});

it('does not release another active caller when one unmounts', () => {
  const first = renderHook(() => useHideHomeActionsWhileOpen(true));
  const second = renderHook(() => useHideHomeActionsWhileOpen(true));
  first.unmount();
  expect(document.body).toHaveAttribute('data-hide-home-actions');
  second.unmount();
  expect(document.body).not.toHaveAttribute('data-hide-home-actions');
});
