import React from 'react';

import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';

import { gaslessEarnWithdrawalToMiden } from 'lib/epoch';
import { withdrawalAmount } from 'lib/epoch/withdraw-amount';
import { hapticLight } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';
import { goBack, navigate } from 'lib/woozie';

import { EARN_PLACEHOLDER } from './earn-mapping';
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
// The network banner now tops this screen, so the wallet names the chain on every surface that
// commits value. Its sheet and the effective-endpoint lookup are tested in their own suites;
// stubbing only those keeps the banner itself real here, so the assertion is not on a stub.
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getTestNetworkNameKey: () => 'testnet'
}));
jest.mock('components/NetworkModeSheet', () => ({ NetworkModeSheet: () => null }));

// A load that did not fully succeed is driven per test; the default is a clean load.
let mockLoadState: { isLoading: boolean; error?: string } = { isLoading: false };
const mockRefetch = jest.fn();
let mockSearch = '';
jest.mock('lib/epoch/earn-withdraw-quote', () => ({
  quoteEarnWithdrawal: jest.fn(),
  assertWithdrawalReviewCurrent: jest.fn()
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: { amount?: string }) => (key === 'earnWithdrawApproxAmount' ? `≈ ${args?.amount}` : key)
  })
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
  isMobile: jest.fn(() => false),
  // The hero's formatter lives in the history helpers, whose `lib/i18n` import calls
  // `isExtension` at module load; without it the whole suite fails to load.
  isExtension: jest.fn(() => false)
}));

jest.mock('lib/woozie', () => ({
  useLocation: () => ({ search: mockSearch }),
  goBack: jest.fn(),
  navigate: jest.fn(),
  Redirect: ({ to }: { to: string }) => <div data-testid="redirect">{to}</div>
}));

jest.mock('./useEarnPositions', () => ({
  ...jest.requireActual<typeof import('./useEarnPositions')>('./useEarnPositions'),
  useEarnPositions: () => ({
    summary: { totalRewardsUsd: 0, blendedApyPercent: 0, totalDepositedUsd: 0, estimatedRewardsUsd: 0 },
    positions: mockPositions,
    vaults: [],
    ...mockLoadState,
    refetch: mockRefetch
  })
}));

jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: { ChevronLeft: 'ChevronLeft' }
}));

// The confirm's onClick as last rendered: a disabled native button dispatches no click, so a test calls it directly.
let mockConfirmClick: (() => void) | undefined;

jest.mock('components/Button', () => ({
  Button: ({
    title,
    onClick,
    disabled,
    accent,
    'data-testid': testId
  }: {
    title?: string;
    onClick?: () => void;
    disabled?: boolean;
    accent?: string;
    'data-testid'?: string;
  }) => {
    if (testId === 'earn-withdraw-review-confirm') mockConfirmClick = onClick;
    return (
      <button type="button" data-accent={accent} onClick={onClick} disabled={disabled}>
        {title}
      </button>
    );
  },
  ButtonVariant: { Primary: 'Primary' }
}));

jest.mock('components/TokenLogo', () => ({
  TokenLogo: ({ faucetId }: { faucetId: string | undefined }) => (
    <span data-testid="token-logo" data-faucet={faucetId} />
  )
}));

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
  epochProtocol: 'dummy-lending',
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
  stale: false,
  chartData: [{ label: 'now', value: 42.25 }]
};

const quotes = jest.requireMock<typeof import('lib/epoch/earn-withdraw-quote')>('lib/epoch/earn-withdraw-quote');

/** Quotes whatever amount the page reviews, paying 99% of it at the same scale. */
function serveQuotes() {
  jest.mocked(quotes.quoteEarnWithdrawal).mockImplementation(async ({ position: subject, amount, accountId }) => {
    const units = withdrawalAmount(amount, subject.decimals) ?? 0n;
    return {
      position: subject,
      accountId,
      amount,
      amountAtomic: units.toString(),
      availableAtomic: (withdrawalAmount(subject.withdrawable, subject.decimals) ?? 0n).toString(),
      scope: 'testnet',
      nativeRevision: 1,
      allocatorUrl: 'url',
      destinationFaucetId: 'faucet',
      destinationSymbol: 'USDCX',
      destinationDecimals: subject.decimals,
      expectedAtomic: ((units * 99n) / 100n).toString(),
      minimumAtomic: ((units * 98n) / 100n).toString(),
      expiresAt: Date.now() + 60000
    };
  });
}

const confirmEnabled = () => waitFor(() => expect(screen.getByRole('button', { name: 'withdraw' })).toBeEnabled());

describe('EarnWithdrawReview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearch = `?amount=${position.withdrawable}`;
    mockConfirmClick = undefined;
    mockAccount.evmAddress = position.owner;
    mockPositions = [position];
    jest.mocked(isMobile).mockReturnValue(false);
    serveQuotes();
    jest.mocked(gaslessEarnWithdrawalToMiden).mockResolvedValue({
      txId: 'tx-id',
      nonce: 'owner:1',
      gaslessUsed: true
    });
  });

  // Only the amount step opens the review, and every review submits with its quote.
  it('sends a review URL with no amount back to the amount step and submits nothing', () => {
    mockSearch = '';
    render(<EarnWithdrawReview positionId="position-1" />);

    expect(screen.getByTestId('redirect')).toHaveTextContent(/^\/earn\/positions\/position-1\/withdraw$/);
    expect(screen.queryByRole('button', { name: 'withdraw' })).toBeNull();
    expect(mockConfirmClick).toBeUndefined();
    expect(quotes.quoteEarnWithdrawal).not.toHaveBeenCalled();
    expect(gaslessEarnWithdrawalToMiden).not.toHaveBeenCalled();
  });

  it('renders the selected position and the full-withdraw route details', async () => {
    render(<EarnWithdrawReview positionId="position-1" />);
    await confirmEnabled();

    expect(screen.getByTestId('earn-withdraw-review-page')).toBeInTheDocument();
    // The protocol is the title; the asset and its network are the muted line under it.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Aave$/);
    // The asset and its network ride the header as the shared mark, the same one the vault and
    // deposit pages carry, rather than a page-local pill. The subtitle names the pair, so the mark
    // is hidden and the banner says it once.
    const banner = screen.getByRole('banner');
    expect(within(banner).getAllByText('earnAssetOnNetwork')).toHaveLength(1);
    expect(within(banner).getByTestId('token-logo').parentElement).toHaveAttribute('aria-hidden', 'true');
    // The hero's figure is the quoted payout, carrying the native token as its compact unit, as on the deposit review.
    const hero = screen.getByRole('region', { name: 'youReceive' });
    expect(hero).toHaveTextContent('≈ 41.82USDCX');
    expect(within(hero).getByText('USDCX', { selector: '.text-title-page' })).toBeInTheDocument();
    // The unit's logo is the quoted destination faucet's, the token the payout arrives as.
    expect(within(hero).getByTestId('token-logo')).toHaveAttribute('data-faucet', 'faucet');
    expect(screen.getByText('earnWithdrawAll')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /details/ }));
    expect(screen.getByText('Aave (Sepolia) -> Miden')).toBeInTheDocument();
    expect(screen.getByText('earnFullPositionGasless')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'back' }));
    expect(goBack).toHaveBeenCalledTimes(1);
  });

  // The withdrawable is what arrives at most, so it rounds down, and from the API's own string: a
  // Number() of it loses digits past double precision.
  it('rounds the full withdrawable down from its exact string', async () => {
    mockPositions = [{ ...position, withdrawable: '10.6555' }];
    mockSearch = '?amount=10.6555';
    const { unmount } = render(<EarnWithdrawReview positionId="position-1" />);
    await confirmEnabled();
    expect(screen.getByText('≈ 10.65 USDC')).toBeInTheDocument();
    unmount();

    mockPositions = [{ ...position, withdrawable: '12345678901234567.899' }];
    mockSearch = '?amount=12345678901234567.899';
    render(<EarnWithdrawReview positionId="position-1" />);
    await confirmEnabled();
    expect(screen.getByText('≈ 12345678901234567.89 USDC')).toBeInTheDocument();
  });

  it('gives the withdraw confirm the earn flow colour', async () => {
    render(<EarnWithdrawReview positionId="position-1" />);
    await confirmEnabled();

    expect(screen.getByRole('button', { name: 'withdraw' })).toHaveAttribute('data-accent', 'earn');
  });

  it('falls back to an empty position and disables withdrawal for an unknown id', () => {
    render(<EarnWithdrawReview positionId="unknown" />);

    expect(within(screen.getByRole('region', { name: 'youReceive' })).getByText(EARN_PLACEHOLDER)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'withdraw' })).toBeDisabled();
    expect(quotes.quoteEarnWithdrawal).not.toHaveBeenCalled();
  });

  it('submits the reviewed full position and routes as soon as the tracking row exists', async () => {
    jest.mocked(gaslessEarnWithdrawalToMiden).mockImplementation(async args => {
      args.onRowCreated?.('tx/1');
      return { txId: 'tx/1', nonce: 'owner:1', gaslessUsed: true };
    });
    render(<EarnWithdrawReview positionId="position-1" />);
    await confirmEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'withdraw' }));

    // No haptic of its own: the shared `Button` fires the tap haptic, and a second call buzzed twice.
    // `Button` is mocked here, so this pins only that the screen adds no call; Button's own tests pin its haptic.
    expect(hapticLight).not.toHaveBeenCalled();
    await waitFor(() => expect(gaslessEarnWithdrawalToMiden).toHaveBeenCalledTimes(1));
    expect(gaslessEarnWithdrawalToMiden).toHaveBeenCalledWith({
      midenAccountPublicKey: 'miden-account',
      evmAddress: position.owner,
      marketUid: position.marketUid,
      protocol: 'dummy-lending',
      chainId: 11155111,
      underlyingAddress: position.underlyingAddress,
      amount: '42.25',
      review: expect.objectContaining({ amount: '42.25', amountAtomic: '42250000', minimumAtomic: '41405000' }),
      underlyingDecimals: 6,
      onRowCreated: expect.any(Function)
    });
    expect(navigate).toHaveBeenCalledWith({
      pathname: '/earn/withdraw-status/tx%2F1',
      state: { newSubmissionTxId: 'tx/1' }
    });
  });

  it('rejects a position not owned by the current wallet account', async () => {
    mockAccount.evmAddress = '0x2222222222222222222222222222222222222222';
    render(<EarnWithdrawReview positionId="position-1" />);
    await confirmEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'withdraw' }));

    expect(await screen.findByText('earnWithdrawNotOwned')).toBeInTheDocument();
    expect(gaslessEarnWithdrawalToMiden).not.toHaveBeenCalled();
  });

  it('reports user-visible error: rejects a position not owned by the current wallet account', async () => {
    jest.useFakeTimers();
    jest.mocked(reportUserVisibleError).mockClear();
    mockAccount.evmAddress = '0x2222222222222222222222222222222222222222';
    render(<EarnWithdrawReview positionId="position-1" />);
    await confirmEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'withdraw' }));

    expect(await screen.findByText('earnWithdrawNotOwned')).toBeInTheDocument();
    expect(gaslessEarnWithdrawalToMiden).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1000));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['earnWithdrawNotOwned', 'notice']]);
  });

  it('handles an account without a derived EVM address', async () => {
    mockAccount.evmAddress = undefined;
    render(<EarnWithdrawReview positionId="position-1" />);
    await confirmEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'withdraw' }));

    expect(await screen.findByText('earnWithdrawNotOwned')).toBeInTheDocument();
    expect(gaslessEarnWithdrawalToMiden).not.toHaveBeenCalled();
  });

  it('surfaces SDK errors and restores the CTA once the amount is quoted again', async () => {
    jest.mocked(gaslessEarnWithdrawalToMiden).mockRejectedValue(new Error('intent unavailable'));
    render(<EarnWithdrawReview positionId="position-1" />);
    await confirmEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'withdraw' }));

    expect(await screen.findByText('intent unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'withdraw' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'earnWithdrawRefreshQuote' }));
    await confirmEnabled();
  });

  it('reports user-visible error: surfaces SDK errors and restores the CTA once the amount is quoted again', async () => {
    jest.useFakeTimers();
    jest.mocked(reportUserVisibleError).mockClear();
    jest.mocked(gaslessEarnWithdrawalToMiden).mockRejectedValue(new Error('intent unavailable'));
    render(<EarnWithdrawReview positionId="position-1" />);
    await confirmEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'withdraw' }));

    expect(await screen.findByText('intent unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'withdraw' })).toBeDisabled();
    act(() => jest.advanceTimersByTime(1000));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['raw_earn_withdraw_submit_failed', 'notice']]);
  });

  it('uses the fallback message for non-Error failures', async () => {
    jest.mocked(gaslessEarnWithdrawalToMiden).mockRejectedValue('failed');
    render(<EarnWithdrawReview positionId="position-1" />);
    await confirmEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'withdraw' }));

    expect(await screen.findByText('earnGaslessWithdrawalFailed')).toBeInTheDocument();
  });

  it('reports user-visible error: uses the fallback message for non-Error failures', async () => {
    jest.useFakeTimers();
    jest.mocked(reportUserVisibleError).mockClear();
    jest.mocked(gaslessEarnWithdrawalToMiden).mockRejectedValue('failed');
    render(<EarnWithdrawReview positionId="position-1" />);
    await confirmEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'withdraw' }));

    expect(await screen.findByText('earnGaslessWithdrawalFailed')).toBeInTheDocument();
    act(() => jest.advanceTimersByTime(1000));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['earnGaslessWithdrawalFailed', 'notice']]);
  });

  // Double-tapping the CTA must not submit two redemption intents.
  it('ignores a second tap while the first withdrawal is in flight', async () => {
    let release: (value: { txId: string; nonce: string; gaslessUsed: boolean }) => void = () => {};
    jest.mocked(gaslessEarnWithdrawalToMiden).mockImplementation(() => new Promise(resolve => (release = resolve)));
    render(<EarnWithdrawReview positionId="position-1" />);
    await confirmEnabled();

    const cta = screen.getByRole('button', { name: 'withdraw' });
    fireEvent.click(cta);
    fireEvent.click(cta);

    expect(gaslessEarnWithdrawalToMiden).toHaveBeenCalledTimes(1);
    await act(async () => {
      release({ txId: 'tx-1', nonce: 'owner:1', gaslessUsed: true });
    });
  });

  it('pins the CTA in the shared frame footer, on the page margin rather than a per-platform one', async () => {
    jest.mocked(isMobile).mockReturnValue(true);
    render(<EarnWithdrawReview positionId="position-1" />);
    await confirmEnabled();

    const footer = screen.getByRole('button', { name: 'withdraw' }).parentElement;
    expect(footer).toHaveAttribute('data-slot', 'footer');
    // The 16px page margin every page takes, not the 24/32px this page used to pick by platform.
    expect(footer).toHaveClass('px-4', 'shrink-0');
    expect(footer?.className).not.toMatch(/px-6|px-8/);
  });

  // This screen commits value, so it names the network. The registry test proves the element is
  // in the file; this proves it actually renders - which is the distinction a source match could
  // not make, and how a banner once shipped behind an early return.
  it('names the network it will commit on', async () => {
    render(<EarnWithdrawReview positionId="position-1" />);
    await confirmEnabled();

    expect(screen.getByTestId('network-mode-banner')).toBeInTheDocument();
  });
});

describe('EarnWithdrawReview after a failed load', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearch = `?amount=${position.withdrawable}`;
    mockPositions = [position];
    mockConfirmClick = undefined;
    serveQuotes();
  });
  afterEach(() => {
    mockLoadState = { isLoading: false };
  });

  it('forwards the selected failure evidence from withdrawal review to the real Notice', () => {
    jest.useFakeTimers();
    jest.mocked(reportUserVisibleError).mockClear();
    const evidence = {
      kind: 'earn_positions_load',
      earnPositionsLoadStage: 'owner_lookup',
      earnPositionsLoadOutcome: 'complete_failure'
    };
    mockLoadState = Object.assign({ isLoading: false, error: 'private failure' }, { errorDiagnostics: evidence });
    render(<EarnWithdrawReview positionId="unknown" />);
    act(() => jest.advanceTimersByTime(1000));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['earnPositionsLoadError', 'notice', evidence]]);
  });

  it('says a per-owner positions failure too, which is not a request failure', () => {
    mockLoadState = { isLoading: false, error: 'owner unavailable' };
    render(<EarnWithdrawReview positionId="unknown" />);

    expect(screen.getByRole('alert')).toHaveTextContent('earnPositionsLoadError');
  });

  it('says the load failed, with Retry, instead of offering to withdraw a placeholder position', () => {
    mockLoadState = { isLoading: false, error: 'boom' };
    render(<EarnWithdrawReview positionId="unknown" />);

    expect(screen.getByRole('alert')).toHaveTextContent('earnPositionsLoadError');
    expect(screen.queryByRole('button', { name: 'withdraw' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it('reports user-visible error: says the load failed, with Retry, instead of offering to withdraw a placeholder position', () => {
    jest.useFakeTimers();
    jest.mocked(reportUserVisibleError).mockClear();
    mockLoadState = { isLoading: false, error: 'boom' };
    render(<EarnWithdrawReview positionId="unknown" />);

    expect(screen.getByRole('alert')).toHaveTextContent('earnPositionsLoadError');
    expect(screen.queryByRole('button', { name: 'withdraw' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(1000));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['earnPositionsLoadError', 'notice']]);
  });

  it('keeps the failure said while a retry is out, and names only the route in the header', () => {
    mockLoadState = { isLoading: false, error: 'boom' };
    render(<EarnWithdrawReview positionId="unknown" />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^withdraw$/);
    expect(screen.queryByText(/earnAssetOnNetwork/)).toBeNull();
  });

  it('draws nothing it has not loaded during a first load with no error', () => {
    mockLoadState = { isLoading: true };
    render(<EarnWithdrawReview positionId="unknown" />);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'withdraw' })).toBeNull();
    expect(screen.queryByText('youReceive')).toBeNull();
  });

  it('reports user-visible error: draws nothing it has not loaded during a first load with no error', () => {
    jest.useFakeTimers();
    jest.mocked(reportUserVisibleError).mockClear();
    mockLoadState = { isLoading: true };
    render(<EarnWithdrawReview positionId="unknown" />);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'withdraw' })).toBeNull();
    expect(screen.queryByText('youReceive')).toBeNull();
    act(() => jest.advanceTimersByTime(1000));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });

  it('keeps a position it already has, under the notice', async () => {
    mockLoadState = { isLoading: false, error: 'boom' };
    render(<EarnWithdrawReview positionId="position-1" />);
    await confirmEnabled();

    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('disables Withdraw for a position the latest read did not load, under the notice with Retry', () => {
    mockLoadState = { isLoading: false, error: 'boom' };
    mockPositions = [{ ...position, stale: true }];
    render(<EarnWithdrawReview positionId="position-1" />);

    expect(screen.getByRole('alert')).toHaveTextContent('earnPositionsLoadError');
    expect(screen.getByRole('button', { name: 'retry' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /details/ }));
    expect(screen.getByText('Aave (Sepolia) -> Miden')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'withdraw' })).toBeDisabled();
  });

  it('never signs for a position the latest read did not load, even when its confirm is called', async () => {
    jest.mocked(gaslessEarnWithdrawalToMiden).mockImplementation(async args => {
      args.onRowCreated?.('tx-1');
      return { txId: 'tx-1', nonce: 'owner:1', gaslessUsed: true };
    });
    mockAccount.evmAddress = position.owner;
    mockLoadState = { isLoading: false, error: 'boom' };
    mockPositions = [{ ...position, stale: true }];
    render(<EarnWithdrawReview positionId="position-1" />);

    const confirm = mockConfirmClick;
    if (!confirm) throw new Error('the withdraw confirm did not render');
    await act(async () => confirm());

    expect(gaslessEarnWithdrawalToMiden).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

const MISSING_LOAD_STATES: Array<[string, { isLoading: boolean; error?: string }]> = [
  ['a failed load', { isLoading: false, error: 'boom' }],
  ['a load in flight', { isLoading: true }],
  ['a settled load without it', { isLoading: false }]
];

describe('EarnWithdrawReview with no position to name', () => {
  beforeEach(() => {
    mockSearch = `?amount=${position.withdrawable}`;
    serveQuotes();
  });
  afterEach(() => {
    mockLoadState = { isLoading: false };
  });

  it.each(MISSING_LOAD_STATES)('keeps a route heading and no placeholder name after %s', (_state, loadState) => {
    mockLoadState = loadState;
    render(<EarnWithdrawReview positionId="unknown" />);

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent(/^withdraw$/);
    // The header names no placeholder; an unquoted payout in the body may read as one.
    expect(within(screen.getByRole('banner')).queryByText(EARN_PLACEHOLDER)).toBeNull();
    expect(screen.queryByText(/earnAssetOnNetwork/)).toBeNull();
  });
});

describe('selected withdrawal review', () => {
  it('reports the visible quote refresh when an empty submit error leaves no owning submit notice', async () => {
    jest.useFakeTimers();
    jest.mocked(gaslessEarnWithdrawalToMiden).mockRejectedValueOnce(new Error(''));
    const view = render(<EarnWithdrawReview positionId="position-1" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'withdraw' })).toBeEnabled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'withdraw' }));
    });
    expect(gaslessEarnWithdrawalToMiden).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('earn-withdraw-review-error')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('earnWithdrawRefresh');
    expect(reportUserVisibleError).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(999));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['earnWithdrawRefresh', 'notice']]);
    view.rerender(<EarnWithdrawReview positionId="position-1" />);
    act(() => jest.advanceTimersByTime(1000));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['earnWithdrawRefresh', 'notice']]);
  });

  it('reports a new balance validation after a submit failure remains visible, with its own full dwell', async () => {
    jest.useFakeTimers();
    jest.mocked(gaslessEarnWithdrawalToMiden).mockRejectedValueOnce(new Error('intent unavailable 123.45 0xprivate'));
    const view = render(<EarnWithdrawReview positionId="position-1" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'withdraw' })).toBeEnabled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'withdraw' }));
    });
    expect(screen.getByTestId('earn-withdraw-review-error')).toHaveTextContent('intent unavailable 123.45 0xprivate');
    expect(reportUserVisibleError).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(999));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['raw_earn_withdraw_submit_failed', 'notice']]);

    mockPositions = [{ ...position, withdrawable: '0.5' }];
    view.rerender(<EarnWithdrawReview positionId="position-1" />);
    expect(screen.getByText('earnWithdrawAboveAvailable')).toBeInTheDocument();
    expect(screen.getByTestId('earn-withdraw-review-error')).toHaveTextContent('intent unavailable 123.45 0xprivate');
    act(() => jest.advanceTimersByTime(999));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['raw_earn_withdraw_submit_failed', 'notice']]);
    act(() => jest.advanceTimersByTime(1));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([
      ['raw_earn_withdraw_submit_failed', 'notice'],
      ['earnWithdrawAboveAvailable', 'notice']
    ]);
    view.rerender(<EarnWithdrawReview positionId="position-1" />);
    act(() => jest.advanceTimersByTime(1000));
    expect(reportUserVisibleError).toHaveBeenCalledTimes(2);
  });

  it('reports an independent quote failure after balance recovery while the submit failure remains visible', async () => {
    jest.useFakeTimers();
    jest.mocked(gaslessEarnWithdrawalToMiden).mockRejectedValueOnce(new Error('intent unavailable 123.45 0xprivate'));
    const view = render(<EarnWithdrawReview positionId="position-1" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'withdraw' })).toBeEnabled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'withdraw' }));
    });
    act(() => jest.advanceTimersByTime(1000));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['raw_earn_withdraw_submit_failed', 'notice']]);

    mockPositions = [{ ...position, withdrawable: '0.5' }];
    view.rerender(<EarnWithdrawReview positionId="position-1" />);
    expect(screen.getByText('earnWithdrawAboveAvailable')).toBeInTheDocument();
    jest.mocked(quotes.quoteEarnWithdrawal).mockRejectedValueOnce(new Error('quote unavailable 987.65 0xprivate'));
    mockPositions = [{ ...position, withdrawable: '40' }];
    await act(async () => {
      view.rerender(<EarnWithdrawReview positionId="position-1" />);
    });
    expect(quotes.quoteEarnWithdrawal).toHaveBeenCalledTimes(2);
    expect(quotes.quoteEarnWithdrawal).toHaveBeenLastCalledWith(
      expect.objectContaining({ position: expect.objectContaining({ withdrawable: '40' }) })
    );
    expect(screen.queryByText('earnWithdrawAboveAvailable')).not.toBeInTheDocument();
    expect(screen.getByText('earnWithdrawQuoteUnavailable')).toBeInTheDocument();
    expect(screen.getByTestId('earn-withdraw-review-error')).toHaveTextContent('intent unavailable 123.45 0xprivate');
    act(() => jest.advanceTimersByTime(999));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['raw_earn_withdraw_submit_failed', 'notice']]);
    act(() => jest.advanceTimersByTime(1));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([
      ['raw_earn_withdraw_submit_failed', 'notice'],
      ['earnWithdrawQuoteUnavailable', 'notice']
    ]);
  });

  it('reports user-visible recognized SDK error by its translation key', async () => {
    jest.useFakeTimers();
    jest.mocked(reportUserVisibleError).mockClear();
    jest.mocked(gaslessEarnWithdrawalToMiden).mockRejectedValueOnce(new Error('earnWithdrawNotOwned'));
    render(<EarnWithdrawReview positionId="position-1" />);
    await confirmEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'withdraw' }));
    await screen.findByText('earnWithdrawNotOwned');
    act(() => jest.advanceTimersByTime(1000));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['earnWithdrawNotOwned', 'notice']]);
  });

  it.each([
    ['0', 'earnWithdrawPositive'],
    ['43', 'earnWithdrawAboveAvailable'],
    ['1.0000001', 'earnWithdrawPrecision']
  ])('reports user-visible review validation %s', (amount, id) => {
    jest.useFakeTimers();
    jest.mocked(reportUserVisibleError).mockClear();
    mockSearch = `?amount=${amount}`;
    render(<EarnWithdrawReview positionId="position-1" />);
    expect(screen.getByRole('alert')).toHaveTextContent(id);
    act(() => jest.advanceTimersByTime(1000));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([[id, 'notice']]);
  });
  it.each(['earnWithdrawRefresh', 'earnWithdrawQuoteUnavailable'])(
    'reports user-visible quote failure %s',
    async id => {
      jest.useFakeTimers();
      jest.mocked(reportUserVisibleError).mockClear();
      jest.mocked(quotes.quoteEarnWithdrawal).mockRejectedValueOnce(new Error(id));
      render(<EarnWithdrawReview positionId="position-1" />);
      await screen.findByText(id);
      act(() => jest.advanceTimersByTime(1000));
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([[id, 'notice']]);
    }
  );

  beforeEach(() => {
    mockSearch = '?amount=1.000001';
    mockPositions = [position];
    mockAccount.evmAddress = position.owner;
    mockLoadState = { isLoading: false };
    jest.clearAllMocks();
    jest.mocked(quotes.quoteEarnWithdrawal).mockResolvedValue({
      amount: '1.000001',
      amountAtomic: '1000001',
      availableAtomic: '42250000',
      expiresAt: Date.now() + 60000,
      accountId: mockAccount.publicKey,
      position,
      scope: 'testnet',
      nativeRevision: 1,
      allocatorUrl: 'url',
      destinationFaucetId: 'faucet',
      destinationSymbol: 'USDCX',
      destinationDecimals: 6,
      expectedAtomic: '990000',
      minimumAtomic: '980100'
    });
    jest.mocked(quotes.assertWithdrawalReviewCurrent).mockResolvedValue(undefined);
    jest.mocked(gaslessEarnWithdrawalToMiden).mockResolvedValue({ txId: 'partial', nonce: '1', gaslessUsed: true });
  });
  it('reviews and submits the same selected amount and payout floor', async () => {
    render(<EarnWithdrawReview positionId="position-1" />);
    expect(screen.getByRole('button', { name: 'withdraw' })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'withdraw' })).toBeEnabled());
    expect(screen.getByRole('region', { name: 'youReceive' })).toHaveTextContent('≈ 0.99USDCX');
    expect(screen.getByText('0.98 USDCX')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /details/ }));
    expect(screen.getByText('0.9801 USDCX')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'withdraw' }));
    await waitFor(() =>
      expect(gaslessEarnWithdrawalToMiden).toHaveBeenCalledWith(
        expect.objectContaining({ amount: '1.000001', review: expect.objectContaining({ minimumAtomic: '980100' }) })
      )
    );
  });
  it('leads with the receipt and keeps exact technical amounts in an accessible disclosure', async () => {
    render(<EarnWithdrawReview positionId="position-1" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'withdraw' })).toBeEnabled());
    expect(screen.getByRole('region', { name: 'youReceive' })).toBeInTheDocument();
    expect(screen.getByTestId('earn-withdraw-remaining')).toHaveTextContent('41.24 USDC');
    const details = screen.getByRole('button', { name: /details/ });
    expect(details).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('positionOwnerLabel')).toBeNull();
    expect(screen.queryByText('earnWithdrawExactAmount')).toBeNull();
    fireEvent.click(details);
    expect(details).toHaveAttribute('aria-expanded', 'true');
    expect(within(screen.getByTestId('earn-withdraw-details')).getByText('1.000001 USDC')).toBeInTheDocument();
    expect(screen.getByText('0.9801 USDCX')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'withdraw' }));
    await waitFor(() =>
      expect(gaslessEarnWithdrawalToMiden).toHaveBeenCalledWith(
        expect.objectContaining({ amount: '1.000001', review: expect.objectContaining({ minimumAtomic: '980100' }) })
      )
    );
  });
  it('preserves the amount on quote failure and allows refresh', async () => {
    jest.mocked(quotes.quoteEarnWithdrawal).mockRejectedValueOnce(new Error('earnWithdrawQuoteUnavailable'));
    render(<EarnWithdrawReview positionId="position-1" />);
    await screen.findByText('earnWithdrawQuoteUnavailable');
    expect(screen.getByRole('button', { name: 'withdraw' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'earnWithdrawRefreshQuote' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'withdraw' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /details/ }));
    expect(within(screen.getByTestId('earn-withdraw-details')).getByText('1.000001 USDC')).toBeInTheDocument();
  });
  it('shows a compact full-balance summary and submits every selected base unit', async () => {
    const exact = '10.123456789012345678';
    mockPositions = [{ ...position, withdrawable: exact, decimals: 18 }];
    mockSearch = `?amount=${exact}`;
    render(<EarnWithdrawReview positionId="position-1" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'withdraw' })).toBeEnabled());
    expect(screen.getByText('≈ 10.12 USDC')).toBeInTheDocument();
    expect(screen.getByText('earnWithdrawAll')).toBeInTheDocument();
    expect(screen.getByTestId('earn-withdraw-remaining')).toHaveTextContent('0 USDC');
    expect(screen.queryByText(`${exact} USDC`)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /details/ }));
    expect(screen.getByText(`${exact} USDC`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'withdraw' }));
    await waitFor(() =>
      expect(gaslessEarnWithdrawalToMiden).toHaveBeenCalledWith(expect.objectContaining({ amount: exact }))
    );
  });

  it('expires a quote without changing the selected amount', async () => {
    jest.useFakeTimers();
    try {
      render(<EarnWithdrawReview positionId="position-1" />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByRole('button', { name: 'withdraw' })).toBeEnabled();
      act(() => {
        jest.advanceTimersByTime(60000);
      });
      expect(screen.getByRole('button', { name: 'withdraw' })).toBeDisabled();
      expect(screen.getByText('earnWithdrawRefresh')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /details/ }));
      expect(within(screen.getByTestId('earn-withdraw-details')).getByText('1.000001 USDC')).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });
  it('blocks duplicate confirms while submission is pending', async () => {
    jest.mocked(gaslessEarnWithdrawalToMiden).mockImplementationOnce(() => new Promise(() => undefined));
    render(<EarnWithdrawReview positionId="position-1" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'withdraw' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'withdraw' }));
    fireEvent.click(screen.getByRole('button', { name: 'withdrawing' }));
    expect(gaslessEarnWithdrawalToMiden).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'withdrawing' })).toBeDisabled();
  });
  it('keeps the reviewed quote when availability changes but still covers the amount', async () => {
    const view = render(<EarnWithdrawReview positionId="position-1" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'withdraw' })).toBeEnabled());
    // A new quote would never settle, so only a kept one leaves Withdraw enabled; 40 still covers 1.000001.
    jest.mocked(quotes.quoteEarnWithdrawal).mockImplementation(() => new Promise(() => undefined));
    mockPositions = [{ ...position, withdrawable: '40' }];
    view.rerender(<EarnWithdrawReview positionId="position-1" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'withdraw' })).toBeEnabled();
    expect(quotes.quoteEarnWithdrawal).toHaveBeenCalledTimes(1);
  });
  it('keeps the reviewed quote when availability falls but still covers the amount', async () => {
    const view = render(<EarnWithdrawReview positionId="position-1" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'withdraw' })).toBeEnabled());
    jest.mocked(quotes.quoteEarnWithdrawal).mockImplementation(() => new Promise(() => undefined));
    mockPositions = [{ ...position, withdrawable: '2' }];
    view.rerender(<EarnWithdrawReview positionId="position-1" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'withdraw' })).toBeEnabled();
    expect(quotes.quoteEarnWithdrawal).toHaveBeenCalledTimes(1);
  });
  it('quotes against the new balance once availability rises from below the amount to cover it', async () => {
    mockPositions = [{ ...position, withdrawable: '0.5' }];
    const view = render(<EarnWithdrawReview positionId="position-1" />);
    expect(screen.getByRole('button', { name: 'withdraw' })).toBeDisabled();
    expect(quotes.quoteEarnWithdrawal).not.toHaveBeenCalled();
    mockPositions = [{ ...position, withdrawable: '40' }];
    view.rerender(<EarnWithdrawReview positionId="position-1" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'withdraw' })).toBeEnabled());
    expect(quotes.quoteEarnWithdrawal).toHaveBeenLastCalledWith(
      expect.objectContaining({ position: expect.objectContaining({ withdrawable: '40' }) })
    );
  });
  it('keeps the reviewed quote when a positions refresh rebuilds the position with the same values', async () => {
    const view = render(<EarnWithdrawReview positionId="position-1" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'withdraw' })).toBeEnabled());
    // A new quote would never settle, so only a kept one leaves Withdraw enabled.
    jest.mocked(quotes.quoteEarnWithdrawal).mockImplementation(() => new Promise(() => undefined));
    mockPositions = [{ ...position }];
    view.rerender(<EarnWithdrawReview positionId="position-1" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'withdraw' })).toBeEnabled();
    expect(quotes.quoteEarnWithdrawal).toHaveBeenCalledTimes(1);
  });
  it('disables Withdraw when availability falls below the reviewed amount', async () => {
    const view = render(<EarnWithdrawReview positionId="position-1" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'withdraw' })).toBeEnabled());
    mockPositions = [{ ...position, withdrawable: '0.5' }];
    view.rerender(<EarnWithdrawReview positionId="position-1" />);
    expect(screen.getByRole('button', { name: 'withdraw' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /details/ }));
    expect(within(screen.getByTestId('earn-withdraw-details')).getByText('1.000001 USDC')).toBeInTheDocument();
  });
});

jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));

afterEach(() => jest.useRealTimers());
