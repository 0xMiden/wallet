import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import { NetworkModePill } from './NetworkModePill';

let mockLanguage = 'en';
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${params.network}` : key),
    i18n: { resolvedLanguage: mockLanguage }
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

// The real sheet, so opening from the pill and closing it are exercised end to end; only its
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

const pill = () => screen.getByTestId('network-mode-pill');

describe('NetworkModePill', () => {
  beforeEach(() => {
    mockNetworkKey = 'testnet';
    mockBuild.network = 'testnet';
    mockLanguage = 'en';
    jest.mocked(hapticLight).mockClear();
  });

  it.each(['testnet', 'devnet', 'localnet'] as const)(
    'names the effective network and says its tokens have no value (%s)',
    key => {
      mockNetworkKey = key;
      render(<NetworkModePill />);

      expect(pill()).toHaveTextContent(`${key}·networkModePillNoValue`);
    }
  );

  it('renders nothing on mainnet', () => {
    mockNetworkKey = null;
    const { container } = render(<NetworkModePill />);

    expect(container).toBeEmptyDOMElement();
  });

  it('is named for what it opens, starting with the visible network name', () => {
    render(<NetworkModePill />);

    expect(screen.getByRole('button', { name: 'networkModeStripLabel:testnet' })).toBe(pill());
    expect(pill()).toHaveAttribute('aria-haspopup', 'dialog');
    expect(pill()).toHaveAttribute('aria-expanded', 'false');
  });

  it('is a full-width neutral pill: the network in ink, the reason and the info glyph muted', () => {
    render(<NetworkModePill />);

    expect(pill()).toHaveClass('w-full', 'bg-fill', 'text-ink', 'h-8');
    expect(screen.getByText('networkModePillNoValue')).toHaveClass('text-muted');
    expect(pill().querySelector('svg')).toHaveClass('text-muted');
  });

  it.each([
    ['en', '14px'],
    ['en-GB', '14px'],
    ['es', '11px'],
    ['ru', '11px'],
    ['zh-CN', '11px']
  ])('sets the line at the locale’s size (%s: %s)', (language, size) => {
    mockLanguage = language;
    render(<NetworkModePill />);

    expect(screen.getByTestId('network-mode-pill-text')).toHaveStyle({ fontSize: size });
  });

  it('opens the explanation sheet on tap, with one light haptic', () => {
    render(<NetworkModePill />);
    expect(screen.queryByTestId('network-mode-sheet')).not.toBeInTheDocument();

    fireEvent.click(pill());

    expect(screen.getByTestId('network-mode-sheet')).toBeInTheDocument();
    expect(screen.getByRole('heading')).toHaveTextContent('networkModeSheetTitle:testnet');
    expect(pill()).toHaveAttribute('aria-expanded', 'true');
    expect(hapticLight).toHaveBeenCalledTimes(1);
  });

  it('closes the sheet on mobile back through the shared Drawer, which the sheet does not opt out of', () => {
    render(<NetworkModePill />);
    fireEvent.click(pill());
    expect(mockDrawerCloseOnBack).toBeUndefined();

    fireEvent.click(screen.getByTestId('drawer-back'));

    expect(screen.queryByTestId('network-mode-sheet')).not.toBeInTheDocument();
    expect(pill()).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes the sheet on "I understand"', () => {
    render(<NetworkModePill />);
    fireEvent.click(pill());

    fireEvent.click(screen.getByTestId('network-mode-sheet-cta'));

    expect(screen.queryByTestId('network-mode-sheet')).not.toBeInTheDocument();
  });
});
