import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { NETWORK_BANNER_SELECTOR } from 'app/pages/Browser/peek-target-rect';
import { hapticLight } from 'lib/mobile/haptics';

import { NetworkModeBanner } from './NetworkModeBanner';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${params.network}` : key)
  })
}));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

// The banner reads the effective network on every render, so a mutable mock can
// switch it between renders of one mounted instance.
let mockNetworkKey: 'testnet' | 'devnet' | 'localnet' | null = 'testnet';
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getTestNetworkNameKey: () => mockNetworkKey
}));

// useMobileBackHandler re-registers when its deps change; capture the handler
// from the latest render, as MobileBackBridge.test does, and its deps, which
// decide whether the real hook re-registers (a stale closure passes otherwise).
const mockBack: { handler: (() => boolean | void) | null; deps: unknown; options: unknown } = {
  handler: null,
  deps: undefined,
  options: undefined
};
jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: (handler: () => boolean | void, ...rest: unknown[]) => {
    mockBack.handler = handler;
    mockBack.deps = rest[0];
    mockBack.options = rest[1];
  }
}));

const mockLocation = { pathname: '/', hash: '' };
jest.mock('lib/woozie', () => ({
  useLocation: () => ({ pathname: mockLocation.pathname, hash: mockLocation.hash })
}));

const mockHideForegroundDapp = jest.fn();
jest.mock('app/providers/DappBrowserProvider', () => ({
  useHideForegroundDappWhileOpen: (open: boolean) => mockHideForegroundDapp(open)
}));

// Vaul renders through a portal with pointer-event bookkeeping jsdom cannot
// drive; a flat stand-in that renders children only while open is enough for
// the open/close wiring. className passes through so the scroll structure is
// assertable. The sheet's Button is the real one, so its own tap haptic is part
// of what the haptic test counts.
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({
    open,
    onOpenChange,
    children
  }: {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
    children: React.ReactNode;
  }) =>
    open ? (
      <div>
        {/* Stands in for the header X, swipe-down and overlay tap: all close through onOpenChange. */}
        <button type="button" aria-label="close" onClick={() => onOpenChange?.(false)} />
        {children}
      </div>
    ) : null,
  DrawerContent: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="drawer-content" className={className}>
      {children}
    </div>
  ),
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DrawerDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DrawerFooter: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-slot="drawer-footer" className={className}>
      {children}
    </div>
  )
}));

const openSheet = () => fireEvent.click(screen.getByTestId('network-mode-banner'));

describe('NetworkModeBanner', () => {
  beforeEach(() => {
    mockNetworkKey = 'testnet';
    mockLocation.pathname = '/';
    mockLocation.hash = '';
    mockBack.handler = null;
    mockBack.deps = undefined;
    mockBack.options = undefined;
    jest.mocked(hapticLight).mockClear();
    mockHideForegroundDapp.mockClear();
  });

  it.each([
    ['testnet', 'networkModeBanner:testnet'],
    ['devnet', 'networkModeBanner:devnet'],
    ['localnet', 'networkModeBanner:localnet']
  ] as const)('names the effective network (%s)', (key, text) => {
    mockNetworkKey = key;

    render(<NetworkModeBanner />);

    expect(screen.getByTestId('network-mode-banner')).toHaveTextContent(text);
  });

  it('renders nothing on mainnet', () => {
    mockNetworkKey = null;

    const { container } = render(<NetworkModeBanner />);

    expect(container).toBeEmptyDOMElement();
  });

  it('is the element the peek tray measures for its fallback restore target', () => {
    render(<NetworkModeBanner />);

    expect(document.querySelector(NETWORK_BANNER_SELECTOR)).toBe(screen.getByTestId('network-mode-banner'));
  });

  it('follows an override saved while it stays mounted', () => {
    // A Developer Settings save swaps the override and navigates, with no reload.
    const { rerender } = render(<NetworkModeBanner />);
    mockNetworkKey = 'devnet';

    rerender(<NetworkModeBanner />);

    expect(screen.getByTestId('network-mode-banner')).toHaveTextContent('networkModeBanner:devnet');
  });

  it('opens the explanation sheet on tap and closes it on "I understand"', () => {
    render(<NetworkModeBanner />);
    expect(screen.queryByTestId('network-mode-sheet')).not.toBeInTheDocument();

    openSheet();
    const sheet = screen.getByTestId('network-mode-sheet');
    expect(sheet).toHaveTextContent('networkNoticeResetTitle');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);

    fireEvent.click(screen.getByText('iUnderstand'));
    expect(screen.queryByTestId('network-mode-sheet')).not.toBeInTheDocument();
  });

  it('fires one haptic per tap: the banner, then "I understand"', () => {
    render(<NetworkModeBanner />);

    openSheet();
    expect(hapticLight).toHaveBeenCalledTimes(1);

    jest.mocked(hapticLight).mockClear();
    fireEvent.click(screen.getByText('iUnderstand'));
    expect(hapticLight).toHaveBeenCalledTimes(1);
  });

  it('scrolls the rows and pins the CTA outside the scroll region', () => {
    // jsdom has no layout, so the structure stands in for the Playwright check:
    // the rows must be able to scroll and the CTA must not scroll away with them.
    render(<NetworkModeBanner />);
    openSheet();

    const [firstRow] = screen.getAllByRole('listitem');
    const scrollRegion = firstRow!.closest('.overflow-y-auto');
    expect(scrollRegion).toHaveClass('min-h-0');
    const cta = screen.getByTestId('network-mode-sheet-cta');
    expect(cta.closest('.overflow-y-auto')).toBeNull();
    expect(cta.closest('[data-slot="drawer-footer"]')).not.toBeNull();
    expect(screen.getByTestId('drawer-content')).toHaveClass('overflow-hidden');
  });

  it('closes on mobile back while open, and passes back on when closed', () => {
    render(<NetworkModeBanner />);
    openSheet();

    let consumed: boolean | void = undefined;
    act(() => {
      consumed = mockBack.handler!();
    });
    expect(consumed).toBe(true);
    expect(screen.queryByTestId('network-mode-sheet')).not.toBeInTheDocument();

    expect(mockBack.handler!()).toBe(false);
  });

  it('registers its back handler in the overlay tier, ahead of any page', () => {
    render(<NetworkModeBanner />);

    expect(mockBack.options).toEqual({ overlay: true });
  });

  it('re-registers its back handler whenever the sheet opens or closes', () => {
    render(<NetworkModeBanner />);
    expect(mockBack.deps).toEqual([false]);

    openSheet();

    expect(mockBack.deps).toEqual([true]);
  });

  it('closes from the header X and releases the dApp hold', () => {
    render(<NetworkModeBanner />);
    openSheet();

    fireEvent.click(screen.getByRole('button', { name: 'close' }));

    expect(screen.queryByTestId('network-mode-sheet')).not.toBeInTheDocument();
    expect(screen.getByTestId('network-mode-banner')).toHaveAttribute('aria-expanded', 'false');
    expect(mockHideForegroundDapp).toHaveBeenLastCalledWith(false);
  });

  it.each([
    ['route', () => (mockLocation.pathname = '/settings')],
    ['onboarding step', () => (mockLocation.hash = '#create-password')]
  ])('closes when the %s changes underneath it', (_label, navigate) => {
    const { rerender } = render(<NetworkModeBanner />);
    openSheet();
    expect(screen.getByTestId('network-mode-sheet')).toBeInTheDocument();

    navigate();
    rerender(<NetworkModeBanner />);

    expect(screen.queryByTestId('network-mode-sheet')).not.toBeInTheDocument();
  });

  it('holds the foreground dApp hidden exactly while the sheet is open', () => {
    render(<NetworkModeBanner />);
    expect(mockHideForegroundDapp).toHaveBeenLastCalledWith(false);

    openSheet();
    expect(mockHideForegroundDapp).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByText('iUnderstand'));
    expect(mockHideForegroundDapp).toHaveBeenLastCalledWith(false);
  });
});
