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

// Long enough for every page transition to finish.
const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 600));
  });

afterEach(() => {
  mockMotion.reduce = false;
  mockMotion.layers = {};
  setReturningFromWebview(false);
});

it('keeps the covered page mounted for as long as the slide page is present', async () => {
  const { container, rerender } = render(view('/history'));
  rerender(view('/settings', true));
  await settle();
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
  await settle();

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
  await settle();

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

it('skips retention for reduced motion', async () => {
  const { container, rerender } = render(view('/history'));
  mockMotion.reduce = true;
  rerender(view('/settings', true));
  await waitFor(() => expect(container.querySelectorAll('[data-page-layer]')).toHaveLength(1));
  expect(screen.getByRole('button')).toHaveTextContent('/settings count 0');
});

it('keeps the page beneath on a webview return, without animating it', async () => {
  const { container, rerender } = render(view('/history'));
  setReturningFromWebview(true);
  rerender(view('/settings', true));
  await act(async () => undefined);
  expect(container.querySelectorAll('[data-page-layer]')).toHaveLength(2);
  expect(mockMotion.layers['/history'].transition).toEqual(reducedMotionTransition);
});

it('keeps a covered page through a re-render inside the webview-return window', async () => {
  const { container, rerender } = render(view('/settings', false, 'tabs'));
  fireEvent.click(screen.getByRole('button', { name: '/settings count 0' }));
  rerender(view('/a', true));
  await settle();
  const root = container.querySelector('[data-page-layer="/settings"]');
  setReturningFromWebview(true);
  rerender(view('/a', true));
  setReturningFromWebview(false);

  rerender(view('/settings', false, 'tabs', HistoryAction.Pop));
  // The window has closed: the popped page slides out although its last render was inside it.
  const popped = container.querySelector('[data-page-layer="/a"]');
  expect(popped).toHaveStyle({ zIndex: '3' });
  await settle();
  expect(popped).not.toBeInTheDocument();
  expect(container.querySelector('[data-page-layer="/settings"]')).toBe(root);
  expect(screen.getByRole('button')).toHaveTextContent('/settings count 1');
});

it('drops a popped page at once on a Back inside the webview-return window', async () => {
  const { container, rerender } = render(view('/settings', false, 'tabs'));
  rerender(view('/a', true));
  await settle();
  setReturningFromWebview(true);
  rerender(view('/settings', false, 'tabs', HistoryAction.Pop));
  await act(async () => undefined);
  expect(container.querySelector('[data-page-layer="/a"]')).not.toBeInTheDocument();
});

it('does not animate a Back inside the webview-return window', async () => {
  const { rerender } = render(view('/history'));
  rerender(view('/settings', true));
  await settle();
  setReturningFromWebview(true);
  rerender(view('/settings', true));
  rerender(view('/history', false, '/history', HistoryAction.Pop));
  expect(mockMotion.layers['/history'].transition).toEqual(reducedMotionTransition);
});

it('covers the page beneath when a push returns to a slide page that was popped earlier', async () => {
  const { container, rerender } = render(view('/settings', false, 'tabs'));
  rerender(view('/settings/guardian', true));
  await settle();
  rerender(view('/rotate-guardian', true));
  await settle();
  fireEvent.click(screen.getByRole('button', { name: '/rotate-guardian count 0' }));

  // Back to Guardian Settings. The covered root keeps the popped page mounted, off screen.
  rerender(view('/settings/guardian', true, '/settings/guardian', HistoryAction.Pop));
  await settle();
  // The popped page has finished sliding out, so it leaves the DOM rather than waiting on the covered root.
  await waitFor(() => expect(container.querySelector('[data-page-layer="/rotate-guardian"]')).not.toBeInTheDocument());

  // Rotate again. Guardian Settings is covered, not slid out as if the push were a Back.
  rerender(view('/rotate-guardian', true));
  const guardian = container.querySelector('[data-page-layer="/settings/guardian"]');
  expect(guardian).toHaveStyle({ zIndex: '1' });
  await settle();
  expect(guardian).toBeInTheDocument();
  expect(guardian).toHaveStyle({ transform: 'translateX(-24%)' });

  // The page opens fresh, and it is the only present layer.
  expect(screen.getByRole('button')).toHaveTextContent('/rotate-guardian count 0');
  expect(container.querySelector('[data-page-layer="/rotate-guardian"]')).toHaveStyle({ transform: 'none' });
}, 15_000);

it('drops a popped copy still sliding out at once when its page is pushed again, leaving one copy', async () => {
  // A reload lands on the sub-page itself, with nothing beneath it.
  const { container, rerender } = render(view('/settings/general', true));
  await settle();
  // Back home and into Settings before the popped page has finished sliding out.
  rerender(view('/', false, 'tabs', HistoryAction.Pop));
  rerender(view('/settings', true, '/settings', HistoryAction.Pop));
  // Open the sub-page again: Settings is now covered and waits under it. The popped copy, still
  // sliding out, goes at once rather than sitting in the DOM beside the new one.
  rerender(view('/settings/general', true));
  expect(container.querySelectorAll('[data-page-layer="/settings/general"]')).toHaveLength(1);
  await settle();

  const copies = container.querySelectorAll('[data-page-layer="/settings/general"]');
  expect(copies).toHaveLength(1);
  expect(copies[0]).not.toHaveAttribute('aria-hidden');
  expect(copies[0]).toHaveTextContent('/settings/general count 0');
  expect(container.querySelector('[data-page-layer="/"]')).not.toBeInTheDocument();
  expect(container.querySelector('[data-page-layer="/settings"]')).toHaveStyle({ transform: 'translateX(-24%)' });
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
  await settle();

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
  await settle();

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
  await settle();
  rerender(view('/receive'));
  await settle();
  rerender(view('/settings', true, '/settings', HistoryAction.Pop));
  await settle();

  rerender(view('/history', false, '/history', HistoryAction.Pop));
  const leaving = container.querySelector('[data-page-layer="/settings"]');
  const history = () => container.querySelector('[data-page-layer="/history"] button');
  expect(leaving).toHaveStyle({ zIndex: '3' });
  expect(history()).toHaveAttribute('data-fully-on-screen', 'false');
  await waitFor(() => expect(leaving).not.toBeInTheDocument());
  await waitFor(() => expect(history()).toHaveAttribute('data-fully-on-screen', 'true'));
});

it('covers the page beneath when a push reopens a page a Replace left under it', async () => {
  // A cold open has no history to go back through, so Back replaces to the parent and the page it
  // left stays covered beneath. Reopening it is a push, not a return.
  const { container, rerender } = render(view('/rotate-guardian/review', true));
  await settle();
  fireEvent.click(screen.getByRole('button', { name: '/rotate-guardian/review count 0' }));
  rerender(view('/rotate-guardian', true, '/rotate-guardian', HistoryAction.Replace));
  await settle();

  rerender(view('/rotate-guardian/review', true));
  const parent = container.querySelector('[data-page-layer="/rotate-guardian"]');
  await settle();
  expect(parent).toBeInTheDocument();
  expect(parent).toHaveStyle({ transform: 'translateX(-24%)' });
  expect(screen.getByRole('button')).toHaveTextContent('/rotate-guardian/review count 0');
});

it('covers the page beneath when a push reopens a page a return skipped over', async () => {
  const { container, rerender } = render(view('/settings', false, 'tabs'));
  rerender(view('/a', true));
  await settle();
  rerender(view('/b', true));
  await settle();
  fireEvent.click(screen.getByRole('button', { name: '/b count 0' }));
  rerender(view('/c', true));
  await settle();
  // C closes to A, which is mounted beneath: a return that leaves B behind it.
  rerender(view('/a', true));
  await settle();

  rerender(view('/b', true));
  const a = container.querySelector('[data-page-layer="/a"]');
  await settle();
  expect(a).toHaveStyle({ transform: 'translateX(-24%)' });
  expect(screen.getByRole('button')).toHaveTextContent('/b count 0');
}, 15_000);

it('still reveals the retained pages a return skipped over when the router pops back to them', async () => {
  const { container, rerender } = render(view('/settings', false, 'tabs'));
  const root = container.querySelector('[data-page-layer="/settings"]');
  rerender(view('/a', true));
  await settle();
  rerender(view('/b', true));
  await settle();
  fireEvent.click(screen.getByRole('button', { name: '/b count 0' }));
  const b = container.querySelector('[data-page-layer="/b"]');
  rerender(view('/c', true));
  await settle();
  rerender(view('/a', true));
  await settle();

  rerender(view('/c', true, '/c', HistoryAction.Pop));
  await settle();
  rerender(view('/b', true, '/b', HistoryAction.Pop));
  expect(container.querySelector('[data-page-layer="/b"]')).toBe(b);
  await settle();
  expect(screen.getByRole('button')).toHaveTextContent('/b count 1');

  rerender(view('/a', true, '/a', HistoryAction.Pop));
  await settle();
  rerender(view('/settings', false, 'tabs', HistoryAction.Pop));
  await settle();
  expect(container.querySelector('[data-page-layer="/settings"]')).toBe(root);
}, 15_000);

it('still reveals a page a Replace left under the stack when the router pops back to it', async () => {
  const { rerender } = render(view('/settings', false, 'tabs'));
  rerender(view('/r', true));
  await settle();
  fireEvent.click(screen.getByRole('button', { name: '/r count 0' }));
  rerender(view('/g', true));
  await settle();
  rerender(view('/r', true));
  await settle();
  rerender(view('/x', true, '/x', HistoryAction.Replace));
  await settle();

  rerender(view('/g', true, '/g', HistoryAction.Pop));
  await settle();
  rerender(view('/r', true, '/r', HistoryAction.Pop));
  await settle();
  expect(screen.getByRole('button')).toHaveTextContent('/r count 1');
}, 15_000);

it('reports a page on screen when a push brings back a layer that went while covered', async () => {
  const { container, rerender } = render(view('/settings', false, 'tabs'));
  rerender(view('/a', true));
  await settle();
  rerender(view('/b', true));
  await settle();
  // B closes to the tabs: A goes at once, but AnimatePresence holds it until B has slid out.
  rerender(view('/settings', false, 'tabs'));
  rerender(view('/a', true));
  await settle();
  expect(container.querySelector('[data-page-layer="/a"] button')).toHaveAttribute('data-fully-on-screen', 'true');
});

it('reports a page on screen when it comes back after being covered again while gone', async () => {
  const { container, rerender } = render(view('/settings', false, 'tabs'));
  rerender(view('/a', true));
  await settle();
  rerender(view('/b', true));
  await settle();
  rerender(view('/settings', false, 'tabs'));
  rerender(view('/c', true));
  await settle();
  rerender(view('/a', true));
  await settle();
  expect(container.querySelector('[data-page-layer="/a"] button')).toHaveAttribute('data-fully-on-screen', 'true');
}, 15_000);

// The page content's own element: the first child of its layer.
const contentOf = (container: HTMLElement, pathname: string) =>
  container.querySelector(`[data-page-layer="${pathname}"]`)?.firstElementChild;

it('reveals a slide page a Pop returns to whose layer was released, once the popped page has gone', async () => {
  const { container, rerender } = render(view('/settings', false, 'tabs'));
  rerender(view('/s1', true));
  await settle();
  rerender(view('/s2', true));
  await settle();
  rerender(view('/p'));
  await settle();
  rerender(view('/s2', true, '/s2', HistoryAction.Pop));
  await settle();

  rerender(view('/s1', true, '/s1', HistoryAction.Pop));
  const s1 = () => container.querySelector('[data-page-layer="/s1"] button');
  expect(container.querySelector('[data-page-layer="/s1"]')).toHaveStyle({ transform: 'translateX(-24%)' });
  expect(container.querySelector('[data-page-layer="/s2"]')).toBeInTheDocument();
  expect(s1()).toHaveAttribute('data-fully-on-screen', 'false');
  await waitFor(() => expect(container.querySelector('[data-page-layer="/s2"]')).not.toBeInTheDocument());
  await waitFor(() => expect(s1()).toHaveAttribute('data-fully-on-screen', 'true'));
}, 15_000);

it('plays no push slide-in for a page a Pop brings back while its layer is still held', async () => {
  const { container, rerender } = render(view('/settings', false, 'tabs'));
  rerender(view('/a', true));
  await settle();
  rerender(view('/b', true));
  await settle();
  // B closes to the tabs; A goes at once but is held until B has slid out.
  rerender(view('/settings', false, 'tabs'));
  rerender(view('/a', true, '/a', HistoryAction.Pop));
  expect(contentOf(container, '/a')).not.toHaveStyle({ transform: 'translateX(100%)' });
});

it('plays the push slide-in for a page first mounted by a return and later pushed back while held', async () => {
  const { container, rerender } = render(view('/settings', false, 'tabs'));
  rerender(view('/x', true));
  await settle();
  rerender(view('/a', true, '/a', HistoryAction.Pop));
  await settle();
  rerender(view('/b', true));
  await settle();
  rerender(view('/settings', false, 'tabs'));
  rerender(view('/a', true));
  expect(contentOf(container, '/a')).toHaveStyle({ transform: 'translateX(100%)' });
}, 15_000);

it('keeps the stack beneath when the router pops to a page outside it', async () => {
  const { container, rerender } = render(view('/settings', false, 'tabs'));
  const root = container.querySelector('[data-page-layer="/settings"]');
  rerender(view('/a', true));
  await settle();
  rerender(view('/b', true));
  await settle();
  rerender(view('/c', true));
  await settle();
  rerender(view('/a', true));
  await settle();
  rerender(view('/c', true, '/c', HistoryAction.Pop));
  await settle();
  rerender(view('/b', true, '/b', HistoryAction.Pop));
  await settle();

  // A close from B to the tabs root, which is still in the stack beneath: a return.
  rerender(view('/settings', false, 'tabs'));
  expect(container.querySelector('[data-page-layer="/b"]')).toHaveStyle({ zIndex: '3' });
  await settle();
  expect(container.querySelector('[data-page-layer="/settings"]')).toBe(root);
}, 15_000);
