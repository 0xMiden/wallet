import React from 'react';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { DepositTokenSheet, type DepositTokenOption, type DepositTokenSheetProps } from './DepositTokenSheet';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key} ${JSON.stringify(params)}` : key)
  })
}));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticSelection: jest.fn() }));
jest.mock('components/TokenLogo', () => ({
  TokenLogo: ({ faucetId }: { faucetId: string | undefined }) => <span data-testid={`logo-${faucetId}`} />
}));
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>
}));

const ETHEREUM = { id: 'ethereum', name: 'Ethereum' };
const BASE = { id: 'base', name: 'Base' };
const TOKENS: DepositTokenOption[] = [
  { id: '1:ETH', symbol: 'ETH', receivedSymbol: 'ETH', logoFaucetId: 'eth', network: ETHEREUM },
  { id: '1:USDC', symbol: 'USDC', receivedSymbol: 'USDCx', logoFaucetId: 'usdcx', network: ETHEREUM },
  { id: '8453:USDC', symbol: 'USDC', receivedSymbol: 'USDCx', logoFaucetId: 'usdcx', network: BASE }
];

const props = (overrides: Partial<DepositTokenSheetProps> = {}): DepositTokenSheetProps => ({
  open: true,
  onOpenChange: jest.fn(),
  networks: [ETHEREUM, BASE],
  networkId: 'ethereum',
  tokens: TOKENS,
  selectedId: '1:ETH',
  onSelect: jest.fn(),
  ...overrides
});

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('DepositTokenSheet', () => {
  it('lists the tokens of the current network under "Deposit in Bread", the current one checked', () => {
    render(<DepositTokenSheet {...props()} />);

    expect(screen.getByRole('heading', { name: 'selectAToken' })).toBeInTheDocument();
    expect(screen.getByTestId('deposit-token-network-ethereum')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('deposit-token-list')).toHaveTextContent('depositFlowTokenGroupInBread');
    expect(screen.getByTestId('deposit-token-1:ETH')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('deposit-token-1:USDC')).toHaveTextContent('depositFlowTokenArrivesAs {"token":"USDCx"}');
    expect(screen.queryByTestId('deposit-token-8453:USDC')).not.toBeInTheDocument();
  });

  it('shows another network from its chip and picks a token there', () => {
    const onSelect = jest.fn();
    render(<DepositTokenSheet {...props({ onSelect })} />);

    fireEvent.click(screen.getByTestId('deposit-token-network-base'));
    expect(screen.getByTestId('deposit-token-network-base')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('deposit-token-8453:USDC'));
    expect(onSelect).toHaveBeenCalledWith('8453:USDC');
  });

  it('searches every network by token, received token or network, and hides the chips', () => {
    render(<DepositTokenSheet {...props()} />);

    fireEvent.change(screen.getByTestId('deposit-token-search'), { target: { value: 'usdcx' } });
    expect(screen.queryByTestId('deposit-token-networks')).not.toBeInTheDocument();
    expect(screen.getByTestId('deposit-token-8453:USDC')).toHaveTextContent(
      'depositFlowTokenOnNetworkArrivesAs {"network":"Base","token":"USDCx"}'
    );
    expect(screen.queryByTestId('deposit-token-1:ETH')).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId('deposit-token-search'), { target: { value: 'base' } });
    expect(screen.getAllByRole('button', { pressed: false }).map(button => button.dataset.testid)).toContain(
      'deposit-token-8453:USDC'
    );
  });

  it('says when nothing matches', () => {
    render(<DepositTokenSheet {...props()} />);

    fireEvent.change(screen.getByTestId('deposit-token-search'), { target: { value: ' doge ' } });
    expect(screen.getByTestId('deposit-token-no-match')).toHaveTextContent('depositFlowTokenNoMatch {"query":"doge"}');
    expect(screen.getByTestId('deposit-token-list')).not.toHaveTextContent('depositFlowTokenGroupInBread');
  });

  it('starts on the current network with an empty search each time it opens', () => {
    const { rerender } = render(<DepositTokenSheet {...props()} />);
    fireEvent.click(screen.getByTestId('deposit-token-network-base'));
    fireEvent.change(screen.getByTestId('deposit-token-search'), { target: { value: 'eth' } });

    rerender(<DepositTokenSheet {...props({ open: false })} />);
    rerender(<DepositTokenSheet {...props()} />);
    expect(screen.getByTestId('deposit-token-search')).toHaveValue('');
    expect(screen.getByTestId('deposit-token-network-ethereum')).toHaveAttribute('aria-pressed', 'true');
  });

  it('offers no connect-wallet action', () => {
    render(<DepositTokenSheet {...props()} />);

    expect(screen.queryByText('depositFlowConnectWalletInstead')).not.toBeInTheDocument();
  });
});
