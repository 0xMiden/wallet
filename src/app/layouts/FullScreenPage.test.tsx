import React from 'react';

import { render, screen } from '@testing-library/react';

// Imported after the mock is registered (jest hoists `jest.mock`, so the
// component picks up the mocked `isMobile`).
import FullScreenPage from './FullScreenPage';

// `lib/platform` gates the whole animation branch of FullScreenPage:
//   - `isMobile()` false  -> the effect bails before touching the DOM.
//   - `isMobile()` true   -> the container gets the `mobile-page-enter` class,
//     an `animationend` listener that strips it, and a cleanup that detaches.
jest.mock('lib/platform', () => ({
  isMobile: jest.fn(() => false)
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const platform = require('lib/platform') as {
  isMobile: jest.Mock;
};

/** The single wrapper `<div>` FullScreenPage renders. */
function getContainerDiv(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement;
}

beforeEach(() => {
  platform.isMobile.mockReturnValue(false);
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('FullScreenPage', () => {
  it('renders its children', () => {
    render(
      <FullScreenPage>
        <span data-testid="child">content</span>
      </FullScreenPage>
    );

    expect(screen.getByTestId('child')).toHaveTextContent('content');
  });

  it('renders multiple children', () => {
    render(
      <FullScreenPage>
        <span data-testid="a">a</span>
        <span data-testid="b">b</span>
      </FullScreenPage>
    );

    expect(screen.getByTestId('a')).toBeInTheDocument();
    expect(screen.getByTestId('b')).toBeInTheDocument();
  });

  it('applies the base layout classes and willChange style', () => {
    const { container } = render(
      <FullScreenPage>
        <span>x</span>
      </FullScreenPage>
    );

    const div = getContainerDiv(container);

    expect(div).toHaveClass('flex', 'flex-col', 'h-full', 'w-full', 'bg-app-bg');
    expect(div.style.willChange).toBe('transform, opacity');
  });

  it('checks the platform on mount', () => {
    render(
      <FullScreenPage>
        <span>x</span>
      </FullScreenPage>
    );

    expect(platform.isMobile).toHaveBeenCalledTimes(1);
  });

  describe('when not on mobile (extension)', () => {
    it('does not add the mobile-page-enter animation class', () => {
      platform.isMobile.mockReturnValue(false);

      const { container } = render(
        <FullScreenPage>
          <span>x</span>
        </FullScreenPage>
      );

      expect(getContainerDiv(container)).not.toHaveClass('mobile-page-enter');
    });
  });

  describe('when on mobile', () => {
    beforeEach(() => {
      platform.isMobile.mockReturnValue(true);
    });

    it('adds the mobile-page-enter animation class on mount', () => {
      const { container } = render(
        <FullScreenPage>
          <span>x</span>
        </FullScreenPage>
      );

      expect(getContainerDiv(container)).toHaveClass('mobile-page-enter');
    });

    it('removes the animation class once the entrance animation ends', () => {
      const { container } = render(
        <FullScreenPage>
          <span>x</span>
        </FullScreenPage>
      );

      const div = getContainerDiv(container);
      expect(div).toHaveClass('mobile-page-enter');

      div.dispatchEvent(new Event('animationend'));

      expect(div).not.toHaveClass('mobile-page-enter');
    });

    it('keeps the animation class until the animation actually ends', () => {
      const { container } = render(
        <FullScreenPage>
          <span>x</span>
        </FullScreenPage>
      );

      // A different animation event must not strip the class prematurely.
      const div = getContainerDiv(container);
      div.dispatchEvent(new Event('animationstart'));

      expect(div).toHaveClass('mobile-page-enter');
    });

    it('detaches the animationend listener on unmount', () => {
      const { container, unmount } = render(
        <FullScreenPage>
          <span>x</span>
        </FullScreenPage>
      );

      const div = getContainerDiv(container);
      const removeSpy = jest.spyOn(div, 'removeEventListener');

      unmount();

      expect(removeSpy).toHaveBeenCalledWith('animationend', expect.any(Function));
    });

    it('does not re-run the animation setup when children change (empty deps)', () => {
      const { container, rerender } = render(
        <FullScreenPage>
          <span data-testid="first">first</span>
        </FullScreenPage>
      );

      const div = getContainerDiv(container);
      // Simulate the animation finishing.
      div.dispatchEvent(new Event('animationend'));
      expect(div).not.toHaveClass('mobile-page-enter');

      // Re-rendering with new children must not re-add the class, because the
      // effect has an empty dependency array and runs only once.
      rerender(
        <FullScreenPage>
          <span data-testid="second">second</span>
        </FullScreenPage>
      );

      expect(getContainerDiv(container)).not.toHaveClass('mobile-page-enter');
      expect(screen.getByTestId('second')).toBeInTheDocument();
      // isMobile is only consulted on the single mount-time effect run.
      expect(platform.isMobile).toHaveBeenCalledTimes(1);
    });
  });
});
