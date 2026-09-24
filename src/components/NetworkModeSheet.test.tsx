import React, { useState } from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import { NetworkModeSheet } from './NetworkModeSheet';

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

// useMobileBackHandler re-registers when its deps change; capture the handler from the latest
// render, and its deps, which decide whether the real hook re-registers (a stale closure passes
// otherwise).
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

const mockPageActive = { value: true };
jest.mock('app/layouts/page-active', () => ({
  usePageActive: () => mockPageActive.value
}));

const mockHideForegroundDapp = jest.fn();
jest.mock('app/providers/DappBrowserProvider', () => ({
  useHideForegroundDappWhileOpen: (open: boolean) => mockHideForegroundDapp(open)
}));

// Vaul renders through a portal with pointer-event bookkeeping jsdom cannot drive; a flat stand-in
// that renders children only while open is enough for the open/close wiring. className passes
// through so the scroll structure is assertable. The sheet's Button is the real one, so its own tap
// haptic is part of what the haptic test counts.
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

/** The sheet with its open state owned the way the ribbon and the banner own it. */
const Harness: React.FC<{ initialOpen?: boolean }> = ({ initialOpen = true }) => {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      <button type="button" data-testid="opener" onClick={() => setOpen(true)} />
      <NetworkModeSheet open={open} onOpenChange={setOpen} />
    </>
  );
};

describe('NetworkModeSheet', () => {
  beforeEach(() => {
    mockNetworkKey = 'testnet';
    mockLocation.pathname = '/';
    mockLocation.hash = '';
    mockPageActive.value = true;
    mockBack.handler = null;
    mockBack.deps = undefined;
    mockBack.options = undefined;
    jest.mocked(hapticLight).mockClear();
    mockHideForegroundDapp.mockClear();
  });

  it.each(['testnet', 'devnet', 'localnet'] as const)('titles itself with the effective network (%s)', key => {
    mockNetworkKey = key;
    render(<Harness />);

    expect(screen.getByRole('heading')).toHaveTextContent(`networkModeBanner:${key}`);
    expect(screen.getByTestId('network-mode-sheet')).toHaveTextContent('networkNoticeResetTitle');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('renders nothing on mainnet, even when asked to open', () => {
    mockNetworkKey = null;
    render(<Harness />);

    expect(screen.queryByTestId('network-mode-sheet')).not.toBeInTheDocument();
  });

  it('closes on "I understand", which fires the Button’s own single haptic', () => {
    render(<Harness />);

    fireEvent.click(screen.getByTestId('network-mode-sheet-cta'));

    expect(screen.queryByTestId('network-mode-sheet')).not.toBeInTheDocument();
    expect(hapticLight).toHaveBeenCalledTimes(1);
  });

  it('closes from the header X and releases the dApp hold', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'close' }));

    expect(screen.queryByTestId('network-mode-sheet')).not.toBeInTheDocument();
    expect(mockHideForegroundDapp).toHaveBeenLastCalledWith(false);
  });

  it('scrolls the rows and pins the CTA outside the scroll region', () => {
    render(<Harness />);

    const [firstRow] = screen.getAllByRole('listitem');
    expect(firstRow!.closest('.overflow-y-auto')).toHaveClass('min-h-0');
    const cta = screen.getByTestId('network-mode-sheet-cta');
    expect(cta.closest('.overflow-y-auto')).toBeNull();
    expect(cta.closest('[data-slot="drawer-footer"]')).not.toBeNull();
    // The sheet itself never clips: vaul's ::after skirt fills the gap under the sheet at the open
    // spring's overshoot, and overflow-hidden on the sheet would clip it. The scroll column shrinks.
    expect(screen.getByTestId('drawer-content')).not.toHaveClass('overflow-hidden');
  });

  it('closes on mobile back while open, and passes back on when closed', () => {
    render(<Harness />);

    let consumed: boolean | void = undefined;
    act(() => {
      consumed = mockBack.handler!();
    });
    expect(consumed).toBe(true);
    expect(screen.queryByTestId('network-mode-sheet')).not.toBeInTheDocument();

    expect(mockBack.handler!()).toBe(false);
  });

  it('registers its back handler in the overlay tier, ahead of any page', () => {
    render(<Harness />);

    expect(mockBack.options).toEqual({ overlay: true });
  });

  it('re-registers its back handler whenever the sheet opens or closes', () => {
    render(<Harness initialOpen={false} />);
    expect(mockBack.deps).toEqual([false]);

    fireEvent.click(screen.getByTestId('opener'));

    expect(mockBack.deps).toEqual([true]);
  });

  it.each([
    ['route', () => (mockLocation.pathname = '/settings')],
    ['onboarding step', () => (mockLocation.hash = '#create-password')],
    ['page going off screen', () => (mockPageActive.value = false)]
  ])('closes when the %s changes underneath it', (_label, change) => {
    const { rerender } = render(<Harness />);
    expect(screen.getByTestId('network-mode-sheet')).toBeInTheDocument();

    change();
    rerender(<Harness />);

    expect(screen.queryByTestId('network-mode-sheet')).not.toBeInTheDocument();
  });

  it('stays open across re-renders that change nothing, even with a new callback each time', () => {
    const Unstable: React.FC = () => {
      const [open, setOpen] = useState(true);
      const [, force] = useState(0);
      return (
        <>
          <button type="button" data-testid="rerender" onClick={() => force(n => n + 1)} />
          <NetworkModeSheet open={open} onOpenChange={next => setOpen(next)} />
        </>
      );
    };
    render(<Unstable />);

    fireEvent.click(screen.getByTestId('rerender'));

    expect(screen.getByTestId('network-mode-sheet')).toBeInTheDocument();
  });

  it('holds the foreground dApp hidden exactly while the sheet is open', () => {
    render(<Harness initialOpen={false} />);
    expect(mockHideForegroundDapp).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByTestId('opener'));
    expect(mockHideForegroundDapp).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByTestId('network-mode-sheet-cta'));
    expect(mockHideForegroundDapp).toHaveBeenLastCalledWith(false);
  });
});
