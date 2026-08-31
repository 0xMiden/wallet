import React from 'react';

import { render, screen } from '@testing-library/react';

import { ApproveInWallet } from './ApproveInWallet';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key)
  })
}));

jest.mock('lib/deposit-bridge', () => ({
  formatBalance: (value: bigint, decimals: number) => {
    const base = 10n ** BigInt(decimals);
    const whole = value / base;
    const fraction = (value % base).toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : `${whole}`;
  }
}));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('app/icons/v2', () => ({ Icon: () => null, IconName: {} }));
jest.mock('utils/string', () => ({ truncateAddress: (value: string) => `trunc:${value}` }));

jest.mock('components/Button', () => ({
  Button: ({ title, onClick, ...rest }: { title: string; onClick?: () => void; 'data-testid'?: string }) => (
    <button data-testid={rest['data-testid']} onClick={onClick}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'primary' }
}));

const ETH = { id: 'ETH', symbol: 'ETH', decimals: 18, route: 'agglayer', midenFaucetId: '', dustFloor: 0n } as const;
const ADDRESS = '0x1111111111111111111111111111111111111111';

const renderScreen = (props: Partial<React.ComponentProps<typeof ApproveInWallet>> = {}) =>
  render(
    <ApproveInWallet
      token={ETH}
      amount={5n * 10n ** 18n}
      evmAddress={ADDRESS}
      method="deeplink"
      walletName="MetaMask"
      onPrimary={jest.fn()}
      onCancel={jest.fn()}
      {...props}
    />
  );

describe('ApproveInWallet', () => {
  it('states the requested amount and the address it is owed to', () => {
    renderScreen();
    expect(screen.getByTestId('approve-amount').textContent).toBe('5 ETH');
    expect(screen.getByTestId('approve-to').textContent).toBe(`trunc:${ADDRESS}`);
  });

  it('offers to re-open the named wallet on the deeplink method', () => {
    renderScreen();
    expect(screen.getByTestId('approve-primary').textContent).toContain('MetaMask');
  });

  it('asks the user to confirm they paid when nothing was handed to a wallet', () => {
    renderScreen({ method: 'address', walletName: undefined });
    expect(screen.getByTestId('approve-primary').textContent).toContain('depositSentTheFunds');
  });

  it('does not claim a wallet was asked to approve when none was', () => {
    renderScreen({ method: 'address', walletName: undefined });
    // The approve copy names a wallet; the address variant must not borrow it.
    expect(screen.queryByText(/approveInWallet/)).toBeNull();
  });

  it('advances the step ladder once the payment is seen on-chain', () => {
    const { container, rerender } = renderScreen({ confirming: false });
    const completeBefore = container.querySelectorAll('.bg-status-positive').length;

    rerender(
      <ApproveInWallet
        token={ETH}
        amount={5n * 10n ** 18n}
        evmAddress={ADDRESS}
        method="deeplink"
        walletName="MetaMask"
        confirming
        onPrimary={jest.fn()}
        onCancel={jest.fn()}
      />
    );

    expect(container.querySelectorAll('.bg-status-positive').length).toBeGreaterThan(completeBefore);
  });

  it('shows the bridge fee only when there is one to show', () => {
    expect(screen.queryByTestId('approve-bridge-fee')).toBeNull();
    renderScreen({ bridgeFeeText: '0.0003 ETH' });
    expect(screen.getByTestId('approve-bridge-fee').textContent).toBe('0.0003 ETH');
  });
});
