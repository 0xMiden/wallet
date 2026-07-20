import React from 'react';

import { fireEvent, render, screen, within } from '@testing-library/react';

// `EarnPositionDetail` renders a recharts `<AreaChart>` inside `ChartContainer`.
// Under jsdom the real `ResponsiveContainer` measures a zero-size box and
// renders nothing, and the chart's render-prop callbacks (the `<Tooltip>`
// `content` and the `<Area>` `dot`) never fire — so they'd read as uncovered.
// We replace the recharts module boundary with light stand-ins that:
//   - `ResponsiveContainer` / `AreaChart` render their children directly, so
//     the source's `<defs>` / `<YAxis>` / `<Tooltip>` / `<Area>` JSX executes.
//   - `Area` invokes the `dot` render-prop across a range of indices so BOTH
//     branches of `props.index === lastIndex ? <circle/> : null` are exercised.
//   - `Tooltip` invokes the `content` render-prop with three payload shapes so
//     every branch of `if (!active || !payload?.[0]) return null` runs.
// The factory references no out-of-scope bindings (only `require('react')`) so
// swc's jest-hoist is happy (mirrors the sibling `lib/ui/charts.test.tsx`).
jest.mock('recharts', () => {
  const R = require('react');
  return {
    __esModule: true,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => children,
    AreaChart: ({ children }: { children: React.ReactNode }) =>
      R.createElement('div', { 'data-testid': 'area-chart' }, children),
    YAxis: () => null,
    Area: ({ dot }: { dot?: (props: any) => React.ReactNode }) => {
      const nodes: React.ReactNode[] = [];
      if (typeof dot === 'function') {
        // Cover both `dot` branches regardless of the chart length: the source
        // returns a <circle> only when `index === lastIndex`, null otherwise.
        for (let index = 0; index < 20; index++) {
          const el = dot({ index, cx: index, cy: index });
          if (el) nodes.push(R.cloneElement(el as React.ReactElement, { key: `dot-${index}` }));
        }
      }
      return R.createElement('g', { 'data-testid': 'area' }, nodes);
    },
    Tooltip: ({ content }: { content?: (props: any) => React.ReactNode }) => {
      if (typeof content !== 'function') return null;
      const variants = [
        // active === false -> early return null (left operand true).
        content({ active: false, payload: [{ payload: { value: 1, label: 'ignored' } }] }),
        // active but payload undefined -> `!payload?.[0]` true -> null.
        content({ active: true, payload: undefined }),
        // active with a real payload -> renders the tooltip body.
        content({ active: true, payload: [{ payload: { value: 1234.5, label: 'MockTooltipLabel' } }] })
      ];
      return R.createElement(
        'div',
        { 'data-testid': 'tooltip' },
        variants.map((v, i) => (v ? R.cloneElement(v as React.ReactElement, { key: `tt-${i}` }) : null))
      );
    },
    Legend: () => null
  };
});

// `lib/woozie`'s real barrel reaches for browser history/analytics on import.
// Stub `goBack` so we can assert the back-button wiring without the router.
jest.mock('lib/woozie', () => ({
  goBack: jest.fn()
}));

// Stub the shared earn widgets to prop probes. This keeps the test focused on
// `EarnPositionDetail`'s own JSX/branches and sidesteps `components.tsx`'s
// `aave.svg?url` logo import + `TokenLogo` chrome (mirrors how the sibling
// `EarnDepositAmount.test.tsx` stubs `./components`).
jest.mock('./components', () => {
  const R = require('react');
  return {
    __esModule: true,
    EarnSummaryPanel: ({
      summary,
      titleId,
      showMetrics
    }: {
      summary: { totalRewards: string };
      titleId: string;
      showMetrics?: boolean;
    }) =>
      R.createElement(
        'div',
        { 'data-testid': 'earn-summary', id: titleId, 'data-showmetrics': String(showMetrics) },
        summary.totalRewards
      ),
    MetricCard: ({ label, value, valueClassName }: { label: string; value: string; valueClassName?: string }) =>
      R.createElement(
        'div',
        { 'data-testid': 'metric-card', 'data-label': label, 'data-valueclass': valueClassName ?? '' },
        value
      ),
    PositionLogo: ({ asset, className }: { asset: string; className?: string }) =>
      R.createElement('div', { 'data-testid': 'position-logo', 'data-asset': asset, className })
  };
});

// Feed the component a deterministic dataset. Two positions let us cover both
// the `find(...)` hit path and the `?? DEFAULT_POSITION` fallback path, and the
// flat-value chart covers the `(max - min) * 0.18 || 1` fallback branch (the
// real dataset never has an all-equal series, so this is the only way to reach
// the `|| 1` arm without touching the source).
jest.mock('./data', () => ({
  EARN_DATA: {
    summary: {
      totalRewards: '$218.32',
      blendedApy: '~5.2%',
      totalDeposited: '$4,218.32',
      estimatedRewards: '+$24.50'
    },
    positions: [
      {
        // positions[0] -> DEFAULT_POSITION (used by the fallback path).
        id: 'pos-normal',
        protocol: 'Aave',
        asset: 'USDC',
        network: 'Ethereum',
        amount: '$1,024.50',
        depositedAmount: '$1,000.00',
        rewards: '+$24.50',
        age: '42d',
        activeDuration: '42 days active',
        apy: '5.24%',
        dailyAverage: '+$0.58',
        started: 'Mar 18',
        yearlyEstimate: '+$53.68 / yr',
        withdrawTime: '~30 sec no lockup',
        route: 'Miden -> Aave (Ethereum)',
        // varying values -> (max - min) * 0.18 is truthy.
        chartData: [
          { label: 'A', value: 10 },
          { label: 'B', value: 20 },
          { label: 'C', value: 30 }
        ]
      },
      {
        id: 'pos-flat',
        protocol: 'FlatProto',
        asset: 'FUSD',
        network: 'Flatnet',
        amount: '$2,024.50',
        depositedAmount: '$2,000.00',
        rewards: '+$99.00',
        age: '7d',
        activeDuration: '7 days active',
        apy: '9.99%',
        dailyAverage: '+$1.11',
        started: 'Jan 01',
        yearlyEstimate: '+$120.00 / yr',
        withdrawTime: '~10 sec instant',
        route: 'Miden -> Flat (Flatnet)',
        // all-equal values -> max - min === 0 -> padding falls back to `|| 1`.
        chartData: [
          { label: 'A', value: 50 },
          { label: 'B', value: 50 },
          { label: 'C', value: 50 }
        ]
      }
    ],
    vaults: []
  }
}));

import { goBack } from 'lib/woozie';

import EarnPositionDetail from './EarnPositionDetail';

const mockGoBack = goBack as jest.Mock;

const renderDetail = (positionId: string) => render(<EarnPositionDetail positionId={positionId} />);

beforeEach(() => {
  mockGoBack.mockClear();
});

describe('EarnPositionDetail', () => {
  it('renders the matched position (find hit path) with header, summary and metrics', () => {
    const { container } = renderDetail('pos-flat');

    // Page shell.
    expect(screen.getByTestId('earn-position-detail-page')).toBeInTheDocument();

    // Header title: "My {protocol} • {asset} position".
    const heading = screen.getByRole('heading', { level: 1, name: /My FlatProto/ });
    expect(heading).toHaveTextContent('My FlatProto');
    expect(heading).toHaveTextContent('FUSD position');

    // EarnSummaryPanel is rendered with metrics hidden and the correct titleId.
    const summary = screen.getByTestId('earn-summary');
    expect(summary).toHaveAttribute('id', 'earn-position-summary-title');
    expect(summary).toHaveAttribute('data-showmetrics', 'false');
    expect(summary).toHaveTextContent('$218.32');

    // Six MetricCards with the flat position's values.
    const cards = screen.getAllByTestId('metric-card');
    expect(cards).toHaveLength(6);
    const byLabel = (label: string) => cards.find(c => c.getAttribute('data-label') === label)!;
    expect(byLabel('Deposited')).toHaveTextContent('$2,000.00');
    expect(byLabel('Total Earned')).toHaveTextContent('+$99.00');
    expect(byLabel('Total Earned')).toHaveAttribute('data-valueclass', 'text-status-positive');
    expect(byLabel('APY')).toHaveTextContent('9.99%');
    expect(byLabel('Daily Avg')).toHaveTextContent('+$1.11');
    expect(byLabel('Time Active')).toHaveTextContent('7d');
    expect(byLabel('Started')).toHaveTextContent('Jan 01');

    // PositionHeading: logo + "{protocol} • {asset}" + "{asset} on {network}" pill.
    expect(screen.getByTestId('position-logo')).toHaveAttribute('data-asset', 'FUSD');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('FlatProto');
    expect(container.textContent).toContain('FUSD on Flatnet');

    // ProjectedEarnings summary line.
    expect(container.textContent).toContain('+$120.00 / yr');
    expect(container.textContent).toContain('9.99% APY');

    // PositionDetails rows.
    expect(container.textContent).toContain('Protocol');
    expect(container.textContent).toContain('Network');
    expect(container.textContent).toContain('Route');
    expect(container.textContent).toContain('Miden -> Flat (Flatnet)');
    expect(container.textContent).toContain('~10 sec instant');

    // Action buttons (note: "Withdraw" also appears as a PositionDetails row
    // label, so target the buttons by role to disambiguate).
    expect(screen.getByRole('button', { name: 'Deposit more' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeInTheDocument();
  });

  it('falls back to DEFAULT_POSITION when the id does not match any position', () => {
    const { container } = renderDetail('does-not-exist');

    // DEFAULT_POSITION === positions[0] === the "Aave / USDC" normal position.
    expect(screen.getByRole('heading', { level: 1, name: /My Aave/ })).toHaveTextContent('USDC position');
    expect(screen.getByTestId('position-logo')).toHaveAttribute('data-asset', 'USDC');

    const cards = screen.getAllByTestId('metric-card');
    const byLabel = (label: string) => cards.find(c => c.getAttribute('data-label') === label)!;
    expect(byLabel('Deposited')).toHaveTextContent('$1,000.00');
    expect(byLabel('APY')).toHaveTextContent('5.24%');
    expect(container.textContent).toContain('+$53.68 / yr');
    expect(container.textContent).toContain('Miden -> Aave (Ethereum)');
  });

  it('renders the four timeframe buttons with 1M active by default and switches on click', () => {
    renderDetail('pos-flat');

    const oneMonth = screen.getByRole('button', { name: '1M' });
    const oneWeek = screen.getByRole('button', { name: '1W' });
    const oneDay = screen.getByRole('button', { name: '1D' });
    const all = screen.getByRole('button', { name: 'All' });

    // Default active timeframe is 1M.
    expect(oneMonth).toHaveClass('font-semibold', 'text-pure-black');
    expect(oneWeek).not.toHaveClass('font-semibold');
    expect(oneDay).not.toHaveClass('font-semibold');
    expect(all).not.toHaveClass('font-semibold');

    // Clicking another timeframe moves the active styling (covers the onClick
    // handler + the `timeframe === item` ternary flipping both ways).
    fireEvent.click(oneWeek);
    expect(oneWeek).toHaveClass('font-semibold', 'text-pure-black');
    expect(oneMonth).not.toHaveClass('font-semibold');
  });

  it('invokes goBack when the back button is pressed', () => {
    renderDetail('pos-flat');

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('renders the area chart, its last-point dot and the tooltip content branch', () => {
    const { container } = renderDetail('pos-flat');

    // AreaChart + Area stand-ins mounted (proves the chart JSX executed).
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
    expect(screen.getByTestId('area')).toBeInTheDocument();

    // The `dot` render-prop returned exactly one <circle> for the last index.
    const circles = container.querySelectorAll('circle');
    expect(circles.length).toBeGreaterThanOrEqual(1);
    expect(circles[0]).toHaveAttribute('fill', '#90BA89');

    // The `content` render-prop rendered the active-payload branch: formatted
    // value (toFixed(2)) + label.
    const tooltip = screen.getByTestId('tooltip');
    expect(within(tooltip).getByText('$1234.50')).toBeInTheDocument();
    expect(within(tooltip).getByText('MockTooltipLabel')).toBeInTheDocument();
  });

  it('covers the flat-chart padding fallback and a varying-chart series without error', () => {
    // pos-flat -> all-equal values -> padding `|| 1` branch.
    const flat = renderDetail('pos-flat');
    expect(flat.getByTestId('area-chart')).toBeInTheDocument();
    flat.unmount();

    // pos-normal -> varying values -> padding truthy branch.
    const normal = renderDetail('pos-normal');
    expect(normal.getByTestId('area-chart')).toBeInTheDocument();
    expect(normal.getByRole('heading', { level: 1, name: /My Aave/ })).toBeInTheDocument();
  });
});
