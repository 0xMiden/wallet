/**
 * The one flag that says a home-carousel pane has a sub-page up — what `TabLayout` reads to drop
 * the action bar, and what the bottom bar, the CTA cushion and the carousel lock already follow
 * through `data-hide-navbar`.
 */

import React from 'react';

import { act, render, screen } from '@testing-library/react';

import { useHomePaneSubPage, useHomePaneSubPageOpen } from './home-pane-subpage';

const Reader: React.FC = () => <span data-testid="open">{String(useHomePaneSubPageOpen())}</span>;

const Pane: React.FC<{ open: boolean }> = ({ open }) => {
  useHomePaneSubPage(open);
  return null;
};

const open = () => screen.getByTestId('open').textContent;
const navbarHidden = () => document.body.hasAttribute('data-hide-navbar');

afterEach(() => document.body.removeAttribute('data-hide-navbar'));

it('is closed until a pane declares a sub-page, and raises the navbar flag with it', () => {
  const { rerender } = render(
    <>
      <Reader />
      <Pane open={false} />
    </>
  );
  expect(open()).toBe('false');
  expect(navbarHidden()).toBe(false);

  act(() =>
    rerender(
      <>
        <Reader />
        <Pane open={true} />
      </>
    )
  );
  expect(open()).toBe('true');
  // The bottom bar, the cushion over it and the carousel's drag lock all key off this one flag,
  // so a sub-page never has to raise them separately.
  expect(navbarHidden()).toBe(true);

  act(() =>
    rerender(
      <>
        <Reader />
        <Pane open={false} />
      </>
    )
  );
  expect(open()).toBe('false');
  expect(navbarHidden()).toBe(false);
});

it('drops the flag when the pane that raised it unmounts', () => {
  const { unmount } = render(
    <>
      <Pane open={true} />
    </>
  );
  unmount();
  render(<Reader />);
  expect(open()).toBe('false');
  expect(navbarHidden()).toBe(false);
});

it('stays open while any pane still has one, so a hand-over never blinks the chrome back', () => {
  const { rerender } = render(
    <>
      <Reader />
      <Pane open={true} />
      <Pane open={true} />
    </>
  );
  expect(open()).toBe('true');

  // One of the two closes: the count is still positive, so nothing comes back.
  act(() =>
    rerender(
      <>
        <Reader />
        <Pane open={true} />
        <Pane open={false} />
      </>
    )
  );
  expect(open()).toBe('true');
  expect(navbarHidden()).toBe(true);

  act(() =>
    rerender(
      <>
        <Reader />
        <Pane open={false} />
        <Pane open={false} />
      </>
    )
  );
  expect(open()).toBe('false');
  expect(navbarHidden()).toBe(false);
});
