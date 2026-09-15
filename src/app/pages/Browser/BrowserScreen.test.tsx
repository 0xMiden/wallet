import React from 'react';

import { render, screen } from '@testing-library/react';

import { PageActiveContext } from 'app/layouts/page-active';

import { BrowserScreen } from './BrowserScreen';

let mockMode: 'active' | 'launcher' = 'active';

jest.mock('app/providers/DappBrowserProvider', () => ({
  useDappBrowser: () => ({ mode: mockMode, open: jest.fn() })
}));
jest.mock('lib/dapp-browser', () => ({
  createDappSession: jest.fn(),
  getDappDisplayName: jest.fn(),
  recordRecentDapp: jest.fn()
}));
jest.mock('lib/platform', () => ({ isDesktop: () => false }));
jest.mock('./DappActive', () => {
  const ReactActual = jest.requireActual<typeof React>('react');
  return { DappActive: () => ReactActual.createElement('div', { 'data-testid': 'dapp-active' }) };
});
jest.mock('./DappLauncher', () => {
  const ReactActual = jest.requireActual<typeof React>('react');
  return { DappLauncher: () => ReactActual.createElement('div', { 'data-testid': 'dapp-launcher' }) };
});

const view = (onScreen: boolean) => (
  <PageActiveContext.Provider value={onScreen}>
    <BrowserScreen />
  </PageActiveContext.Provider>
);

beforeEach(() => {
  mockMode = 'active';
});

it('mounts the foreground dApp surface only while its page is on screen', () => {
  const { rerender } = render(view(true));
  expect(screen.queryByTestId('dapp-active')).not.toBeNull();

  // Off screen in a retained tab pane or under a slide page: the surface unmounts, which parks the dApp.
  rerender(view(false));
  expect(screen.queryByTestId('dapp-active')).toBeNull();

  rerender(view(true));
  expect(screen.queryByTestId('dapp-active')).not.toBeNull();
});

it('keeps the launcher mounted off screen when no dApp is in the foreground', () => {
  mockMode = 'launcher';
  const { rerender } = render(view(true));
  expect(screen.queryByTestId('dapp-launcher')).not.toBeNull();

  rerender(view(false));
  expect(screen.queryByTestId('dapp-launcher')).not.toBeNull();
});
