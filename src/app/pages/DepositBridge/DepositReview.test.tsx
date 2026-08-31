import React from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { DepositReview } from './DepositReview';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key)
  })
}));

const ETH_CONFIG = { id: 'ETH', symbol: 'ETH', decimals: 18, route: 'agglayer', dustFloor: 0n };
const USDC_CONFIG = { id: 'USDC', symbol: 'USDC', decimals: 18, route: 'epoch', dustFloor: 0n };

let mockSearch = '?token=ETH';
let mockBalances: Record<string, bigint | null> = { ETH: 10n ** 18n, USDC: null };

const maxSendableDeposit = jest.fn<Promise<bigint>, [unknown]>(async () => 10n ** 18n);
const estimateDepositGasReserve = jest.fn<Promise<bigint>, [unknown]>(async () => 0n);
const quoteDepositViaEpoch = jest.fn<Promise<{ quoteResult: { tokenOut: string } }>, [unknown]>(async () => ({
  quoteResult: { tokenOut: (10n ** 18n).toString() }
}));
const bridgeDepositViaEpoch = jest.fn<Promise<void>, [{ onRowCreated?: (id: string) => void }]>(async args => {
  args.onRowCreated?.('tx-epoch');
});
const bridgeDepositViaAgglayer = jest.fn<Promise<void>, [{ onRowCreated?: (id: string) => void }]>(async args => {
  args.onRowCreated?.('tx-agg');
});
const acknowledge = jest.fn(async () => {});
const readPreferredRoute = jest.fn<Promise<string>, [string, string]>(async () => 'agglayer');
const writePreferredRoute = jest.fn<Promise<void>, [string, string, string]>(async () => {});

jest.mock('lib/deposit-bridge', () => ({
  availableRoutes: (id: string) => (id === 'ETH' ? ['agglayer', 'epoch'] : ['epoch']),
  // Shared objects, like the real registry — the page must not care, but a
  // fresh object per call would hide a dependency bug rather than expose one.
  getDepositToken: (id: string) => (id === 'ETH' ? ETH_CONFIG : USDC_CONFIG),
  isDepositTokenId: (value: string) => value === 'ETH' || value === 'USDC',
  formatBalance: (value: bigint, decimals: number) => {
    const base = 10n ** BigInt(decimals);
    const whole = value / base;
    const fraction = (value % base).toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : `${whole}`;
  },
  maxSendableDeposit: (args: unknown) => maxSendableDeposit(args),
  estimateDepositGasReserve: (args: unknown) => estimateDepositGasReserve(args),
  quoteDepositViaEpoch: (args: unknown) => quoteDepositViaEpoch(args),
  readPreferredRoute: (a: string, t: string) => readPreferredRoute(a, t),
  writePreferredRoute: (a: string, t: string, r: string) => writePreferredRoute(a, t, r),
  bridgeDepositViaEpoch: (args: { onRowCreated?: (id: string) => void }) => bridgeDepositViaEpoch(args),
  bridgeDepositViaAgglayer: (args: { onRowCreated?: (id: string) => void }) => bridgeDepositViaAgglayer(args),
  useDepositAddressStore: Object.assign(
    (selector: (state: { balances: Record<string, bigint | null> }) => unknown) => selector({ balances: mockBalances }),
    { getState: () => ({ acknowledge }) }
  )
}));

jest.mock('lib/miden/front', () => ({
  useAccount: () => ({ publicKey: 'mtst1qaccount', evmAddress: '0x1111111111111111111111111111111111111111' })
}));

const navigate = jest.fn();
jest.mock('lib/woozie', () => ({
  navigate: (path: string) => navigate(path),
  goBack: jest.fn(),
  Redirect: ({ to }: { to: string }) => <div data-testid="redirect" data-to={to} />,
  useLocation: () => ({ search: mockSearch })
}));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticMedium: jest.fn() }));
jest.mock('app/icons/v2', () => ({ Icon: () => null, IconName: {} }));
jest.mock('components/TokenLogo', () => ({ TokenLogo: () => null }));
jest.mock('components/ScreenHeader', () => ({
  ScreenHeader: ({ title }: { title: React.ReactNode }) => <h1 data-testid="screen-header">{title}</h1>
}));
jest.mock('components/Button', () => ({
  Button: ({
    title,
    onClick,
    disabled,
    ...rest
  }: {
    title: string;
    onClick?: () => void;
    disabled?: boolean;
    'data-testid'?: string;
  }) => (
    <button data-testid={rest['data-testid']} onClick={onClick} disabled={disabled}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'primary' }
}));

const awaitAmountReady = () => waitFor(() => expect(screen.getByTestId('review-send').textContent).toBeTruthy());

describe('DepositReview', () => {
  beforeEach(() => {
    mockSearch = '?token=ETH';
    mockBalances = { ETH: 10n ** 18n, USDC: null };
    maxSendableDeposit.mockClear().mockResolvedValue(10n ** 18n);
    estimateDepositGasReserve.mockClear().mockResolvedValue(0n);
    quoteDepositViaEpoch.mockClear().mockResolvedValue({ quoteResult: { tokenOut: (10n ** 18n).toString() } });
    bridgeDepositViaEpoch.mockClear();
    bridgeDepositViaAgglayer.mockClear();
    acknowledge.mockClear();
    navigate.mockClear();
    readPreferredRoute.mockClear().mockResolvedValue('agglayer');
    writePreferredRoute.mockClear().mockResolvedValue(undefined);
  });

  it('renders as a page with its own header, not inside a sheet', async () => {
    render(<DepositReview />);
    expect(screen.getByTestId('screen-header').textContent).toBe('reviewBridge');
    await awaitAmountReady();
  });

  it('bridges what arrived less the gas reserve, not what was requested', async () => {
    // 5 ETH was requested on the tab, but only 2 landed.
    maxSendableDeposit.mockResolvedValue(2n * 10n ** 18n);
    render(<DepositReview />);
    await waitFor(() => expect(screen.getByTestId('review-send').textContent).toContain('2 ETH'));
    expect(screen.getByTestId('review-total').textContent).toContain('2 ETH');
  });

  it('delivers the whole amount with no fee on the AggLayer route', async () => {
    render(<DepositReview />);
    await awaitAmountReady();
    expect(screen.getByTestId('review-receive').textContent).toContain('1 ETH');
    expect(screen.getByTestId('review-fee').textContent).toContain('0 ETH');
    expect(quoteDepositViaEpoch).not.toHaveBeenCalled();
  });

  it('shows what arrives and what the solver keeps on the Fast route', async () => {
    readPreferredRoute.mockResolvedValue('epoch');
    quoteDepositViaEpoch.mockResolvedValue({ quoteResult: { tokenOut: (9997n * 10n ** 14n).toString() } });
    render(<DepositReview />);
    await awaitAmountReady();

    await waitFor(() => expect(screen.getByTestId('review-receive').textContent).toContain('0.9997'));
    expect(screen.getByTestId('review-fee').textContent).toContain('0.0003');
  });

  it('changes the route from the review row and remembers the new choice', async () => {
    render(<DepositReview />);
    await awaitAmountReady();

    fireEvent.click(screen.getByTestId('review-route-row'));
    fireEvent.click(await screen.findByTestId('bridge-route-fast'));

    expect(writePreferredRoute).toHaveBeenCalledWith('0x1111111111111111111111111111111111111111', 'ETH', 'epoch');
    await waitFor(() => expect(screen.getByTestId('deposit-review-bridge')).toBeTruthy());
  });

  it('confirms via the saved route and leaves for the progress page before the signature resolves', async () => {
    render(<DepositReview />);
    await awaitAmountReady();

    fireEvent.click(screen.getByTestId('review-confirm-bridge'));

    await waitFor(() => expect(bridgeDepositViaAgglayer).toHaveBeenCalled());
    expect(bridgeDepositViaEpoch).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/generating-transaction/tx-agg');
    await waitFor(() => expect(acknowledge).toHaveBeenCalledWith('ETH'));
  });

  it('does not acknowledge and surfaces the error when the submit fails pre-signature', async () => {
    bridgeDepositViaAgglayer.mockRejectedValue(new Error('vault locked'));
    render(<DepositReview />);
    await awaitAmountReady();

    fireEvent.click(screen.getByTestId('review-confirm-bridge'));

    await waitFor(() => expect(screen.getByTestId('deposit-bridge-error').textContent).toContain('vault locked'));
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('blocks confirming when the address cannot cover its own gas', async () => {
    maxSendableDeposit.mockResolvedValue(0n);
    render(<DepositReview />);
    await waitFor(() => expect(screen.getByTestId('deposit-bridge-no-gas')).toBeTruthy());
    expect(screen.getByTestId('review-confirm-bridge').hasAttribute('disabled')).toBe(true);
  });

  it('refuses a token it cannot resolve', () => {
    mockSearch = '?token=DOGE';
    render(<DepositReview />);
    expect(screen.getByTestId('redirect').getAttribute('data-to')).toBe('/receive?tab=crosschain');
  });
});
