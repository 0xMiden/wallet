import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';

import EarnDepositReview from './EarnDepositReview';

// --- woozie router: mutable location + spyable navigate/goBack.
const mockLocation = { search: '' };
const mockNavigate = jest.fn();
const mockGoBack = jest.fn();

jest.mock('lib/woozie', () => ({
  navigate: (...args: unknown[]) => mockNavigate(...args),
  goBack: (...args: unknown[]) => mockGoBack(...args),
  useLocation: () => mockLocation
}));

// --- Platform / haptics.
jest.mock('lib/platform', () => ({
  isMobile: jest.fn(() => false)
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

// --- Chart wrapper: render children directly so the projection JSX still runs.
jest.mock('lib/ui/charts', () => ({
  ChartContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="chart-container">{children}</div>
  )
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
  Button: ({ title, onClick }: { title?: string; onClick?: () => void }) => (
    <button data-testid="open-position-btn" onClick={onClick}>
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

const renderReview = (vaultId: string, search = '') => {
  mockLocation.search = search;
  return render(<EarnDepositReview vaultId={vaultId} />);
};

describe('EarnDepositReview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLocation.search = '';
    (isMobile as jest.Mock).mockReturnValue(false);
  });

  describe('deposit amount header', () => {
    it('renders the page shell, resolves the vault by id, and shows the parsed amount + asset logo', () => {
      renderReview('aave-usdc-ethereum-2', '?amount=1000');

      expect(screen.getByTestId('earn-deposit-review-page')).toBeInTheDocument();

      // Vault resolved by id (not the default vaults[0]).
      const header = screen.getByTestId('earn-flow-header');
      expect(header).toHaveAttribute('data-vault-id', 'aave-usdc-ethereum-2');
      expect(header).toHaveAttribute('data-asset', 'USDC');

      // Amount from the query string, formatted to 2 dp.
      expect(screen.getByText('1000.00')).toBeInTheDocument();

      // Asset logo + label wired from the resolved vault.
      const logo = screen.getByTestId('token-logo');
      expect(logo).toHaveAttribute('data-symbol', 'USDC');
      expect(logo).toHaveAttribute('data-size', 'md');
      // The asset label appears next to the logo.
      expect(screen.getAllByText('USDC').length).toBeGreaterThan(0);
    });

    it('falls back to the default vault when the vaultId does not match any vault', () => {
      renderReview('does-not-exist', '?amount=500');
      // Default vault is EARN_DATA.vaults[0] → id "aave-usdc-ethereum-1".
      expect(screen.getByTestId('earn-flow-header')).toHaveAttribute('data-vault-id', 'aave-usdc-ethereum-1');
      expect(screen.getByText('500.00')).toBeInTheDocument();
    });

    it('strips thousands separators from the amount before parsing', () => {
      renderReview('aave-usdc-ethereum-1', '?amount=1,234.50');
      expect(screen.getByText('1234.50')).toBeInTheDocument();
    });

    it('defaults the amount to 0.00 when the query string has no amount param', () => {
      renderReview('aave-usdc-ethereum-1', '');
      expect(screen.getByText('0.00')).toBeInTheDocument();
    });

    it('coerces a non-numeric amount to 0.00 (parseAmount NaN branch)', () => {
      renderReview('aave-usdc-ethereum-1', '?amount=not-a-number');
      expect(screen.getByText('0.00')).toBeInTheDocument();
    });
  });

  describe('open position CTA', () => {
    it('fires haptic feedback and navigates to the default position on click', () => {
      renderReview('aave-usdc-ethereum-1', '?amount=1000');

      const cta = screen.getByTestId('open-position-btn');
      expect(cta).toHaveTextContent('Open position');

      fireEvent.click(cta);

      expect(hapticLight).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      // DEFAULT_POSITION_ID resolves from EARN_DATA.positions[0].id → "aave-usdc-1".
      expect(mockNavigate).toHaveBeenCalledWith('/earn/positions/aave-usdc-1');
    });
  });

  describe('footer padding responds to platform', () => {
    it('uses mobile horizontal padding when isMobile() is true', () => {
      (isMobile as jest.Mock).mockReturnValue(true);
      renderReview('aave-usdc-ethereum-1', '?amount=1000');
      const footer = screen.getByTestId('open-position-btn').parentElement as HTMLElement;
      expect(footer).toHaveClass('px-8');
      expect(footer).not.toHaveClass('px-6');
    });

    it('uses desktop horizontal padding when isMobile() is false', () => {
      renderReview('aave-usdc-ethereum-1', '?amount=1000');
      const footer = screen.getByTestId('open-position-btn').parentElement as HTMLElement;
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

      // Projected rewards: amount * factor, 2dp, "+$" prefixed.
      // 1000 * 0.0164 = 16.40, 1000 * 0.09825 = 98.25, 1000 * 0.1965 = 196.50.
      expect(screen.getByText('+$16.40')).toBeInTheDocument();
      expect(screen.getByText('+$98.25')).toBeInTheDocument();
      expect(screen.getByText('+$196.50')).toBeInTheDocument();
    });

    it('renders the static detail rows including the route built from the vault', () => {
      renderReview('aave-usdc-ethereum-1', '?amount=1000');

      expect(screen.getByText('Solver fee')).toBeInTheDocument();
      expect(screen.getByText('0.30%')).toBeInTheDocument();

      // "Network fee" appears twice (network fee + estimated time).
      expect(screen.getAllByText('Network fee')).toHaveLength(2);
      expect(screen.getByText('~$0.42')).toBeInTheDocument();
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
  });

  // The module-level `DEFAULT_POSITION_ID = positions[0]?.id ?? 'aave-usdc-1'`
  // and `DEFAULT_VAULT = vaults[0]!` are derived from EARN_DATA at import time.
  // With the real data (non-empty positions) the primary tests only exercise the
  // "truthy" side of those expressions. Re-importing the module against a
  // positions-less data fixture runs the module body again and exercises the
  // `?.id` short-circuit + `?? 'aave-usdc-1'` literal fallback branch.
  //
  // We only re-`require` here (no re-render): `isolateModules` gives the fresh
  // module its own React copy, which is incompatible with the top-level RTL
  // `render`. The fallback branch lives in module-scope initialization, so the
  // `require` itself is what exercises it.
  describe('module defaults fallback (empty positions)', () => {
    afterEach(() => {
      jest.dontMock('./data');
    });

    it('re-evaluates the default position/vault constants when there are no positions', () => {
      let FreshReview: unknown;

      jest.isolateModules(() => {
        jest.doMock('./data', () => ({
          EARN_DATA: {
            summary: { totalRewards: '', blendedApy: '', totalDeposited: '', estimatedRewards: '' },
            positions: [],
            vaults: [
              {
                id: 'fallback-vault',
                protocol: 'Compound',
                asset: 'DAI',
                network: 'Base',
                apy: '',
                apyChange24h: '',
                tvl: '',
                risk: '',
                audited: false,
                about: '',
                chartData: []
              }
            ]
          }
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        FreshReview = require('./EarnDepositReview').default;
      });

      // The module re-evaluated cleanly with no positions, proving the
      // `positions[0]?.id ?? 'aave-usdc-1'` fallback path executes without error.
      expect(typeof FreshReview).toBe('function');
    });
  });
});
