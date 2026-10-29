import React from 'react';

import { act, render, screen, fireEvent, within } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';
import type { FeatureAvailability } from 'lib/remote-config/availability';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';
import { navigate } from 'lib/woozie';
import { EARN_DATA } from 'screens/earn-flow/data';
import { buildEarnSummary } from 'screens/earn-flow/earn-mapping';
import { useEarnPositions } from 'screens/earn-flow/useEarnPositions';

import Earn from './Earn';

// Stub the two child widgets this page pulls in. The real `EarnSummaryPanel` / `ProviderLogo` drag
// in `components/TokenLogo` chrome and the Aave `?url` SVG import, neither of which says anything
// about `Earn.tsx`'s own wiring. Rendering them as probes keeps the coverage scoped to this page
// while still letting us assert the props it forwards (summary + titleId to the panel, protocol to
// the logo). This mirrors how the sibling `components.test.tsx` stubs its own children.
jest.mock('screens/earn-flow/components', () => ({
  EarnSummaryPanel: ({ summary, titleId }: { summary: { totalRewardsUsd: number }; titleId: string }) => (
    <div data-testid="earn-summary-panel" data-title-id={titleId} data-total-rewards={summary.totalRewardsUsd} />
  ),
  EarnAssetMark: ({ asset, network }: { asset: string; network: string }) => (
    <span data-testid="earn-asset-mark" data-asset={asset} data-network={network} />
  ),
  earnSubjectTitle: ({ name, protocol }: { name?: string; protocol: string }) => name ?? protocol,
  EarnSubjectSubtitle: ({ subject }: { subject: { asset: string; network: string } }) =>
    `${subject.asset} on ${subject.network}`
}));
jest.mock('screens/earn-flow/ProviderLogo', () => ({
  ProviderLogo: ({ protocol, logoUrl, className }: { protocol: string; logoUrl?: string; className?: string }) => (
    <span data-testid="provider-logo" data-protocol={protocol} data-logo-url={logoUrl} className={className} />
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

// Render every icon as a probe with its name, so a test can see which icons a surface draws.
jest.mock('app/icons/v2', () => ({
  Icon: ({ name, fill }: { name: string; fill?: string }) => (
    <span data-testid="chevron-icon" data-name={name} data-fill={fill} />
  ),
  IconName: { ChevronRightLucide: 'ChevronRightLucide' }
}));

let mockEarnDeposit: FeatureAvailability = { state: 'available' };
const mockFeatureAvailability = jest.fn(
  (_feature: string, _options?: { hold?: boolean }): FeatureAvailability => mockEarnDeposit
);
jest.mock('lib/remote-config/use-feature-availability', () => ({
  useFeatureAvailability: (feature: string, options?: { hold?: boolean }) => mockFeatureAvailability(feature, options)
}));

jest.mock('screens/earn-flow/useEarnPositions', () => ({
  useEarnPositions: jest.fn()
}));

jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));

// i18n: the page renders every user-facing string through `t()`. Stub the hook
// so `t(key)` returns the key verbatim, letting us assert on the stable key
// instead of the English copy. An interpolated call appends its values
// (`key:a,b`), so a test can see the value it interpolates, not just the key.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${Object.values(opts).join(',')}` : key)
  })
}));

const mockHaptic = hapticLight as jest.Mock;
const mockNavigate = navigate as jest.Mock;
const mockUseEarnPositions = useEarnPositions as jest.Mock;

const { summary, positions, vaults } = EARN_DATA;

beforeEach(() => {
  mockEarnDeposit = { state: 'available' };
  mockFeatureAvailability.mockClear();
  mockHaptic.mockReset();
  mockNavigate.mockReset();
  jest.mocked(reportUserVisibleError).mockClear();
  mockUseEarnPositions.mockReturnValue(EARN_DATA);
});

const positionsSection = () => screen.getByRole('region', { name: 'earnCurrentPositionsTitle' });
const vaultsSection = () => screen.getByRole('region', { name: 'earnVaultsTitle' });

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
    expect(panel).toHaveAttribute('data-total-rewards', String(summary.totalRewardsUsd));
  });

  it('names the page for assistive tech only, and opens on the summary', () => {
    render(<Earn />);

    const title = screen.getByTestId('earn-title');
    expect(title.tagName).toBe('H1');
    expect(title).toHaveTextContent('earnTitle');
    // No visible title: "Total earned" is the pane's first line, as Receive opens on its code.
    expect(title).toHaveClass('sr-only');
    expect(title).not.toHaveClass('text-title-tab');
    // The summary follows straight on, with no gap above it of its own.
    const content = title.nextElementSibling as HTMLElement;
    expect(content).toContainElement(screen.getByTestId('earn-summary-panel'));
    expect(content.className).not.toMatch(/\bpt-/);

    // One `h1` on the page: the section titles under it are `h2`s.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('renders both section headings', () => {
    render(<Earn />);

    expect(screen.getByRole('heading', { name: 'earnCurrentPositionsTitle' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'earnVaultsTitle' })).toBeInTheDocument();
  });

  it('navigates to the positions list when "See All" is tapped', () => {
    render(<Earn />);

    fireEvent.click(screen.getByRole('button', { name: 'earnSeeAll' }));

    expect(mockHaptic).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/earn/positions');
  });

  it('says nothing about positions while the first load is in flight', () => {
    mockUseEarnPositions.mockReturnValue({ summary, positions: [], vaults, isLoading: true, refetch: jest.fn() });
    render(<Earn />);
    expect(screen.queryByTestId('earn-positions-empty')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a retryable load error, not "no positions", when a load failed with nothing to show', () => {
    const refetch = jest.fn();
    mockUseEarnPositions.mockReturnValue({
      summary,
      positions: [],
      vaults,
      isLoading: false,
      error: 'boom',
      notOnNetwork: false,
      refetch
    });
    render(<Earn />);
    expect(screen.queryByTestId('earn-positions-empty')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('earnPositionsLoadError');
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('forwards load evidence when the failed Earn tab has no positions', () => {
    jest.useFakeTimers();
    try {
      const evidence = {
        kind: 'earn_positions_load',
        earnPositionsLoadStage: 'configuration',
        earnPositionsLoadOutcome: 'complete_failure'
      };
      mockUseEarnPositions.mockReturnValue({
        summary,
        positions: [],
        vaults,
        isLoading: false,
        notOnNetwork: false,
        error: 'boom',
        errorDiagnostics: evidence,
        refetch: jest.fn()
      });
      render(<Earn />);
      act(() => jest.advanceTimersByTime(1000));
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['earnPositionsLoadError', 'notice', evidence]]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('forwards load evidence when the failed Earn tab retains positions', () => {
    jest.useFakeTimers();
    try {
      const evidence = {
        kind: 'earn_positions_load',
        earnPositionsLoadStage: 'request',
        earnPositionsLoadOutcome: 'partial_failure'
      };
      mockUseEarnPositions.mockReturnValue({
        ...EARN_DATA,
        isLoading: false,
        notOnNetwork: false,
        error: 'boom',
        errorDiagnostics: evidence,
        refetch: jest.fn()
      });
      render(<Earn />);
      act(() => jest.advanceTimersByTime(1000));
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['earnPositionsLoadError', 'notice', evidence]]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('says Earn is not on this network, with no error, retry, summary or See all, where the network has none', () => {
    mockUseEarnPositions.mockReturnValue({
      summary,
      positions: [],
      vaults: [],
      isLoading: false,
      error: 'The bridge config has no usable epoch.positionsUrl.',
      loadError: 'The bridge config has no usable epoch.positionsUrl.',
      notOnNetwork: true,
      refetch: jest.fn()
    });
    render(<Earn />);
    expect(screen.getByTestId('earn-unavailable')).toHaveTextContent('earnUnavailableOnNetwork');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'retry' })).toBeNull();
    expect(screen.queryByTestId('earn-summary-panel')).toBeNull();
    expect(screen.queryByTestId('earn-see-all')).toBeNull();
    expect(screen.queryByTestId('earn-positions-empty')).toBeNull();
    // The page is still named, so the tab reads the same to assistive tech.
    expect(screen.getByTestId('earn-title')).toHaveTextContent('earnTitle');
  });

  it('says a per-owner positions failure too, which is not a request failure', () => {
    mockUseEarnPositions.mockReturnValue({
      summary,
      positions: [],
      vaults,
      isLoading: false,
      error: 'owner unavailable',
      loadError: undefined,
      refetch: jest.fn()
    });
    render(<Earn />);
    expect(screen.queryByTestId('earn-positions-empty')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('earnPositionsLoadError');
  });

  it('keeps the failure said, and the summary gone, while a retry is out', () => {
    // The hook keeps the error through a retry and reports it as not loading: the failed state must not
    // lift and flash "$0" back.
    const refetch = jest.fn();
    mockUseEarnPositions.mockReturnValue({ summary, positions: [], vaults, isLoading: false, error: 'boom', refetch });
    render(<Earn />);
    expect(screen.queryByTestId('earn-positions-empty')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('earnPositionsLoadError');
    expect(screen.queryByTestId('earn-summary-panel')).toBeNull();
  });

  it('keeps last-good positions on screen through a failed refresh, under a retryable notice', () => {
    const refetch = jest.fn();
    mockUseEarnPositions.mockReturnValue({ ...EARN_DATA, isLoading: false, error: 'boom', refetch });
    render(<Earn />);
    // The cards stay, but they are not presented as complete: the failure is said beside them.
    expect(screen.queryByTestId('earn-positions-empty')).toBeNull();
    expect(positionsSection().querySelector('.overflow-x-auto')).not.toBeNull();
    expect(within(positionsSection()).getByRole('alert')).toHaveTextContent('earnPositionsLoadError');
    fireEvent.click(within(positionsSection()).getByRole('button', { name: 'retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('draws no summary over a failed first load, so it never reads as $0', () => {
    mockUseEarnPositions.mockReturnValue({
      summary,
      positions: [],
      vaults,
      isLoading: false,
      error: 'boom',
      refetch: jest.fn()
    });
    render(<Earn />);
    expect(screen.queryByTestId('earn-summary-panel')).toBeNull();
  });

  it('draws no summary while a first load (no error yet) is in flight, so it never reads as $0', () => {
    mockUseEarnPositions.mockReturnValue({
      summary: buildEarnSummary([]),
      positions: [],
      vaults,
      isLoading: true,
      refetch: jest.fn()
    });
    render(<Earn />);
    expect(screen.queryByTestId('earn-summary-panel')).toBeNull();
  });

  it('keeps the summary once positions have loaded', () => {
    mockUseEarnPositions.mockReturnValue({ ...EARN_DATA, isLoading: false, error: 'boom', refetch: jest.fn() });
    render(<Earn />);
    expect(screen.getByTestId('earn-summary-panel')).toBeInTheDocument();
  });

  it('shows the dashed empty state, not the scroll row, when there are no positions', () => {
    mockUseEarnPositions.mockReturnValue({ summary, positions: [], vaults, isLoading: false, refetch: jest.fn() });
    render(<Earn />);

    const empty = screen.getByTestId('earn-positions-empty');
    expect(empty).toHaveClass('border-dashed');
    // The compact empty state: the slot stays small until a position fills it.
    expect(empty).toHaveClass('text-center', 'py-4');
    expect(empty).toHaveTextContent('earnNoActivePositionsTitle');
    expect(empty).toHaveTextContent('earnNoActivePositionsBody');
    expect(positionsSection().querySelector('.overflow-x-auto')).toBeNull();
  });

  it('renders one PositionCard per position with its details', () => {
    render(<Earn />);

    const section = positionsSection();
    // Each position card is a button; the "See All" button lives in the header,
    // not the scroll row, so the card count equals positions.length + nothing.
    const cards = within(section)
      .getAllByRole('button')
      .filter(button => button.textContent !== 'earnSeeAll');
    expect(cards).toHaveLength(positions.length);
    cards.forEach(card => {
      expect(card).toHaveClass('bg-page', 'border', 'border-hairline');
      expect(card).not.toHaveClass('bg-fill');
    });

    // Each card names its position as the page it opens does: the protocol over its asset on its
    // network, never the old "{protocol} • {asset}" join.
    positions.forEach((position, index) => {
      const card = cards[index]!;
      expect(card).not.toHaveTextContent(`${position.protocol} • ${position.asset}`);
      expect(within(card).getByText(position.protocol)).toHaveClass('text-row-title');
      expect(within(card).getByText(`${position.asset} on ${position.network}`)).toHaveClass('text-muted');
    });

    const first = positions[0]!;
    const firstCard = cards[0]!;
    expect(firstCard).toHaveTextContent(`earnPositionsApy:${first.apy}`);
    expect(firstCard).toHaveTextContent(first.amount);
    // No rewards/age line: neither has a source yet, and it only ever drew placeholder dashes.
    expect(firstCard).not.toHaveTextContent(`${first.rewards} • ${first.age}`);

    // The asset's mark, badged with its network, leads the row.
    const mark = within(firstCard).getByTestId('earn-asset-mark');
    expect(mark).toHaveAttribute('data-asset', first.asset);
    expect(mark).toHaveAttribute('data-network', first.network);
  });

  it('sets each position row in the heading face', () => {
    render(<Earn />);

    positions.forEach(position => {
      const card = screen.getByTestId(`earn-position-card-${position.id}`);
      const row = within(card).getByTestId('earn-asset-mark').parentElement;
      expect(row).toHaveClass('face-heading', 'flex', 'items-center');
      expect(row).toContainElement(within(card).getByText(position.amount));
    });
  });

  it('spans a lone position across the row, and keeps several at their own width to scroll', () => {
    const { unmount } = render(<Earn />);
    expect(positions.length).toBeGreaterThan(1);
    positions.forEach(position => {
      const card = screen.getByTestId(`earn-position-card-${position.id}`);
      expect(card).toHaveClass('shrink-0');
      expect(card).not.toHaveClass('w-full');
    });
    unmount();

    const lone = positions[0]!;
    mockUseEarnPositions.mockReturnValue({ ...EARN_DATA, positions: [lone] });
    render(<Earn />);
    expect(screen.getByTestId(`earn-position-card-${lone.id}`)).toHaveClass('w-full', 'shrink-0');
  });

  it('uses theme-aware text colors for position and vault labels', () => {
    render(<Earn />);

    const positionCard = within(positionsSection())
      .getAllByRole('button')
      .find(button => button.textContent !== 'earnSeeAll')!;
    expect(within(positionCard).getByText(positions[0]!.protocol)).toHaveClass('text-ink');
    expect(within(positionCard).getByText(positions[0]!.amount)).toHaveClass('text-ink');

    const vaultRow = within(vaultsSection()).getAllByRole('button')[0]!;
    expect(within(vaultRow).getByText(vaults[0]!.name ?? '')).toHaveClass('text-ink');
  });

  it('navigates to a position detail when its card is tapped', () => {
    render(<Earn />);

    const cards = within(positionsSection())
      .getAllByRole('button')
      .filter(button => button.textContent !== 'earnSeeAll');
    fireEvent.click(cards[0]!);

    expect(mockHaptic).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith(`/earn/positions/${positions[0]!.id}`);
  });

  it('keeps the end of the positions row from chaining into the pager', () => {
    const { container } = render(<Earn />);

    expect(container.querySelector('.touch-pan-x')).toHaveClass('overscroll-x-contain');
  });

  it('renders one VaultRow per vault with its details and no TVL line', () => {
    render(<Earn />);

    const section = vaultsSection();
    const rows = within(section).getAllByRole('button');
    expect(rows).toHaveLength(vaults.length);
    rows.forEach(row => {
      expect(row).toHaveClass('bg-page', 'border', 'border-hairline');
      expect(row).not.toHaveClass('bg-fill');
      expect(within(row).queryByTestId('chevron-icon')).toBeNull();
    });

    // The Aave V3 vault: a market that its protocol and network identify.
    const first = vaults[2]!;
    const firstRow = rows[2]!;
    expect(firstRow).toHaveTextContent(first.protocol);
    expect(firstRow).toHaveTextContent(`earnVaultAssetOnNetwork:${first.asset},${first.network}`);
    expect(firstRow).toHaveTextContent(first.apy);
    // The earn API has no TVL, so the row promises none.
    expect(within(firstRow).queryByText('earnVaultTvl')).toBeNull();
    expect(firstRow).not.toHaveTextContent('earnVaultTvl');

    // Each row also renders a ProviderLogo probe with the vault's protocol.
    expect(within(firstRow).getByTestId('provider-logo')).toHaveAttribute('data-protocol', first.protocol);
  });

  it('hands each vault row its document logo, and none to a vault whose listing names none', () => {
    const logoUrl = 'https://config.test/icons/aave.svg';
    const withLogo = vaults.map((vault, index) => (index === 0 ? { ...vault, logoUrl } : vault));
    mockUseEarnPositions.mockReturnValue({ ...EARN_DATA, vaults: withLogo });
    render(<Earn />);

    const logos = within(vaultsSection()).getAllByTestId('provider-logo');
    expect(logos[0]).toHaveAttribute('data-logo-url', logoUrl);
    expect(logos[1]).not.toHaveAttribute('data-logo-url');
  });

  it("titles each row with the document's name, so two Morpho USDC vaults on one chain read differently", () => {
    render(<Earn />);

    const [first, second] = vaults;
    expect(first!.protocol).toBe(second!.protocol);
    const firstRow = screen.getByTestId(`earn-vault-row-${first!.id}`);
    const secondRow = screen.getByTestId(`earn-vault-row-${second!.id}`);
    expect(within(firstRow).getByText(first!.name ?? '')).toHaveClass('text-row-title');
    expect(within(secondRow).getByText(second!.name ?? '')).toHaveClass('text-row-title');
    expect(within(firstRow).getByText(`earnVaultAssetOnNetwork:${first!.asset},${first!.network}`)).toHaveClass(
      'text-caption',
      'text-muted',
      'truncate'
    );
    expect(firstRow.textContent).not.toBe(secondRow.textContent);
  });

  it("puts the document's about sentence under the name, and nothing for a vault with none", () => {
    render(<Earn />);

    const compound = vaults.find(vault => vault.listedAbout);
    expect(compound).toBeDefined();
    expect(screen.getByTestId(`earn-vault-row-about-${compound!.id}`)).toHaveTextContent(compound!.listedAbout ?? '');
    expect(screen.queryByTestId(`earn-vault-row-about-${vaults[0]!.id}`)).toBeNull();
  });

  it('names a market with no document name by its protocol, and its market name beside the asset', () => {
    const { name: _name, ...unnamed } = vaults[0]!;
    mockUseEarnPositions.mockReturnValue({
      summary,
      positions,
      vaults: [{ ...unnamed, marketName: 'Morpho uniBTC-USDC 77' }],
      refetch: jest.fn(),
      isLoading: false
    });
    render(<Earn />);

    const row = screen.getByTestId(`earn-vault-row-${unnamed.id}`);
    expect(within(row).getByText('Morpho')).toHaveClass('text-row-title');
    expect(row).toHaveTextContent('earnMarketAssetOnNetwork:Morpho uniBTC-USDC 77,USDC,Base');
  });

  it('lists the vaults in the order the hook gives them', () => {
    render(<Earn />);

    const rows = within(vaultsSection()).getAllByRole('button');
    expect(rows.map(row => row.getAttribute('data-testid'))).toEqual(vaults.map(vault => `earn-vault-row-${vault.id}`));
  });

  it('navigates to a vault detail when its row is tapped', () => {
    render(<Earn />);

    const rows = within(vaultsSection()).getAllByRole('button');
    fireEvent.click(rows[0]!);

    expect(mockHaptic).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith(`/earn/vaults/${vaults[0]!.id}`);
  });

  // The vaults come from the same read as the positions, so with none to list the section says nothing:
  // not while it loads, not after a failure (the positions section already says so), not once settled.
  it.each([
    ['loading', { isLoading: true }],
    ['failed', { isLoading: false, error: 'boom' }],
    ['settled', { isLoading: false }]
  ])('draws no vaults section with no vaults, %s', (_state, load) => {
    mockUseEarnPositions.mockReturnValue({ summary, positions: [], vaults: [], refetch: jest.fn(), ...load });
    render(<Earn />);

    expect(screen.queryByRole('region', { name: 'earnVaultsTitle' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'earnVaultsTitle' })).toBeNull();
  });

  it.each([
    ['settled', { isLoading: false }],
    ['retrying', { isLoading: true }],
    ['failed', { isLoading: false, error: 'boom' }]
  ])('keeps the vaults it has, %s', (_state, load) => {
    mockUseEarnPositions.mockReturnValue({ summary, positions, vaults, refetch: jest.fn(), ...load });
    render(<Earn />);

    expect(within(vaultsSection()).getAllByRole('button')).toHaveLength(vaults.length);
  });
});

it('lists the Testnet native funding asset while keeping the vault underlying separate', () => {
  const vault = { ...vaults[2]!, fundingAsset: 'USDCx' };
  const morpho = { ...vaults[0]!, fundingAsset: 'USDCx' };
  mockUseEarnPositions.mockReturnValue({ ...EARN_DATA, vaults: [vault, morpho] });
  render(<Earn />);
  const row = screen.getByTestId(`earn-vault-row-${vault.id}`);
  expect(row).toHaveTextContent('earnVaultAssetOnNetwork:USDCx,Miden');
  expect(row).not.toHaveTextContent(`earnVaultAssetOnNetwork:${vault.asset},${vault.network}`);
  expect(screen.getByTestId(`earn-vault-row-${morpho.id}`)).toHaveTextContent('earnVaultAssetOnNetwork:USDCx,Miden');
});

describe('Earn page availability notice', () => {
  it('opens on the not-available notice, above the summary, where Earn is not offered in the location', () => {
    mockEarnDeposit = { state: 'unavailable', reason: 'restricted', detail: 'region' };
    render(<Earn />);

    const notice = screen.getByTestId('earn-unavailable-notice');
    expect(notice).toHaveTextContent('geoRestrictedTitle');
    expect(notice).toHaveTextContent('geoRestrictedBody');
    // First in the pane, before "Total earned".
    const panel = screen.getByTestId('earn-summary-panel');
    expect(notice.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(mockFeatureAvailability).toHaveBeenLastCalledWith('earnDeposit', { hold: true });
  });

  it('shows the service notice while Earn deposits are down', () => {
    mockEarnDeposit = { state: 'unavailable', reason: 'service-down', detail: 'allocator /health: timeout' };
    render(<Earn />);

    expect(screen.getByTestId('earn-unavailable-notice')).toHaveTextContent('bridgeFeatureUnavailableTitle');
  });

  it.each<[string, FeatureAvailability]>([
    ['available', { state: 'available' }],
    ['still loading', { state: 'loading' }]
  ])('shows no notice while Earn is %s', (_label, availability) => {
    mockEarnDeposit = availability;
    render(<Earn />);

    expect(screen.queryByTestId('earn-unavailable-notice')).toBeNull();
  });

  it('shows no location notice on a network with no Earn, and holds no fast poll there', () => {
    mockEarnDeposit = { state: 'unavailable', reason: 'restricted', detail: 'region' };
    mockUseEarnPositions.mockReturnValue({ ...EARN_DATA, positions: [], vaults: [], notOnNetwork: true });
    render(<Earn />);

    expect(screen.getByTestId('earn-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('earn-unavailable-notice')).toBeNull();
    expect(mockFeatureAvailability).toHaveBeenLastCalledWith('earnDeposit', { hold: false });
  });
});
