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

// TokenLogo has two branches, both through the canonical `Avatar` (components/ui/Avatar):
//   1. The verified list names a logo for the faucet → Avatar with that logo.
//   2. No faucet, a faucet the list does not name, or a listed logo that failed → the default image.
// A symbol never keys a logo: any faucet can take any symbol.

const getCircle = (container: HTMLElement) => container.querySelector('span > span');
const getImg = (container: HTMLElement) => container.querySelector('img');
const DEFAULT_LOGO = '/misc/token-logos/default.svg';

// size → avatar box class, per AVATAR_SIZES.
const SIZES: Array<['sm' | 'md' | 'lg' | 'xl' | '2xl', string]> = [
  ['sm', 'h-6 w-6'],
  ['md', 'h-9 w-9'],
  ['lg', 'h-10 w-10'],
  ['xl', 'h-22 w-22'],
  ['2xl', 'h-22 w-22']
];

describe('TokenLogo', () => {
  describe('default mark', () => {
    it('draws the default image, decoratively, for a faucet the list does not name', () => {
      const { container } = render(<TokenLogo faucetId="0xunlisted" />);

      const img = getImg(container);
      expect(img).toHaveAttribute('src', DEFAULT_LOGO);
      // Decorative: the token's name is always shown as text beside the logo elsewhere on screen.
      expect(img).toHaveAttribute('alt', '');
      expect(mockUseTokenLogoUri).toHaveBeenCalledWith('0xunlisted');
    });

    it('draws the default image without a faucet, and asks the list for nothing', () => {
      const { container } = render(<TokenLogo faucetId={undefined} />);

      expect(getImg(container)).toHaveAttribute('src', DEFAULT_LOGO);
      expect(mockUseTokenLogoUri).toHaveBeenCalledWith(undefined);
    });

    it('defaults to the md size when size is omitted', () => {
      const { container } = render(<TokenLogo faucetId={undefined} />);

      expect(getCircle(container)).toHaveClass('h-9', 'w-9');
    });

    it.each(SIZES)('threads the %s size through to Avatar', (size, circleCls) => {
      const { container } = render(<TokenLogo faucetId={undefined} size={size} />);

      expect(getCircle(container)).toHaveClass(...circleCls.split(' '));
    });

    it('draws the transparent default mark on a fill disc at hero size only', () => {
      const { container: hero } = render(<TokenLogo faucetId={undefined} size="2xl" />);
      expect(getCircle(hero)).toHaveClass('bg-fill');

      const { container: row } = render(<TokenLogo faucetId={undefined} size="md" />);
      expect(getCircle(row)).not.toHaveClass('bg-fill');
    });

    it('forwards a custom className onto the Avatar circle', () => {
      const { container } = render(<TokenLogo faucetId={undefined} className="fallback-extra" />);

      expect(getCircle(container)).toHaveClass('fallback-extra');
    });
  });

  describe('listed logo', () => {
    it('draws the listed logo of the faucet inside a bg-fill circle', () => {
      mockLogo = 'https://example.com/pol.png';
      const { container } = render(<TokenLogo faucetId="0xpol" />);

      expect(getImg(container)?.src).toBe('https://example.com/pol.png');
      expect(getCircle(container)).toHaveClass('bg-fill');
      expect(mockUseTokenLogoUri).toHaveBeenCalledWith('0xpol');
    });

    it('shows the default mark when the listed logo fails to load', () => {
      mockLogo = 'https://example.com/xyz.png';
      const { container } = render(<TokenLogo faucetId="0xfaucet" />);

      const img = getImg(container);
      if (img) fireEvent.error(img);

      expect(getImg(container)?.getAttribute('src')).toBe(DEFAULT_LOGO);
    });

    it('tries the next token logo after an earlier one failed', () => {
      mockLogo = 'https://example.com/a.png';
      const { container, rerender } = render(<TokenLogo faucetId="0xa" />);
      const img = getImg(container);
      if (img) fireEvent.error(img);

      mockLogo = 'https://example.com/b.png';
      rerender(<TokenLogo faucetId="0xb" />);

      expect(getImg(container)?.src).toBe('https://example.com/b.png');
    });

    it('retries the listed logo when the window comes online again', () => {
      mockLogo = 'https://example.com/xyz.png';
      const { container } = render(<TokenLogo faucetId="0xfaucet" />);
      const img = getImg(container);
      if (img) fireEvent.error(img);
      expect(getImg(container)?.getAttribute('src')).toBe(DEFAULT_LOGO);

      act(() => {
        window.dispatchEvent(new Event('online'));
      });

      expect(getImg(container)?.src).toBe('https://example.com/xyz.png');
    });

    it('retries the listed logo when the document becomes visible again', () => {
      mockLogo = 'https://example.com/xyz.png';
      const { container } = render(<TokenLogo faucetId="0xfaucet" />);
      const img = getImg(container);
      if (img) fireEvent.error(img);
      expect(getImg(container)?.getAttribute('src')).toBe(DEFAULT_LOGO);

      const visibility = jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      visibility.mockRestore();

      expect(getImg(container)?.src).toBe('https://example.com/xyz.png');
    });

    it('stays on the default mark while the document is hidden', () => {
      mockLogo = 'https://example.com/xyz.png';
      const { container } = render(<TokenLogo faucetId="0xfaucet" />);
      const img = getImg(container);
      if (img) fireEvent.error(img);

      const visibility = jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      visibility.mockRestore();

      expect(getImg(container)?.getAttribute('src')).toBe(DEFAULT_LOGO);
    });

    it('still renders the badge on the listed-logo branch', () => {
      mockLogo = 'https://example.com/xyz.png';
      const { getByTestId } = render(<TokenLogo faucetId="0xfaucet" badge={<i data-testid="badge" />} />);

      expect(getByTestId('badge')).toBeInTheDocument();
    });
  });
});
