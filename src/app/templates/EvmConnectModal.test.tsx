import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { EvmConnectModal } from './EvmConnectModal';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('@reown/appkit/react', () => ({
  useAppKit: () => ({ open: jest.fn() })
}));

let mockNativeError: string | null = null;
let mockConnectionStatus = 'idle';
jest.mock('lib/walletconnect/useEvmWalletConnection', () => ({
  useEvmWalletConnection: () => ({
    status: mockConnectionStatus,
    nativeReown: { error: mockNativeError },
    useNativeReownWallet: false
  })
}));

jest.mock('lib/mobile/haptics', () => ({ hapticMedium: jest.fn() }));

// The effective network: a test network unless a case switches to mainnet.
let mockTestNetworkKey: 'testnet' | null = 'testnet';
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getTestNetworkNameKey: () => mockTestNetworkKey
}));
afterEach(() => {
  mockTestNetworkKey = 'testnet';
});

jest.mock('components/ui/Button', () => ({
  Button: ({
    children,
    onClick,
    className,
    'data-testid': testId
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    className?: string;
    'data-testid'?: string;
  }) => (
    <button type="button" onClick={onClick} className={className} data-testid={testId}>
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
    expect(warning).toHaveAttribute('role', 'note');
    expect(warning).toHaveAttribute('data-tone', 'warning');
    expect(warning.querySelector('[data-slot="title"]')?.textContent).toBe('evmConnectTestWalletTitle');
    expect(warning.querySelector('[data-slot="body"]')?.textContent).toBe('evmConnectTestWalletBody');
  });

  it('shows no test-wallet warning on mainnet, where the funds are real', () => {
    mockTestNetworkKey = null;
    render(<EvmConnectModal open onOpenChange={jest.fn()} />);

    expect(screen.getByTestId('evm-connect-body')).toBeInTheDocument();
    expect(screen.queryByTestId('evm-connect-test-wallet-warning')).not.toBeInTheDocument();
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
    // The sheet itself never clips: vaul's ::after skirt fills the gap under the sheet at the open
    // spring's overshoot, and overflow-hidden on the sheet would clip it. The scroll column shrinks.
    expect(screen.getByTestId('drawer-content')).not.toHaveClass('overflow-hidden');
  });

  it('stretches "Open wallet" across the footer instead of the 370px CTA cap', () => {
    render(<EvmConnectModal open onOpenChange={jest.fn()} />);

    expect(screen.getByTestId('evm-connect-open-wallet')).toHaveClass('max-w-none');
  });

  it('hands a dismiss (header X, swipe, overlay tap) to its onOpenChange prop', () => {
    const onOpenChange = jest.fn();
    render(<EvmConnectModal open onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'close' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

const mockReportUserVisibleError = jest.fn();
jest.mock('lib/telemetry/user-visible-error', () => ({
  ...jest.requireActual('lib/telemetry/user-visible-error'),
  reportUserVisibleError: (...args: unknown[]) => mockReportUserVisibleError(...args)
}));

const expectErrorAfterDwell = async (id: string, surface: string) => {
  await act(async () => {
    jest.advanceTimersByTime(999);
  });
  expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  await act(async () => {
    jest.advanceTimersByTime(1);
  });
  expect(mockReportUserVisibleError.mock.calls).toEqual([[id, surface]]);
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect(mockReportUserVisibleError.mock.calls).toEqual([[id, surface]]);
};

describe('user-visible WalletConnect errors', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockNativeError = null;
    mockConnectionStatus = 'idle';
  });
  afterEach(() => {
    jest.useRealTimers();
    mockNativeError = null;
    mockConnectionStatus = 'idle';
  });

  it('reports the native connection error as one closed inline tuple', async () => {
    mockNativeError = 'private connect 42 https://synthetic.invalid/0xabc';
    render(<EvmConnectModal open onOpenChange={jest.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(mockNativeError);
    await expectErrorAfterDwell('raw_bridge_connect_failed', 'inline');
  });

  it('keeps a hidden error, connecting progress and the test-wallet warning quiet', async () => {
    mockNativeError = 'hidden connection failure';
    const view = render(<EvmConnectModal open={false} onOpenChange={jest.fn()} />);
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    mockNativeError = null;
    mockConnectionStatus = 'connecting';
    view.rerender(<EvmConnectModal open onOpenChange={jest.fn()} />);
    expect(screen.getByText('preparing')).toBeInTheDocument();
    expect(screen.getByTestId('evm-connect-test-wallet-warning')).toHaveAttribute('role', 'note');
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  });

  it.each(['dismiss', 'recover', 'unmount'])('cancels a connection error on %s before dwell', async action => {
    mockNativeError = 'temporary connection failure';
    const view = render(<EvmConnectModal open onOpenChange={jest.fn()} />);
    await act(async () => {
      jest.advanceTimersByTime(999);
    });
    if (action === 'unmount') view.unmount();
    else {
      if (action === 'recover') mockNativeError = null;
      view.rerender(<EvmConnectModal open={action !== 'dismiss'} onOpenChange={jest.fn()} />);
    }
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  });
});
