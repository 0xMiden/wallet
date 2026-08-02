import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { hapticSelection } from 'lib/mobile/haptics';
import { goBack, navigate } from 'lib/woozie';

// Imported after the mocks above are registered (jest hoists jest.mock).
import EarnVaultDetail from './EarnVaultDetail';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// `./components` re-exports `MetricCard` alongside a module-level
// `import aaveLogoUrl from '...aave.svg?url'` (a webpack `?url` query that
// jest's `\.svg$` mapper does not match). Stub the module so we only pull in a
// light `MetricCard` and never touch that asset import. The stub echoes its
// props via data-* attributes so we can assert what `EarnVaultDetail` passed
// (label / value / valueClassName), which is where the audited-branch styling
// lives.
// i18n: the component and the shared Button/CircleButton call `useTranslation`.
// Stub it so `t(key)` echoes the key, letting us assert on stable keys instead
// of translated English.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('./components', () => ({
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

// Haptics wrap the Capacitor plugin. `EarnVaultDetail` calls `hapticSelection`
// on timeframe taps; the real `Button` / `CircleButton` we render call
// `hapticLight`. Stub both so no native code is touched.
jest.mock('lib/mobile/haptics', () => ({
  hapticSelection: jest.fn(),
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
    isLoading: false,
    error: undefined
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

    // Stats: audited → "✓ yes" with the heading-gray value class.
    expect(metricValue('earnTvlLabel')).toHaveTextContent('$1.2B');
    expect(metricValue('earnRiskLabel')).toHaveTextContent('Low');
    const audited = metricValue('earnAuditedLabel');
    expect(audited).toHaveTextContent('✓ yes');
    expect(audited).toHaveAttribute('data-value-class', 'text-heading-gray');

    // About section copy.
    expect(screen.getByText('About the audited vault.')).toBeInTheDocument();

    // Chart mounted and the tooltip render-prop ran (produced our label + point).
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
    expect(screen.getByText('TipLabel')).toBeInTheDocument();
    // The tooltip body formats the point value to 2dp with a % suffix.
    // (The APY headline also reads "5.24%" but uses font-bold, not font-semibold.)
    expect(screen.getByText('5.24%', { selector: 'div.font-heading.font-semibold' })).toBeInTheDocument();
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

    // `?? placeholderVault()` — every display field is the "—" placeholder and
    // the empty id disables the Deposit CTA.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('— • —');
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

  it('defaults the active timeframe to 1M and switches on tap with haptic feedback', () => {
    render(<EarnVaultDetail vaultId="v-audited" />);

    const oneMonth = screen.getByRole('button', { name: '1M' });
    const oneDay = screen.getByRole('button', { name: '1D' });

    // Initial state: 1M is the selected (bold / black) timeframe.
    expect(oneMonth).toHaveClass('font-semibold', 'text-pure-black');
    expect(oneDay).not.toHaveClass('font-semibold');
    expect(oneDay).toHaveClass('text-gray-secondary');

    // Tap 1D → haptic fires and selection moves.
    fireEvent.click(oneDay);
    expect(hapticSelection).toHaveBeenCalledTimes(1);
    expect(oneDay).toHaveClass('font-semibold', 'text-pure-black');
    expect(oneMonth).not.toHaveClass('font-semibold');

    // All four timeframe options are rendered.
    ['1D', '1W', '1M', 'All'].forEach(label => {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    });
  });
});
