import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import { NetworkModeRibbon } from './NetworkModeRibbon';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${params.network}` : key)
  })
}));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

let mockNetworkKey: 'testnet' | 'devnet' | 'localnet' | null = 'testnet';
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getTestNetworkNameKey: () => mockNetworkKey
}));

// The build's network drives the brand ramp (slate on a devnet build), independently of the
// effective network a Developer Settings override may point at. Other modules read it at import,
// before this file's own constants exist, so its state lives inside the factory.
jest.mock('lib/miden-chain/networks-config', () => {
  const build = { network: 'testnet' };
  return {
    ...jest.requireActual('lib/miden-chain/networks-config'),
    mockBuild: build,
    get DEFAULT_NETWORK() {
      return build.network;
    }
  };
});
const { mockBuild } = jest.requireMock<{ mockBuild: { network: string } }>('lib/miden-chain/networks-config');

// The real sheet, so opening from the ribbon and closing it are exercised end to end; only its
// platform edges are stubbed. The shared Drawer closes the sheet on mobile back (drawer.test pins
// how), so the stand-in records whether the sheet opts out and exposes the close it would call.
let mockDrawerCloseOnBack: boolean | undefined = true;
jest.mock('lib/woozie', () => ({ useLocation: () => ({ pathname: '/', hash: '' }) }));
jest.mock('app/providers/DappBrowserProvider', () => ({ useHideForegroundDappWhileOpen: jest.fn() }));
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({
    open,
    onOpenChange,
    closeOnBack,
    children
  }: {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
    closeOnBack?: boolean;
    children: React.ReactNode;
  }) => {
    mockDrawerCloseOnBack = closeOnBack;
    return open ? (
      <div role="dialog">
        <button type="button" data-testid="drawer-back" onClick={() => onOpenChange?.(false)} />
        {children}
      </div>
    ) : null;
  },
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DrawerDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DrawerFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}));

const ribbon = () => screen.getByTestId('network-mode-ribbon');
const band = () => screen.getByTestId('network-mode-ribbon-band');

describe('NetworkModeRibbon', () => {
  beforeEach(() => {
    mockNetworkKey = 'testnet';
    mockBuild.network = 'testnet';
    jest.mocked(hapticLight).mockClear();
  });

  it.each(['testnet', 'devnet', 'localnet'] as const)(
    'writes the effective network’s name along the band (%s)',
    key => {
      mockNetworkKey = key;
      render(<NetworkModeRibbon docked />);

      expect(ribbon()).toHaveTextContent(key);
      expect(band()).toContainElement(ribbon());
    }
  );

  it('renders nothing on mainnet', () => {
    mockNetworkKey = null;
    const { container } = render(<NetworkModeRibbon docked />);

    expect(container).toBeEmptyDOMElement();
  });

  it('is named for what it opens, starting with the visible network name', () => {
    render(<NetworkModeRibbon docked />);

    expect(screen.getByRole('button', { name: 'networkModeStripLabel:testnet' })).toBe(ribbon());
    expect(ribbon()).toHaveAttribute('aria-haspopup', 'dialog');
    expect(ribbon()).toHaveAttribute('aria-expanded', 'false');
  });

  it('is a crisp 45° sash, out of flow, in uppercase bold 10px letter-spaced type that ellipsizes', () => {
    render(<NetworkModeRibbon docked />);

    expect(band()).toHaveClass('absolute', '-rotate-45', 'h-3.5', 'w-[200px]', 'shadow-ribbon');
    expect(ribbon()).toHaveClass('uppercase', 'font-extrabold', 'text-[10px]', 'tracking-[0.06em]', 'truncate');
    expect(ribbon()).toHaveClass('max-w-[56px]', 'leading-[14px]');
  });

  it('takes taps on the word only: the band lets them through to the tabs underneath', () => {
    render(<NetworkModeRibbon docked />);

    expect(band()).toHaveClass('pointer-events-none');
    expect(ribbon()).toHaveClass('pointer-events-auto');
  });

  it('sits deep in the corner, the word centred on the visible stretch of the band', () => {
    // Docked: centreline x + y = 50 from the screen's corner, the word at (25, 25), its midpoint.
    const { unmount } = render(<NetworkModeRibbon docked />);
    expect(band()).toHaveClass('-right-[75px]', 'bottom-[18px]');
    unmount();

    // Floating: x + y = 44 inside the pill's 24px radius, the word at (22, 22).
    render(<NetworkModeRibbon docked={false} />);
    expect(band()).toHaveClass('-right-[78px]', 'bottom-[15px]');
  });

  it('is a solid brand band with white text (6.3:1 on #9F4518, 6.5:1 on devnet slate), in both themes', () => {
    render(<NetworkModeRibbon docked />);

    expect(band()).toHaveClass('bg-primary-orange-dark', 'text-pure-white');
    // A fixed palette, not a theme-flipping token, so dark mode keeps the same passing pair.
    expect(band().className).not.toMatch(/(^|\s)dark:/);
    expect(band()).not.toHaveClass('bg-accent-tint');
  });

  it('follows the build’s brand ramp, which is slate on a devnet build', () => {
    // tailwind.config.ts resolves `primary-orange-dark` per build (#4E5F73 on devnet), so the class
    // is the same on every network and the build picks the colour.
    mockBuild.network = 'devnet';
    render(<NetworkModeRibbon docked />);

    expect(band()).toHaveClass('bg-primary-orange-dark');
  });

  it('opens the explanation sheet on tap, with one light haptic', () => {
    render(<NetworkModeRibbon docked />);
    expect(screen.queryByTestId('network-mode-sheet')).not.toBeInTheDocument();

    fireEvent.click(ribbon());

    expect(screen.getByTestId('network-mode-sheet')).toBeInTheDocument();
    expect(screen.getByRole('heading')).toHaveTextContent('networkModeBanner:testnet');
    expect(ribbon()).toHaveAttribute('aria-expanded', 'true');
    expect(hapticLight).toHaveBeenCalledTimes(1);
  });

  it('closes the sheet on mobile back through the shared Drawer, which the sheet does not opt out of', () => {
    render(<NetworkModeRibbon docked />);
    fireEvent.click(ribbon());
    expect(mockDrawerCloseOnBack).toBeUndefined();

    // What the Drawer's back handler calls: onOpenChange(false).
    fireEvent.click(screen.getByTestId('drawer-back'));

    expect(screen.queryByTestId('network-mode-sheet')).not.toBeInTheDocument();
    expect(ribbon()).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes the sheet on "I understand"', () => {
    render(<NetworkModeRibbon docked />);
    fireEvent.click(ribbon());

    fireEvent.click(screen.getByTestId('network-mode-sheet-cta'));

    expect(screen.queryByTestId('network-mode-sheet')).not.toBeInTheDocument();
  });
});
