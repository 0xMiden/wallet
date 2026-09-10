import React, { useState } from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { setReturningFromWebview } from 'lib/mobile/webview-state';
import { HistoryAction } from 'lib/woozie/history';
import { LocationState, useLocation } from 'lib/woozie/location';

import FullScreenPage from './FullScreenPage';
import MobilePageLayers from './MobilePageLayers';

const mockMotion = { reduce: false };

jest.mock('lib/platform', () => ({ isMobile: () => true }));
jest.mock('framer-motion', () => {
  const actual = jest.requireActual<typeof import('framer-motion')>('framer-motion');
  return { ...actual, useReducedMotion: () => mockMotion.reduce };
});

function location(pathname: string): LocationState {
  return {
    pathname,
    search: '',
    hash: '',
    state: null,
    trigger: HistoryAction.Push,
    historyLength: 1,
    historyPosition: 0
  };
}

function Page() {
  const { pathname } = useLocation();
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>{`${pathname} count ${count}`}</button>;
}

function view(pathname: string, slide = false, key = pathname) {
  return (
    <MobilePageLayers location={location(pathname)} pageKey={key} slide={slide}>
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
  expect(screen.getByRole('button')).toHaveTextContent('/history-details/one count 0');
  expect(document.body).not.toHaveAttribute('data-hide-navbar');
  await waitFor(() => expect(document.body).toHaveAttribute('data-hide-navbar'));

  rerender(view('/history'));
  const revealed = container.querySelector('[data-page-layer="/history"]');
  expect(revealed).toBe(previous);
  expect(revealed).toHaveTextContent('/history count 1');
  expect(revealed).not.toHaveAttribute('inert');
  expect(revealed).toHaveStyle({ zIndex: '2', pointerEvents: 'auto' });
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
  expect(container.querySelector('[data-page-layer="/settings"]')).toHaveStyle({ zIndex: '2' });
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
