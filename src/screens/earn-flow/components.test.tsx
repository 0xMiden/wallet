import React from 'react';

import { render, screen, fireEvent, within } from '@testing-library/react';

import { IconName } from 'app/icons/v2';
import { goBack } from 'lib/woozie';

import { EarnAmountUnit, EarnAssetMark, EarnFlowHeader, EarnHero, MetricCard, EarnSummaryPanel } from './components';
import { EarnSummary, EarnVault } from './types';

jest.mock('app/hooks/useVerificationBaseFee', () => ({ __esModule: true, default: () => 0 }));
jest.mock('app/hooks/useMidenFaucetId', () => ({ __esModule: true, default: () => 'MIDEN-ID' }));

// `EarnFlowHeader` hands `lib/woozie`'s `goBack` to its PageHeader's back button,
// which reaches for browser history on import. Stub it so we can assert the
// wiring without running the real router.
jest.mock('lib/woozie', () => ({
  goBack: jest.fn()
}));

// Stub react-i18next so `t(key)` echoes the key, letting us assert on
// translation keys instead of English (matches the sibling earn-flow tests).
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// Stub the two child widgets to probes that surface the props `components.tsx`
// forwards, so we can prove the wiring (icon/onClick/aria-label, token symbol)
// without pulling in haptics / the SVG-logo chrome. This mirrors how the
// sibling `EarnDepositAmount.test.tsx` stubs its children.
jest.mock('components/ui/IconButton', () => ({
  IconButton: ({
    icon,
    onClick,
    label,
    className
  }: {
    icon: unknown;
    onClick?: () => void;
    label?: string;
    className?: string;
  }) => (
    <button
      data-testid="icon-button"
      data-icon={String(icon)}
      className={className}
      aria-label={label}
      onClick={onClick}
    />
  )
}));

jest.mock('components/TokenLogo', () => ({
  TokenLogo: ({
    symbol,
    size,
    badge,
    className
  }: {
    symbol: string;
    size?: string;
    badge?: React.ReactNode;
    className?: string;
  }) => (
    <div data-testid="token-logo" data-symbol={symbol} data-size={size} className={className}>
      {badge}
    </div>
  )
}));

// The network mark badged onto the token logo. A probe so the mark's wiring is assertable without
// the real inline SVGs.
jest.mock('components/NetworkChip', () => ({
  NetworkLogo: ({ kind }: { kind: string }) => <span data-testid="network-logo" data-kind={kind} />
}));

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
  totalRewardsUsd: 218.32,
  blendedApyPercent: 5.2,
  totalDepositedUsd: 4218.32,
  estimatedRewardsUsd: 24.5
};

beforeEach(() => {
  mockGoBack.mockClear();
});

describe('EarnAssetMark', () => {
  it('is the token mark with the network badged on its corner, not a wide text pill', () => {
    render(<EarnAssetMark asset="USDC" network="Ethereum" />);

    const logo = screen.getByTestId('token-logo');
    expect(logo).toHaveAttribute('data-symbol', 'USDC');
    expect(logo).toHaveAttribute('data-size', 'md');
    // The badge is the network's own mark, inside the avatar rather than beside it.
    expect(within(logo).getByTestId('network-logo')).toHaveAttribute('data-kind', 'ethereum');
  });

  it('keeps the "{asset} on {network}" name the pill used to carry, for assistive tech', () => {
    render(<EarnAssetMark asset="USDC" network="Ethereum" />);

    const label = screen.getByText('earnAssetOnNetwork');
    expect(label).toHaveClass('sr-only');
  });

  it('takes the Miden mark only for Miden itself; every earn vault is EVM-side', () => {
    const { rerender } = render(<EarnAssetMark asset="MIDEN" network="Miden" />);
    expect(screen.getByTestId('network-logo')).toHaveAttribute('data-kind', 'miden');

    rerender(<EarnAssetMark asset="USDC" network="Sepolia" />);
    expect(screen.getByTestId('network-logo')).toHaveAttribute('data-kind', 'ethereum');
  });
});

describe('EarnFlowHeader', () => {
  it('renders the protocol • asset title and the asset mark', () => {
    render(<EarnFlowHeader subject={VAULT} />);

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Aave');
    expect(heading).toHaveTextContent('USDC');
    // The bullet separator is rendered between protocol and asset.
    expect(heading.textContent).toContain('•');

    expect(screen.getByText('earnAssetOnNetwork')).toBeInTheDocument();
  });

  it('wires the back button to goBack with the shared header arrow and Back label', () => {
    render(<EarnFlowHeader subject={VAULT} />);

    const button = screen.getByTestId('icon-button');
    expect(button).toHaveAttribute('aria-label', 'back');
    expect(button).toHaveAttribute('data-icon', String(IconName.ArrowLeft));

    expect(mockGoBack).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('is the shared PageHeader row, carrying the 16px page margin its unpadded pages lack', () => {
    render(<EarnFlowHeader subject={VAULT} />);

    const header = screen.getByRole('banner');
    expect(header).toHaveClass('h-15', 'px-4', 'shrink-0');
    // No bespoke divider or 26px title: the page header draws neither.
    expect(header).not.toHaveClass('border-b');
    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('text-title-tab');
  });

  it('puts the asset mark in the header actions, in place of the wide text pill', () => {
    render(<EarnFlowHeader subject={VAULT} />);

    // The pill was a 32px `bg-fill` capsule wide enough to spell "{asset} on {network}"; the mark
    // is the token avatar, and the name it used to show is now screen-reader-only.
    expect(screen.queryByText('earnAssetOnNetwork')).toHaveClass('sr-only');
    expect(screen.getByRole('banner')).toContainElement(screen.getByTestId('token-logo'));
  });

  it('reflects a different vault protocol/asset/network', () => {
    render(<EarnFlowHeader subject={{ ...VAULT, protocol: 'Compound', asset: 'ETH', network: 'Base' }} />);

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Compound');
    expect(heading).toHaveTextContent('ETH');
    expect(screen.getByTestId('token-logo')).toHaveAttribute('data-symbol', 'ETH');
  });
});

describe('EarnHero', () => {
  it('leads with the figure, then its caption, then the change line', () => {
    const { container } = render(<EarnHero labelId="hero-label" value="5.24%" label="Current APY" meta="+0.02%" />);

    const section = container.querySelector('section') as HTMLElement;
    // Document order IS the design: the figure comes first, the label under it.
    expect(section.textContent).toBe('5.24%Current APY+0.02%');

    expect(screen.getByText('5.24%')).toHaveClass('text-display', 'text-ink');
    expect(screen.getByText('Current APY')).toHaveClass('text-label', 'text-muted');
    expect(screen.getByText('+0.02%')).toHaveClass('text-value', 'text-positive-tint-ink');
  });

  it('names the section by its caption, and the caption is not a heading', () => {
    const { container } = render(<EarnHero labelId="hero-label" value="$1" label="Total" />);

    expect(container.querySelector('section')).toHaveAttribute('aria-labelledby', 'hero-label');
    expect(screen.getByText('Total')).toHaveAttribute('id', 'hero-label');
    // The page's own title is its `h1`; a hero caption never competes with it.
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('takes a value colour, a unit beside the figure and content under the hero', () => {
    render(
      <EarnHero
        labelId="hero-label"
        value="1,000"
        valueClassName="text-positive-tint-ink"
        unit={<span>USDC</span>}
        label="Deposit amount"
      >
        <span>extra</span>
      </EarnHero>
    );

    expect(screen.getByText('1,000')).toHaveClass('text-positive-tint-ink');
    expect(screen.getByText('1,000')).not.toHaveClass('text-ink');
    expect(screen.getByText('USDC')).toBeInTheDocument();
    expect(screen.getByText('extra')).toBeInTheDocument();
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
    expect(card).toHaveClass('bg-fill');

    const valueEl = screen.getByText('Value');
    // The named row-value style, never a hand-assembled size and weight.
    expect(valueEl).toHaveClass('text-value', 'text-ink');
    expect(valueEl.className).not.toMatch(/text-\[|\btext-sm\b/);
  });

  it('merges valueClassName onto the value node and className onto the container', () => {
    const { container } = render(
      <MetricCard
        label="Estimated Rewards"
        value="+$24.50"
        valueClassName="text-positive-tint-ink"
        className="my-card"
      />
    );

    const card = container.firstChild as HTMLElement;
    expect(card).toHaveClass('my-card');
    expect(card).toHaveClass('bg-fill');

    const valueEl = screen.getByText('+$24.50');
    expect(valueEl).toHaveClass('text-positive-tint-ink');
  });
});

describe('EarnSummaryPanel', () => {
  it('leads with the figure, then the caption and the blended APY line', () => {
    const { container } = render(<EarnSummaryPanel summary={SUMMARY} titleId="earn-title" showMetrics={false} />);

    expect(screen.getByText('$218.32')).toHaveClass('text-display', 'text-ink');
    expect(screen.getByText('earnTotalEarnedRewards')).toHaveClass('text-label', 'text-muted');
    expect(screen.getByText('earnEarningBlendedApy')).toHaveClass('text-value', 'text-positive-tint-ink');
    // The figure precedes its caption — the same order the vault page's APY hero takes.
    expect((container.querySelector('section') as HTMLElement).textContent).toBe(
      '$218.32earnTotalEarnedRewardsearnEarningBlendedApy'
    );
  });

  it('links the section to the caption via titleId, and leaves the h1 to the page', () => {
    const { container } = render(<EarnSummaryPanel summary={SUMMARY} titleId="my-title-id" className="panel-class" />);

    const section = container.querySelector('section') as HTMLElement;
    expect(section).toHaveAttribute('aria-labelledby', 'my-title-id');
    expect(section).toHaveClass('panel-class');

    expect(screen.getByText('earnTotalEarnedRewards')).toHaveAttribute('id', 'my-title-id');
    // "Total Earned Rewards" was the page's `h1`, which is why it read as the page title.
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('renders both metric cards by default (showMetrics defaults to true)', () => {
    render(<EarnSummaryPanel summary={SUMMARY} titleId="earn-title" />);

    expect(screen.getByText('earnTotalDeposited')).toBeInTheDocument();
    expect(screen.getByText('$4,218.32')).toBeInTheDocument();
    expect(screen.getByText('earnEstimatedRewards')).toBeInTheDocument();
    expect(screen.getByText('+$24.50')).toBeInTheDocument();
  });

  it('hides the metric cards when showMetrics is false', () => {
    render(<EarnSummaryPanel summary={SUMMARY} titleId="earn-title" showMetrics={false} />);

    expect(screen.queryByText('earnTotalDeposited')).not.toBeInTheDocument();
    expect(screen.queryByText('earnEstimatedRewards')).not.toBeInTheDocument();
    // The summary heading and figures still render.
    expect(screen.getByText('earnTotalEarnedRewards')).toBeInTheDocument();
    expect(screen.getByText('$218.32')).toBeInTheDocument();
  });
});

describe('EarnAmountUnit', () => {
  it('renders the token mark and its symbol on the unit type style', () => {
    render(<EarnAmountUnit symbol="USDC" />);

    expect(screen.getByTestId('token-logo')).toHaveAttribute('data-symbol', 'USDC');
    expect(screen.getByText('USDC')).toHaveClass('text-entry-unit', 'text-ink');
  });
});
