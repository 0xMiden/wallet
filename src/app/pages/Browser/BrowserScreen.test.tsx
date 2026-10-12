import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { openUrlInNewTab } from 'app/env';
import { PageActiveContext } from 'app/layouts/page-active';
import { createDappSession, getDappDisplayName, recordRecentDapp } from 'lib/dapp-browser';

import { BrowserScreen } from './BrowserScreen';

let mockMode: 'active' | 'launcher' = 'active';
let mockExtension = false;

jest.mock('app/env', () => ({ openUrlInNewTab: jest.fn() }));
jest.mock('app/providers/DappBrowserProvider', () => ({
  useDappBrowser: () => {
    // As the real hook does outside its provider, which only mobile mounts.
    if (mockExtension) throw new Error('useDappBrowser must be used inside <DappBrowserProvider>');
    return { mode: mockMode, open: jest.fn() };
  }
}));
jest.mock('lib/dapp-browser', () => ({
  createDappSession: jest.fn(),
  getDappDisplayName: jest.fn(),
  parseOrigin: (url: string) => new URL(url).origin,
  recordRecentDapp: jest.fn()
}));
jest.mock('lib/platform', () => ({ isDesktop: () => false, isExtension: () => mockExtension }));
jest.mock('./DappActive', () => {
  const ReactActual = jest.requireActual<typeof React>('react');
  return { DappActive: () => ReactActual.createElement('div', { 'data-testid': 'dapp-active' }) };
});
jest.mock('./DappLauncher', () => {
  const ReactActual = jest.requireActual<typeof React>('react');
  // The launcher's only contract with this screen is `onOpen`, so the stub exposes it: without a
  // handle here nothing can observe what BrowserScreen does with a URL it is handed.
  return {
    DappLauncher: ({ onOpen }: { onOpen: (url: string) => void }) =>
      ReactActual.createElement(
        'div',
        { 'data-testid': 'dapp-launcher' },
        ReactActual.createElement(
          'button',
          { 'data-testid': 'open-dapp', onClick: () => onOpen('https://example.dapp/app') },
          'dapp'
        ),
        ReactActual.createElement(
          'button',
          { 'data-testid': 'open-search', onClick: () => onOpen('https://duckduckgo.com/?q=nft%20games') },
          'search'
        )
      )
  };
});

const view = (onScreen: boolean) => (
  <PageActiveContext.Provider value={onScreen}>
    <BrowserScreen />
  </PageActiveContext.Provider>
);

beforeEach(() => {
  mockMode = 'active';
  mockExtension = false;
  (recordRecentDapp as jest.Mock).mockReset();
  (openUrlInNewTab as jest.Mock).mockReset();
});

// Recents is a list of dApps the user chose. A web search the launcher produced opens like any page
// but is not one of those, and this screen is one of its two writers.
it('records an opened dApp as a recent, and a web search never', () => {
  mockMode = 'launcher';
  (createDappSession as jest.Mock).mockImplementation((url: string) => ({
    url,
    origin: new URL(url).origin,
    favicon: undefined
  }));
  (getDappDisplayName as jest.Mock).mockReturnValue('Example');
  // The production call chains `.catch()`, so the stub has to be thenable.
  (recordRecentDapp as jest.Mock).mockResolvedValue(undefined);
  render(view(true));

  fireEvent.click(screen.getByTestId('open-dapp'));
  expect(recordRecentDapp).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.dapp/app' }));

  (recordRecentDapp as jest.Mock).mockClear();
  fireEvent.click(screen.getByTestId('open-search'));
  expect(recordRecentDapp).not.toHaveBeenCalled();
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

describe('on the extension', () => {
  beforeEach(() => {
    mockExtension = true;
    (getDappDisplayName as jest.Mock).mockReturnValue('example.dapp');
    (openUrlInNewTab as jest.Mock).mockResolvedValue(undefined);
  });

  it('shows the launcher without the embedded browser, even off screen', () => {
    const { rerender } = render(view(true));
    expect(screen.queryByTestId('dapp-launcher')).not.toBeNull();

    rerender(view(false));
    expect(screen.queryByTestId('dapp-launcher')).not.toBeNull();
  });

  // The new tab takes focus and closes the popup, which ends this script: a record still pending then is lost.
  it('records a picked dApp as a recent before it opens the dApp in a new tab', async () => {
    let finishRecord = () => {};
    (recordRecentDapp as jest.Mock).mockReturnValue(new Promise<void>(resolve => (finishRecord = resolve)));
    render(view(true));

    fireEvent.click(screen.getByTestId('open-dapp'));
    expect(recordRecentDapp).toHaveBeenCalledWith({
      url: 'https://example.dapp/app',
      name: 'example.dapp',
      origin: 'https://example.dapp'
    });
    await act(async () => {});
    expect(openUrlInNewTab).not.toHaveBeenCalled();

    await act(async () => finishRecord());
    expect(openUrlInNewTab).toHaveBeenCalledWith('https://example.dapp/app');
  });

  it('still opens the tab when the record fails', async () => {
    (recordRecentDapp as jest.Mock).mockRejectedValue(new Error('storage down'));
    render(view(true));

    await act(async () => fireEvent.click(screen.getByTestId('open-dapp')));
    expect(openUrlInNewTab).toHaveBeenCalledWith('https://example.dapp/app');
  });

  it('opens a web search in a new tab without recording it', async () => {
    render(view(true));

    await act(async () => fireEvent.click(screen.getByTestId('open-search')));
    expect(openUrlInNewTab).toHaveBeenCalledWith('https://duckduckgo.com/?q=nft%20games');
    expect(recordRecentDapp).not.toHaveBeenCalled();
  });
});
