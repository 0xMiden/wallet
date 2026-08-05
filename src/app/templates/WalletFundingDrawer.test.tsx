import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import type { WalletFundingState } from 'lib/wallet-funding';

import { WalletFundingDrawer } from './WalletFundingDrawer';

const mockCloseWalletFunding = jest.fn();
const mockRetryWalletFunding = jest.fn();
const mockStartWalletFunding = jest.fn();
const mockRegisterBackHandler = jest.fn();
const mockUnregisterBackHandler = jest.fn();
let mockBackHandler = () => {};
const mockFundingState: WalletFundingState = { open: true, status: 'idle', address: 'account-a', error: null };

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('app/env', () => ({
  useAppEnv: () => ({ registerBackHandler: mockRegisterBackHandler })
}));

jest.mock('lib/wallet-funding', () => ({
  closeWalletFunding: () => mockCloseWalletFunding(),
  retryWalletFunding: () => mockRetryWalletFunding(),
  startWalletFunding: () => mockStartWalletFunding(),
  useWalletFunding: () => mockFundingState
}));

jest.mock('lib/ui/drawer', () => ({
  Drawer: ({
    open,
    onOpenChange,
    children
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: React.ReactNode;
  }) => (
    <div data-testid="drawer" data-open={String(open)}>
      <button type="button" onClick={() => onOpenChange(false)}>
        drawer-close
      </button>
      <button type="button" onClick={() => onOpenChange(true)}>
        drawer-open
      </button>
      {children}
    </div>
  ),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerFooter: ({ children }: { children: React.ReactNode }) => <footer>{children}</footer>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>
}));

jest.mock('components/Button', () => ({
  Button: ({ title, onClick }: { title: string; onClick: () => void }) => (
    <button type="button" onClick={onClick}>
      {title}
    </button>
  )
}));

jest.mock('components/Loader', () => ({ Loader: () => <div data-testid="loader" /> }));
jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <div data-testid={`icon-${name}`} />,
  IconName: { Checkmark: 'Checkmark', Close: 'Close' }
}));

describe('WalletFundingDrawer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFundingState.open = true;
    mockFundingState.status = 'idle';
    mockFundingState.address = 'account-a';
    mockFundingState.error = null;
    mockStartWalletFunding.mockResolvedValue(undefined);
    mockRetryWalletFunding.mockResolvedValue(undefined);
    mockRegisterBackHandler.mockImplementation((handler: () => void) => {
      mockBackHandler = handler;
      return mockUnregisterBackHandler;
    });
  });

  it('starts automatically on mount and lets the user hide the drawer', () => {
    const { unmount } = render(<WalletFundingDrawer />);

    expect(mockStartWalletFunding).toHaveBeenCalledTimes(1);
    expect(screen.getByText('walletFundingLoadingTitle')).toBeInTheDocument();
    expect(screen.getByText('walletFundingLoadingBody')).toBeInTheDocument();
    expect(screen.getByTestId('loader')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'drawer-open' }));
    expect(mockCloseWalletFunding).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'drawer-close' }));
    expect(mockCloseWalletFunding).toHaveBeenCalledTimes(1);

    act(() => mockBackHandler());
    expect(mockCloseWalletFunding).toHaveBeenCalledTimes(2);
    unmount();
    expect(mockUnregisterBackHandler).toHaveBeenCalledTimes(1);
  });

  it('shows success until the user closes it', () => {
    mockFundingState.status = 'success';
    render(<WalletFundingDrawer />);

    expect(screen.getByText('walletFundingSuccessTitle')).toBeInTheDocument();
    expect(screen.getByText('walletFundingSuccessBody')).toBeInTheDocument();
    expect(screen.getByTestId('icon-Checkmark')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'done' }));
    expect(mockCloseWalletFunding).toHaveBeenCalledTimes(1);
  });

  it('shows the API error and offers retry', () => {
    mockFundingState.status = 'failure';
    mockFundingState.error = 'Account is rate limited';
    render(<WalletFundingDrawer />);

    expect(screen.getByText('walletFundingFailureTitle')).toBeInTheDocument();
    expect(screen.getByText('walletFundingFailureBody')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Account is rate limited');
    expect(screen.getByTestId('icon-Close')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'tryAgain' }));
    expect(mockRetryWalletFunding).toHaveBeenCalledTimes(1);
  });
});
