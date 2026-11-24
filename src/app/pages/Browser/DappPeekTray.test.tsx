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
type OverlayProps = { sourceRect: Rect; targetRect: Rect; origin: string; onDone: () => void };

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
const mockOverlayProps: OverlayProps[] = [];
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
  DappExpanderOverlay: (props: OverlayProps) => {
    mockOverlayProps.push(props);
    return <div data-testid="expander-overlay" />;
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
const swipeFront = (direction: 'left' | 'right') =>
  mockCardProps
    .filter(props => props.stackIndex === 0)
    .at(-1)
    ?.onNavigate?.(direction);
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

  it('puts an arriving card in front when another card leaves on the same render', () => {
    const S3 = session('s3');
    const S4 = session('s4');
    mockBrowser.parkedSessions = [{ session: S1 }, { session: S2 }, { session: S3 }];
    const { rerender } = render(<DappPeekTray />);
    act(() => swipeFront('right'));
    expect(cardIds()[0]).toBe('s2');

    mockBrowser.parkedSessions = [{ session: S2 }, { session: S3 }, { session: S4 }];
    rerender(<DappPeekTray />);
    expect(cardIds()[0]).toBe('s4');
  });

  it('keeps the rotated front card when a card only leaves', () => {
    const S3 = session('s3');
    mockBrowser.parkedSessions = [{ session: S1 }, { session: S2 }, { session: S3 }];
    const { rerender } = render(<DappPeekTray />);
    act(() => swipeFront('right'));

    mockBrowser.parkedSessions = [{ session: S2 }, { session: S3 }];
    rerender(<DappPeekTray />);
    expect(cardIds()[0]).toBe('s2');
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

describe('DappPeekTray cold restore overlay', () => {
  it('uses the overlay only for a cold session', async () => {
    mockBrowser.parkedSessions = [{ session: S1 }, { session: S2 }];
    mockBrowser.sessionStates = [{ session: S1, instance: null, isCold: true }, warm(S2)];
    render(<DappPeekTray />);

    await act(async () =>
      mockCardProps.find(props => props.session.id === 's2')?.onCommitRestore(new DOMRect(), { x: 0, y: 0 })
    );
    expect(screen.queryByTestId('expander-overlay')).toBeNull();
    await act(async () =>
      mockCardProps
        .find(props => props.session.id === 's1')
        ?.onCommitRestore(new DOMRect(282, 650, 104, 132), { x: 0, y: 0 })
    );

    expect(mockBrowser.restore).toHaveBeenLastCalledWith('s1');
    expect(screen.getByTestId('expander-overlay')).toBeInTheDocument();
    expect(mockOverlayProps.at(-1)?.sourceRect).toEqual({ x: 282, y: 650, width: 104, height: 132 });
    act(() => mockOverlayProps.at(-1)?.onDone());
    expect(screen.queryByTestId('expander-overlay')).toBeNull();
  });

  it('uses the overlay when native does not accept the morph', async () => {
    mockBrowser.restore.mockResolvedValue(false);
    mockBrowser.parkedSessions = [{ session: S1 }];
    mockBrowser.sessionStates = [warm(S1)];
    render(<DappPeekTray />);

    await act(async () => fireEvent.click(screen.getByTestId('dapp-peek-card')));

    expect(mockBrowser.restore).toHaveBeenCalledWith('s1', expect.objectContaining({ velocity: { x: 0, y: 0 } }));
    expect(screen.getByTestId('expander-overlay')).toBeInTheDocument();
  });

  it.each([
    ['cold', { session: S1, instance: null, isCold: true }, true],
    ['refused warm', warm(S1), false]
  ])('uses the last measured slot when the live slot is gone (%s)', async (_, state, resolved) => {
    const measured = { x: 0, y: 160, width: 390, height: 600 };
    mockBrowser.restore.mockResolvedValue(resolved);
    mockBrowser.parkedSessions = [{ session: S1 }];
    mockBrowser.sessionStates = [state];
    mockBrowser.slotRect = measured;
    const { rerender } = render(<DappPeekTray />);
    mockBrowser.slotRect = { x: 0, y: 0, width: 0, height: 0 };
    rerender(<DappPeekTray />);
    mockBrowser.slotRect = null;
    rerender(<DappPeekTray />);

    await act(async () => fireEvent.click(screen.getByTestId('dapp-peek-card')));

    expect(mockOverlayProps.at(-1)?.targetRect).toEqual(measured);
  });

  const cold = (s: DappSession) => ({ session: s, instance: null, isCold: true });
  const pending = () => {
    let settle: (moved: boolean) => void = () => undefined;
    const promise = new Promise<boolean>(resolve => (settle = resolve));
    return { promise, settle };
  };
  const commit = (id: string) =>
    act(async () =>
      mockCardProps
        .filter(props => props.session.id === id)
        .at(-1)
        ?.onCommitRestore(new DOMRect(), { x: 0, y: 0 })
    );
  const overlay = () => screen.queryByTestId('expander-overlay');

  it('keeps the cold-expand overlay on the latest gesture', async () => {
    const warmRestore = pending();
    mockBrowser.restore.mockImplementation((id: string) => (id === 's1' ? warmRestore.promise : Promise.resolve(true)));
    mockBrowser.parkedSessions = [{ session: S1 }, { session: S2 }];
    mockBrowser.sessionStates = [warm(S1), cold(S2)];
    render(<DappPeekTray />);

    await commit('s1');
    await commit('s2');
    expect(mockOverlayProps.at(-1)?.origin).toBe('https://s2.example');
    await act(async () => warmRestore.settle(false));

    expect(overlay()).toBeInTheDocument();
    expect(mockOverlayProps.at(-1)?.origin).toBe('https://s2.example');
  });

  it('a finished earlier overlay does not clear the latest one', async () => {
    mockBrowser.parkedSessions = [{ session: S1 }, { session: S2 }];
    mockBrowser.sessionStates = [cold(S1), cold(S2)];
    render(<DappPeekTray />);

    await commit('s1');
    const firstDone = mockOverlayProps.at(-1)?.onDone;
    await commit('s2');
    act(() => firstDone?.());

    expect(overlay()).toBeInTheDocument();
    expect(mockOverlayProps.at(-1)?.origin).toBe('https://s2.example');
  });

  it('clears the overlay when the session leaves before restore settles', async () => {
    const restore = pending();
    mockBrowser.restore.mockReturnValue(restore.promise);
    mockBrowser.parkedSessions = [{ session: S1 }];
    mockBrowser.sessionStates = [cold(S1)];
    const { rerender } = render(<DappPeekTray />);

    await commit('s1');
    expect(overlay()).toBeInTheDocument();
    mockBrowser.parkedSessions = [];
    mockBrowser.sessionStates = [];
    rerender(<DappPeekTray />);
    expect(overlay()).toBeNull();

    await act(async () => restore.settle(false));
    expect(overlay()).toBeNull();
  });

  it('does not install a warm fallback for a session that closed', async () => {
    const restore = pending();
    mockBrowser.restore.mockReturnValue(restore.promise);
    mockBrowser.parkedSessions = [{ session: S1 }];
    mockBrowser.sessionStates = [warm(S1)];
    const { rerender } = render(<DappPeekTray />);

    await commit('s1');
    mockBrowser.parkedSessions = [];
    mockBrowser.sessionStates = [];
    rerender(<DappPeekTray />);
    await act(async () => restore.settle(false));

    expect(overlay()).toBeNull();
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
