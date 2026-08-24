/**
 * The slot-measurement lifecycle in `DappActive`.
 *
 * Why this exists as a unit test at all, in a directory that is otherwise
 * excluded from coverage as E2E territory: what broke here was not layout, it
 * was TIMERS. The rect values are irrelevant to every assertion below — only
 * whether a measurement is pushed, and when. jsdom has no layout engine, so
 * `getBoundingClientRect` is stubbed to a constant and the ancestor transform
 * is driven by a `getComputedStyle` stub; both stand in for a real device
 * faithfully enough because the code under test only ever asks two questions:
 * "is an ancestor still translated" and "what rect does the slot report".
 *
 * The bug this keeps dead: measurements taken during the tab slide-in are
 * discarded, and nothing guaranteed a later one. A ResizeObserver does not fire
 * on transform changes, so once the three fixed timers were spent `slotRect`
 * stayed null for the lifetime of the screen — leaving the dApp foreground in
 * state and invisible on screen, with the auto-park recovery itself gated on a
 * rect having been reported.
 */
import React from 'react';

import { act, render } from '@testing-library/react';

const mockSetSlotRect = jest.fn();
const mockSession = { id: 'session-1', url: 'https://dapp.example', origin: 'https://dapp.example' };

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k })
}));

jest.mock('app/providers/DappBrowserProvider', () => ({
  useDappBrowser: () => ({
    session: mockSession,
    isLoading: false,
    close: jest.fn(),
    open: jest.fn(),
    park: jest.fn(),
    setSlotRect: mockSetSlotRect,
    openSwitcher: jest.fn(),
    sessionStates: []
  })
}));

jest.mock('@miden/dapp-browser', () => ({
  InAppBrowser: { setVisible: jest.fn().mockResolvedValue(undefined) }
}));

jest.mock('lib/dapp-browser', () => ({ createDappSession: jest.fn() }));
jest.mock('lib/dapp-browser/snapshot-store', () => ({ getSnapshot: () => null }));
jest.mock('lib/mobile/useMobileBackHandler', () => ({ useMobileBackHandler: () => undefined }));
jest.mock('lib/platform', () => ({ isMobile: () => true }));

jest.mock('./CapsuleBar', () => ({ CapsuleBar: () => null }));
jest.mock('./DappActionsSheet', () => ({ DappActionsSheet: () => null }));
jest.mock('./ProgressBar', () => ({ ProgressBar: () => null }));
jest.mock('./NativeWebViewSlot', () => {
  const ReactActual = jest.requireActual<typeof React>('react');
  return {
    NativeWebViewSlot: ReactActual.forwardRef<HTMLDivElement>((_props, ref) =>
      ReactActual.createElement('div', { ref, 'data-testid': 'native-slot' })
    )
  };
});

// eslint-disable-next-line import/first
import { DappActive } from './DappActive';

const SLOT_RECT = { left: 10, top: 20, width: 300, height: 400 };

/** Drives `hasActiveAncestorTransform`: every ancestor reports this transform. */
let ancestorTransform = 'none';

let originalGetComputedStyle: typeof window.getComputedStyle;
let originalGetBoundingClientRect: typeof Element.prototype.getBoundingClientRect;

beforeEach(() => {
  jest.useFakeTimers();
  mockSetSlotRect.mockClear();
  ancestorTransform = 'none';

  originalGetComputedStyle = window.getComputedStyle;
  window.getComputedStyle = (() =>
    ({ transform: ancestorTransform, getPropertyValue: () => '' }) as unknown as CSSStyleDeclaration) as never;

  originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return { ...SLOT_RECT, right: 0, bottom: 0, x: SLOT_RECT.left, y: SLOT_RECT.top, toJSON: () => ({}) } as DOMRect;
  };

  // jsdom has no ResizeObserver. A no-op stand-in is faithful for these tests:
  // the point of the fix is precisely that the observer contributes nothing
  // once a transform is the only thing changing.
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
});

afterEach(() => {
  window.getComputedStyle = originalGetComputedStyle;
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  jest.useRealTimers();
});

/** A translation past the 1pt threshold the guard uses. */
const SLID = 'matrix(1, 0, 0, 1, 31, 0)';

const rectPushes = () => mockSetSlotRect.mock.calls.filter(([arg]) => arg !== null);

describe('DappActive slot measurement', () => {
  it('pushes the rect immediately when nothing is sliding', () => {
    render(<DappActive />);

    expect(rectPushes()).toHaveLength(1);
    expect(rectPushes()[0]![0]).toEqual({ x: 10, y: 20, width: 300, height: 400 });
  });

  it('discards every measurement while an ancestor is still sliding', () => {
    ancestorTransform = SLID;
    render(<DappActive />);

    // Past all three fixed timers (200/400/700ms), which is where the old
    // code ran out of chances.
    act(() => {
      jest.advanceTimersByTime(800);
    });

    expect(rectPushes()).toHaveLength(0);
  });

  it('measures within one retry interval of the slide settling, long after the fixed timers are spent', () => {
    ancestorTransform = SLID;
    render(<DappActive />);

    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(rectPushes()).toHaveLength(0);

    // No resize, no fixed timer left — only the retry can notice this.
    ancestorTransform = 'none';
    act(() => {
      jest.advanceTimersByTime(50);
    });

    expect(rectPushes()).toHaveLength(1);
    expect(rectPushes()[0]![0]).toEqual({ x: 10, y: 20, width: 300, height: 400 });
  });

  it('measures anyway once the settle deadline passes, rather than giving up', () => {
    ancestorTransform = SLID;
    render(<DappActive />);

    act(() => {
      jest.advanceTimersByTime(2900);
    });
    expect(rectPushes()).toHaveLength(0);

    // A rect that may be ~32pt off beats no rect: it makes the dApp visible and
    // re-arms the auto-park recovery, which is itself gated on a reported rect.
    act(() => {
      jest.advanceTimersByTime(200);
    });

    expect(rectPushes()).toHaveLength(1);
  });

  it('pushes nothing after unmount, so it cannot race the unmount that clears the rect', () => {
    ancestorTransform = SLID;
    const { unmount } = render(<DappActive />);

    act(() => {
      jest.advanceTimersByTime(300);
    });
    expect(rectPushes()).toHaveLength(0);

    unmount();
    const callsAtUnmount = mockSetSlotRect.mock.calls.length;

    // A detached node's ancestor walk finds no transform, so a surviving timer
    // would not merely push a stale rect — it would push an all-zero one over
    // the null, and an all-zero rect is truthy enough to suppress the recovery.
    ancestorTransform = 'none';
    act(() => {
      jest.advanceTimersByTime(5000);
    });

    expect(mockSetSlotRect.mock.calls.length).toBe(callsAtUnmount);
  });
});
