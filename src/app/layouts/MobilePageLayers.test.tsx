import React, { useState } from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { setReturningFromWebview } from 'lib/mobile/webview-state';
import { HistoryAction } from 'lib/woozie/history';
import { LocationState, useLocation } from 'lib/woozie/location';

import FullScreenPage from './FullScreenPage';
import MobilePageLayers, { usePageSlideComplete } from './MobilePageLayers';

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

function ControlledSlide() {
  const complete = usePageSlideComplete();
  return <button onClick={complete}>Complete slide</button>;
}

it('waits for the incoming completion signal even when the slide takes longer', async () => {
  const { container, rerender } = render(view('/history'));
  rerender(
    <MobilePageLayers location={location('/settings')} pageKey="/settings" slide>
      <ControlledSlide />
    </MobilePageLayers>
  );
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 400));
  });
  expect(container.querySelector('[data-page-layer="/history"]')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Complete slide' }));
  await waitFor(() => expect(container.querySelector('[data-page-layer="/history"]')).not.toBeInTheDocument());
});

it('keeps the original page under the slide, then releases it', async () => {
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

  await waitFor(() => expect(previous).not.toBeInTheDocument());
  await waitFor(() => expect(document.body).toHaveAttribute('data-hide-navbar'));
});

it('keeps one tab layout when only the selected tab changes', () => {
  const { container, rerender } = render(view('/', false, 'tabs'));
  fireEvent.click(screen.getByRole('button'));
  rerender(view('/history', false, 'tabs'));
  expect(container.querySelectorAll('[data-page-layer]')).toHaveLength(1);
  expect(screen.getByRole('button')).toHaveTextContent('/history count 1');
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
