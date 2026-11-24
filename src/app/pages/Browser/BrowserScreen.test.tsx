import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { openUrlInNewTab } from 'app/env';
import { PageActiveContext } from 'app/layouts/page-active';
import { createDappSession, getDappDisplayName, recordRecentDapp } from 'lib/dapp-browser';

import { BrowserScreen } from './BrowserScreen';

let mockMode: 'active' | 'launcher' = 'active';
let mockExtension = false;
let mockPolicyPending = false;
type Motion = {
  id: string;
  target: 'collapsed' | 'expanded';
  morphId?: string;
  started?: boolean;
  acknowledging?: boolean;
  tracking?: boolean;
  progress?: number;
  velocity?: number;
  eventSeq?: number;
};
let mockMotion: Motion | null = null;
const mockStopCompanions = jest.fn();
const mockStartCompanions = jest.fn((..._args: unknown[]) => mockStopCompanions);
let mockSession: { id: string } | null = { id: 's1' };
const mockLauncherCommit = jest.fn();

jest.mock('app/env', () => ({ openUrlInNewTab: jest.fn() }));
jest.mock('app/providers/DappBrowserProvider', () => ({
  useDappBrowser: () => {
    // As the real hook does outside its provider, which only mobile mounts.
    if (mockExtension) throw new Error('useDappBrowser must be used inside <DappBrowserProvider>');
    return {
      mode: mockMode,
      open: jest.fn(),
      policyPending: mockPolicyPending,
      reportLauncherCommit: mockLauncherCommit,
      motion: mockMotion,
      session: mockSession
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
jest.mock('./morph-companions', () => ({ startMorphCompanions: (...args: unknown[]) => mockStartCompanions(...args) }));
jest.mock('./DappActive', () => {
  const ReactActual = jest.requireActual<typeof React>('react');
  return {
    DappActive: ({ capsuleRef }: { capsuleRef?: React.Ref<HTMLDivElement> }) =>
      ReactActual.createElement('div', { 'data-testid': 'dapp-active', ref: capsuleRef })
  };
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

// jsdom has no Web Animations; the screen asks the companions' elements for theirs when a finger holds the page.
const hasGetAnimations = 'getAnimations' in HTMLElement.prototype;

beforeEach(() => {
  if (!hasGetAnimations)
    Object.defineProperty(HTMLElement.prototype, 'getAnimations', { configurable: true, value: () => [] });
  mockMode = 'active';
  mockPolicyPending = false;
  mockMotion = null;
  mockSession = { id: 's1' };
  mockStartCompanions.mockClear();
  mockStopCompanions.mockClear();
  mockLauncherCommit.mockClear();
  mockExtension = false;
  (recordRecentDapp as jest.Mock).mockReset();
  (openUrlInNewTab as jest.Mock).mockReset();
});

afterEach(() => {
  if (!hasGetAnimations) Reflect.deleteProperty(HTMLElement.prototype, 'getAnimations');
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

describe('while the foreground page morphs', () => {
  const launcherBox = () => screen.getByTestId('dapp-launcher').parentElement!;

  it('renders the launcher inert behind the page while a motion runs', () => {
    mockMotion = { id: 's1', target: 'collapsed', started: true };
    render(view(true));

    expect(launcherBox()).toBeVisible();
    expect(launcherBox()).toHaveClass('absolute', 'inset-0');
    expect(launcherBox()).toHaveAttribute('aria-hidden', 'true');
    expect(launcherBox().inert).toBe(true);
    expect(screen.getByTestId('dapp-active')).toBeInTheDocument();
  });

  it('hides the launcher once an expand settles', () => {
    mockMotion = { id: 's1', target: 'expanded' };
    const { rerender } = render(view(true));
    expect(launcherBox()).toBeVisible();

    mockMotion = null;
    rerender(view(true));

    expect(launcherBox()).not.toBeVisible();
  });

  it('makes the launcher focusable again only after the collapse commits', () => {
    mockMotion = { id: 's1', target: 'collapsed' };
    const { rerender } = render(view(true));
    expect(launcherBox().inert).toBe(true);

    mockMode = 'launcher';
    mockSession = null;
    rerender(view(true));

    expect(launcherBox().inert).toBe(false);
    expect(launcherBox()).not.toHaveClass('absolute');
    expect(screen.queryByTestId('dapp-active')).toBeNull();
  });

  it('keeps the launcher hidden behind a page that is not the one moving', () => {
    mockMotion = { id: 'other', target: 'expanded' };
    render(view(true));

    expect(launcherBox()).not.toBeVisible();
  });
});

describe('morph companions', () => {
  const event = (extra: Partial<Motion>): Motion => ({
    id: 's1',
    target: 'collapsed',
    morphId: 'm1',
    started: true,
    acknowledging: false,
    tracking: false,
    progress: 0.9,
    velocity: -2,
    eventSeq: 1,
    ...extra
  });

  it('runs on every started and retargeted event and stops when the motion ends', () => {
    mockMotion = event({ started: false, eventSeq: 0 });
    const { rerender } = render(view(true));
    expect(mockStartCompanions).not.toHaveBeenCalled();
    expect(screen.getByTestId('dapp-launcher').parentElement).toHaveStyle({ opacity: '0' });

    mockMotion = event({});
    rerender(view(true));
    expect(mockStartCompanions).toHaveBeenLastCalledWith(
      { capsule: screen.getByTestId('dapp-active'), launcher: screen.getByTestId('dapp-launcher').parentElement },
      mockMotion,
      false
    );
    mockMotion = event({ target: 'expanded', eventSeq: 2 });
    rerender(view(true));
    expect(mockStartCompanions).toHaveBeenCalledTimes(2);

    mockMotion = null;
    rerender(view(true));
    expect(mockStopCompanions).toHaveBeenCalledTimes(1);
  });

  it('waits for the release while a finger holds the page', () => {
    mockMotion = event({ tracking: true });
    render(view(true));

    expect(mockStartCompanions).not.toHaveBeenCalled();
  });

  const holdAnimations = () => {
    const pause = { capsule: jest.fn(), launcher: jest.fn() };
    const hold = (element: HTMLElement, fn: jest.Mock) =>
      Object.defineProperty(element, 'getAnimations', { configurable: true, value: () => [{ pause: fn }] });
    hold(screen.getByTestId('dapp-active'), pause.capsule);
    hold(screen.getByTestId('dapp-launcher').parentElement!, pause.launcher);
    return pause;
  };

  it('freezes the companions where they are when a finger grabs the page', () => {
    mockMotion = event({});
    const { rerender } = render(view(true));
    expect(mockStartCompanions).toHaveBeenCalledTimes(1);
    const pause = holdAnimations();

    mockMotion = event({ tracking: true, eventSeq: 2, velocity: 0 });
    rerender(view(true));
    expect(pause.capsule).toHaveBeenCalledTimes(1);
    expect(pause.launcher).toHaveBeenCalledTimes(1);
    expect(mockStartCompanions).toHaveBeenCalledTimes(1);
    expect(mockStopCompanions).not.toHaveBeenCalled();

    mockMotion = event({ tracking: true, eventSeq: 3, velocity: 0, progress: 0.8 });
    rerender(view(true));
    expect(pause.capsule).toHaveBeenCalledTimes(2);
    expect(pause.launcher).toHaveBeenCalledTimes(2);
    expect(mockStartCompanions).toHaveBeenCalledTimes(1);

    mockMotion = event({ tracking: false, eventSeq: 4, target: 'expanded', progress: 0.4, velocity: 1.5 });
    rerender(view(true));
    expect(mockStartCompanions).toHaveBeenCalledTimes(2);
    expect(mockStartCompanions).toHaveBeenLastCalledWith(expect.anything(), mockMotion, false);
    expect(mockStopCompanions).not.toHaveBeenCalled();
  });

  it('cancels a held set when the motion ends or the screen unmounts', () => {
    mockMotion = event({});
    const first = render(view(true));
    holdAnimations();
    mockMotion = event({ tracking: true, eventSeq: 2, velocity: 0 });
    first.rerender(view(true));
    mockMotion = null;
    first.rerender(view(true));
    expect(mockStopCompanions).toHaveBeenCalledTimes(1);
    first.unmount();

    mockStopCompanions.mockClear();
    mockMotion = event({});
    const second = render(view(true));
    holdAnimations();
    mockMotion = event({ tracking: true, eventSeq: 2, velocity: 0 });
    second.rerender(view(true));
    second.unmount();
    expect(mockStopCompanions).toHaveBeenCalledTimes(1);
  });
});
