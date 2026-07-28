import React from 'react';

import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { gaslessEarnWithdrawalToMiden } from 'lib/epoch';
import { hapticLight } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';

import EarnWithdrawReview from './EarnWithdrawReview';

// --- woozie router: spyable navigate + goBack.
const mockNavigate = jest.fn();
const mockGoBack = jest.fn();

jest.mock('lib/woozie', () => ({
  navigate: (...args: unknown[]) => mockNavigate(...args),
  goBack: (...args: unknown[]) => mockGoBack(...args)
}));

// --- Platform / haptics.
jest.mock('lib/platform', () => ({
  isMobile: jest.fn(() => false)
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

// --- Epoch SDK barrel: only the gasless withdrawal entry point is used here.
jest.mock('lib/epoch', () => ({
  gaslessEarnWithdrawalToMiden: jest.fn(() => Promise.resolve())
}));

// --- Wallet context: the screen needs the account's EVM address (must match
//     the position owner) plus the miden public key for the intent.
const mockAccount: { publicKey: string; evmAddress?: string } = {
  publicKey: 'mm1testaccount',
  evmAddress: '0xowner'
};

jest.mock('lib/miden/front', () => ({
  useAccount: () => mockAccount
}));

// --- Live earn data: serve a single controllable position.
const mockPosition = {
  id: 'aave-usdc-1',
  owner: '0xOwner',
  marketUid: 'market-1',
  underlyingAddress: '0xunderlying',
  withdrawable: '1024.5',
  decimals: 6,
  protocol: 'Aave',
  asset: 'USDC',
  network: 'Ethereum'
};

const mockPositions: (typeof mockPosition)[] = [mockPosition];

jest.mock('./useEarnPositions', () => ({
  useEarnPositions: () => ({
    positions: mockPositions,
    isLoading: false,
    error: undefined
  })
}));

// --- Presentational children: keep just enough to assert the wiring.
jest.mock('components/TokenLogo', () => ({
  TokenLogo: ({ symbol, size }: { symbol: string; size?: string }) => (
    <span data-testid="token-logo" data-symbol={symbol} data-size={size} />
  )
}));

jest.mock('components/CircleButton', () => ({
  CircleButton: ({ onClick, 'aria-label': ariaLabel }: { onClick?: () => void; 'aria-label'?: string }) => (
    <button data-testid="back-btn" aria-label={ariaLabel} onClick={onClick} />
  )
}));

jest.mock('components/Button', () => ({
  Button: ({ title, onClick, disabled }: { title?: string; onClick?: () => void; disabled?: boolean }) => (
    <button data-testid="withdraw-btn" onClick={onClick} disabled={disabled}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'Primary', Secondary: 'Secondary', Ghost: 'Ghost' }
}));

const mockWithdraw = gaslessEarnWithdrawalToMiden as jest.Mock;

describe('EarnWithdrawReview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAccount.evmAddress = '0xowner';
    mockPositions.length = 0;
    mockPositions.push({ ...mockPosition });
    (isMobile as jest.Mock).mockReturnValue(false);
    mockWithdraw.mockResolvedValue(undefined);
  });

  it('renders the page shell, amount, asset logo and translated detail rows', () => {
    render(<EarnWithdrawReview positionId="aave-usdc-1" />);

    expect(screen.getByTestId('earn-withdraw-review-page')).toBeInTheDocument();

    // Amount formatted to 2dp.
    expect(screen.getByText('1024.50')).toBeInTheDocument();
    const logo = screen.getByTestId('token-logo');
    expect(logo).toHaveAttribute('data-symbol', 'USDC');

    // Translated labels are keyed (react-i18next returns the key with no provider).
    expect(screen.getByText('earnWithdrawAmount')).toBeInTheDocument();
    expect(screen.getByText('route')).toBeInTheDocument();
    expect(screen.getByText('positionOwnerLabel')).toBeInTheDocument();
    expect(screen.getByText('earnWithdrawalLabel')).toBeInTheDocument();
    expect(screen.getByText('earnFullPositionGasless')).toBeInTheDocument();
    expect(screen.getByText('earnEstimatedTimeLabel')).toBeInTheDocument();
    expect(screen.getByText('earnEstimatedTimeOneMinute')).toBeInTheDocument();

    // CTA and back button use keyed labels.
    expect(screen.getByTestId('withdraw-btn')).toHaveTextContent('withdraw');
    expect(screen.getByTestId('back-btn')).toHaveAttribute('aria-label', 'back');
  });

  it('goes back when the header button is pressed', () => {
    render(<EarnWithdrawReview positionId="aave-usdc-1" />);
    fireEvent.click(screen.getByTestId('back-btn'));
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('fires haptics and submits the gasless withdrawal for the matching owner', async () => {
    render(<EarnWithdrawReview positionId="aave-usdc-1" />);

    const cta = screen.getByTestId('withdraw-btn');
    expect(cta).toBeEnabled();
    fireEvent.click(cta);

    expect(hapticLight).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockWithdraw).toHaveBeenCalledTimes(1));

    const call = mockWithdraw.mock.calls[0]![0];
    // Owner match is case-insensitive.
    expect(call.evmAddress).toBe('0xowner');
    expect(call.midenAccountPublicKey).toBe('mm1testaccount');
    expect(call.marketUid).toBe('market-1');
  });

  it('routes to the withdraw-status page as soon as the tx row exists', async () => {
    mockWithdraw.mockImplementation((args: { onRowCreated: (txId: string) => void }) => {
      args.onRowCreated('tx/1');
      return Promise.resolve();
    });

    render(<EarnWithdrawReview positionId="aave-usdc-1" />);
    fireEvent.click(screen.getByTestId('withdraw-btn'));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/earn/withdraw-status/tx%2F1'));
  });

  it('surfaces the translated not-owned error and never calls the SDK on an owner mismatch', async () => {
    mockAccount.evmAddress = '0xsomeoneelse';
    render(<EarnWithdrawReview positionId="aave-usdc-1" />);

    fireEvent.click(screen.getByTestId('withdraw-btn'));

    expect(await screen.findByText('earnWithdrawNotOwned')).toBeInTheDocument();
    expect(mockWithdraw).not.toHaveBeenCalled();
  });

  it('surfaces the SDK error message when the withdrawal rejects', async () => {
    mockWithdraw.mockRejectedValue(new Error('intent broadcast failed'));
    render(<EarnWithdrawReview positionId="aave-usdc-1" />);

    fireEvent.click(screen.getByTestId('withdraw-btn'));

    expect(await screen.findByText('intent broadcast failed')).toBeInTheDocument();
  });

  it('falls back to the translated generic error when the rejection is not an Error', async () => {
    mockWithdraw.mockRejectedValue('boom');
    render(<EarnWithdrawReview positionId="aave-usdc-1" />);

    fireEvent.click(screen.getByTestId('withdraw-btn'));

    expect(await screen.findByText('earnGaslessWithdrawalFailed')).toBeInTheDocument();
  });

  it('uses mobile horizontal padding when isMobile() is true', () => {
    (isMobile as jest.Mock).mockReturnValue(true);
    render(<EarnWithdrawReview positionId="aave-usdc-1" />);
    const footer = screen.getByTestId('withdraw-btn').parentElement!;
    expect(footer).toHaveClass('px-8');
    expect(footer).not.toHaveClass('px-6');
  });
});
