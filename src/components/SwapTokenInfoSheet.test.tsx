import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { swapTokenInfo } from 'lib/miden/swap/token-info';
import { hapticLight } from 'lib/mobile/haptics';

import { SwapTokenInfoButton } from './SwapTokenInfoSheet';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { token?: string }) => (opts?.token ? `${key}:${opts.token}` : key)
  })
}));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

jest.mock('app/providers/DappBrowserProvider', () => ({ useHideForegroundDappWhileOpen: jest.fn() }));

// Vaul renders through a portal jsdom cannot drive; a flat stand-in that renders children only while
// open is enough for the open/close wiring.
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DrawerDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DrawerFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}));

jest.mock('lib/miden/swap/token-info', () => ({ swapTokenInfo: jest.fn() }));

beforeEach(() => jest.clearAllMocks());

describe('SwapTokenInfoButton', () => {
  it('renders nothing for a token without info', () => {
    jest.mocked(swapTokenInfo).mockReturnValue(null);
    render(<SwapTokenInfoButton faucetId="mtst1other" label="MIDEN" />);
    expect(screen.queryByTestId('swap-token-info-button')).not.toBeInTheDocument();
    expect(swapTokenInfo).toHaveBeenCalledWith('mtst1other');
  });

  it('opens a sheet naming the token, what it is and where the swap executes', () => {
    jest.mocked(swapTokenInfo).mockReturnValue({
      descriptionKey: 'testIethDescription',
      executionKey: 'testIethExecution'
    });
    render(<SwapTokenInfoButton faucetId="mtst1ieth" label="Test iETH" />);

    const button = screen.getByTestId('swap-token-info-button');
    expect(button).toHaveAttribute('aria-label', 'tokenInfoLabel:Test iETH');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('swap-token-info-sheet')).not.toBeInTheDocument();
    expect(hapticLight).not.toHaveBeenCalled();
    fireEvent.click(button);

    expect(hapticLight).toHaveBeenCalled();
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('heading', { name: 'Test iETH' })).toBeInTheDocument();
    expect(screen.getByText('testIethDescription')).toBeInTheDocument();
    expect(screen.getByText('swapExecutionTitle')).toBeInTheDocument();
    expect(screen.getByText('testIethExecution')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('swap-token-info-sheet-cta'));
    expect(screen.queryByTestId('swap-token-info-sheet')).not.toBeInTheDocument();
  });
});
