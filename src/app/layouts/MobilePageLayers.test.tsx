import React, { useState } from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { pageSlideDim, pageSlideParallax, presets, reducedMotionTransition } from 'lib/animation';
import { setReturningFromWebview } from 'lib/mobile/webview-state';
import { HistoryAction } from 'lib/woozie/history';
import { LocationState, useLocation } from 'lib/woozie/location';

import FullScreenPage from './FullScreenPage';
import MobilePageLayers from './MobilePageLayers';
import { usePageActive, usePageOnScreen } from './page-active';

const mockMotion: { reduce: boolean; layers: Record<string, any> } = { reduce: false, layers: {} };

// The real framer-motion. motion.div also records the props each page layer last rendered with.
jest.mock('framer-motion', () => {
  const actual = jest.requireActual<typeof import('framer-motion')>('framer-motion');
  const R = require('react');
  const div = R.forwardRef((props: any, ref: any) => {
    if (props['data-page-layer']) mockMotion.layers[props['data-page-layer']] = props;
    return R.createElement(actual.motion.div, { ...props, ref });
  });
  const motion = new Proxy(actual.motion, { get: (target, key) => (key === 'div' ? div : Reflect.get(target, key)) });
  return { ...actual, motion, useReducedMotion: () => mockMotion.reduce };
});

function location(pathname: string, trigger = HistoryAction.Push): LocationState {
  return {
    pathname,
    search: '',
    hash: '',
    state: null,
    trigger,
    historyLength: 1,
    historyPosition: 0
  };
}

function Page() {
  const { pathname } = useLocation();
  const onScreen = usePageActive();
  const fullyOnScreen = usePageOnScreen();
  const [count, setCount] = useState(0);
  return (
    <button
      data-on-screen={String(onScreen)}
      data-fully-on-screen={String(fullyOnScreen)}
      onClick={() => setCount(count + 1)}
    >
      {`${pathname} count ${count}`}
    </button>
  );
}

function view(pathname: string, slide = false, key = pathname, trigger = HistoryAction.Push) {
  return (
    <MobilePageLayers location={location(pathname, trigger)} pageKey={key} slide={slide}>
      {slide ? (
        <FullScreenPage entrance="slide">
          <Page />
        </FullScreenPage>
      ) : (
        <Page />
      )}
    </MobilePageLayers>
  );
}

afterEach(() => {
  mockMotion.reduce = false;
  mockMotion.layers = {};
  setReturningFromWebview(false);
});

it('keeps the covered page mounted for as long as the slide page is present', async () => {
  const { container, rerender } = render(view('/history'));
  rerender(view('/settings', true));
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 600));
  });
  expect(container.querySelector('[data-page-layer="/history"]')).toBeInTheDocument();
  expect(container.querySelector('[data-page-layer="/settings"]')).toBeInTheDocument();
});

it('keeps the original page under the slide and reveals the same instance on pop', async () => {
  const { container, rerender } = render(view('/history'));
  fireEvent.click(screen.getByRole('button'));
  rerender(view('/history-details/one', true));

  const previous = container.querySelector('[data-page-layer="/history"]');
  expect(previous).toHaveTextContent('/history count 1');
  expect(previous).toHaveAttribute('inert');
  expect(previous).toHaveAttribute('aria-hidden', 'true');
  expect(previous).toHaveStyle({ zIndex: '1', pointerEvents: 'none' });
  expect(previous?.querySelector('button')).toHaveAttribute('data-on-screen', 'false');
  expect(screen.getByRole('button')).toHaveTextContent('/history-details/one count 0');
  expect(document.body).not.toHaveAttribute('data-hide-navbar');
  await waitFor(() => expect(document.body).toHaveAttribute('data-hide-navbar'));

  rerender(view('/history'));
  const revealed = container.querySelector('[data-page-layer="/history"]');
  expect(revealed).toBe(previous);
  expect(revealed).toHaveTextContent('/history count 1');
  expect(revealed).not.toHaveAttribute('inert');
  expect(revealed).toHaveStyle({ zIndex: '2', pointerEvents: 'auto' });
  expect(revealed?.querySelector('button')).toHaveAttribute('data-on-screen', 'true');
  expect(document.body).not.toHaveAttribute('data-hide-navbar');
  const leaving = container.querySelector('[data-page-layer="/history-details/one"]');
  expect(leaving).toHaveStyle({ zIndex: '3' });
  await waitFor(() => expect(leaving).not.toBeInTheDocument());
});

it('slides a popped slide page out instead of parking it under the page beneath', async () => {
  const { container, rerender } = render(view('/'));
  rerender(view('/settings', true));
  rerender(view('/settings/general', true));
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 600));
  });

  rerender(view('/settings', true));
  const popped = container.querySelector('[data-page-layer="/settings/general"]');
  expect(popped).toHaveStyle({ zIndex: '3' });
  const home = container.querySelector('[data-page-layer="/"]');
  expect(home).toHaveAttribute('inert');
  await waitFor(() => expect(popped).toHaveStyle({ transform: 'translateX(100%)' }));
  expect(home).toHaveStyle({ transform: 'translateX(-24%)' });
  const revealed = container.querySelector('[data-page-layer="/settings"]');
  expect(revealed).toHaveStyle({ zIndex: '2', pointerEvents: 'auto' });
  expect(revealed).not.toHaveAttribute('inert');
  expect(revealed).not.toHaveAttribute('aria-hidden');
  await waitFor(() => expect(revealed).toHaveStyle({ transform: 'none' }));
});

it('plays no Back animation on a push from a slide page to a plain page, and covers nothing after popping back', async () => {
  const { container, rerender } = render(view('/history'));
  rerender(view('/history-details/one', true));
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 600));
  });

  rerender(view('/pending-notes'));
  expect(container.querySelector('[data-page-layer="/pending-notes"]')).not.toHaveStyle({
    transform: 'translateX(-24%)'
  });
  expect(container.querySelector('[data-page-layer="/history-details/one"][style*="z-index: 3"]')).toBeNull();
  await waitFor(() =>
    expect(container.querySelector('[data-page-layer="/history-details/one"]')).not.toBeInTheDocument()
  );

  rerender(view('/history-details/one', true, '/history-details/one', HistoryAction.Pop));
  await waitFor(() => expect(container.querySelector('[data-page-layer="/pending-notes"]')).not.toBeInTheDocument());
  expect(container.querySelectorAll('[data-page-layer]')).toHaveLength(1);
});

it('keeps one tab layout when only the selected tab changes', () => {
  const { container, rerender } = render(view('/', false, 'tabs'));
  fireEvent.click(screen.getByRole('button'));
  rerender(view('/history', false, 'tabs'));
  expect(container.querySelectorAll('[data-page-layer]')).toHaveLength(1);
  expect(screen.getByRole('button')).toHaveTextContent('/history count 1');
});

it('keeps the active page in layout flow so fixed-height extension pages size the root', () => {
  const { container } = render(view('/pending-notes'));
  const stack = container.firstElementChild;
  const layer = container.querySelector('[data-page-layer="/pending-notes"]');

  expect(stack).toHaveClass('grid', 'h-full');
  expect(layer).toHaveClass('relative', 'col-start-1', 'row-start-1');
  expect(layer).not.toHaveClass('absolute');
});

it('removes all retained pages immediately when the layer owner unmounts', () => {
  const { container, rerender } = render(view('/history'));
  rerender(view('/settings', true));
  expect(container.querySelectorAll('[data-page-layer]')).toHaveLength(2);
  rerender(<div>Locked</div>);
  expect(container.querySelectorAll('[data-page-layer]')).toHaveLength(0);
  expect(document.body).not.toHaveAttribute('data-hide-navbar');
});

it('cleans up when back navigation interrupts a slide', async () => {
  const { container, rerender } = render(view('/history'));
  rerender(view('/settings', true));
  rerender(view('/history'));
  await waitFor(() => expect(container.querySelectorAll('[data-page-layer]')).toHaveLength(1));
  expect(screen.getByRole('button')).toHaveTextContent('/history count 0');
  expect(document.body).not.toHaveAttribute('data-hide-navbar');
});

it.each(['reduced motion', 'webview return'])('skips retention for %s', async mode => {
  const { container, rerender } = render(view('/history'));
  mockMotion.reduce = mode === 'reduced motion';
  setReturningFromWebview(mode === 'webview return');
  rerender(view('/settings', true));
  await waitFor(() => expect(container.querySelectorAll('[data-page-layer]')).toHaveLength(1));
  expect(screen.getByRole('button')).toHaveTextContent('/settings count 0');
});

it('moves the layers on the page preset: the covered page to the parallax offset under the dim', async () => {
  const { container, rerender } = render(view('/history'));
  rerender(view('/settings', true));

  const covered = mockMotion.layers['/history'];
  expect(covered.animate).toEqual({ x: pageSlideParallax });
  expect(covered.transition).toBe(presets.page.transition);
  expect(mockMotion.layers['/settings'].transition).toBe(presets.page.transition);

  const dim = container.querySelector('[data-page-layer="/history"] > [aria-hidden]:last-child');
  await waitFor(() => expect(dim).toHaveStyle({ opacity: String(pageSlideDim) }));
});

it('slides a popped page out to the page preset exit and brings the page beneath back from the parallax offset', () => {
  const { rerender } = render(view('/history'));
  rerender(view('/history-details/one', true));
  rerender(view('/history', false, '/history', HistoryAction.Pop));

  expect(mockMotion.layers['/history-details/one'].animate).toEqual(presets.page.exit);
  expect(mockMotion.layers['/history'].animate).toEqual(presets.page.animate);
  expect(mockMotion.layers['/history'].transition).toBe(presets.page.transition);
});

it('makes the layer transition instant under reduced motion', () => {
  mockMotion.reduce = true;
  render(view('/settings', true));
  expect(mockMotion.layers['/settings'].transition).toEqual(reducedMotionTransition);
});

it('reports a covered page off screen at once, and a revealed one on screen only after the slide page has gone', async () => {
  const { container, rerender } = render(view('/history'));
  const button = () => container.querySelector('[data-page-layer="/history"] button');
  expect(button()).toHaveAttribute('data-fully-on-screen', 'true');

  rerender(view('/history-details/one', true));
  expect(button()).toHaveAttribute('data-fully-on-screen', 'false');
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 600));
  });

  rerender(view('/history'));
  const leaving = container.querySelector('[data-page-layer="/history-details/one"]');
  expect(leaving).toHaveStyle({ zIndex: '3' });
  // Present already (so polls resume), but the slide page still covers it.
  expect(button()).toHaveAttribute('data-on-screen', 'true');
  expect(button()).toHaveAttribute('data-fully-on-screen', 'false');
  await waitFor(() => expect(leaving).not.toBeInTheDocument());
  await waitFor(() => expect(button()).toHaveAttribute('data-fully-on-screen', 'true'));
});

it('reports a page fully on screen at once under reduced motion', () => {
  mockMotion.reduce = true;
  const { container, rerender } = render(view('/history'));
  rerender(view('/settings', true));
  rerender(view('/history'));
  expect(container.querySelector('[data-page-layer="/history"] button')).toHaveAttribute(
    'data-fully-on-screen',
    'true'
  );
});

it('keeps a slide page revealed by a slide-to-slide pop off screen until the popped page has gone', async () => {
  const { container, rerender } = render(view('/settings', true));
  rerender(view('/settings/general', true));
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 600));
  });

  rerender(view('/settings', true));
  const popped = container.querySelector('[data-page-layer="/settings/general"]');
  const settings = () => container.querySelector('[data-page-layer="/settings"] button');
  expect(popped).toHaveStyle({ zIndex: '3' });
  expect(settings()).toHaveAttribute('data-fully-on-screen', 'false');
  await waitFor(() => expect(popped).not.toBeInTheDocument());
  await waitFor(() => expect(settings()).toHaveAttribute('data-fully-on-screen', 'true'));
});

it('reports a page nothing covered on screen at once when it is returned to', () => {
  const { container, rerender } = render(view('/history'));
  rerender(view('/receive'));
  rerender(view('/history', false, '/history', HistoryAction.Pop));
  expect(container.querySelector('[data-page-layer="/history"] button')).toHaveAttribute(
    'data-fully-on-screen',
    'true'
  );
});

it('keeps a freshly mounted page off screen through its reveal after the stack was released', async () => {
  const { container, rerender } = render(view('/history'));
  rerender(view('/settings', true));
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 600));
  });
  rerender(view('/receive'));
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 600));
  });
  rerender(view('/settings', true, '/settings', HistoryAction.Pop));
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 600));
  });

  rerender(view('/history', false, '/history', HistoryAction.Pop));
  const leaving = container.querySelector('[data-page-layer="/settings"]');
  const history = () => container.querySelector('[data-page-layer="/history"] button');
  expect(leaving).toHaveStyle({ zIndex: '3' });
  expect(history()).toHaveAttribute('data-fully-on-screen', 'false');
  await waitFor(() => expect(leaving).not.toBeInTheDocument());
  await waitFor(() => expect(history()).toHaveAttribute('data-fully-on-screen', 'true'));
});
