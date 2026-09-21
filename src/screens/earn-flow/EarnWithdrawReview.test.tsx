import React from 'react';

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

import { gaslessEarnWithdrawalToMiden } from 'lib/epoch';
import { hapticLight } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';
import { goBack, navigate } from 'lib/woozie';

import EarnWithdrawReview from './EarnWithdrawReview';
import type { EarnPosition } from './types';

const mockAccount: { publicKey: string; evmAddress?: string } = {
  publicKey: 'miden-account',
  evmAddress: '0x1111111111111111111111111111111111111111'
};
let mockPositions: EarnPosition[] = [];

// `PageHeader` (real, unmocked below) calls `useTranslation` for its back
// button's accessible name; without this the un-initialized react-i18next
// instance warns on every render and `t('back')` falls back to the key.
// Mocking it keeps that fallback deterministic instead of implicit.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/miden/front', () => ({
  useAccount: () => mockAccount
}));

jest.mock('lib/epoch', () => ({
  gaslessEarnWithdrawalToMiden: jest.fn()
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

jest.mock('lib/platform', () => ({
  isMobile: jest.fn(() => false)
}));

jest.mock('lib/woozie', () => ({
  goBack: jest.fn(),
  navigate: jest.fn()
}));

jest.mock('./useEarnPositions', () => ({
  useEarnPositions: () => ({
    summary: { totalRewards: '', blendedApy: '', totalDeposited: '', estimatedRewards: '' },
    positions: mockPositions,
    vaults: [],
    isLoading: false,
    error: undefined
  })
}));

jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: { ChevronLeft: 'ChevronLeft' }
}));

jest.mock('components/Button', () => ({
  Button: ({
    title,
    onClick,
    disabled
  }: {
    title?: string;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'Primary' }
}));

jest.mock('components/TokenLogo', () => ({
  TokenLogo: ({ symbol }: { symbol: string }) => <span data-testid="token-logo">{symbol}</span>
}));

// `./components` imports the Aave logo as `...aave.svg?url`, a webpack query jest's `\.svg$` mapper
// does not match. Stub the shared earn widgets this page uses to probes that keep their wiring
// assertable (mirrors the sibling earn-flow tests).
jest.mock('./components', () => {
  const R = require('react');
  return {
    __esModule: true,
    earnSubjectTitle: ({ protocol, asset }: { protocol: string; asset: string }) => `${protocol} \u2022 ${asset}`,
    EarnAssetMark: ({ asset, network }: { asset: string; network: string }) =>
      R.createElement(
        'span',
        { 'data-testid': 'earn-asset-mark', 'data-asset': asset, 'data-network': network },
        'earnAssetOnNetwork'
      ),
    EarnAmountUnit: ({ symbol }: { symbol: string }) =>
      R.createElement('span', { 'data-testid': 'token-logo' }, symbol),
    EarnHero: ({
      labelId,
      value,
      unit,
      label
    }: {
      labelId: string;
      value: string;
      unit?: React.ReactNode;
      label: string;
    }) =>
      R.createElement(
        'section',
        { 'data-testid': 'earn-hero', id: labelId },
        R.createElement('span', null, value),
        unit,
        R.createElement('span', null, label)
      )
  };
});

const position: EarnPosition = {
  id: 'position-1',
  vaultId: 'vault-1',
  owner: '0x1111111111111111111111111111111111111111',
  marketUid: 'DUMMY_LENDING:11155111:0xasset',
  chainId: '11155111',
  underlyingAddress: '0xasset',
  withdrawable: '42.25',
  decimals: 6,
  protocol: 'Aave',
  asset: 'USDC',
  network: 'Sepolia',
  amount: '$42.25',
  depositedAmount: '$40.00',
  rewards: '+$2.25',
  age: '1d',
  activeDuration: '1 day active',
  apy: '5%',
  dailyAverage: '+$0.01',
  started: 'Jul 28',
  yearlyEstimate: '+$2 / yr',
  withdrawTime: '~1 minute',
  route: 'Miden -> Aave (Sepolia)',
  chartData: [{ label: 'now', value: 42.25 }]
};

describe('EarnWithdrawReview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAccount.evmAddress = position.owner;
    mockPositions = [position];
    jest.mocked(isMobile).mockReturnValue(false);
    jest.mocked(gaslessEarnWithdrawalToMiden).mockResolvedValue({
      txId: 'tx-id',
      nonce: 'owner:1',
      gaslessUsed: true
    });
  });

  it('renders the selected position and the full-withdraw route details', () => {
    render(<EarnWithdrawReview positionId="position-1" />);

    expect(screen.getByTestId('earn-withdraw-review-page')).toBeInTheDocument();
    expect(screen.getByRole('heading')).toHaveTextContent('Aave • USDC');
    // The asset and its network ride the header as the shared mark, the same one the vault and
    // deposit pages carry, rather than a page-local pill.
    const mark = screen.getByTestId('earn-asset-mark');
    expect(mark).toHaveAttribute('data-asset', 'USDC');
    expect(mark).toHaveAttribute('data-network', 'Sepolia');
    expect(screen.getByRole('banner')).toContainElement(mark);
    expect(screen.getByText('42.25')).toBeInTheDocument();
    expect(screen.getByTestId('token-logo')).toHaveTextContent('USDC');
    expect(screen.getByText('Aave (Sepolia) -> Miden')).toBeInTheDocument();
    expect(screen.getByText('earnFullPositionGasless')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'withdraw' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'back' }));
    expect(goBack).toHaveBeenCalledTimes(1);
  });

  it('falls back to an empty position and disables withdrawal for an unknown id', () => {
    render(<EarnWithdrawReview positionId="unknown" />);

    expect(screen.getByText('0.00')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'withdraw' })).toBeDisabled();
  });

  it('submits the full position and routes as soon as the tracking row exists', async () => {
    jest.mocked(gaslessEarnWithdrawalToMiden).mockImplementation(async args => {
      args.onRowCreated?.('tx/1');
      return { txId: 'tx/1', nonce: 'owner:1', gaslessUsed: true };
    });
    render(<EarnWithdrawReview positionId="position-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'withdraw' }));

    // No haptic of its own: the shared `Button` fires the tap haptic, and a second call buzzed twice.
    expect(hapticLight).not.toHaveBeenCalled();
    await waitFor(() => expect(gaslessEarnWithdrawalToMiden).toHaveBeenCalledTimes(1));
    expect(gaslessEarnWithdrawalToMiden).toHaveBeenCalledWith({
      midenAccountPublicKey: 'miden-account',
      evmAddress: position.owner,
      marketUid: position.marketUid,
      underlyingAddress: position.underlyingAddress,
      amount: '42.25',
      underlyingDecimals: 6,
      onRowCreated: expect.any(Function)
    });
    expect(navigate).toHaveBeenCalledWith('/earn/withdraw-status/tx%2F1');
  });

  it('rejects a position not owned by the current wallet account', async () => {
    mockAccount.evmAddress = '0x2222222222222222222222222222222222222222';
    render(<EarnWithdrawReview positionId="position-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'withdraw' }));

    expect(await screen.findByText('earnWithdrawNotOwned')).toBeInTheDocument();
    expect(gaslessEarnWithdrawalToMiden).not.toHaveBeenCalled();
  });

  it('handles an account without a derived EVM address', async () => {
    mockAccount.evmAddress = undefined;
    render(<EarnWithdrawReview positionId="position-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'withdraw' }));

    expect(await screen.findByText('earnWithdrawNotOwned')).toBeInTheDocument();
    expect(gaslessEarnWithdrawalToMiden).not.toHaveBeenCalled();
  });

  it('surfaces SDK errors and restores the CTA', async () => {
    jest.mocked(gaslessEarnWithdrawalToMiden).mockRejectedValue(new Error('intent unavailable'));
    render(<EarnWithdrawReview positionId="position-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'withdraw' }));

    expect(await screen.findByText('intent unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'withdraw' })).toBeEnabled();
  });

  it('uses the fallback message for non-Error failures', async () => {
    jest.mocked(gaslessEarnWithdrawalToMiden).mockRejectedValue('failed');
    render(<EarnWithdrawReview positionId="position-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'withdraw' }));

    expect(await screen.findByText('earnGaslessWithdrawalFailed')).toBeInTheDocument();
  });

  // Double-tapping the CTA must not submit two redemption intents.
  it('ignores a second tap while the first withdrawal is in flight', async () => {
    let release: (value: { txId: string; nonce: string; gaslessUsed: boolean }) => void = () => {};
    jest.mocked(gaslessEarnWithdrawalToMiden).mockImplementation(() => new Promise(resolve => (release = resolve)));
    render(<EarnWithdrawReview positionId="position-1" />);

    const cta = screen.getByRole('button', { name: 'withdraw' });
    fireEvent.click(cta);
    fireEvent.click(cta);

    expect(gaslessEarnWithdrawalToMiden).toHaveBeenCalledTimes(1);
    await act(async () => {
      release({ txId: 'tx-1', nonce: 'owner:1', gaslessUsed: true });
    });
  });

  it('pins the CTA in the shared frame footer, on the page margin rather than a per-platform one', () => {
    jest.mocked(isMobile).mockReturnValue(true);
    render(<EarnWithdrawReview positionId="position-1" />);

    const footer = screen.getByRole('button', { name: 'withdraw' }).parentElement;
    expect(footer).toHaveAttribute('data-slot', 'footer');
    // The 16px page margin every page takes, not the 24/32px this page used to pick by platform.
    expect(footer).toHaveClass('px-4', 'shrink-0');
    expect(footer?.className).not.toMatch(/px-6|px-8/);
  });
});
