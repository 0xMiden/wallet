/**
 * The two places the tray uses its footer clearance: its own `bottom`, and the card position the
 * minimize shrink lands on. jsdom has no layout, so the tab bar's footer is a stub whose top edge
 * each test sets.
 */
import React from 'react';

import { act, render, screen } from '@testing-library/react';

import type { DappSession } from 'lib/dapp-browser';

import { CARD_HEIGHT } from './DappPeekCard';
import { DappPeekTray } from './DappPeekTray';

type Rect = { x: number; y: number; width: number; height: number };

const S1: DappSession = {
  id: 's1',
  url: 'https://app.example/',
  origin: 'https://app.example',
  title: 'Example',
  favicon: null,
  status: 'active',
  openedAt: 0
};

const mockBrowser: {
  session: DappSession | null;
  parkedSessions: { session: DappSession }[];
  restore: jest.Mock;
  close: jest.Mock;
  openSwitcher: jest.Mock;
  slotRect: Rect | null;
} = {
  session: null,
  parkedSessions: [],
  restore: jest.fn(),
  close: jest.fn(),
  openSwitcher: jest.fn(),
  slotRect: null
};
const mockOverlayProps: { targetRect: Rect }[] = [];

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('app/providers/DappBrowserProvider', () => ({ useDappBrowser: () => mockBrowser }));
jest.mock('lib/dapp-browser/snapshot-store', () => ({
  getSnapshot: (id: string) => (id === 's1' ? 'data:image/png;base64,AAAA' : undefined),
  subscribeSnapshots: () => () => undefined
}));
jest.mock('./DappExpanderOverlay', () => ({
  EXPAND_TOTAL_DURATION_MS: jest.requireActual('./DappExpanderOverlay').EXPAND_TOTAL_DURATION_MS,
  DappExpanderOverlay: (props: { targetRect: Rect }) => {
    mockOverlayProps.push(props);
    return null;
  }
}));

const originalInnerHeight = window.innerHeight;
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

beforeEach(() => {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  mockBrowser.session = null;
  mockBrowser.parkedSessions = [];
  mockBrowser.slotRect = null;
  mockOverlayProps.length = 0;
});

afterEach(() => {
  jest.useRealTimers();
  document.querySelector('[data-tabbar-footer="true"]')?.remove();
  document.body.removeAttribute('data-hide-navbar');
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

    await act(async () => {
      footerTop += 300;
      document.body.removeAttribute('data-hide-navbar');
      await flushMutations();
    });
    expect(trayBottom()).toBe('78px');
  });

  it('lands the minimize shrink on the front card above the footer', () => {
    jest.useFakeTimers();
    footerTop = 800 - 74;
    appendFooter();
    mockBrowser.session = S1;
    mockBrowser.slotRect = { x: 0, y: 100, width: 390, height: 600 };
    const { rerender } = render(<DappPeekTray />);
    // The slot-rect cache write is debounced by 350ms.
    act(() => {
      jest.advanceTimersByTime(350);
    });

    mockBrowser.session = null;
    mockBrowser.slotRect = null;
    mockBrowser.parkedSessions = [{ session: S1 }];
    rerender(<DappPeekTray />);

    expect(mockOverlayProps[mockOverlayProps.length - 1]?.targetRect.y).toBe(800 - 78 - CARD_HEIGHT);
  });
});
