import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { openUrlInNewTab } from 'app/env';
import { PageActiveContext } from 'app/layouts/page-active';
import { createDappSession, getDappDisplayName, recordRecentDapp } from 'lib/dapp-browser';

import { BrowserScreen } from './BrowserScreen';

let mockMode: 'active' | 'launcher' = 'active';
let mockExtension = false;
let mockPolicyPending = false;
const mockLauncherCommit = jest.fn();
const mockLauncherFeedback = React.createContext<((active: boolean) => void) | null>(null);

jest.mock('app/env', () => ({ openUrlInNewTab: jest.fn() }));
jest.mock('app/providers/DappBrowserProvider', () => ({
  useDappBrowser: () => {
    const ReactActual = jest.requireActual<typeof React>('react');
    const reportLauncherCommit = ReactActual.useContext(mockLauncherFeedback) ?? mockLauncherCommit;
    // As the real hook does outside its provider, which only mobile mounts.
    if (mockExtension) throw new Error('useDappBrowser must be used inside <DappBrowserProvider>');
    return {
      mode: mockMode,
      open: jest.fn(),
      policyPending: mockPolicyPending,
      reportLauncherCommit
    };
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
  mockPolicyPending = false;
  mockLauncherCommit.mockClear();
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

it('retains the launcher during policy discovery without reporting a close destination', () => {
  mockPolicyPending = true;
  const { rerender } = render(view(true));
  const launcher = screen.getByTestId('dapp-launcher');
  const active = screen.getByTestId('dapp-active');
  expect(launcher).toBeVisible();
  expect(mockLauncherCommit).toHaveBeenLastCalledWith(false);
  mockPolicyPending = false;
  rerender(view(true));
  expect(screen.getByTestId('dapp-active')).toBe(active);
  expect(screen.getByTestId('dapp-launcher')).toBe(launcher);
  expect(launcher).not.toBeVisible();
});

describe('launcher destination receipts', () => {
  const FeedbackParent = ({ onReport }: { onReport: (active: boolean) => void }) => {
    const [committed, setCommitted] = React.useState(false);
    const reportLauncherCommit = React.useCallback(
      (active: boolean) => {
        onReport(active);
        setCommitted(active);
      },
      [onReport]
    );
    return (
      <mockLauncherFeedback.Provider value={reportLauncherCommit}>
        <output data-testid="launcher-destination">{committed ? 'committed' : 'withdrawn'}</output>
        {view(true)}
      </mockLauncherFeedback.Provider>
    );
  };

  it('settles parent state feedback without a maximum-depth error', () => {
    mockMode = 'launcher';
    const onReport = jest.fn();
    expect(() => render(<FeedbackParent onReport={onReport} />)).not.toThrow();
    expect(screen.getByTestId('launcher-destination')).toHaveTextContent('committed');
    expect(screen.getByTestId('dapp-launcher')).toBeVisible();
  });

  it('does not withdraw a mounted launcher destination during parent state feedback', () => {
    mockMode = 'launcher';
    const reports: { active: boolean; launcherConnected: boolean }[] = [];
    const onReport = (active: boolean) => {
      reports.push({ active, launcherConnected: screen.queryByTestId('dapp-launcher')?.isConnected ?? false });
    };
    render(<FeedbackParent onReport={onReport} />);
    expect(screen.getByTestId('launcher-destination')).toHaveTextContent('committed');
    expect(reports.filter(report => !report.active && report.launcherConnected)).toEqual([]);
  });

  it('does not withdraw the destination when its retained launcher rerenders unchanged', () => {
    mockMode = 'launcher';
    const { rerender } = render(view(true));
    const launcher = screen.getByTestId('dapp-launcher');
    mockLauncherCommit.mockClear();
    rerender(view(true));
    expect(screen.getByTestId('dapp-launcher')).toBe(launcher);
    expect(launcher).toBeVisible();
    expect(mockLauncherCommit).not.toHaveBeenCalledWith(false);
  });

  it('withdraws the destination while its retained page is off screen and restores it on return', () => {
    mockMode = 'launcher';
    const { rerender } = render(view(true));
    const launcher = screen.getByTestId('dapp-launcher');
    expect(mockLauncherCommit).toHaveBeenLastCalledWith(true);
    rerender(view(false));
    expect(screen.getByTestId('dapp-launcher')).toBe(launcher);
    expect(mockLauncherCommit).toHaveBeenLastCalledWith(false);
    rerender(view(true));
    expect(screen.getByTestId('dapp-launcher')).toBe(launcher);
    expect(mockLauncherCommit).toHaveBeenLastCalledWith(true);
  });

  it('withdraws the destination for an active dApp and restores the same launcher when it closes', () => {
    mockMode = 'launcher';
    const { rerender } = render(view(true));
    const launcher = screen.getByTestId('dapp-launcher');
    expect(mockLauncherCommit).toHaveBeenLastCalledWith(true);
    mockMode = 'active';
    rerender(view(true));
    expect(launcher).not.toBeVisible();
    expect(mockLauncherCommit).toHaveBeenLastCalledWith(false);
    mockMode = 'launcher';
    rerender(view(true));
    expect(screen.getByTestId('dapp-launcher')).toBe(launcher);
    expect(launcher).toBeVisible();
    expect(mockLauncherCommit).toHaveBeenLastCalledWith(true);
  });

  it('withdraws the destination when the browser screen actually unmounts', () => {
    mockMode = 'launcher';
    const { unmount } = render(view(true));
    const launcher = screen.getByTestId('dapp-launcher');
    expect(mockLauncherCommit).toHaveBeenLastCalledWith(true);
    mockLauncherCommit.mockClear();
    unmount();
    expect(launcher).not.toBeInTheDocument();
    expect(mockLauncherCommit).toHaveBeenLastCalledWith(false);
  });
});
