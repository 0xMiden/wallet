/**
 * The tray's footer clearance, the landing card it publishes for the native morph, and the cards it keeps under a
 * moving page. jsdom has no layout, so the tab bar's footer is a stub whose top edge each test sets, and the tray's
 * box is derived from its own inline position.
 */
import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { DappSession } from 'lib/dapp-browser';

import { CARD_HEIGHT, CARD_WIDTH } from './DappPeekCard';
import { DappPeekTray } from './DappPeekTray';

type Rect = { x: number; y: number; width: number; height: number };
type Motion = { id: string; target: 'collapsed' | 'expanded'; started: boolean };
type CardProps = React.ComponentProps<typeof import('./DappPeekCard').DappPeekCard>;

const session = (id: string): DappSession => ({
  id,
  url: `https://${id}.example/`,
  origin: `https://${id}.example`,
  title: id,
  favicon: null,
  status: 'active',
  openedAt: 0
});
const S1 = session('s1');
const S2 = session('s2');
const warm = (s: DappSession) => ({ session: s, instance: {}, isCold: false });

const mockBrowser: {
  session: DappSession | null;
  parkedSessions: { session: DappSession }[];
  sessionStates: { session: DappSession; instance: object | null; isCold: boolean }[];
  motion: Motion | null;
  restore: jest.Mock;
  close: jest.Mock;
  openSwitcher: jest.Mock;
  reportLandingCard: jest.Mock;
  slotRect: Rect | null;
} = {
  session: null,
  parkedSessions: [],
  sessionStates: [],
  motion: null,
  restore: jest.fn(),
  close: jest.fn(),
  openSwitcher: jest.fn(),
  reportLandingCard: jest.fn(),
  slotRect: null
};
const mockOverlayProps: { targetRect: Rect }[] = [];
const mockCardProps: CardProps[] = [];
const mockSnapshots = new Map<string, string>();
const mockSnapshotListeners = new Set<() => void>();

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('app/providers/DappBrowserProvider', () => ({ useDappBrowser: () => mockBrowser }));
jest.mock('lib/dapp-browser/snapshot-store', () => ({
  getSnapshot: (id: string) => mockSnapshots.get(id),
  subscribeSnapshots: (listener: () => void) => {
    mockSnapshotListeners.add(listener);
    return () => mockSnapshotListeners.delete(listener);
  }
}));
jest.mock('./DappExpanderOverlay', () => ({
  EXPAND_TOTAL_DURATION_MS: jest.requireActual('./DappExpanderOverlay').EXPAND_TOTAL_DURATION_MS,
  DappExpanderOverlay: (props: { targetRect: Rect }) => {
    mockOverlayProps.push(props);
    return null;
  }
}));
jest.mock('./DappPeekCard', () => {
  const actual = jest.requireActual<typeof import('./DappPeekCard')>('./DappPeekCard');
  return {
    ...actual,
    DappPeekCard: (props: CardProps) => {
      mockCardProps.push(props);
      return <actual.DappPeekCard {...props} />;
    }
  };
});

const VIEWPORT_WIDTH = 390;
const originalInnerHeight = window.innerHeight;
const originalRect = Element.prototype.getBoundingClientRect;
let footerTop = 0;

const appendFooter = () => {
  const footer = document.createElement('div');
  footer.setAttribute('data-tabbar-footer', 'true');
  footer.getBoundingClientRect = () => new DOMRect(0, footerTop, 0, 58);
  document.body.appendChild(footer);
};
// MutationObserver delivers its records in a microtask.
const flushMutations = () => new Promise(resolve => setTimeout(resolve, 0));
const trayBottom = () => screen.getByTestId('dapp-peek-tray').style.bottom;
const cardIds = () => screen.queryAllByTestId('dapp-peek-card').map(card => card.getAttribute('data-dapp-id'));
const lastCard = () => mockBrowser.reportLandingCard.mock.calls.at(-1)?.[0];
const frontCard = (bottom: number) => ({
  x: VIEWPORT_WIDTH - 16 - CARD_WIDTH,
  y: 800 - bottom - CARD_HEIGHT,
  width: CARD_WIDTH,
  height: CARD_HEIGHT,
  cornerRadius: 16
});

beforeEach(() => {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (!(this instanceof HTMLElement) || this.dataset.testid !== 'dapp-peek-tray') return new DOMRect();
    const right = VIEWPORT_WIDTH - parseFloat(this.style.right);
    const bottom = window.innerHeight - parseFloat(this.style.bottom);
    const width = parseFloat(this.style.width);
    return new DOMRect(right - width, bottom - CARD_HEIGHT, width, CARD_HEIGHT);
  };
  mockBrowser.session = null;
  mockBrowser.parkedSessions = [];
  mockBrowser.sessionStates = [];
  mockBrowser.motion = null;
  mockBrowser.slotRect = null;
  mockBrowser.restore.mockReset().mockResolvedValue(true);
  mockBrowser.reportLandingCard.mockClear();
  mockOverlayProps.length = 0;
  mockCardProps.length = 0;
  mockSnapshots.clear();
  mockSnapshots.set('s1', 'data:image/png;base64,AAAA');
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalRect;
  document.querySelector('[data-tabbar-footer="true"]')?.remove();
  document.body.removeAttribute('data-hide-navbar');
  document.body.removeAttribute('data-drawer-open');
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
});

describe('DappPeekTray footer clearance', () => {
  it('sits on the fallback clearance while no footer exists', () => {
    render(<DappPeekTray />);
    expect(trayBottom()).toBe('96px');
  });

  it('sits 4px above the footer top edge', () => {
    footerTop = 800 - 74;
    appendFooter();
    render(<DappPeekTray />);
    expect(trayBottom()).toBe('78px');
  });

  it('holds its bottom while the bar is held hidden, then reads the resting edge once it shows', async () => {
    footerTop = 800 - 74;
    appendFooter();
    render(<DappPeekTray />);

    // The keyboard holds the bar hidden and lifts the footer through the body padding.
    await act(async () => {
      document.body.setAttribute('data-hide-navbar', '');
      footerTop -= 300;
      window.dispatchEvent(new Event('resize'));
      await flushMutations();
    });
    expect(trayBottom()).toBe('78px');

    // The resting edge differs from the held 78px, so only a re-read on the flag change passes.
    await act(async () => {
      footerTop = 800 - 90;
      document.body.removeAttribute('data-hide-navbar');
      await flushMutations();
    });
    expect(trayBottom()).toBe('94px');
  });
});

describe('DappPeekTray landing card', () => {
  it('publishes the front card landing rect above the footer', () => {
    footerTop = 800 - 74;
    appendFooter();
    render(<DappPeekTray />);

    expect(lastCard()).toEqual(frontCard(78));
    expect(lastCard().y).toBe(800 - 78 - CARD_HEIGHT);
  });

  it('republishes the landing rect when the footer clearance changes', async () => {
    footerTop = 800 - 74;
    appendFooter();
    render(<DappPeekTray />);

    await act(async () => {
      footerTop = 800 - 90;
      window.dispatchEvent(new Event('resize'));
      await flushMutations();
    });

    expect(lastCard()).toEqual(frontCard(94));
  });

  it('publishes no landing card while the tray is hidden or unmounted', async () => {
    const { unmount } = render(<DappPeekTray />);
    expect(lastCard()).not.toBeNull();

    await act(async () => {
      document.body.setAttribute('data-drawer-open', '');
      await flushMutations();
    });
    expect(lastCard()).toBeNull();
    await act(async () => {
      document.body.removeAttribute('data-drawer-open');
      await flushMutations();
    });
    expect(lastCard()).toEqual(frontCard(96));

    unmount();
    expect(lastCard()).toBeNull();
  });
});

describe('DappPeekTray under a moving page', () => {
  it('mounts the collapsing session as the front landing card before it parks', () => {
    mockBrowser.parkedSessions = [{ session: S2 }];
    mockBrowser.sessionStates = [warm(S1), warm(S2)];
    mockBrowser.motion = { id: 's1', target: 'collapsed', started: true };
    const { rerender } = render(<DappPeekTray />);

    expect(cardIds()).toEqual(['s1', 's2']);
    expect(mockCardProps.filter(props => props.session.id === 's1').at(-1)).toMatchObject({
      stackIndex: 0,
      chromeVisible: false,
      isShrinking: true
    });

    // Parked in creation order, S1 first, yet it stays the front card it landed on.
    mockBrowser.parkedSessions = [{ session: S1 }, { session: S2 }];
    mockBrowser.motion = null;
    rerender(<DappPeekTray />);
    expect(cardIds()).toEqual(['s1', 's2']);
  });

  it('keeps the expanding card until the native page has started, then removes it at once', async () => {
    mockBrowser.sessionStates = [warm(S1)];
    mockBrowser.motion = { id: 's1', target: 'expanded', started: false };
    const { rerender } = render(<DappPeekTray />);
    const card = screen.getByTestId('dapp-peek-card');
    expect(mockCardProps.at(-1)).toMatchObject({ exitInstantly: true, chromeVisible: false });

    mockBrowser.motion = { id: 's1', target: 'expanded', started: true };
    rerender(<DappPeekTray />);

    await waitFor(() => expect(card).not.toBeInTheDocument());
  });

  it('keeps a card mounted when its snapshot updates', () => {
    mockBrowser.parkedSessions = [{ session: S1 }];
    render(<DappPeekTray />);
    const card = screen.getByTestId('dapp-peek-card');

    act(() => {
      mockSnapshots.set('s1', 'data:image/png;base64,BBBB');
      mockSnapshotListeners.forEach(listener => listener());
    });

    expect(screen.getByTestId('dapp-peek-card')).toBe(card);
    expect(card.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,BBBB');
  });

  it('renders no expander overlay for a warm restore', async () => {
    mockBrowser.parkedSessions = [{ session: S1 }];
    mockBrowser.sessionStates = [warm(S1)];
    render(<DappPeekTray />);

    await act(async () => fireEvent.click(screen.getByTestId('dapp-peek-card')));

    expect(mockBrowser.restore).toHaveBeenCalledWith('s1', {
      card: { x: 0, y: 0, width: 0, height: 0, cornerRadius: 0 },
      velocity: { x: 0, y: 0 }
    });
    expect(mockOverlayProps).toEqual([]);
  });

  it('hands the release velocity to restore', async () => {
    mockBrowser.parkedSessions = [{ session: S1 }];
    mockBrowser.sessionStates = [warm(S1)];
    render(<DappPeekTray />);

    await act(async () =>
      mockCardProps.at(-1)?.onCommitRestore(new DOMRect(282, 650, CARD_WIDTH * 0.94, 124), { x: 12, y: -900 })
    );

    expect(mockBrowser.restore).toHaveBeenCalledWith('s1', {
      card: { x: 282, y: 650, width: CARD_WIDTH * 0.94, height: 124, cornerRadius: 16 * 0.94 },
      velocity: { x: 12, y: -900 }
    });
  });
});

describe('DappPeekTray card overlays', () => {
  // `black` is ink, white in dark theme, so a card scrim written with it washes the snapshot white.
  it('darkens the card with pure black, never the theme black', () => {
    mockBrowser.parkedSessions = [{ session: S1 }];
    render(<DappPeekTray />);

    const themeBlack = [...document.body.querySelectorAll('[class]')].flatMap(el =>
      (el.getAttribute('class') ?? '')
        .split(/\s+/)
        .filter(cls => ['from-black/', 'via-black/', 'bg-black/'].some(prefix => cls.startsWith(prefix)))
    );
    expect(themeBlack).toEqual([]);
    expect(document.body.querySelector('[class~="from-pure-black/85"]')).not.toBeNull();
  });
});
