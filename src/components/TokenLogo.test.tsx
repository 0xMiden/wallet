import React from 'react';

import { act, fireEvent, render } from '@testing-library/react';

import { TokenLogo } from './TokenLogo';

let mockLogo: string | undefined;
const mockUseTokenLogoUri = jest.fn((_faucetId?: string) => mockLogo);
jest.mock('lib/token-list/useTokenLogoUri', () => ({
  useTokenLogoUri: (faucetId?: string) => mockUseTokenLogoUri(faucetId)
}));

beforeEach(() => {
  mockLogo = undefined;
  mockUseTokenLogoUri.mockClear();
});

// TokenLogo has three branches, all of which go through the canonical
// `Avatar` (components/ui/Avatar):
//   1. Known symbol (MIDEN / ETH / USDC / BTC) → Avatar with the token's own
//      background class and its logo as the `icon`.
//   2. Listed token (by faucetId) → Avatar with the verified list's logo.
//   3. Anything else, or a listed logo that failed → the default token-logo image.
//
// The four logo imports resolve through the repo's global `\\.svg$` mock
// (__mocks__/svgMock.js), which exports the string `'svg'` for
// `ReactComponent`. React therefore renders each `<tokenLogo.Logo />` as a
// host `<svg>` element, so all four known tokens produce an identical `<svg>`;
// they are distinguished by the circle's background class.

const getCircle = (container: HTMLElement) => container.querySelector('span > span') as HTMLElement;
const getSvg = (container: HTMLElement) => container.querySelector('svg') as SVGSVGElement;
const getImg = (container: HTMLElement) => container.querySelector('img') as HTMLImageElement;

// Symbol → expected circle background class, per TOKEN_LOGOS. `bg-white` (not
// a hex literal) for MIDEN: it resolves to the theme-flipping `--color-surface`
// token, so the disc isn't a hardcoded white circle in dark mode.
const KNOWN_TOKENS: Array<[string, string]> = [
  ['MIDEN', 'bg-white'],
  ['ETH', 'bg-pure-black'],
  ['USDC', 'bg-[#0278D2]'],
  ['BTC', 'bg-[#F7931A]']
];

// size → [avatar box class, icon class], per AVATAR_SIZES/ICON_CLASSES.
const SIZES: Array<['sm' | 'md' | 'lg' | 'xl' | '2xl', string, string]> = [
  ['sm', 'h-6 w-6', 'h-3.5 w-3.5'],
  ['md', 'h-9 w-9', 'h-5 w-5'],
  ['lg', 'h-10 w-10', 'h-6 w-6'],
  ['xl', 'h-22 w-22', 'h-12 w-12'],
  // The design system's 88px hero avatar, with a larger mark than `xl`.
  ['2xl', 'h-22 w-22', 'h-14 w-14']
];

describe('TokenLogo', () => {
  describe('known symbols', () => {
    it.each(KNOWN_TOKENS)('renders %s on the token background class, wrapping an <svg>', (symbol, bgClass) => {
      const { container } = render(<TokenLogo symbol={symbol} />);
      const circle = getCircle(container);

      expect(circle).toHaveClass('rounded-full', bgClass);

      const svg = getSvg(container);
      expect(svg).toBeInTheDocument();
      expect(svg.parentElement).toBe(circle);
      expect(getImg(container)).toBeNull();
    });

    it('defaults to the md size (h-9 w-9 / icon h-5 w-5) when size is omitted', () => {
      const { container } = render(<TokenLogo symbol="MIDEN" />);

      expect(getCircle(container)).toHaveClass('h-9', 'w-9');
      expect(getSvg(container)).toHaveClass('h-5', 'w-5');
    });

    it.each(SIZES)('applies the %s size classes to the circle and icon', (size, circleCls, iconCls) => {
      const { container } = render(<TokenLogo symbol="ETH" size={size} />);

      expect(getCircle(container)).toHaveClass(...circleCls.split(' '));
      expect(getSvg(container)).toHaveClass(...iconCls.split(' '));
    });

    it('forwards a custom className onto the Avatar circle, alongside the token background', () => {
      const { container } = render(<TokenLogo symbol="BTC" className="my-extra-class" />);

      expect(getCircle(container)).toHaveClass('my-extra-class', 'bg-[#F7931A]');
    });
  });

  describe('unknown symbols (Avatar image fallback)', () => {
    it('renders the default-image Avatar for an unrecognised symbol, decoratively', () => {
      const { container } = render(<TokenLogo symbol="DOGE" />);

      const img = getImg(container);
      expect(img).toBeInTheDocument();
      expect(img).toHaveAttribute('src', '/misc/token-logos/default.svg');
      // Decorative: the symbol is always shown as text beside the logo elsewhere on screen.
      expect(img).toHaveAttribute('alt', '');

      expect(getSvg(container)).toBeNull();
    });

    it.each(SIZES)('threads the %s size through to Avatar', (size, circleCls) => {
      const { container } = render(<TokenLogo symbol="XYZ" size={size} />);

      expect(getCircle(container)).toHaveClass(...circleCls.split(' '));
    });

    it('draws the transparent default mark on a fill disc at hero size only', () => {
      const { container: hero } = render(<TokenLogo symbol="XYZ" size="2xl" />);
      expect(getCircle(hero)).toHaveClass('bg-fill');

      const { container: row } = render(<TokenLogo symbol="XYZ" size="md" />);
      expect(getCircle(row)).not.toHaveClass('bg-fill');
    });

    it('forwards a custom className onto the Avatar circle on the fallback branch too', () => {
      const { container } = render(<TokenLogo symbol="XYZ" className="fallback-extra" />);

      expect(getCircle(container)).toHaveClass('fallback-extra');
    });

    it('treats an empty-string symbol as unknown and falls back to Avatar', () => {
      const { container } = render(<TokenLogo symbol="" />);

      expect(getImg(container)).toBeInTheDocument();
      expect(getSvg(container)).toBeNull();
    });
  });

  describe('listed logo', () => {
    it('draws the bundled mark for a bundled symbol and never asks for a listed logo', () => {
      mockLogo = 'https://example.com/eth.png';
      const { container } = render(<TokenLogo symbol="ETH" faucetId="0xfaucet" />);

      expect(getSvg(container)).toBeInTheDocument();
      expect(getImg(container)).toBeNull();
      expect(mockUseTokenLogoUri).toHaveBeenCalledWith(undefined);
    });

    it('draws the listed logo of an unbundled symbol inside a bg-fill circle', () => {
      mockLogo = 'https://example.com/xyz.png';
      const { container } = render(<TokenLogo symbol="XYZ" faucetId="0xfaucet" />);

      expect(getImg(container).src).toBe('https://example.com/xyz.png');
      expect(getCircle(container)).toHaveClass('bg-fill');
      expect(mockUseTokenLogoUri).toHaveBeenCalledWith('0xfaucet');
    });

    it('shows the default mark when the listed logo fails to load', () => {
      mockLogo = 'https://example.com/xyz.png';
      const { container } = render(<TokenLogo symbol="XYZ" faucetId="0xfaucet" />);

      fireEvent.error(getImg(container));

      expect(getImg(container).getAttribute('src')).toBe('/misc/token-logos/default.svg');
    });

    it('tries the next token logo after an earlier one failed', () => {
      mockLogo = 'https://example.com/a.png';
      const { container, rerender } = render(<TokenLogo symbol="XYZ" faucetId="0xa" />);
      fireEvent.error(getImg(container));

      mockLogo = 'https://example.com/b.png';
      rerender(<TokenLogo symbol="XYZ" faucetId="0xb" />);

      expect(getImg(container).src).toBe('https://example.com/b.png');
    });

    it('retries the listed logo when the window comes online again', () => {
      mockLogo = 'https://example.com/xyz.png';
      const { container } = render(<TokenLogo symbol="XYZ" faucetId="0xfaucet" />);
      fireEvent.error(getImg(container));
      expect(getImg(container).getAttribute('src')).toBe('/misc/token-logos/default.svg');

      act(() => {
        window.dispatchEvent(new Event('online'));
      });

      expect(getImg(container).src).toBe('https://example.com/xyz.png');
    });

    it('retries the listed logo when the document becomes visible again', () => {
      mockLogo = 'https://example.com/xyz.png';
      const { container } = render(<TokenLogo symbol="XYZ" faucetId="0xfaucet" />);
      fireEvent.error(getImg(container));
      expect(getImg(container).getAttribute('src')).toBe('/misc/token-logos/default.svg');

      const visibility = jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      visibility.mockRestore();

      expect(getImg(container).src).toBe('https://example.com/xyz.png');
    });

    it('stays on the default mark while the document is hidden', () => {
      mockLogo = 'https://example.com/xyz.png';
      const { container } = render(<TokenLogo symbol="XYZ" faucetId="0xfaucet" />);
      fireEvent.error(getImg(container));

      const visibility = jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      visibility.mockRestore();

      expect(getImg(container).getAttribute('src')).toBe('/misc/token-logos/default.svg');
    });

    it('keeps the default mark for an unbundled symbol without a faucetId', () => {
      const { container } = render(<TokenLogo symbol="XYZ" />);

      expect(getImg(container).getAttribute('src')).toBe('/misc/token-logos/default.svg');
      expect(mockUseTokenLogoUri).toHaveBeenCalledWith(undefined);
    });

    it('still renders the badge on the listed-logo branch', () => {
      mockLogo = 'https://example.com/xyz.png';
      const { getByTestId } = render(<TokenLogo symbol="XYZ" faucetId="0xfaucet" badge={<i data-testid="badge" />} />);

      expect(getByTestId('badge')).toBeInTheDocument();
    });
  });
});
