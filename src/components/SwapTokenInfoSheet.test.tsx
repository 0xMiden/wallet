import React from 'react';

import { fireEvent, render, screen, within } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';
import { testnetTokenInfo } from 'lib/remote-config/token-labels';

import { SwapTokenInfoButton } from './SwapTokenInfoSheet';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { token?: string }) => (opts?.token ? `${key}:${opts.token}` : key)
  })
}));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

jest.mock('app/providers/DappBrowserProvider', () => ({ useHideForegroundDappWhileOpen: jest.fn() }));

// The real icon set, each glyph tagged with its name so a test can say which one a row leads with.
jest.mock('app/icons/v2', () => ({
  ...jest.requireActual('app/icons/v2'),
  Icon: ({ name }: { name: string }) => <svg data-icon={name} />
}));

// Vaul renders through a portal jsdom cannot drive; a flat stand-in that renders children only while
// open is enough for the open/close wiring. The description keeps its className, so its variant is assertable.
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DrawerDescription: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <p className={className}>{children}</p>
  ),
  DrawerFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}));

jest.mock('lib/remote-config/token-labels', () => ({ testnetTokenInfo: jest.fn() }));

beforeEach(() => jest.clearAllMocks());

describe('SwapTokenInfoButton', () => {
  it('renders nothing for a token without info', () => {
    jest.mocked(testnetTokenInfo).mockReturnValue(null);
    render(<SwapTokenInfoButton faucetId="mtst1other" label="MIDEN" />);
    expect(screen.queryByTestId('swap-token-info-button')).not.toBeInTheDocument();
    expect(testnetTokenInfo).toHaveBeenCalledWith('mtst1other');
  });

  it('opens a sheet naming the token, what it is and where the swap executes', () => {
    jest.mocked(testnetTokenInfo).mockReturnValue({
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

  it('sets where the swap executes as a plain fact row under the caption description, as the network sheet does', () => {
    jest.mocked(testnetTokenInfo).mockReturnValue({
      descriptionKey: 'testIethDescription',
      executionKey: 'testIethExecution'
    });
    render(<SwapTokenInfoButton faucetId="mtst1ieth" label="Test iETH" />);
    fireEvent.click(screen.getByTestId('swap-token-info-button'));

    // The drawer's own caption: the execution fact follows it, so it is not the sheet's whole message.
    expect(screen.getByText('testIethDescription')).not.toHaveClass('text-body-strong');

    const list = within(screen.getByTestId('swap-token-info-sheet')).getByRole('list');
    expect(list).not.toHaveClass('bg-fill');
    expect(list).toHaveClass('[&>*]:before:left-[var(--row-flush-inset,0px)]');
    const [row] = within(list).getAllByRole('listitem');
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(row).toHaveAttribute('data-slot', 'fact-row');
    expect(within(row).getByRole('heading', { level: 3 })).toHaveTextContent('swapExecutionTitle');
    expect(row).toHaveTextContent('testIethExecution');

    // Led by the swap action's own glyph, in its colour.
    const icon = row.querySelector('[data-slot="icon"]');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon).toHaveClass('text-action-swap');
    expect(icon?.querySelector('svg')).toHaveAttribute('data-icon', 'convert');
  });
});
