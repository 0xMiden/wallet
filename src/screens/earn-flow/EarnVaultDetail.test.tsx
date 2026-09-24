import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { goBack, navigate } from 'lib/woozie';

// Imported after the mocks above are registered (jest hoists jest.mock).
import { EARN_PLACEHOLDER } from './earn-mapping';
import EarnVaultDetail from './EarnVaultDetail';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// `./components` imports `...aave.svg?url` (a webpack `?url` query that jest's
// `\.svg$` mapper does not match), so a virtual mock stands in for it. The
// real `EarnFlowHeader` draws the page header; `MetricCard` is a stub that
// echoes its props via data-* attributes so we can assert what
// `EarnVaultDetail` passed (label / value / valueClassName), which is where the
// audited-branch styling lives.
// i18n: the component and the shared Button/IconButton call `useTranslation`.
// Stub it so `t(key)` echoes the key, letting us assert on stable keys instead
// of translated English.
// A load that did not fully succeed is driven per test; the default is a clean load.
let mockLoadState: { isLoading: boolean; error?: string; loadError?: string } = { isLoading: false };
const mockRefetch = jest.fn();

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('app/icons/earn-provider-logos/aave.svg?url', () => 'aave-logo-url-stub', { virtual: true });

// Stubs the accent through to a `data-accent` attribute (the SendAmount.test.tsx pattern) so the
// Deposit CTA's flow colour is assertable without the real Button's cva class computation.
jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary' },
  Button: ({ title, variant: _variant, accent, ...rest }: any) => (
    <button type="button" data-accent={accent} {...rest}>
      {title}
    </button>
  )
}));

jest.mock('./components', () => ({
  EarnFlowHeader: jest.requireActual<typeof import('./components')>('./components').EarnFlowHeader,
  MetricCard: ({
    label,
    value,
    valueClassName,
    className
  }: {
    label: string;
    value: string;
    valueClassName?: string;
    className?: string;
  }) => (
    <div data-testid="metric-card" data-label={label} data-value-class={valueClassName ?? ''} className={className}>
      {value}
    </div>
  )
}));

// `lib/woozie` back/forward navigation is native-history-backed; stub the two
// entry points the component calls so we can assert them without a real router.
jest.mock('lib/woozie', () => ({
  goBack: jest.fn(),
  navigate: jest.fn()
}));

// Haptics wrap the Capacitor plugin. The real `Button` / `IconButton` we render
// call `hapticLight`; stub it so no native code is touched.
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

// Recharts renders nothing under jsdom's zero-size layout, so the component's
// `Tooltip` `content` render-prop and the `Area` `dot` render-prop would never
// execute. Replace the module boundary with light stand-ins that:
//   - render their children (so the chart subtree mounts),
//   - invoke `content` across every branch (inactive / empty payload / a real
//     point) so the tooltip body runs,
//   - invoke `dot` across a range of indices so both the "last point" (renders
//     a circle) and "not last" (returns null) branches run.
jest.mock('recharts', () => {
  const ReactLib = require('react');
  return {
    __esModule: true,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) =>
      ReactLib.createElement(ReactLib.Fragment, null, children),
    AreaChart: ({ children }: { children: React.ReactNode }) =>
      ReactLib.createElement('div', { 'data-testid': 'area-chart' }, children),
    YAxis: () => null,
    Legend: () => null,
    Tooltip: ({ content }: { content?: (args: any) => React.ReactNode }) => {
      if (typeof content !== 'function') return null;
      const rendered = [
        content({ active: false, payload: undefined }),
        content({ active: true, payload: [] }),
        content({ active: true, payload: [{ payload: { value: 5.24, label: 'TipLabel' } }] })
      ];
      return ReactLib.createElement(
        'div',
        { 'data-testid': 'tooltip' },
        rendered.map((node: React.ReactNode, i: number) => ReactLib.createElement(ReactLib.Fragment, { key: i }, node))
      );
    },
    Area: ({ dot }: { dot?: (props: any) => React.ReactNode }) => {
      const dots: React.ReactNode[] = [];
      if (typeof dot === 'function') {
        for (let i = 0; i < 20; i++) {
          dots.push(ReactLib.createElement(ReactLib.Fragment, { key: i }, dot({ index: i, cx: i, cy: i })));
        }
      }
      return ReactLib.createElement('svg', { 'data-testid': 'area' }, dots);
    }
  };
});

// Controlled data (inlined inside the factory because jest hoists jest.mock
// above module-scope `const`s, so referencing outer consts would hit the TDZ).
// The screen reads live Epoch data through `useEarnPositions` (`useAccount` +
// SWR under the hood), so we replace that hook rather than the data module.
// Two vaults exercise every data-dependent branch:
//   - the audited vault  — audited=true, varying chart values → padding math
//     truthy branch.
//   - the unaudited vault — audited=false, all-equal chart values →
//     `(max-min)*0.18` is 0, so the `|| 1` fallback branch runs.
jest.mock('./useEarnPositions', () => ({
  ...jest.requireActual<typeof import('./useEarnPositions')>('./useEarnPositions'),
  useEarnPositions: () => ({
    summary: { totalRewards: '', blendedApy: '', totalDeposited: '', estimatedRewards: '' },
    positions: [],
    vaults: [
      {
        id: 'v-audited',
        protocol: 'Aave',
        asset: 'USDC',
        network: 'Ethereum',
        apy: '5.24%',
        apyChange24h: '+0.12% (24h)',
        tvl: '$1.2B',
        risk: 'Low',
        audited: true,
        about: 'About the audited vault.',
        chartData: [
          { label: 'D1', value: 4.9 },
          { label: 'D2', value: 5.1 },
          { label: 'D3', value: 5.0 },
          { label: 'D4', value: 5.24 }
        ]
      },
      {
        id: 'v-unaudited',
        protocol: 'Compound',
        asset: 'DAI',
        network: 'Base',
        apy: '3.10%',
        apyChange24h: '-0.05% (24h)',
        tvl: '$500M',
        risk: 'Medium',
        audited: false,
        about: 'About the unaudited vault.',
        chartData: [
          { label: 'F1', value: 3.0 },
          { label: 'F2', value: 3.0 },
          { label: 'F3', value: 3.0 }
        ]
      }
    ],
    ...mockLoadState,
    refetch: mockRefetch
  })
}));

const metricValue = (label: string) => {
  const cards = screen.getAllByTestId('metric-card');
  const card = cards.find(el => el.getAttribute('data-label') === label);
  if (!card) throw new Error(`metric card "${label}" not found`);
  return card;
};

describe('EarnVaultDetail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Guardian accounts are supported: earn deposits are built as a recallable
  // P2IDE custom proposal in `generateTransaction`, so the CTA is never gated on
  // account type — it only disables while the vault id is still loading.
  it('leaves the Deposit CTA enabled once the vault has loaded', () => {
    render(<EarnVaultDetail vaultId="v-audited" />);

    expect(screen.getByRole('button', { name: 'earnDeposit' })).not.toBeDisabled();
  });

  it('gives the Deposit CTA the earn flow colour', () => {
    render(<EarnVaultDetail vaultId="v-audited" />);

    expect(screen.getByTestId('earn-vault-deposit-btn')).toHaveAttribute('data-accent', 'earn');
  });

  it('carries only layout on the deposit CTA, no restyled height/radius/weight', () => {
    render(<EarnVaultDetail vaultId="v-audited" />);

    // Was `h-14 max-w-none rounded-full text-lg font-bold` (`rounded-full` and
    // `font-extrabold` below are the canonical Button's own base classes, not a
    // caller override, so they're expected and not asserted against here).
    const depositBtn = screen.getByTestId('earn-vault-deposit-btn');
    expect(depositBtn).toHaveClass('max-w-none');
    expect(depositBtn.className).not.toMatch(/h-14|\btext-lg\b|\bfont-bold\b/);
  });

  it('renders the audited vault: header, APY block, stats, about and chart', () => {
    render(<EarnVaultDetail vaultId="v-audited" />);

    // Page root.
    expect(screen.getByTestId('earn-vault-detail-page')).toBeInTheDocument();

    // Header: "{protocol} • {asset}" title and "{asset} on {network}" pill.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Aave • USDC');
    // "{{asset}} on {{network}}" pill — the stubbed t() echoes the key.
    expect(screen.getByText('earnAssetOnNetwork')).toBeInTheDocument();

    // APY section.
    expect(screen.getByText('earnCurrentApy')).toBeInTheDocument();
    expect(screen.getByText('+0.12% (24h)')).toBeInTheDocument();
    // "5.24%" appears in the APY headline (and in the mocked tooltip body).
    expect(screen.getAllByText('5.24%').length).toBeGreaterThanOrEqual(1);

    // Stats: audited → "✓ yes" with the ink value class.
    expect(metricValue('earnTvlLabel')).toHaveTextContent('$1.2B');
    expect(metricValue('earnRiskLabel')).toHaveTextContent('Low');
    const audited = metricValue('earnAuditedLabel');
    expect(audited).toHaveTextContent('✓ yes');
    expect(audited).toHaveAttribute('data-value-class', 'text-ink');

    // About section copy.
    expect(screen.getByText('About the audited vault.')).toBeInTheDocument();

    // Chart mounted and the tooltip render-prop ran (produced our label + point).
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
    expect(screen.getByText('TipLabel')).toBeInTheDocument();
    // The tooltip body formats the point value to 2dp with a % suffix.
    // (The APY headline also reads "5.24%" but takes the display style.)
    expect(screen.getByText('5.24%', { selector: 'div.text-badge' })).toBeInTheDocument();
  });

  it('renders the unaudited vault with flat chart data (padding fallback + "No")', () => {
    render(<EarnVaultDetail vaultId="v-unaudited" />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Compound • DAI');
    expect(screen.getByText('earnAssetOnNetwork')).toBeInTheDocument();

    // Not audited → "no" and no explicit value class (undefined → '').
    const audited = metricValue('earnAuditedLabel');
    expect(audited).toHaveTextContent('no');
    expect(audited).toHaveAttribute('data-value-class', '');
    expect(metricValue('earnRiskLabel')).toHaveTextContent('Medium');
    expect(metricValue('earnTvlLabel')).toHaveTextContent('$500M');

    expect(screen.getByText('About the unaudited vault.')).toBeInTheDocument();
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
  });

  it('falls back to the placeholder vault when the id is unknown', () => {
    render(<EarnVaultDetail vaultId="does-not-exist" />);

    // `?? placeholderVault()`: every body field is the EARN_PLACEHOLDER value, the header names only the
    // route, and the empty id disables the Deposit CTA.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^earnDeposit$/);
    expect(metricValue('earnTvlLabel')).toHaveTextContent('—');
    expect(screen.getByRole('button', { name: 'earnDeposit' })).toBeDisabled();
  });

  it('navigates back when the header back button is pressed', () => {
    render(<EarnVaultDetail vaultId="v-audited" />);

    fireEvent.click(screen.getByLabelText('back'));
    expect(goBack).toHaveBeenCalledTimes(1);
  });

  it('navigates to the deposit route when the Deposit button is pressed', () => {
    render(<EarnVaultDetail vaultId="v-audited" />);

    fireEvent.click(screen.getByRole('button', { name: 'earnDeposit' }));
    expect(navigate).toHaveBeenCalledWith('/earn/vaults/v-audited/deposit');
  });

  // No timeframe row: no chart on this screen reads a timeframe, so the control changed nothing.
  it('draws the chart with no timeframe row', () => {
    render(<EarnVaultDetail vaultId="v-audited" />);

    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
  });
});

describe('EarnVaultDetail after a failed load', () => {
  afterEach(() => {
    mockLoadState = { isLoading: false };
  });

  it('says the load failed, with Retry, instead of drawing a placeholder vault', () => {
    mockLoadState = { isLoading: false, error: 'boom', loadError: 'boom' };
    render(<EarnVaultDetail vaultId="does-not-exist" />);

    expect(screen.getByRole('alert')).toHaveTextContent('earnVaultLoadError');
    expect(screen.getByRole('alert')).not.toHaveTextContent('earnPositionsLoadError');
    expect(screen.queryByRole('button', { name: 'earnDeposit' })).toBeNull();
    expect(screen.queryByText('earnCurrentApy')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it("shows no notice over a found vault when only one owner's positions failed", () => {
    mockLoadState = { isLoading: false, error: 'owner unavailable' };
    render(<EarnVaultDetail vaultId="v-audited" />);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Aave • USDC');
    expect(screen.getByRole('button', { name: 'earnDeposit' })).toBeEnabled();
  });

  it('keeps a vault it already has, under the notice', () => {
    mockLoadState = { isLoading: false, error: 'boom', loadError: 'boom' };
    render(<EarnVaultDetail vaultId="v-audited" />);

    expect(screen.getByRole('alert')).toHaveTextContent('earnVaultLoadError');
    expect(screen.getByRole('alert')).not.toHaveTextContent('earnPositionsLoadError');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Aave • USDC');
    expect(screen.getByRole('button', { name: 'earnDeposit' })).toBeEnabled();
  });

  it('keeps the failure said while a retry is loading, and names only the route in the header', () => {
    mockLoadState = { isLoading: true, error: 'boom', loadError: 'boom' };
    render(<EarnVaultDetail vaultId="does-not-exist" />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('— • —')).toBeNull();
    expect(screen.queryByText('earnAssetOnNetwork')).toBeNull();
    expect(screen.getByLabelText('back')).toBeInTheDocument();
  });

  it('draws nothing it has not loaded during a first load with no error', () => {
    mockLoadState = { isLoading: true };
    render(<EarnVaultDetail vaultId="does-not-exist" />);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'earnDeposit' })).toBeNull();
    expect(screen.queryByText('earnCurrentApy')).toBeNull();
    expect(screen.queryByText(EARN_PLACEHOLDER)).toBeNull();
  });
});

const MISSING_LOAD_STATES: Array<[string, { isLoading: boolean; error?: string; loadError?: string }]> = [
  ['a failed load', { isLoading: false, error: 'boom', loadError: 'boom' }],
  ['a load in flight', { isLoading: true }],
  ['a settled load without it', { isLoading: false }]
];

describe('EarnVaultDetail with no vault to name', () => {
  afterEach(() => {
    mockLoadState = { isLoading: false };
  });

  it.each(MISSING_LOAD_STATES)('keeps a route heading and no placeholder name after %s', (_state, loadState) => {
    mockLoadState = loadState;
    render(<EarnVaultDetail vaultId="does-not-exist" />);

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent(/^earnDeposit$/);
    expect(screen.queryByText(`${EARN_PLACEHOLDER} • ${EARN_PLACEHOLDER}`)).toBeNull();
    expect(screen.queryByText(/earnAssetOnNetwork/)).toBeNull();
  });
});
