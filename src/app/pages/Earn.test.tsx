import React from 'react';

import { render, screen, fireEvent, within } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';
import { navigate } from 'lib/woozie';
import { EARN_DATA } from 'screens/earn-flow/data';
import { useEarnPositions } from 'screens/earn-flow/useEarnPositions';

import Earn from './Earn';

// Stub the two child widgets pulled in from `screens/earn-flow/components`.
// The real `EarnSummaryPanel` / `ProviderLogo` drag in the Aave `?url` SVG
// import plus `components/CircleButton` / `components/TokenLogo` chrome that is
// irrelevant to `Earn.tsx`'s own wiring. Rendering them as probes keeps the
// coverage scoped to this page while still letting us assert the props it
// forwards (summary + titleId to the panel, protocol to the logo). This mirrors
// how the sibling `components.test.tsx` stubs its own children.
jest.mock('screens/earn-flow/components', () => ({
  EarnSummaryPanel: ({ summary, titleId }: { summary: { totalRewards: string }; titleId: string }) => (
    <div data-testid="earn-summary-panel" data-title-id={titleId} data-total-rewards={summary.totalRewards} />
  ),
  ProviderLogo: ({ protocol, className }: { protocol: string; className?: string }) => (
    <span data-testid="provider-logo" data-protocol={protocol} className={className} />
  )
}));

// `Earn.tsx` fires a light haptic on every tap before navigating. Stub it so we
// can assert the call without reaching for the real `@capacitor/haptics` native
// plugin.
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

// The router's `navigate` touches browser history on import — stub it and read
// back the destinations each tap requests.
jest.mock('lib/woozie', () => ({
  navigate: jest.fn()
}));

// The trailing chevron on each vault row is the only icon on the page. Render a
// probe that surfaces the requested icon name so we can prove the wiring.
jest.mock('app/icons/v2', () => ({
  Icon: ({ name, fill }: { name: string; fill?: string }) => (
    <span data-testid="chevron-icon" data-name={name} data-fill={fill} />
  ),
  IconName: { ChevronRightLucide: 'ChevronRightLucide' }
}));

jest.mock('screens/earn-flow/useEarnPositions', () => ({
  useEarnPositions: jest.fn()
}));

const mockHaptic = hapticLight as jest.Mock;
const mockNavigate = navigate as jest.Mock;
const mockUseEarnPositions = useEarnPositions as jest.Mock;

const { summary, positions, vaults } = EARN_DATA;

beforeEach(() => {
  mockHaptic.mockReset();
  mockNavigate.mockReset();
  mockUseEarnPositions.mockReturnValue(EARN_DATA);
});

const positionsSection = () => screen.getByRole('region', { name: 'Current Positions' });
const vaultsSection = () => screen.getByRole('region', { name: 'Featured Vaults' });

describe('Earn page', () => {
  // Sanity guard: the "renders one card per item" checks below rely on the
  // fixture actually having data to map over, otherwise they pass vacuously.
  it('has fixture positions and vaults to exercise', () => {
    expect(positions.length).toBeGreaterThan(0);
    expect(vaults.length).toBeGreaterThan(0);
  });

  it('renders the page shell and forwards the summary to EarnSummaryPanel', () => {
    render(<Earn />);

    expect(screen.getByTestId('earn-page')).toBeInTheDocument();

    const panel = screen.getByTestId('earn-summary-panel');
    expect(panel).toHaveAttribute('data-title-id', 'earn-summary-title');
    expect(panel).toHaveAttribute('data-total-rewards', summary.totalRewards);
  });

  it('renders both section headings', () => {
    render(<Earn />);

    expect(screen.getByRole('heading', { name: 'Current Positions' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Featured Vaults' })).toBeInTheDocument();
  });

  it('navigates to the positions list when "See All" is tapped', () => {
    render(<Earn />);

    fireEvent.click(screen.getByRole('button', { name: 'See All' }));

    expect(mockHaptic).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/earn/positions');
  });

  it('renders one PositionCard per position with its details', () => {
    render(<Earn />);

    const section = positionsSection();
    // Each position card is a button; the "See All" button lives in the header,
    // not the scroll row, so the card count equals positions.length + nothing.
    const cards = within(section)
      .getAllByRole('button')
      .filter(button => button.textContent !== 'See All');
    expect(cards).toHaveLength(positions.length);

    const first = positions[0]!;
    const firstCard = cards[0]!;
    // Protocol + asset are joined by a bullet in a single node.
    expect(firstCard).toHaveTextContent(`${first.protocol} • ${first.asset}`);
    expect(firstCard).toHaveTextContent(`${first.apy} APY`);
    expect(firstCard).toHaveTextContent(first.amount);
    expect(firstCard).toHaveTextContent(`${first.rewards} • ${first.age}`);

    // ProviderLogo probe receives the position's protocol.
    const logo = within(firstCard).getByTestId('provider-logo');
    expect(logo).toHaveAttribute('data-protocol', first.protocol);
  });

  it('uses theme-aware text colors for position and vault labels', () => {
    render(<Earn />);

    const positionCard = within(positionsSection())
      .getAllByRole('button')
      .find(button => button.textContent !== 'See All')!;
    expect(within(positionCard).getByText(`${positions[0]!.protocol} • ${positions[0]!.asset}`)).toHaveClass(
      'text-black'
    );
    expect(within(positionCard).getByText(positions[0]!.amount)).toHaveClass('text-black');

    const vaultRow = within(vaultsSection()).getAllByRole('button')[0]!;
    expect(within(vaultRow).getByText(vaults[0]!.protocol)).toHaveClass('text-black');
  });

  it('navigates to a position detail when its card is tapped', () => {
    render(<Earn />);

    const cards = within(positionsSection())
      .getAllByRole('button')
      .filter(button => button.textContent !== 'See All');
    fireEvent.click(cards[0]!);

    expect(mockHaptic).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith(`/earn/positions/${positions[0]!.id}`);
  });

  it('stops pointer-down propagation on the horizontal scroll row', () => {
    const { container } = render(<Earn />);

    const scroller = container.querySelector('.touch-pan-x') as HTMLElement;
    expect(scroller).not.toBeNull();

    const event = new Event('pointerdown', { bubbles: true });
    const stopSpy = jest.spyOn(event, 'stopPropagation');
    scroller.dispatchEvent(event);
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('renders one VaultRow per vault with its details and a chevron', () => {
    render(<Earn />);

    const section = vaultsSection();
    const rows = within(section).getAllByRole('button');
    expect(rows).toHaveLength(vaults.length);

    const first = vaults[0]!;
    const firstRow = rows[0]!;
    expect(firstRow).toHaveTextContent(first.protocol);
    expect(firstRow).toHaveTextContent(`${first.asset} on ${first.network}`);
    expect(firstRow).toHaveTextContent(first.apy);

    // The trailing chevron probe uses the ChevronRightLucide icon rendered with
    // fill="none".
    const chevron = within(firstRow).getByTestId('chevron-icon');
    expect(chevron).toHaveAttribute('data-name', 'ChevronRightLucide');
    expect(chevron).toHaveAttribute('data-fill', 'none');

    // Each row also renders a ProviderLogo probe with the vault's protocol.
    expect(within(firstRow).getByTestId('provider-logo')).toHaveAttribute('data-protocol', first.protocol);
  });

  it('navigates to a vault detail when its row is tapped', () => {
    render(<Earn />);

    const rows = within(vaultsSection()).getAllByRole('button');
    fireEvent.click(rows[0]!);

    expect(mockHaptic).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith(`/earn/vaults/${vaults[0]!.id}`);
  });
});
