import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import { NetworkModeStrip } from './NetworkModeStrip';

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

// The real sheet, so opening from the strip and closing with mobile back are exercised end to end;
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

const strip = () => screen.getByTestId('network-mode-strip');
const pill = () => strip().firstElementChild as HTMLElement;

describe('NetworkModeStrip', () => {
  beforeEach(() => {
    mockNetworkKey = 'testnet';
    mockBuild.network = 'testnet';
    mockBack.handler = null;
    jest.mocked(hapticLight).mockClear();
  });

  it.each(['testnet', 'devnet', 'localnet'] as const)('shows the effective network’s name (%s)', key => {
    mockNetworkKey = key;
    render(<NetworkModeStrip />);

    expect(strip()).toHaveTextContent(key);
  });

  it('renders nothing on mainnet', () => {
    mockNetworkKey = null;
    const { container } = render(<NetworkModeStrip />);

    expect(container).toBeEmptyDOMElement();
  });

  it('is named for what it opens, starting with the visible network name', () => {
    render(<NetworkModeStrip />);

    expect(screen.getByRole('button', { name: 'networkModeStripLabel:testnet' })).toBe(strip());
    expect(strip()).toHaveAttribute('aria-haspopup', 'dialog');
    expect(strip()).toHaveAttribute('aria-expanded', 'false');
  });

  it('is a compact, fully round pill in the accent tint inside a 44px target', () => {
    render(<NetworkModeStrip />);

    expect(strip()).toHaveClass('h-11', 'min-w-0', 'max-w-full', 'items-end', 'pb-1');
    expect(pill()).toHaveClass('h-6', 'text-xs', 'font-bold', 'rounded-full', 'max-w-full');
    expect(pill()).toHaveClass('bg-accent-tint', 'text-accent-tint-ink');
    // Truncates rather than pushing the tabs: the name's span ellipsizes.
    expect(pill().querySelector('.truncate')).toHaveTextContent('testnet');
  });

  it('turns slate on a devnet build, following the brand ramp', () => {
    mockBuild.network = 'devnet';
    render(<NetworkModeStrip />);

    expect(pill()).toHaveClass('bg-primary-orange-lighter', 'text-primary-orange-dark');
    expect(pill()).not.toHaveClass('bg-accent-tint');
  });

  it('opens the explanation sheet on tap, with one light haptic', () => {
    render(<NetworkModeStrip />);
    expect(screen.queryByTestId('network-mode-sheet')).not.toBeInTheDocument();

    fireEvent.click(strip());

    expect(screen.getByTestId('network-mode-sheet')).toBeInTheDocument();
    expect(screen.getByRole('heading')).toHaveTextContent('networkModeBanner:testnet');
    expect(strip()).toHaveAttribute('aria-expanded', 'true');
    expect(hapticLight).toHaveBeenCalledTimes(1);
  });

  it('closes the sheet on mobile back', () => {
    render(<NetworkModeStrip />);
    fireEvent.click(strip());

    let consumed: boolean | void = undefined;
    act(() => {
      consumed = mockBack.handler!();
    });

    expect(consumed).toBe(true);
    expect(screen.queryByTestId('network-mode-sheet')).not.toBeInTheDocument();
    expect(strip()).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes the sheet on "I understand"', () => {
    render(<NetworkModeStrip />);
    fireEvent.click(strip());

    fireEvent.click(screen.getByTestId('network-mode-sheet-cta'));

    expect(screen.queryByTestId('network-mode-sheet')).not.toBeInTheDocument();
  });
});
