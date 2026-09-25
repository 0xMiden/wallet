import React from 'react';

import { render, screen, waitFor } from '@testing-library/react';

import { presets, reducedMotionTransition } from 'lib/animation';

import FullScreenPage from './FullScreenPage';
import { PageMountedByReturnContext } from './page-active';

const mockMotion: { reduce: boolean; props: Record<string, any> | null } = { reduce: false, props: null };

let mockIsMobile = true;
jest.mock('lib/platform', () => ({ isMobile: () => mockIsMobile }));

let mockReturningFromWebview = false;
jest.mock('lib/mobile/webview-state', () => ({ isReturningFromWebview: () => mockReturningFromWebview }));

// The real motion.div, which also records the props it was last rendered with.
jest.mock('framer-motion', () => {
  const actual = jest.requireActual<typeof import('framer-motion')>('framer-motion');
  const R = require('react');
  const div = R.forwardRef((props: any, ref: any) => {
    mockMotion.props = props;
    return R.createElement(actual.motion.div, { ...props, ref });
  });
  return { ...actual, motion: { div }, useReducedMotion: () => mockMotion.reduce };
});

afterEach(() => {
  mockMotion.reduce = false;
  mockMotion.props = null;
  mockIsMobile = true;
  mockReturningFromWebview = false;
});

it('slides in by default on mobile', () => {
  const { container } = render(<FullScreenPage>Page</FullScreenPage>);
  expect(container.firstElementChild).toHaveStyle({ transform: 'translateX(100%)' });
});

it('keeps the fade by default off mobile, so an unfinished entrance never parks the page off screen', () => {
  mockIsMobile = false;
  const { container } = render(<FullScreenPage>Page</FullScreenPage>);
  expect(container.firstElementChild).not.toHaveStyle({ transform: 'translateX(100%)' });
});

it('shows a fade page and releases the navbar when the page unmounts', () => {
  const { unmount } = render(
    <FullScreenPage entrance="fade">
      <span>Page content</span>
    </FullScreenPage>
  );

  expect(screen.getByText('Page content')).toBeInTheDocument();
  expect(document.body).toHaveAttribute('data-hide-navbar');
  unmount();
  expect(document.body).not.toHaveAttribute('data-hide-navbar');
});

it('brings a slide page in from the right without vertical movement', async () => {
  const { container } = render(<FullScreenPage entrance="slide">Settings</FullScreenPage>);
  const page = container.firstElementChild;
  expect(page).toHaveStyle({ transform: 'translateX(100%)', opacity: '1' });
  await waitFor(() => expect(page).toHaveStyle({ transform: 'none' }));
});

it('shows a slide page immediately when reduced motion is enabled', () => {
  mockMotion.reduce = true;
  const { container } = render(<FullScreenPage entrance="slide">Settings</FullScreenPage>);
  expect(container.firstElementChild).toHaveStyle({ opacity: '1' });
  expect(container.firstElementChild).not.toHaveStyle({ transform: 'translateX(100%)' });
});

it('slides a page in on the page preset: from its initial x, on its transition', () => {
  render(<FullScreenPage entrance="slide">Settings</FullScreenPage>);
  expect(mockMotion.props?.initial).toEqual({ ...presets.page.initial, opacity: 1 });
  expect(mockMotion.props?.animate).toEqual({ ...presets.page.animate, opacity: 1 });
  expect(mockMotion.props?.transition).toBe(presets.page.transition);
});

it('fades a page in on the fade preset', async () => {
  mockIsMobile = false;
  const { container } = render(<FullScreenPage>Page</FullScreenPage>);
  expect(mockMotion.props?.initial).toEqual(presets.fade.initial);
  expect(mockMotion.props?.animate).toEqual(presets.fade.animate);
  expect(mockMotion.props?.transition).toBe(presets.fade.transition);
  expect(container.firstElementChild).toHaveStyle({ opacity: '0' });
  await waitFor(() => expect(container.firstElementChild).toHaveStyle({ opacity: '1' }));
});

it.each(['slide', 'fade'] as const)('makes a %s page instant under reduced motion', entrance => {
  mockMotion.reduce = true;
  const { container } = render(<FullScreenPage entrance={entrance}>Page</FullScreenPage>);
  expect(mockMotion.props?.initial).toBe(false);
  expect(mockMotion.props?.transition).toEqual(reducedMotionTransition);
  expect(container.firstElementChild).toHaveStyle({ opacity: '1' });
});

it('runs a slide page that cannot slide (back from a webview) on the fade preset, not the page one', () => {
  mockReturningFromWebview = true;
  const { container } = render(<FullScreenPage entrance="slide">Page</FullScreenPage>);
  expect(mockMotion.props?.initial).toBe(false);
  expect(mockMotion.props?.animate).toEqual(presets.fade.animate);
  expect(mockMotion.props?.transition).toBe(presets.fade.transition);
  expect(container.firstElementChild).not.toHaveStyle({ transform: 'translateX(100%)' });
});

it('plays no entrance of its own when a return mounted its layer, and hides the navbar at once', () => {
  const { container } = render(
    <PageMountedByReturnContext.Provider value={true}>
      <FullScreenPage entrance="slide">Settings</FullScreenPage>
    </PageMountedByReturnContext.Provider>
  );
  expect(container.firstElementChild).not.toHaveStyle({ transform: 'translateX(100%)' });
  expect(document.body).toHaveAttribute('data-hide-navbar');
});
