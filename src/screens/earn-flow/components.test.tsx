import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

// `components.tsx` imports the Aave logo as `...aave.svg?url`. The `?url` query
// suffix means it does NOT match the `\.svg$` asset mapper (which anchors on a
// trailing `.svg`), and the `^app/` path mapper would point at a non-existent
// `aave.svg?url` file. A virtual mock short-circuits resolution and gives the
// import a distinct, assertable value (mirrors `Logo.test.tsx`).
jest.mock('app/icons/earn-provider-logos/aave.svg?url', () => 'aave-logo-url-stub', { virtual: true });

// `EarnFlowHeader` wires the back button's `onClick` to `lib/woozie`'s `goBack`,
// which reaches for browser history on import. Stub it so we can assert the
// wiring without running the real router.
jest.mock('lib/woozie', () => ({
  goBack: jest.fn()
}));

// Stub the two child widgets to probes that surface the props `components.tsx`
// forwards, so we can prove the wiring (icon/onClick/aria-label, token symbol)
// without pulling in haptics / the SVG-logo chrome. This mirrors how the
// sibling `EarnDepositAmount.test.tsx` stubs its children.
jest.mock('components/CircleButton', () => ({
  CircleButton: ({
    icon,
    onClick,
    size,
    className,
    'aria-label': ariaLabel
  }: {
    icon: unknown;
    onClick?: () => void;
    size?: string;
    className?: string;
    'aria-label'?: string;
  }) => (
    <button
      data-testid="circle-button"
      data-icon={String(icon)}
      data-size={size}
      className={className}
      aria-label={ariaLabel}
      onClick={onClick}
    />
  )
}));

jest.mock('components/TokenLogo', () => ({
  TokenLogo: ({ symbol, size, className }: { symbol: string; size?: string; className?: string }) => (
    <div data-testid="token-logo" data-symbol={symbol} data-size={size} className={className} />
  )
}));

import { IconName } from 'app/icons/v2';
import { goBack } from 'lib/woozie';

import { EarnFlowHeader, MetricCard, EarnSummaryPanel, ProviderLogo, PositionLogo } from './components';
import { EarnSummary, EarnVault } from './types';

const mockGoBack = goBack as jest.Mock;

const VAULT: EarnVault = {
  id: 'aave-usdc-ethereum-1',
  protocol: 'Aave',
  asset: 'USDC',
  network: 'Ethereum',
  apy: '5.24%',
  apyChange24h: '+0.02%',
  tvl: '$1.2B',
  risk: 'Low',
  audited: true,
  about: 'about text',
  chartData: []
};

const SUMMARY: EarnSummary = {
  totalRewards: '$218.32',
  blendedApy: '~5.2%',
  totalDeposited: '$4,218.32',
  estimatedRewards: '+$24.50'
};

beforeEach(() => {
  mockGoBack.mockClear();
});

describe('EarnFlowHeader', () => {
  it('renders the protocol • asset title and the "asset on network" pill', () => {
    render(<EarnFlowHeader vault={VAULT} />);

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Aave');
    expect(heading).toHaveTextContent('USDC');
    // The bullet separator is rendered between protocol and asset.
    expect(heading.textContent).toContain('•');

    expect(screen.getByText('USDC on Ethereum')).toBeInTheDocument();
  });

  it('wires the back button to goBack with the ChevronLeft icon and Back label', () => {
    render(<EarnFlowHeader vault={VAULT} />);

    const button = screen.getByTestId('circle-button');
    expect(button).toHaveAttribute('aria-label', 'Back');
    expect(button).toHaveAttribute('data-icon', String(IconName.ChevronLeft));
    expect(button).toHaveAttribute('data-size', 'md');

    expect(mockGoBack).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('reflects a different vault protocol/asset/network', () => {
    render(<EarnFlowHeader vault={{ ...VAULT, protocol: 'Compound', asset: 'ETH', network: 'Base' }} />);

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Compound');
    expect(heading).toHaveTextContent('ETH');
    expect(screen.getByText('ETH on Base')).toBeInTheDocument();
  });
});

describe('MetricCard', () => {
  it('renders the label and value', () => {
    render(<MetricCard label="Total Deposited" value="$4,218.32" />);

    expect(screen.getByText('Total Deposited')).toBeInTheDocument();
    expect(screen.getByText('$4,218.32')).toBeInTheDocument();
  });

  it('applies the base container class and no extra classes when optional props are omitted', () => {
    const { container } = render(<MetricCard label="Label" value="Value" />);

    const card = container.firstChild as HTMLElement;
    expect(card).toHaveClass('bg-gray-25');

    const valueEl = screen.getByText('Value');
    // Base value classes are always present; no valueClassName was supplied.
    expect(valueEl).toHaveClass('font-bold');
  });

  it('merges valueClassName onto the value node and className onto the container', () => {
    const { container } = render(
      <MetricCard label="Estimated Rewards" value="+$24.50" valueClassName="text-status-positive" className="my-card" />
    );

    const card = container.firstChild as HTMLElement;
    expect(card).toHaveClass('my-card');
    expect(card).toHaveClass('bg-gray-25');

    const valueEl = screen.getByText('+$24.50');
    expect(valueEl).toHaveClass('text-status-positive');
  });
});

describe('EarnSummaryPanel', () => {
  it('renders the heading, total rewards and blended APY line', () => {
    render(<EarnSummaryPanel summary={SUMMARY} titleId="earn-title" />);

    expect(screen.getByText('Total Earned Rewards')).toBeInTheDocument();
    expect(screen.getByText('$218.32')).toBeInTheDocument();
    expect(screen.getByText('Earning ~5.2% blended APY')).toBeInTheDocument();
  });

  it('links the section to the heading via titleId and applies className', () => {
    const { container } = render(
      <EarnSummaryPanel summary={SUMMARY} titleId="my-title-id" className="panel-class" />
    );

    const section = container.querySelector('section') as HTMLElement;
    expect(section).toHaveAttribute('aria-labelledby', 'my-title-id');
    expect(section).toHaveClass('panel-class');

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveAttribute('id', 'my-title-id');
  });

  it('renders both metric cards by default (showMetrics defaults to true)', () => {
    render(<EarnSummaryPanel summary={SUMMARY} titleId="earn-title" />);

    expect(screen.getByText('Total Deposited')).toBeInTheDocument();
    expect(screen.getByText('$4,218.32')).toBeInTheDocument();
    expect(screen.getByText('Estimated Rewards')).toBeInTheDocument();
    expect(screen.getByText('+$24.50')).toBeInTheDocument();
  });

  it('hides the metric cards when showMetrics is false', () => {
    render(<EarnSummaryPanel summary={SUMMARY} titleId="earn-title" showMetrics={false} />);

    expect(screen.queryByText('Total Deposited')).not.toBeInTheDocument();
    expect(screen.queryByText('Estimated Rewards')).not.toBeInTheDocument();
    // The summary heading and figures still render.
    expect(screen.getByText('Total Earned Rewards')).toBeInTheDocument();
    expect(screen.getByText('$218.32')).toBeInTheDocument();
  });
});

describe('ProviderLogo', () => {
  it('renders the Aave image branch with the stubbed logo url and empty alt', () => {
    const { container } = render(<ProviderLogo protocol="Aave" className="logo-class" />);

    const img = container.querySelector('img') as HTMLImageElement;
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', 'aave-logo-url-stub');
    expect(img).toHaveAttribute('alt', '');

    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper).toHaveClass('logo-class');
    expect(wrapper).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders the first character fallback for a non-Aave protocol', () => {
    const { container } = render(<ProviderLogo protocol="Compound" />);

    expect(container.querySelector('img')).toBeNull();
    // protocol.charAt(0) → 'C'
    expect(container.firstChild).toHaveTextContent('C');
  });
});

describe('PositionLogo', () => {
  it('renders a TokenLogo for the asset symbol at size sm and forwards className', () => {
    render(<PositionLogo asset="USDC" className="pos-class" />);

    const logo = screen.getByTestId('token-logo');
    expect(logo).toHaveAttribute('data-symbol', 'USDC');
    expect(logo).toHaveAttribute('data-size', 'sm');
    expect(logo).toHaveClass('pos-class');
  });
});
