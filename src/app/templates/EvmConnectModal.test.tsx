import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { EvmConnectModal } from './EvmConnectModal';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('@reown/appkit/react', () => ({
  useAppKit: () => ({ open: jest.fn() })
}));

jest.mock('lib/walletconnect/useEvmWalletConnection', () => ({
  useEvmWalletConnection: () => ({ status: 'idle', nativeReown: { error: null }, useNativeReownWallet: false })
}));

jest.mock('lib/mobile/haptics', () => ({ hapticMedium: jest.fn() }));

jest.mock('lib/ui/button', () => ({
  Button: ({
    children,
    onClick,
    'data-testid': testId
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    'data-testid'?: string;
  }) => (
    <button type="button" onClick={onClick} data-testid={testId}>
      {children}
    </button>
  )
}));

// Vaul renders through a portal jsdom cannot drive; a flat stand-in is enough.
// className passes through so the scroll structure is assertable.
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

jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: { WarningFill: 'WarningFill' }
}));

describe('EvmConnectModal (#875)', () => {
  it('warns to connect a test wallet only before the WalletConnect handshake', () => {
    render(<EvmConnectModal open onOpenChange={jest.fn()} />);

    const warning = screen.getByTestId('evm-connect-test-wallet-warning');
    expect(warning).toHaveTextContent('evmConnectTestWalletTitle');
    expect(warning).toHaveTextContent('evmConnectTestWalletBody');
  });

  it('keeps the warning in the scroll region and "Open wallet" in the pinned footer', () => {
    // Structure only: the stand-in drawer has no layout. network-banner.spec measures the
    // same DrawerContent / DrawerFooter pattern on the real drawer. Landscape leaves 80vh
    // short enough for the warning to push the button out of view, hence the scroll region.
    render(<EvmConnectModal open onOpenChange={jest.fn()} />);

    const body = screen.getByTestId('evm-connect-body');
    expect(body).toHaveClass('overflow-y-auto', 'min-h-0');
    expect(body).toContainElement(screen.getByTestId('evm-connect-test-wallet-warning'));
    const openWallet = screen.getByTestId('evm-connect-open-wallet');
    expect(body).not.toContainElement(openWallet);
    expect(openWallet.closest('[data-slot="drawer-footer"]')).not.toBeNull();
    expect(screen.getByTestId('drawer-content')).toHaveClass('overflow-hidden');
  });

  it('hands a dismiss (header X, swipe, overlay tap) to its onOpenChange prop', () => {
    const onOpenChange = jest.fn();
    render(<EvmConnectModal open onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'close' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
