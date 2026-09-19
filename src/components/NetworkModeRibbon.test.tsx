import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

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

// The real sheet, so opening from the ribbon and closing with mobile back are exercised end to end;
// only its platform edges are stubbed.
const mockBack: { handler: (() => boolean | void) | null } = { handler: null };
jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: (handler: () => boolean | void) => {
    mockBack.handler = handler;
  }
}));
jest.mock('lib/woozie', () => ({ useLocation: () => ({ pathname: '/', hash: '' }) }));
jest.mock('app/providers/DappBrowserProvider', () => ({ useHideForegroundDappWhileOpen: jest.fn() }));
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
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
    mockBack.handler = null;
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

  it('is a 45° sash, out of flow, in uppercase bold 10px letter-spaced type that ellipsizes', () => {
    render(<NetworkModeRibbon docked />);

    expect(band()).toHaveClass('absolute', '-rotate-45', 'h-3', 'w-[200px]');
    expect(ribbon()).toHaveClass('uppercase', 'font-extrabold', 'text-[10px]', 'tracking-[0.06em]', 'truncate');
    expect(ribbon()).toHaveClass('max-w-[58px]');
  });

  it('takes taps on the word only: the band lets them through to the tabs underneath', () => {
    render(<NetworkModeRibbon docked />);

    expect(band()).toHaveClass('pointer-events-none');
    expect(ribbon()).toHaveClass('pointer-events-auto');
  });

  it('sits above the home indicator zone when docked, and in the pill’s corner when floating', () => {
    const { unmount } = render(<NetworkModeRibbon docked />);
    expect(band()).toHaveClass('-right-[75px]');
    expect(band().className).toContain(
      'bottom-[calc(var(--app-safe-bottom,max(16px,env(safe-area-inset-bottom)))+16.5px)]'
    );
    unmount();

    render(<NetworkModeRibbon docked={false} />);
    expect(band()).toHaveClass('-right-[78px]', 'bottom-4');
  });

  it('is the accent tint with its ink (5.1:1)', () => {
    render(<NetworkModeRibbon docked />);

    expect(band()).toHaveClass('bg-accent-tint', 'text-accent-tint-ink');
  });

  it('turns slate on a devnet build, following the brand ramp', () => {
    mockBuild.network = 'devnet';
    render(<NetworkModeRibbon docked />);

    expect(band()).toHaveClass('bg-primary-orange-lighter', 'text-primary-orange-dark');
    expect(band()).not.toHaveClass('bg-accent-tint');
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

  it('closes the sheet on mobile back', () => {
    render(<NetworkModeRibbon docked />);
    fireEvent.click(ribbon());

    let consumed: boolean | void = undefined;
    act(() => {
      consumed = mockBack.handler!();
    });

    expect(consumed).toBe(true);
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
