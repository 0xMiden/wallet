import React from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { DepositApprove } from './DepositApprove';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key)
  })
}));

let mockSearch = '?token=ETH&amount=5000000000000000000&method=deeplink&wallet=MetaMask';
let mockBalances: Record<string, bigint | null> = { ETH: null, USDC: null };
let mockDetectedArrivals: Array<{ token: string; amount: bigint; balance: bigint }> = [];
let mockArrivals: Array<{ token: string; amount: bigint; balance: bigint }> = [];
const openPaymentDeeplink = jest.fn();
const poll = jest.fn();

jest.mock('lib/deposit-bridge', () => ({
  DEPOSIT_WALLETS: [
    { id: 'metamask', name: 'MetaMask', descriptionKey: 'x', buildUri: () => 'https://link.metamask.io/send/mock' },
    { id: 'default', name: '', descriptionKey: 'y', buildUri: () => 'ethereum:mock' }
  ],
  getDepositToken: (id: string) => ({
    id,
    symbol: id,
    decimals: 18,
    route: 'agglayer',
    dustFloor: 100_000_000_000_000n
  }),
  isDepositTokenId: (value: string) => value === 'ETH' || value === 'USDC',
  openPaymentDeeplink: (uri: string) => openPaymentDeeplink(uri),
  formatBalance: (value: bigint) => (value / 10n ** 18n).toString(),
  useDepositAddressStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      balances: mockBalances,
      arrivals: mockArrivals,
      detectedArrivals: mockDetectedArrivals,
      recentTxs: [],
      poll
    })
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

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('app/icons/v2', () => ({ Icon: () => null, IconName: {} }));
jest.mock('utils/string', () => ({ truncateAddress: (v: string) => `trunc:${v}` }));
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

describe('DepositApprove', () => {
  beforeEach(() => {
    mockSearch = '?token=ETH&amount=5000000000000000000&method=deeplink&wallet=MetaMask';
    mockBalances = { ETH: null, USDC: null };
    mockDetectedArrivals = [];
    mockArrivals = [];
    navigate.mockClear();
    openPaymentDeeplink.mockClear();
    poll.mockClear();
  });

  it('renders as a page with its own header, not inside a sheet', () => {
    render(<DepositApprove />);
    expect(screen.getByTestId('screen-header').textContent).toBe('approveInWalletTitle');
    expect(screen.getByTestId('deposit-approve-in-wallet')).toBeTruthy();
  });

  it('offers to open the named wallet, then to confirm the send once it has been opened', () => {
    render(<DepositApprove />);
    const cta = screen.getByTestId('approve-primary');
    expect(cta.textContent).toContain('MetaMask');

    fireEvent.click(cta);

    expect(openPaymentDeeplink).toHaveBeenCalledWith('https://link.metamask.io/send/mock');
    expect(screen.getByTestId('approve-primary').textContent).toContain('depositSentTheFunds');
  });

  it('only nudges the poll once the user has said they paid', () => {
    render(<DepositApprove />);
    fireEvent.click(screen.getByTestId('approve-primary'));
    expect(poll).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('approve-primary'));
    expect(poll).toHaveBeenCalled();
  });

  it('starts on "I have sent the funds" when nothing was handed to a wallet', () => {
    mockSearch = '?token=ETH&amount=5000000000000000000&method=address';
    render(<DepositApprove />);
    expect(screen.getByTestId('approve-primary').textContent).toContain('depositSentTheFunds');
  });

  it('waits on Sepolia finality before handing off to the review', () => {
    // Seen on-chain, but not yet through the confirmation ticks.
    mockBalances = { ETH: 5n * 10n ** 18n, USDC: null };
    mockDetectedArrivals = [{ token: 'ETH', amount: 5n * 10n ** 18n, balance: 5n * 10n ** 18n }];
    render(<DepositApprove />);

    const cta = screen.getByTestId('approve-primary');
    expect(cta.textContent).toContain('depositFundsDetected');
    // Detection is the wallet's own observation, so there is nothing left to ask for.
    expect(cta.hasAttribute('disabled')).toBe(true);
    // Bridging unconfirmed money is the thing this wait exists to prevent.
    expect(navigate).not.toHaveBeenCalled();
  });

  it('hands off to the review once the arrival is final', async () => {
    mockBalances = { ETH: 5n * 10n ** 18n, USDC: null };
    mockDetectedArrivals = [{ token: 'ETH', amount: 5n * 10n ** 18n, balance: 5n * 10n ** 18n }];
    mockArrivals = mockDetectedArrivals;
    render(<DepositApprove />);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/deposit-bridge/review?token=ETH'));
  });

  it('refuses a request it cannot state — a missing or unusable amount', () => {
    mockSearch = '?token=ETH&method=address';
    render(<DepositApprove />);
    expect(screen.getByTestId('redirect').getAttribute('data-to')).toBe('/receive?tab=crosschain');
  });
});
