import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import MenuItem from './MenuItem';

// `t(key)` is never `init()`-ed in the unit env; echo the key back (an empty
// key — from the `titleI18nKey || ''` fallback — echoes to '') so the rendered
// label is directly assertable.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// Haptics wrap the native Capacitor plugin; stub it so we can assert the light
// impact fires on interaction without touching native code.
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

// `lib/woozie`'s real `Link` depends on the woozie location/history/analytics
// stack. Replace it with a plain anchor that forwards the props MenuItem sets
// so we can assert `to`, `testID` and the click handler in the Link branch.
jest.mock('lib/woozie', () => ({
  Link: ({
    to,
    onClick,
    testID,
    children
  }: {
    to: string;
    onClick?: () => void;
    testID?: string;
    children?: React.ReactNode;
  }) => (
    <a href={to} data-testid={testID ?? 'woozie-link'} data-to={to} onClick={onClick}>
      {children}
    </a>
  )
}));

const mockHapticLight = hapticLight as jest.Mock;

const baseProps = {
  titleI18nKey: 'menuTitle',
  testID: 'menu-item-test-id',
  linksOutsideOfWallet: false
};

beforeEach(() => {
  mockHapticLight.mockClear();
});

describe('MenuItem', () => {
  describe('external link branch (linksOutsideOfWallet=true)', () => {
    it('renders an external anchor with the slug href, target/rel, right text and title', () => {
      const { container } = render(
        <MenuItem {...baseProps} linksOutsideOfWallet slug="https://example.com" rightText="v1.2.3" />
      );

      const anchor = container.querySelector('a')!;
      expect(anchor).toHaveAttribute('href', 'https://example.com');
      expect(anchor).toHaveAttribute('target', '_blank');
      expect(anchor).toHaveAttribute('rel', 'noreferrer');

      // titleI18nKey echoed through `t`, plus the rightText span.
      expect(screen.getByText('menuTitle')).toBeInTheDocument();
      expect(screen.getByText('v1.2.3')).toBeInTheDocument();

      // The chevron is the only svg the row renders.
      expect(anchor.querySelectorAll('svg')).toHaveLength(1);
    });

    it('fires hapticLight (handleExternalClick) when the external anchor is clicked', () => {
      const { container } = render(<MenuItem {...baseProps} linksOutsideOfWallet slug="https://example.com" />);

      fireEvent.click(container.querySelector('a')!);

      expect(mockHapticLight).toHaveBeenCalledTimes(1);
    });
  });

  describe('button branch (onClick && !slug)', () => {
    it('renders a button (no right text, empty title) exercising the falsy ClickableContent branches', () => {
      render(<MenuItem {...baseProps} titleI18nKey="" onClick={jest.fn()} />);

      const button = screen.getByTestId('menu-item-test-id');
      expect(button.tagName).toBe('BUTTON');
      expect(button).toHaveAttribute('type', 'button');

      expect(button.querySelectorAll('svg')).toHaveLength(1);

      // rightText absent → no right-text span; titleI18nKey '' → `t('')` === ''.
      expect(button.querySelector('span')).toBeNull();
    });

    it('fires hapticLight then the onClick handler when the button is clicked', () => {
      const onClick = jest.fn();
      render(<MenuItem {...baseProps} onClick={onClick} />);

      fireEvent.click(screen.getByTestId('menu-item-test-id'));

      expect(mockHapticLight).toHaveBeenCalledTimes(1);
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });

  describe('Link branch (default)', () => {
    it('renders a woozie Link with `to=slug` when a slug is present alongside onClick', () => {
      const onClick = jest.fn();
      // onClick truthy but slug truthy → `onClick && !slug` is false → Link branch.
      render(<MenuItem {...baseProps} slug="/settings" onClick={onClick} />);

      const link = screen.getByTestId('menu-item-test-id');
      expect(link.tagName).toBe('A');
      expect(link).toHaveAttribute('data-to', '/settings');

      // The Link's onClick is MenuItem's onClick (no hapticLight wrapper here).
      fireEvent.click(link);
      expect(onClick).toHaveBeenCalledTimes(1);
      expect(mockHapticLight).not.toHaveBeenCalled();
    });

    it('falls back to `to="#"` when neither slug nor onClick is provided', () => {
      // onClick falsy → `onClick && ...` short-circuits → Link branch; slug
      // absent → `slug || '#'` fallback.
      render(<MenuItem {...baseProps} />);

      const link = screen.getByTestId('menu-item-test-id');
      expect(link.tagName).toBe('A');
      expect(link).toHaveAttribute('data-to', '#');
    });
  });

  it('pads the row to a 44px touch target', () => {
    // The row's own height is just the title's 24px line box, which sits exactly
    // on the WCAG 2.5.8 floor and well under the iOS and Android minimums — and
    // dropping the leading icons brought adjacent rows closer together at the
    // same time. jsdom computes no layout, so the padding is asserted directly:
    // 10px top and bottom on 24px is 44px.
    const { container } = render(<MenuItem {...baseProps} />);

    const row = container.querySelector('.flex.items-center.justify-between');
    expect(row).toHaveClass('py-2.5');
  });
});
