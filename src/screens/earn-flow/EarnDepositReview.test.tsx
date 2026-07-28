import React from 'react';

import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { openEarnPosition } from 'lib/epoch';
import { hapticLight } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';

import EarnDepositReview from './EarnDepositReview';

// --- woozie router: mutable location + spyable navigate.
const mockLocation = { search: '' };
const mockNavigate = jest.fn();

jest.mock('lib/woozie', () => ({
  navigate: (...args: unknown[]) => mockNavigate(...args),
  useLocation: () => mockLocation
}));

// --- Platform / haptics.
jest.mock('lib/platform', () => ({
  isMobile: jest.fn(() => false)
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

// --- Epoch SDK barrel (wasm + network clients): only the deposit entry point
//     and the USDC decimals constant are used by this screen.
jest.mock('lib/epoch', () => ({
  MIDEN_USDC_DECIMALS: 6,
  openEarnPosition: jest.fn(() => Promise.resolve())
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
    useEarnPositions: () => ({
      summary: EARN_DATA.summary,
      positions: EARN_DATA.positions,
      vaults: EARN_DATA.vaults,
      isLoading: false,
      error: undefined
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
  EarnFlowHeader: ({ vault }: { vault: { id: string; asset: string; protocol: string; network: string } }) => (
    <div
      data-testid="earn-flow-header"
      data-vault-id={vault.id}
      data-asset={vault.asset}
      data-protocol={vault.protocol}
      data-network={vault.network}
    />
  )
}));

const mockOpenEarnPosition = openEarnPosition as jest.Mock;

const renderReview = (vaultId: string, search = '') => {
  mockLocation.search = search;
  return render(<EarnDepositReview vaultId={vaultId} />);
};

describe('EarnDepositReview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLocation.search = '';
    mockAccount.evmAddress = '0xdeadbeef';
    mockAccount.type = undefined;
    (isMobile as jest.Mock).mockReturnValue(false);
    mockOpenEarnPosition.mockResolvedValue(undefined);
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

    it('falls back to the placeholder vault when the vaultId matches nothing', () => {
      renderReview('does-not-exist', '?amount=500');

      const header = screen.getByTestId('earn-flow-header');
      expect(header).toHaveAttribute('data-vault-id', '');
      expect(header).toHaveAttribute('data-protocol', '—');
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
    it('disables the CTA and explains why on a Guardian account', () => {
      mockAccount.type = 'guardian';
      renderReview('aave-usdc-ethereum-1', '?amount=1000');

      const cta = screen.getByTestId('open-position-btn');
      expect(cta).toBeDisabled();
      expect(screen.getByText('earnDepositGuardianUnsupported')).toBeInTheDocument();

      fireEvent.click(cta);
      expect(mockOpenEarnPosition).not.toHaveBeenCalled();
    });

    it('fires haptics and opens the Epoch position with the scaled amount + account owner', async () => {
      renderReview('aave-usdc-ethereum-1', '?amount=1,000');

      const cta = screen.getByTestId('open-position-btn');
      expect(cta).toHaveTextContent('Open position');
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

      expect(await screen.findByText('No EVM address available for this account.')).toBeInTheDocument();
      expect(mockOpenEarnPosition).not.toHaveBeenCalled();
    });

    it('surfaces the SDK error message when opening the position rejects', async () => {
      mockOpenEarnPosition.mockRejectedValue(new Error('allocator unreachable'));
      renderReview('aave-usdc-ethereum-1', '?amount=1000');

      fireEvent.click(screen.getByTestId('open-position-btn'));

      expect(await screen.findByText('allocator unreachable')).toBeInTheDocument();
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

      // Projection labels.
      expect(screen.getByText('1 MONTH')).toBeInTheDocument();
      expect(screen.getByText('6 MONTHS')).toBeInTheDocument();
      expect(screen.getByText('1 YEAR')).toBeInTheDocument();

      // Rewards = amount × APY fraction × year fraction, 2dp, "+$" prefixed.
      // The fixture vault's APY is "5.24%" => 0.0524.
      expect(screen.getByText('+$4.37')).toBeInTheDocument();
      expect(screen.getByText('+$26.20')).toBeInTheDocument();
      expect(screen.getByText('+$52.40')).toBeInTheDocument();
    });

    it('renders the static detail rows including the route built from the vault', () => {
      renderReview('aave-usdc-ethereum-1', '?amount=1000');

      expect(screen.getByText('Collateral')).toBeInTheDocument();
      expect(screen.getByText('Miden P2IDE (gasless)')).toBeInTheDocument();

      expect(screen.getByText('Estimated time')).toBeInTheDocument();
      expect(screen.getByText('~30 seconds')).toBeInTheDocument();

      // Route: `Miden -> ${protocol} (${network})`.
      expect(screen.getByText('Route')).toBeInTheDocument();
      expect(screen.getByText('Miden -> Aave (Ethereum)')).toBeInTheDocument();
    });

    it('renders zero rewards when the amount is zero', () => {
      renderReview('aave-usdc-ethereum-1', '?amount=0');
      expect(screen.getByText('0.00')).toBeInTheDocument();
      // All three reward tiles collapse to +$0.00.
      expect(screen.getAllByText('+$0.00')).toHaveLength(3);
    });

    it('treats an unparseable APY as zero (placeholder vault, `|| 0` branch)', () => {
      renderReview('does-not-exist', '?amount=1000');
      expect(screen.getAllByText('+$0.00')).toHaveLength(3);
    });
  });
});
