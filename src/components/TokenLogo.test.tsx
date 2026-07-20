import React from 'react';

import { render } from '@testing-library/react';

// TokenLogo has two branches:
//   1. Known symbol (MIDEN / ETH / USDC / BTC) → a coloured, rounded <div>
//      wrapping the corresponding logo <svg>.
//   2. Unknown symbol → the real `Avatar` (components/Avatar), whose only
//      impure dependency is `useTranslation` from react-i18next. Mirroring the
//      sibling atom tests (ColorIdenticon / Alert / CopyButton) we stub the
//      translator so `t('avatar')` deterministically returns its key, and
//      exercise the rest of Avatar for real.
//
// The four logo imports resolve through the repo's global `\\.svg$` mock
// (__mocks__/svgMock.js), which exports the string `'svg'` for
// `ReactComponent`. React therefore renders each `<tokenLogo.Logo />` as a
// host `<svg>` element, so all four known tokens produce an identical `<svg>`;
// they are distinguished by their container background class.
//
// TokenLogo exports a single component, no helpers or hooks, so ~100% coverage
// needs: each of the four known-symbol entries (for its `bg`), the unknown
// branch, every `size` in SIZE_CLASSES (sm/md/lg/xl), the default `size` (md),
// and the `className` passthrough on both branches.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}));

import { TokenLogo } from './TokenLogo';

const getRoot = (container: HTMLElement) => container.firstChild as HTMLElement;
const getSvg = (container: HTMLElement) => container.querySelector('svg') as SVGSVGElement;
const getImg = (container: HTMLElement) => container.querySelector('img') as HTMLImageElement;

// Symbol → expected container background, per TOKEN_LOGOS.
const KNOWN_TOKENS: Array<[string, string]> = [
  ['MIDEN', 'bg-white'],
  ['ETH', 'bg-pure-black'],
  ['USDC', 'bg-[#0278D2]'],
  ['BTC', 'bg-[#F7931A]']
];

// size → [container class, icon class], per SIZE_CLASSES.
const SIZES: Array<['sm' | 'md' | 'lg' | 'xl', string, string]> = [
  ['sm', 'w-7 h-7', 'w-4 h-4'],
  ['md', 'w-9 h-9', 'w-5 h-5'],
  ['lg', 'w-16 h-16', 'w-10 h-10'],
  ['xl', 'w-18 h-18', 'w-12 h-12']
];

describe('TokenLogo', () => {
  describe('known symbols', () => {
    it.each(KNOWN_TOKENS)('renders %s inside a coloured rounded div wrapping an <svg>', (symbol, bg) => {
      const { container } = render(<TokenLogo symbol={symbol} />);
      const root = getRoot(container);

      // Root is the coloured container div (NOT the Avatar branch).
      expect(root.tagName.toLowerCase()).toBe('div');
      expect(root).toHaveClass('rounded-full', 'flex', 'items-center', 'justify-center');
      // Correct per-token background colour.
      expect(root).toHaveClass(...bg.split(' '));

      // The logo renders as a host <svg> (via the svg mock) carrying the icon
      // size class, and there is no Avatar <img> on this branch.
      const svg = getSvg(container);
      expect(svg).toBeInTheDocument();
      expect(svg.parentElement).toBe(root);
      expect(getImg(container)).toBeNull();
    });

    it('defaults to the md size (container w-9 h-9 / icon w-5 h-5) when size is omitted', () => {
      const { container } = render(<TokenLogo symbol="MIDEN" />);

      expect(getRoot(container)).toHaveClass('w-9', 'h-9');
      expect(getSvg(container)).toHaveClass('w-5', 'h-5');
    });

    it.each(SIZES)('applies the %s size classes to the container and icon', (size, containerCls, iconCls) => {
      const { container } = render(<TokenLogo symbol="ETH" size={size} />);

      expect(getRoot(container)).toHaveClass(...containerCls.split(' '));
      expect(getSvg(container)).toHaveClass(...iconCls.split(' '));
    });

    it('forwards a custom className onto the container div', () => {
      const { container } = render(<TokenLogo symbol="BTC" className="my-extra-class" />);

      const root = getRoot(container);
      expect(root).toHaveClass('my-extra-class');
      // className is additive — it does not clobber the base / bg classes.
      expect(root).toHaveClass('rounded-full', 'bg-[#F7931A]');
    });

    it('renders no className fragment when className is undefined', () => {
      const { container } = render(<TokenLogo symbol="USDC" />);

      // clsx drops the falsy trailing arg, so the class list has no `undefined`.
      expect(getRoot(container).className).not.toMatch(/undefined/);
    });
  });

  describe('unknown symbols (Avatar fallback)', () => {
    it('renders the default-image Avatar for an unrecognised symbol', () => {
      const { container } = render(<TokenLogo symbol="DOGE" />);

      // Falls through to Avatar → a rounded div containing the default <img>.
      const img = getImg(container);
      expect(img).toBeInTheDocument();
      expect(img).toHaveAttribute('src', '/misc/token-logos/default.svg');
      // Avatar sets alt from the (stubbed) translator → the raw key.
      expect(img).toHaveAttribute('alt', 'avatar');

      // No token-logo <svg> is rendered on this branch.
      expect(getSvg(container)).toBeNull();
    });

    it('passes the rounded-full + default-size (md) container class down to Avatar', () => {
      const { container } = render(<TokenLogo symbol="UNKNOWN" />);
      const root = getRoot(container);

      // TokenLogo builds Avatar's className from `rounded-full` + sizeClass
      // (md → w-9 h-9); Avatar merges it onto its own root div.
      expect(root).toHaveClass('rounded-full', 'w-9', 'h-9');
    });

    it.each(SIZES)('threads the %s container size and a custom className through to Avatar', (size, containerCls) => {
      const { container } = render(<TokenLogo symbol="XYZ" size={size} className="fallback-extra" />);
      const root = getRoot(container);

      expect(root).toHaveClass(...containerCls.split(' '));
      expect(root).toHaveClass('rounded-full', 'fallback-extra');
    });

    it('treats an empty-string symbol as unknown and falls back to Avatar', () => {
      const { container } = render(<TokenLogo symbol="" />);

      expect(getImg(container)).toBeInTheDocument();
      expect(getSvg(container)).toBeNull();
    });
  });
});
