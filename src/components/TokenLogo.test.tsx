import React from 'react';

import { render } from '@testing-library/react';

import { TokenLogo } from './TokenLogo';

// TokenLogo has two branches, both of which now go through the canonical
// `Avatar` (components/ui/Avatar):
//   1. Known symbol (MIDEN / ETH / USDC / BTC) → Avatar with the token's own
//      color and its logo as the `icon`.
//   2. Unknown symbol → Avatar with the default token-logo image.
//
// The four logo imports resolve through the repo's global `\\.svg$` mock
// (__mocks__/svgMock.js), which exports the string `'svg'` for
// `ReactComponent`. React therefore renders each `<tokenLogo.Logo />` as a
// host `<svg>` element, so all four known tokens produce an identical `<svg>`;
// they are distinguished by the circle's background color.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}));

const getCircle = (container: HTMLElement) => container.querySelector('span > span') as HTMLElement;
const getSvg = (container: HTMLElement) => container.querySelector('svg') as SVGSVGElement;
const getImg = (container: HTMLElement) => container.querySelector('img') as HTMLImageElement;

// Symbol → expected circle background color, per TOKEN_LOGOS.
const KNOWN_TOKENS: Array<[string, string]> = [
  ['MIDEN', 'rgb(255, 255, 255)'],
  ['ETH', 'rgb(0, 0, 0)'],
  ['USDC', 'rgb(2, 120, 210)'],
  ['BTC', 'rgb(247, 147, 26)']
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
    it.each(KNOWN_TOKENS)('renders %s on the token color, wrapping an <svg>', (symbol, color) => {
      const { container } = render(<TokenLogo symbol={symbol} />);
      const circle = getCircle(container);

      expect(circle).toHaveClass('rounded-full');
      expect(circle.style.backgroundColor).toBe(color);

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

    it('forwards a custom className onto the Avatar circle', () => {
      const { container } = render(<TokenLogo symbol="BTC" className="my-extra-class" />);

      expect(getCircle(container)).toHaveClass('my-extra-class');
    });
  });

  describe('unknown symbols (Avatar image fallback)', () => {
    it('renders the default-image Avatar for an unrecognised symbol', () => {
      const { container } = render(<TokenLogo symbol="DOGE" />);

      const img = getImg(container);
      expect(img).toBeInTheDocument();
      expect(img).toHaveAttribute('src', '/misc/token-logos/default.svg');
      expect(img).toHaveAttribute('alt', 'avatar');

      expect(getSvg(container)).toBeNull();
    });

    it.each(SIZES)('threads the %s size through to Avatar', (size, circleCls) => {
      const { container } = render(<TokenLogo symbol="XYZ" size={size} />);

      expect(getCircle(container)).toHaveClass(...circleCls.split(' '));
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
});
