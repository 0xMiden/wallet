import React from 'react';

import { render, screen, act } from '@testing-library/react';

import CustomModal from './CustomModal';

// `lib/platform` drives two branches in CustomModal:
//   - `isExtension()` selects the `closeTimeoutMS` (0 for extension, 200 else)
//   - `isMobile()` (via `useHideDappBubblesWhileOpen`) toggles the body drawer
// Mock it as jest.fn()s so each test can steer the branch it exercises.
jest.mock('lib/platform', () => ({
  isExtension: jest.fn(() => false),
  isMobile: jest.fn(() => false)
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const platform = require('lib/platform') as {
  isExtension: jest.Mock;
  isMobile: jest.Mock;
};

/** Adds the `#root` element CustomModal looks up, mirroring the real app shell. */
function mountRoot(): HTMLElement {
  const root = document.createElement('div');
  root.setAttribute('id', 'root');
  document.body.appendChild(root);
  return root;
}

/**
 * react-modal fires `onAfterOpen` inside a `requestAnimationFrame` and defers
 * timed closes with a `setTimeout`. Advancing the fake clock (wrapped in `act`)
 * flushes both so the modal's lifecycle callbacks actually run.
 */
function flushModalTimers(ms = 300): void {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  platform.isExtension.mockReturnValue(false);
  platform.isMobile.mockReturnValue(false);
});

afterEach(() => {
  jest.useRealTimers();
  // Clean up any manually-added #root and the body flags the callbacks set so
  // tests stay isolated from each other.
  document.getElementById('root')?.remove();
  document.body.classList.remove('overscroll-y-none');
  document.body.removeAttribute('data-drawer-open');
});

describe('CustomModal', () => {
  it('renders null when there is no #root element', () => {
    // No #root mounted -> the early-return branch fires.
    const { container } = render(
      <CustomModal isOpen>
        <div data-testid="content">hi</div>
      </CustomModal>
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('content')).not.toBeInTheDocument();
    expect(document.getElementById('custom-modal')).toBeNull();
  });

  it('renders the modal content when #root exists and isOpen is true', () => {
    mountRoot();

    render(
      <CustomModal isOpen>
        <div data-testid="content">hello</div>
      </CustomModal>
    );

    expect(screen.getByTestId('content')).toBeInTheDocument();
    expect(document.getElementById('custom-modal')).toBeInTheDocument();
  });

  it('does not render content when isOpen is false', () => {
    mountRoot();

    render(
      <CustomModal isOpen={false}>
        <div data-testid="content">hidden</div>
      </CustomModal>
    );

    expect(screen.queryByTestId('content')).not.toBeInTheDocument();
  });

  it('adds the base classes and merges a custom className onto the content', () => {
    mountRoot();

    render(
      <CustomModal isOpen className="my-custom-class">
        <div>body</div>
      </CustomModal>
    );

    const content = document.getElementById('custom-modal') as HTMLElement;
    // z-80, not z-30: this dialog is opened from inside drawers (z-50), and at
    // z-30 it was painted underneath them — invisible and unclickable.
    expect(content).toHaveClass('bg-surface-solid', 'rounded', 'z-80', 'shadow-2xl', 'my-custom-class');
  });

  it('merges a custom overlayClassName onto the overlay', () => {
    mountRoot();

    render(
      <CustomModal isOpen overlayClassName="my-overlay-class">
        <div>body</div>
      </CustomModal>
    );

    const overlay = document.querySelector('.my-overlay-class') as HTMLElement;
    expect(overlay).not.toBeNull();
    // `pointer-events-auto` is load-bearing, not decoration: a vaul drawer is a
    // modal Radix dialog, and Radix sets `pointer-events: none` on <body> while
    // one is open. This overlay is portaled to <body>, so without it the dialog
    // is inert no matter how high it sits.
    expect(overlay).toHaveClass(
      'fixed',
      'inset-0',
      'z-80',
      'pointer-events-auto',
      'flex',
      'items-center',
      'justify-center',
      'p-6'
    );
  });

  it('flags the body via onAfterOpen when the modal opens', () => {
    mountRoot();

    render(
      <CustomModal isOpen>
        <div>body</div>
      </CustomModal>
    );

    // onAfterOpen runs on the next animation frame.
    flushModalTimers();

    expect(document.body).toHaveClass('overscroll-y-none');
  });

  it('clears the body flag via onAfterClose when the modal closes (extension: closeTimeoutMS 0)', () => {
    platform.isExtension.mockReturnValue(true);
    mountRoot();

    const { rerender } = render(
      <CustomModal isOpen>
        <div>body</div>
      </CustomModal>
    );

    flushModalTimers();
    expect(document.body).toHaveClass('overscroll-y-none');

    act(() => {
      rerender(
        <CustomModal isOpen={false}>
          <div>body</div>
        </CustomModal>
      );
    });

    // closeTimeoutMS is 0 for the extension, so the close is not deferred.
    expect(document.body).not.toHaveClass('overscroll-y-none');
  });

  it('closes with the non-extension timeout (closeTimeoutMS 200) and still clears the flag', () => {
    platform.isExtension.mockReturnValue(false);
    mountRoot();

    const { rerender } = render(
      <CustomModal isOpen>
        <div>body</div>
      </CustomModal>
    );

    flushModalTimers();
    expect(document.body).toHaveClass('overscroll-y-none');

    act(() => {
      rerender(
        <CustomModal isOpen={false}>
          <div>body</div>
        </CustomModal>
      );
    });

    // The 200ms close animation defers onAfterClose until the timer elapses.
    flushModalTimers();

    expect(document.body).not.toHaveClass('overscroll-y-none');
  });

  it('sets the drawer-open body flag on mobile via useHideDappBubblesWhileOpen', () => {
    platform.isMobile.mockReturnValue(true);
    mountRoot();

    render(
      <CustomModal isOpen>
        <div>body</div>
      </CustomModal>
    );

    expect(document.body.hasAttribute('data-drawer-open')).toBe(true);
  });

  it('forwards arbitrary react-modal props (e.g. contentLabel)', () => {
    mountRoot();

    render(
      <CustomModal isOpen contentLabel="my-dialog">
        <div>body</div>
      </CustomModal>
    );

    const content = document.getElementById('custom-modal') as HTMLElement;
    expect(content.getAttribute('aria-label')).toBe('my-dialog');
  });
});
