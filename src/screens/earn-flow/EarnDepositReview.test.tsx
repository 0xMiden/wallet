import React from 'react';

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

import { openEarnPosition } from 'lib/epoch';
import { hapticLight } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';

import { EARN_DATA } from './data';
import EarnDepositReview from './EarnDepositReview';

// --- react-i18next: echo the key back, and fold interpolation options into the
//     returned string so we can assert the interpolated route/reward values
//     (mirrors the swap-flow ReviewSwap sibling test).
// The network banner now tops this screen, so the wallet names the chain on every surface that
// commits value. Its sheet and the effective-endpoint lookup are tested in their own suites;
// stubbing only those keeps the banner itself real here, so the assertion is not on a stub.
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getTestNetworkNameKey: () => 'testnet'
}));
jest.mock('components/NetworkModeSheet', () => ({ NetworkModeSheet: () => null }));

// A load that did not fully succeed is driven per test; the default is a clean load.
let mockLoadState: { isLoading: boolean; error?: string; loadError?: string } = { isLoading: false };
const mockRefetch = jest.fn();

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const values = opts ? Object.values(opts) : [];
      return values.length > 0 ? `${key}_${values.join('_')}` : key;
    }
  })
}));

// --- woozie router: mutable location + spyable navigate.
const mockLocation = { search: '' };
const mockNavigate = jest.fn();

jest.mock('lib/woozie', () => ({
  navigate: (...args: unknown[]) => mockNavigate(...args),
  useLocation: () => mockLocation
}));

// --- Platform / haptics.
jest.mock('lib/platform', () => ({
  isMobile: jest.fn(() => false),
  // The network-fee row resolves the native asset's metadata, and that chain reaches
  // `getAssetUrl`, which calls `isExtension` at module load. A partial platform mock
  // fails the whole suite rather than one test.
  isExtension: jest.fn(() => true)
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

// --- Epoch SDK barrel (wasm + network clients): only the deposit entry point
//     and the USDC decimals constant are used by this screen.
jest.mock('lib/epoch', () => ({
  getEarnCollateralFaucetId: () => 'mtst1usdc',
  MIDEN_USDC_DECIMALS: 6,
  openEarnPosition: jest.fn(() => Promise.resolve())
}));

const mockWalletStoreState = { assessSpendingLimit: jest.fn(), readSpendingLimit: jest.fn() };
jest.mock('lib/store', () => ({
  useWalletStore: (selector: (state: typeof mockWalletStoreState) => unknown) => selector(mockWalletStoreState)
}));

// Set by a test that needs the mock challenge to hand back an authorization for a DIFFERENT
// account than the one the challenge itself was opened for - a stale/forged credential, which the
// real `SpendingLimitChallenge` never produces (its authorization always carries the challenge's
// own `source.accountId`) but which `runOpenPosition` must independently refuse.
let mockAuthorizationAccountOverride: string | undefined;

jest.mock('components/SpendingLimitChallenge', () => ({
  SpendingLimitChallenge: (props: any) => {
    const source = props.assessment ?? props.unpriced;
    return (
      <div data-testid="spending-limit-challenge">
        <span>{source.revision}</span>
        <span data-testid="challenge-kind">{props.assessment !== undefined ? 'assessment' : 'unpriced'}</span>
        <button
          type="button"
          onClick={() =>
            props.onResult({
              kind: props.assessment !== undefined ? 'usd' : 'unpriced',
              id: 'authorization-1',
              accountId: mockAuthorizationAccountOverride ?? source.accountId,
              revision: source.revision,
              issuedAt: 100,
              expiresAt: 220
            })
          }
        >
          authorize-limit
        </button>
        <button type="button" onClick={() => props.onResult(undefined)}>
          cancel-limit
        </button>
      </div>
    );
  }
}));

// --- Wallet context: the screen needs the account's EVM address (the deposit
//     owner) plus `signTransaction` for the guardian-signed Miden note.
const mockAccount: { publicKey: string; evmAddress?: string; type?: string } = {
  publicKey: 'mm1testaccount',
  evmAddress: '0xdeadbeef'
};

jest.mock('lib/miden/front', () => ({
  useAccount: () => mockAccount
}));

const mockSignTransaction = jest.fn();
jest.mock('lib/miden/front/client', () => ({
  useMidenContext: () => ({ signTransaction: mockSignTransaction })
}));

jest.mock('lib/miden/front/guardian-sync', () => ({
  zustandProvider: { kind: 'zustand-provider' }
}));

// --- Live earn data: serve the static demo fixture instead of the SWR-backed
//     Epoch positions hook.
jest.mock('./useEarnPositions', () => {
  const { EARN_DATA } = jest.requireActual<typeof import('./data')>('./data');
  return {
    ...jest.requireActual<typeof import('./useEarnPositions')>('./useEarnPositions'),
    useEarnPositions: () => ({
      summary: EARN_DATA.summary,
      positions: EARN_DATA.positions,
      vaults: EARN_DATA.vaults,
      ...mockLoadState,
      refetch: mockRefetch
    })
  };
});

// --- Chart wrapper: render children directly so the projection JSX still runs.
jest.mock('lib/ui/charts', () => ({
  ChartContainer: ({ children }: { children: React.ReactNode }) => <div data-testid="chart-container">{children}</div>
}));

// --- recharts primitives: light stand-ins (jsdom can't lay out SVG charts).
//     `AreaChart` deliberately drops its children: the source's chart JSX
//     (<defs>/<linearGradient>/<Area>/<XAxis>/…) is still evaluated as
//     createElement args (so its lines are covered), but not mounted — mounting
//     raw SVG tags into a <div> only produces noisy jsdom casing warnings.
jest.mock('recharts', () => ({
  __esModule: true,
  AreaChart: () => <div data-testid="area-chart" />,
  Area: () => <div data-testid="area" />,
  XAxis: () => <div data-testid="x-axis" />,
  YAxis: () => <div data-testid="y-axis" />,
  ReferenceLine: () => <div data-testid="reference-line" />
}));

// --- Presentational children: keep just enough to assert the wiring.
jest.mock('components/TokenLogo', () => ({
  TokenLogo: ({ symbol, size }: { symbol: string; size?: string }) => (
    <span data-testid="token-logo" data-symbol={symbol} data-size={size} />
  )
}));

jest.mock('components/Button', () => ({
  Button: ({ title, onClick, disabled }: { title?: string; onClick?: () => void; disabled?: boolean }) => (
    <button data-testid="open-position-btn" onClick={onClick} disabled={disabled}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'Primary', Secondary: 'Secondary', Ghost: 'Ghost' }
}));

// --- Shared header: expose the vault it received so we can assert vault lookup.
jest.mock('./components', () => ({
  EarnFlowHeader: ({ vault }: { vault?: { id: string; asset: string; protocol: string; network: string } }) => (
    <div
      data-testid="earn-flow-header"
      data-vault-id={vault?.id ?? 'none'}
      data-asset={vault?.asset ?? 'none'}
      data-protocol={vault?.protocol ?? 'none'}
      data-network={vault?.network ?? 'none'}
    />
  )
}));

const mockOpenEarnPosition = openEarnPosition as jest.Mock;

const renderReview = (vaultId: string, search = '') => {
  mockLocation.search = search;
  return render(<EarnDepositReview vaultId={vaultId} />);
};

const breachAssessment = (overrides: Record<string, unknown> = {}) => ({
  accountId: 'mm1testaccount',
  usdAmount: 1_000_000_000n,
  revision: 'revision-1',
  assessedAt: 100,
  breach: { spent: 1n, proposedTotal: 1_000_000_001n, limit: 2n, overBy: 999_999_999n, resetAt: 200 },
  ...overrides
});

describe('EarnDepositReview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthorizationAccountOverride = undefined;
    mockLocation.search = '';
    mockAccount.evmAddress = '0xdeadbeef';
    mockAccount.type = undefined;
    (isMobile as jest.Mock).mockReturnValue(false);
    mockOpenEarnPosition.mockResolvedValue(undefined);
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue(undefined);
    mockWalletStoreState.readSpendingLimit.mockResolvedValue({
      accountId: 'mm1testaccount',
      limit: 100_000_000n,
      revision: 'revision-1',
      createdAt: 1,
      updatedAt: 2
    });
  });

  describe('deposit amount header', () => {
    it('renders the page shell, resolves the vault by id, and shows the parsed amount + asset logo', () => {
      renderReview('aave-usdc-ethereum-2', '?amount=1000');

      expect(screen.getByTestId('earn-deposit-review-page')).toBeInTheDocument();

      // Vault resolved by id (not the first vault).
      const header = screen.getByTestId('earn-flow-header');
      expect(header).toHaveAttribute('data-vault-id', 'aave-usdc-ethereum-2');
      expect(header).toHaveAttribute('data-asset', 'USDC');

      // Amount from the query string, formatted to 2 dp.
      expect(screen.getByText('1000.00')).toBeInTheDocument();

      // The deposit asset is always USDC (Epoch Earn is USDC-only).
      const logo = screen.getByTestId('token-logo');
      expect(logo).toHaveAttribute('data-symbol', 'USDC');
      expect(logo).toHaveAttribute('data-size', 'md');
      expect(screen.getAllByText('USDC').length).toBeGreaterThan(0);
    });

    it('names no vault in the header when the vaultId matches nothing', () => {
      renderReview('does-not-exist', '?amount=500');

      // The header gets the vault it found, never the "—" placeholder.
      expect(screen.getByTestId('earn-flow-header')).toHaveAttribute('data-vault-id', 'none');
      expect(screen.getByText('500.00')).toBeInTheDocument();
      // No vault id => nothing to deposit into => CTA disabled.
      expect(screen.getByTestId('open-position-btn')).toBeDisabled();
    });

    it('strips thousands separators from the amount before parsing', () => {
      renderReview('aave-usdc-ethereum-1', '?amount=1,234.50');
      expect(screen.getByText('1234.50')).toBeInTheDocument();
    });

    it('defaults the amount to 0.00 when the query string has no amount param', () => {
      renderReview('aave-usdc-ethereum-1', '');
      expect(screen.getByText('0.00')).toBeInTheDocument();
    });

    it('coerces a non-numeric amount to 0.00 (parseAmount `|| 0` branch)', () => {
      renderReview('aave-usdc-ethereum-1', '?amount=not-a-number');
      expect(screen.getByText('0.00')).toBeInTheDocument();
    });
  });

  describe('open position CTA', () => {
    // Guardian accounts are supported: the collateral note is built as a
    // recallable P2IDE custom proposal in `generateTransaction`, so the CTA is
    // never gated on account type. This fails if the old guardian block returns.
    it('lets a Guardian account open a position', async () => {
      mockAccount.type = 'guardian';
      renderReview('aave-usdc-ethereum-1', '?amount=1000');

      const cta = screen.getByTestId('open-position-btn');
      expect(cta).toBeEnabled();
      expect(screen.queryByText('earnDepositGuardianUnsupported')).not.toBeInTheDocument();

      fireEvent.click(cta);
      await waitFor(() => expect(mockOpenEarnPosition).toHaveBeenCalledTimes(1));
    });

    it('fires haptics and opens the Epoch position with the scaled amount + account owner', async () => {
      renderReview('aave-usdc-ethereum-1', '?amount=1,000');

      const cta = screen.getByTestId('open-position-btn');
      expect(cta).toHaveTextContent('earnOpenPosition');
      expect(cta).toBeEnabled();

      fireEvent.click(cta);

      expect(hapticLight).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(mockOpenEarnPosition).toHaveBeenCalledTimes(1));

      const call = mockOpenEarnPosition.mock.calls[0]![0];
      // Commas stripped, then scaled by the USDC decimals (6).
      expect(call.amount).toBe(1_000_000_000n);
      expect(call.evmAddress).toBe('0xdeadbeef');
      expect(call.senderPublicKey).toBe('mm1testaccount');
      expect(call.deps.signTransaction).toBe(mockSignTransaction);
    });

    it('requires strict authentication before any Earn quote or intent work when over limit', async () => {
      mockWalletStoreState.assessSpendingLimit.mockResolvedValue(breachAssessment());
      renderReview('aave-usdc-ethereum-1', '?amount=1,000');

      fireEvent.click(screen.getByTestId('open-position-btn'));

      expect(await screen.findByTestId('spending-limit-challenge')).toBeInTheDocument();
      expect(mockOpenEarnPosition).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' }));
      await waitFor(() => expect(mockOpenEarnPosition).toHaveBeenCalledTimes(1));
      expect(mockOpenEarnPosition).toHaveBeenCalledWith(
        expect.objectContaining({
          spendingLimitAuthorization: expect.objectContaining({ id: 'authorization-1', revision: 'revision-1' })
        })
      );
    });

    it('discards an authorization that no longer matches the deposit it was minted for', async () => {
      // The assessment names another account, so the authorization the challenge returns is bound
      // to an account other than the one opening this deposit. Honouring it would spend this
      // deposit against a credential issued for something else.
      mockWalletStoreState.assessSpendingLimit.mockResolvedValue(
        breachAssessment({ accountId: 'mm1someotheraccount' })
      );
      renderReview('aave-usdc-ethereum-1', '?amount=1,000');

      fireEvent.click(screen.getByTestId('open-position-btn'));
      await waitFor(() => expect(mockWalletStoreState.assessSpendingLimit).toHaveBeenCalled());

      // Asserting before the pre-check settles passes vacuously. A mismatched assessment must
      // not open the drawer at all, including the commit before the staleness effect runs.
      await act(async () => {
        await mockWalletStoreState.assessSpendingLimit.mock.results[0]!.value;
      });
      await waitFor(() => expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument());
      expect(mockOpenEarnPosition).not.toHaveBeenCalled();
    });

    it('discards a forged authorization for a different account instead of depositing against it', async () => {
      // `SpendingLimitChallenge` always mints an authorization bound to the account its own
      // assessment named; this plants a forged/stale one directly to prove `runOpenPosition`
      // refuses it on its own, independently of the staleness guard above.
      mockWalletStoreState.assessSpendingLimit.mockResolvedValue(breachAssessment());
      mockAuthorizationAccountOverride = 'mm1someotheraccount';
      renderReview('aave-usdc-ethereum-1', '?amount=1,000');

      fireEvent.click(screen.getByTestId('open-position-btn'));
      fireEvent.click(await screen.findByRole('button', { name: 'authorize-limit' }));

      await waitFor(() => expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument());
      expect(mockOpenEarnPosition).not.toHaveBeenCalled();
    });

    it('opens the unvalued challenge when the pre-check cannot price the deposit', async () => {
      mockWalletStoreState.assessSpendingLimit.mockRejectedValue({
        code: 'SPENDING_LIMIT_PRICE_UNAVAILABLE',
        symbol: 'USDC'
      });
      renderReview('aave-usdc-ethereum-1', '?amount=1,000');

      fireEvent.click(screen.getByTestId('open-position-btn'));

      await waitFor(() => expect(mockWalletStoreState.readSpendingLimit).toHaveBeenCalledWith('mm1testaccount'));
      expect(await screen.findByTestId('spending-limit-challenge')).toBeInTheDocument();
      expect(screen.getByTestId('challenge-kind')).toHaveTextContent('unpriced');
      expect(mockOpenEarnPosition).not.toHaveBeenCalled();
    });

    it('falls back to the generic error when the pre-check itself cannot open the unpriced challenge', async () => {
      // Distinct from the success case above: `readSpendingLimit` fails outright (a storage
      // fault), reached from `handleOpenPosition`'s own catch before `runOpenPosition` is entered.
      mockWalletStoreState.assessSpendingLimit.mockRejectedValue({
        code: 'SPENDING_LIMIT_PRICE_UNAVAILABLE',
        symbol: 'USDC'
      });
      mockWalletStoreState.readSpendingLimit.mockRejectedValue(new Error('storage offline'));
      renderReview('aave-usdc-ethereum-1', '?amount=1,000');

      fireEvent.click(screen.getByTestId('open-position-btn'));

      // The outer catch's `error` is still the original price-unavailable object (not an Error),
      // so this is the fallback copy, not the inner storage failure's own message.
      expect(await screen.findByText('earnFailedToOpenPosition')).toBeInTheDocument();
      expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
      expect(mockOpenEarnPosition).not.toHaveBeenCalled();
    });

    it('shows a real Error rejection from the pre-check by its own message', async () => {
      // Not price-unavailable and not an authorization-required breach - a genuine pre-check
      // failure, which must surface as itself rather than the generic fallback copy.
      mockWalletStoreState.assessSpendingLimit.mockRejectedValue(new Error('assessment backend down'));
      renderReview('aave-usdc-ethereum-1', '?amount=1,000');

      fireEvent.click(screen.getByTestId('open-position-btn'));

      expect(await screen.findByText('assessment backend down')).toBeInTheDocument();
    });

    it('falls back to a generic error when the price-unavailable pre-check has no configured limit to read', async () => {
      mockWalletStoreState.assessSpendingLimit.mockRejectedValue({
        code: 'SPENDING_LIMIT_PRICE_UNAVAILABLE',
        symbol: 'USDC'
      });
      mockWalletStoreState.readSpendingLimit.mockResolvedValue(undefined);
      renderReview('aave-usdc-ethereum-1', '?amount=1,000');

      fireEvent.click(screen.getByTestId('open-position-btn'));

      expect(await screen.findByText('earnFailedToOpenPosition')).toBeInTheDocument();
      expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
      expect(mockOpenEarnPosition).not.toHaveBeenCalled();
    });

    it('opens the unvalued challenge when the actual deposit cannot be priced', async () => {
      mockOpenEarnPosition.mockRejectedValue({ code: 'SPENDING_LIMIT_PRICE_UNAVAILABLE', symbol: 'USDC' });
      renderReview('aave-usdc-ethereum-1', '?amount=1,000');

      fireEvent.click(screen.getByTestId('open-position-btn'));

      expect(await screen.findByTestId('spending-limit-challenge')).toBeInTheDocument();
      expect(screen.getByTestId('challenge-kind')).toHaveTextContent('unpriced');
    });

    it('re-enables the CTA when the drawer authorize path cannot open the unpriced challenge', async () => {
      // `runOpenPosition`'s own `openUnpricedChallenge` attempt throws here, not the pre-check's -
      // reached only once a breach already opened the challenge and the user re-authorizes into an
      // actual deposit that itself cannot be priced.
      mockWalletStoreState.assessSpendingLimit.mockResolvedValue(breachAssessment());
      mockOpenEarnPosition.mockRejectedValue({ code: 'SPENDING_LIMIT_PRICE_UNAVAILABLE', symbol: 'USDC' });
      renderReview('aave-usdc-ethereum-1', '?amount=1,000');

      fireEvent.click(screen.getByTestId('open-position-btn'));
      expect(await screen.findByTestId('spending-limit-challenge')).toBeInTheDocument();

      mockWalletStoreState.readSpendingLimit.mockRejectedValue(new Error('storage offline'));
      fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' }));

      // Same reasoning as the pre-check case above: the outer catch's `error` is the original
      // price-unavailable object, so this is the fallback copy, not the storage failure's message.
      expect(await screen.findByText('earnFailedToOpenPosition')).toBeInTheDocument();
      expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
    });

    it('cancels the Earn challenge before quote or intent work and preserves the amount', async () => {
      mockWalletStoreState.assessSpendingLimit.mockResolvedValue(breachAssessment());
      renderReview('aave-usdc-ethereum-1', '?amount=1,000');

      fireEvent.click(screen.getByTestId('open-position-btn'));
      fireEvent.click(await screen.findByRole('button', { name: 'cancel-limit' }));

      expect(mockOpenEarnPosition).not.toHaveBeenCalled();
      expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
      expect(screen.getByText('1000.00')).toBeInTheDocument();
    });

    it('reopens the challenge after a stale Earn authorization without losing the deposit amount', async () => {
      const firstAssessment = breachAssessment({
        breach: { spent: 1n, proposedTotal: 1_000_000_001n, limit: 2n, overBy: 999_999_999n, resetAt: null }
      });
      mockWalletStoreState.assessSpendingLimit.mockResolvedValue(firstAssessment);
      mockOpenEarnPosition.mockRejectedValue({
        code: 'SPENDING_LIMIT_AUTHORIZATION_REQUIRED',
        assessment: { ...firstAssessment, revision: 'revision-2', assessedAt: 240 }
      });
      renderReview('aave-usdc-ethereum-1', '?amount=1,000');

      fireEvent.click(screen.getByTestId('open-position-btn'));
      fireEvent.click(await screen.findByRole('button', { name: 'authorize-limit' }));

      expect(await screen.findByTestId('spending-limit-challenge')).toHaveTextContent('revision-2');
      expect(screen.getByText('1000.00')).toBeInTheDocument();
    });

    it('routes to the generating-transaction page as soon as the tx row exists', async () => {
      mockOpenEarnPosition.mockImplementation((args: { onRowCreated: (txId: string) => void }) => {
        args.onRowCreated('tx/1');
        return Promise.resolve();
      });

      renderReview('aave-usdc-ethereum-1', '?amount=1000');
      fireEvent.click(screen.getByTestId('open-position-btn'));

      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/generating-transaction-full/tx%2F1'));
    });

    it('surfaces an error and never calls the SDK when the account has no EVM address', async () => {
      mockAccount.evmAddress = undefined;
      renderReview('aave-usdc-ethereum-1', '?amount=1000');

      fireEvent.click(screen.getByTestId('open-position-btn'));

      expect(await screen.findByText('earnNoEvmAddress')).toBeInTheDocument();
      expect(mockOpenEarnPosition).not.toHaveBeenCalled();
    });

    it('surfaces the SDK error message when opening the position rejects', async () => {
      mockOpenEarnPosition.mockRejectedValue(new Error('allocator unreachable'));
      renderReview('aave-usdc-ethereum-1', '?amount=1000');

      fireEvent.click(screen.getByTestId('open-position-btn'));

      expect(await screen.findByText('allocator unreachable')).toBeInTheDocument();
    });

    it('falls back to a generic message when the rejection is not an Error', async () => {
      mockOpenEarnPosition.mockRejectedValue('nope');
      renderReview('aave-usdc-ethereum-1', '?amount=1000');

      fireEvent.click(screen.getByTestId('open-position-btn'));

      expect(await screen.findByText('earnFailedToOpenPosition')).toBeInTheDocument();
    });

    // Double-tapping the CTA must not open two positions.
    it('ignores a second tap while the first submission is in flight', async () => {
      let release: () => void = () => {};
      mockOpenEarnPosition.mockImplementation(() => new Promise<void>(resolve => (release = resolve)));
      renderReview('aave-usdc-ethereum-1', '?amount=1000');

      const cta = screen.getByTestId('open-position-btn');
      fireEvent.click(cta);
      fireEvent.click(cta);

      await waitFor(() => expect(mockOpenEarnPosition).toHaveBeenCalledTimes(1));
      await act(async () => {
        release();
      });
    });

    it('disables the CTA for a zero amount', () => {
      renderReview('aave-usdc-ethereum-1', '?amount=0');
      expect(screen.getByTestId('open-position-btn')).toBeDisabled();
    });
  });

  describe('footer padding responds to platform', () => {
    it('uses mobile horizontal padding when isMobile() is true', () => {
      (isMobile as jest.Mock).mockReturnValue(true);
      renderReview('aave-usdc-ethereum-1', '?amount=1000');
      const footer = screen.getByTestId('open-position-btn').parentElement!;
      expect(footer).toHaveClass('px-8');
      expect(footer).not.toHaveClass('px-6');
    });

    it('uses desktop horizontal padding when isMobile() is false', () => {
      renderReview('aave-usdc-ethereum-1', '?amount=1000');
      const footer = screen.getByTestId('open-position-btn').parentElement!;
      expect(footer).toHaveClass('px-6');
      expect(footer).not.toHaveClass('px-8');
    });
  });

  describe('deposit projection', () => {
    it('renders the projection chart and the three projected reward tiles', () => {
      renderReview('aave-usdc-ethereum-1', '?amount=1000');

      // Chart plumbing rendered.
      expect(screen.getByTestId('chart-container')).toBeInTheDocument();
      expect(screen.getByTestId('area-chart')).toBeInTheDocument();

      // Projection labels (keys echoed by the i18n mock).
      expect(screen.getByText('earnProjection1Month')).toBeInTheDocument();
      expect(screen.getByText('earnProjection6Months')).toBeInTheDocument();
      expect(screen.getByText('earnProjection1Year')).toBeInTheDocument();

      // Rewards = amount × APY fraction × year fraction, 2dp, interpolated into
      // the reward key. The fixture vault's APY is "5.24%" => 0.0524.
      expect(screen.getByText('earnProjectedRewardAmount_$4.37')).toBeInTheDocument();
      expect(screen.getByText('earnProjectedRewardAmount_$26.20')).toBeInTheDocument();
      expect(screen.getByText('earnProjectedRewardAmount_$52.40')).toBeInTheDocument();
    });

    it('renders the static detail rows including the route built from the vault', () => {
      renderReview('aave-usdc-ethereum-1', '?amount=1000');

      expect(screen.getByText('earnCollateralLabel')).toBeInTheDocument();
      expect(screen.getByText('earnCollateralValue')).toBeInTheDocument();

      expect(screen.getByText('earnEstimatedTime')).toBeInTheDocument();
      expect(screen.getByText('earnEstimatedTimeValue')).toBeInTheDocument();

      // Route label reuses the shared `route` key; value interpolates protocol + network.
      expect(screen.getByText('route')).toBeInTheDocument();
      expect(screen.getByText('earnDepositRoute_Aave_Ethereum')).toBeInTheDocument();
    });

    it('renders zero rewards when the amount is zero', () => {
      renderReview('aave-usdc-ethereum-1', '?amount=0');
      expect(screen.getByText('0.00')).toBeInTheDocument();
      // All three reward tiles collapse to +$0.00.
      expect(screen.getAllByText('earnProjectedRewardAmount_$0.00')).toHaveLength(3);
    });

    it('treats an unparseable APY as zero (placeholder vault, `|| 0` branch)', () => {
      renderReview('does-not-exist', '?amount=1000');
      expect(screen.getAllByText('earnProjectedRewardAmount_$0.00')).toHaveLength(3);
    });
  });

  // This screen commits value, so it names the network. The registry test proves the element is
  // in the file; this proves it actually renders - the distinction a source match cannot make.
  it('names the network it will commit on', () => {
    renderReview('vault-1', '?amount=10');

    expect(screen.getByTestId('network-mode-banner')).toBeInTheDocument();
  });
});

describe('EarnDepositReview after a failed load', () => {
  afterEach(() => {
    mockLoadState = { isLoading: false };
  });

  it('says the load failed, with Retry, instead of offering to open a position in a placeholder vault', () => {
    mockLoadState = { isLoading: false, error: 'boom', loadError: 'boom' };
    renderReview('no-such-vault', '?amount=10');

    expect(screen.getByRole('alert')).toHaveTextContent('earnVaultLoadError');
    expect(screen.getByRole('alert')).not.toHaveTextContent('earnPositionsLoadError');
    expect(screen.queryByRole('button', { name: 'earnOpenPosition' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the failure said while a retry is loading, with no vault in the header', () => {
    mockLoadState = { isLoading: true, error: 'boom', loadError: 'boom' };
    renderReview('no-such-vault', '?amount=10');

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByTestId('earn-flow-header')).toHaveAttribute('data-vault-id', 'none');
  });

  it('draws nothing it has not loaded during a first load with no error', () => {
    mockLoadState = { isLoading: true };
    renderReview('no-such-vault', '?amount=10');

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'earnOpenPosition' })).toBeNull();
    expect(screen.queryByText('earnDepositAmountTitle')).toBeNull();
  });

  it("shows no notice over a found vault when only one owner's positions failed", () => {
    mockLoadState = { isLoading: false, error: 'owner unavailable' };
    renderReview(EARN_DATA.vaults[1]!.id, '?amount=10');

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'earnOpenPosition' })).toBeInTheDocument();
  });

  it('keeps a vault it already has, under the notice', () => {
    mockLoadState = { isLoading: false, error: 'boom', loadError: 'boom' };
    renderReview(EARN_DATA.vaults[1]!.id, '?amount=10');

    expect(screen.getByRole('alert')).toHaveTextContent('earnVaultLoadError');
    expect(screen.getByRole('alert')).not.toHaveTextContent('earnPositionsLoadError');
    expect(screen.getByRole('button', { name: 'earnOpenPosition' })).toBeInTheDocument();
  });
});
