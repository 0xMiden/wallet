import React from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { WalletAccount } from 'lib/shared/types';

import { DepositBridgeDrawer } from './DepositBridgeDrawer';

// `t(key)` echoes the key so assertions read against raw i18n keys.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key)
  })
}));

// Hand-written module mock: the real barrel pulls the Epoch SDK + viem clients,
// none of which belong in a step-logic test.
const ETH_CONFIG = { id: 'ETH', symbol: 'ETH', decimals: 18, route: 'agglayer', midenFaucetId: '', dustFloor: 0n };
const USDC_CONFIG = {
  id: 'USDC',
  symbol: 'USDC',
  decimals: 18,
  address: '0xusdc',
  route: 'epoch',
  midenFaucetId: '0xfaucet',
  dustFloor: 0n
};

const maxSendableDeposit = jest.fn<Promise<bigint>, [unknown]>(async () => 10n ** 18n);
const estimateDepositGasReserve = jest.fn<Promise<bigint>, [unknown]>(async () => 0n);
const quoteDepositViaEpoch = jest.fn<Promise<{ quoteResult: { tokenOut: string } }>, [unknown]>(async () => ({
  quoteResult: { tokenOut: (10n ** 18n).toString() }
}));
const bridgeDepositViaEpoch = jest.fn<Promise<{ txId: string }>, [{ onRowCreated?: (id: string) => void }]>(
  async args => {
    args.onRowCreated?.('tx-epoch');
    return { txId: 'tx-epoch' };
  }
);
const bridgeDepositViaAgglayer = jest.fn<Promise<{ txId: string }>, [{ onRowCreated?: (id: string) => void }]>(
  async args => {
    args.onRowCreated?.('tx-agg');
    return { txId: 'tx-agg' };
  }
);
const acknowledge = jest.fn(async () => {});

let mockBalances: Record<string, bigint | null> = { ETH: 10n ** 18n, USDC: null };

jest.mock('lib/deposit-bridge', () => ({
  DEPOSIT_TOKEN_IDS: ['ETH', 'USDC'],
  getDepositToken: (id: string) => (id === 'ETH' ? ETH_CONFIG : USDC_CONFIG),
  formatBalance: (value: bigint, decimals: number) => {
    const base = 10n ** BigInt(decimals);
    const whole = value / base;
    const fraction = (value % base).toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : `${whole}`;
  },
  maxSendableDeposit: (args: unknown) => maxSendableDeposit(args),
  estimateDepositGasReserve: (args: unknown) => estimateDepositGasReserve(args),
  quoteDepositViaEpoch: (args: unknown) => quoteDepositViaEpoch(args),
  bridgeDepositViaEpoch: (args: { onRowCreated?: (id: string) => void }) => bridgeDepositViaEpoch(args),
  bridgeDepositViaAgglayer: (args: { onRowCreated?: (id: string) => void }) => bridgeDepositViaAgglayer(args),
  useDepositAddressStore: Object.assign(
    (selector: (state: { balances: Record<string, bigint | null> }) => unknown) => selector({ balances: mockBalances }),
    { getState: () => ({ acknowledge }) }
  )
}));

const navigate = jest.fn();
jest.mock('lib/woozie', () => ({ navigate: (path: string) => navigate(path) }));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticMedium: jest.fn() }));

jest.mock('lib/ui/drawer', () => ({
  Drawer: ({ open, children }: { open: boolean; children: React.ReactNode }) => (
    <div data-testid="drawer" data-open={String(open)}>
      {children}
    </div>
  ),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-content">{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2 data-testid="drawer-title">{children}</h2>
}));

jest.mock('app/icons/v2', () => ({ Icon: () => null, IconName: { ChevronLeft: 'chevron-left' } }));
jest.mock('components/TokenLogo', () => ({ TokenLogo: () => null }));

// The amount field is the shared SelectAmount input; stub it to a plain input so
// the test drives the value contract directly.
jest.mock('screens/send-flow/SelectAmount', () => ({
  SelectAmount: ({
    amount,
    error,
    onAmountChange
  }: {
    amount: string;
    error?: string;
    onAmountChange: (v: string) => void;
  }) => (
    <div>
      <input data-testid="amount-input" value={amount} onChange={e => onAmountChange(e.target.value)} />
      {error && <span data-testid="amount-error">{error}</span>}
    </div>
  )
}));

jest.mock('components/Button', () => ({
  Button: ({
    title,
    disabled,
    onClick,
    ...rest
  }: {
    title: string;
    disabled?: boolean;
    onClick?: () => void;
    'data-testid'?: string;
  }) => (
    <button data-testid={rest['data-testid']} disabled={disabled} onClick={onClick}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'primary' }
}));

// Route is exercised on its own; here it only needs to expose the props the
// drawer computes and a way to fire Confirm.
jest.mock('screens/send-flow/Route', () => ({
  Route: ({
    fastEnabled,
    slowEnabled,
    confirmDisabled,
    providerLabels,
    notice,
    onConfirm
  }: {
    fastEnabled?: boolean;
    slowEnabled: boolean;
    confirmDisabled?: boolean;
    providerLabels?: { fast?: string; slow?: string };
    notice?: React.ReactNode;
    onConfirm: () => void;
  }) => (
    <div
      data-testid="route-step"
      data-fast-enabled={String(fastEnabled)}
      data-slow-enabled={String(slowEnabled)}
      data-confirm-disabled={String(Boolean(confirmDisabled))}
      data-provider-fast={providerLabels?.fast}
      data-provider-slow={providerLabels?.slow}
    >
      <div data-testid="route-notice">{notice}</div>
      <button data-testid="route-confirm" onClick={onConfirm} />
    </div>
  )
}));

const account: WalletAccount = {
  publicKey: 'mtst1qaccount',
  name: 'Account 1',
  isPublic: true,
  type: 0,
  hdIndex: 0,
  evmAddress: '0x1111111111111111111111111111111111111111'
} as unknown as WalletAccount;

/**
 * The amount step renders before `maxSendableDeposit` resolves (Confirm is
 * disabled until it does), so every step-advancing test has to wait for the
 * defaulted amount rather than for the field alone.
 */
const awaitAmountReady = () =>
  waitFor(() => expect(screen.getByTestId('amount-input').getAttribute('value')).not.toBe(''));

const renderDrawer = (props: Partial<React.ComponentProps<typeof DepositBridgeDrawer>> = {}) =>
  render(<DepositBridgeDrawer open onOpenChange={jest.fn()} account={account} {...props} />);

describe('DepositBridgeDrawer', () => {
  beforeEach(() => {
    mockBalances = { ETH: 10n ** 18n, USDC: null };
    maxSendableDeposit.mockClear().mockResolvedValue(10n ** 18n);
    estimateDepositGasReserve.mockClear().mockResolvedValue(0n);
    quoteDepositViaEpoch.mockClear();
    bridgeDepositViaEpoch.mockClear();
    bridgeDepositViaAgglayer.mockClear();
    acknowledge.mockClear();
    navigate.mockClear();
  });

  it('skips the asset step when only one token is funded', async () => {
    renderDrawer();
    await waitFor(() => expect(screen.getByTestId('amount-input')).toBeTruthy());
    expect(screen.queryByTestId('deposit-bridge-asset-ETH')).toBeNull();
  });

  it('skips the asset step when initialToken is given, even with two funded tokens', async () => {
    mockBalances = { ETH: 10n ** 18n, USDC: 5n * 10n ** 18n };
    renderDrawer({ initialToken: 'USDC' });
    await waitFor(() => expect(screen.getByTestId('amount-input')).toBeTruthy());
    expect(maxSendableDeposit).toHaveBeenCalledWith(expect.objectContaining({ token: 'USDC' }));
  });

  it('shows the asset list when two tokens are funded and advances on tap', async () => {
    mockBalances = { ETH: 10n ** 18n, USDC: 5n * 10n ** 18n };
    renderDrawer();
    expect(screen.getByTestId('deposit-bridge-asset-USDC')).toBeTruthy();

    fireEvent.click(screen.getByTestId('deposit-bridge-asset-ETH'));
    await waitFor(() => expect(screen.getByTestId('amount-input')).toBeTruthy());
  });

  it('defaults the amount to the max sendable', async () => {
    maxSendableDeposit.mockResolvedValue(2n * 10n ** 18n);
    renderDrawer();
    await waitFor(() => expect(screen.getByTestId('amount-input').getAttribute('value')).toBe('2'));
  });

  it('blocks confirming and explains when the address cannot cover its own gas', async () => {
    maxSendableDeposit.mockResolvedValue(0n);
    renderDrawer();
    await waitFor(() => expect(screen.getByTestId('deposit-bridge-no-gas')).toBeTruthy());
    expect(screen.getByTestId('deposit-bridge-amount-confirm').hasAttribute('disabled')).toBe(true);
  });

  it('shows the reserved network fee for ETH', async () => {
    estimateDepositGasReserve.mockResolvedValue(10n ** 15n);
    renderDrawer();
    await waitFor(() => expect(screen.getByTestId('deposit-bridge-gas-reserve').textContent).toContain('0.001'));
  });

  it('routes ETH through AggLayer, navigating before the signature resolves', async () => {
    const onOpenChange = jest.fn();
    renderDrawer({ onOpenChange });
    await awaitAmountReady();
    fireEvent.click(screen.getByTestId('deposit-bridge-amount-confirm'));

    const route = await screen.findByTestId('route-step');
    expect(route.getAttribute('data-fast-enabled')).toBe('false');
    expect(route.getAttribute('data-slow-enabled')).toBe('true');
    expect(route.getAttribute('data-provider-slow')).toBe('viaAgglayer');

    fireEvent.click(screen.getByTestId('route-confirm'));

    await waitFor(() => expect(bridgeDepositViaAgglayer).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(navigate).toHaveBeenCalledWith('/generating-transaction/tx-agg');
    await waitFor(() => expect(acknowledge).toHaveBeenCalledWith('ETH'));
  });

  it('does not acknowledge and surfaces the error when the submit fails pre-signature', async () => {
    bridgeDepositViaAgglayer.mockRejectedValue(new Error('vault locked'));
    renderDrawer();
    await awaitAmountReady();
    fireEvent.click(screen.getByTestId('deposit-bridge-amount-confirm'));
    fireEvent.click(await screen.findByTestId('route-confirm'));

    await waitFor(() => expect(screen.getByTestId('deposit-bridge-error').textContent).toContain('vault locked'));
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('quotes the Epoch fee for USDC and keeps Confirm blocked while the quote is in flight', async () => {
    mockBalances = { ETH: null, USDC: 5n * 10n ** 18n };
    maxSendableDeposit.mockResolvedValue(5n * 10n ** 18n);
    renderDrawer({ initialToken: 'USDC' });
    await awaitAmountReady();
    fireEvent.click(screen.getByTestId('deposit-bridge-amount-confirm'));

    const route = await screen.findByTestId('route-step');
    expect(route.getAttribute('data-fast-enabled')).toBe('true');
    expect(route.getAttribute('data-slow-enabled')).toBe('false');
    expect(route.getAttribute('data-confirm-disabled')).toBe('true');

    await waitFor(() => expect(quoteDepositViaEpoch).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('route-step').getAttribute('data-confirm-disabled')).toBe('false'));
  });

  it('disables Confirm and shows the liquidity notice when the quote fails', async () => {
    mockBalances = { ETH: null, USDC: 5n * 10n ** 18n };
    quoteDepositViaEpoch.mockRejectedValue(new Error('no liquidity'));
    renderDrawer({ initialToken: 'USDC' });
    await awaitAmountReady();
    fireEvent.click(screen.getByTestId('deposit-bridge-amount-confirm'));
    await screen.findByTestId('route-step');

    await waitFor(() => expect(screen.getByTestId('route-notice').textContent).toContain('fastRouteUnavailable'));
    expect(screen.getByTestId('route-step').getAttribute('data-confirm-disabled')).toBe('true');
  });

  it('steps back from route to amount', async () => {
    mockBalances = { ETH: 10n ** 18n, USDC: 5n * 10n ** 18n };
    renderDrawer();
    fireEvent.click(screen.getByTestId('deposit-bridge-asset-ETH'));
    await awaitAmountReady();
    fireEvent.click(screen.getByTestId('deposit-bridge-amount-confirm'));
    await screen.findByTestId('route-step');

    fireEvent.click(screen.getByTestId('deposit-bridge-back'));
    expect(screen.getByTestId('amount-input')).toBeTruthy();

    // …and back again from amount to the asset list.
    fireEvent.click(screen.getByTestId('deposit-bridge-back'));
    expect(screen.getByTestId('deposit-bridge-asset-ETH')).toBeTruthy();
  });
});
