import React from 'react';

import { render, screen, fireEvent, within } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';
import { goBack, navigate } from 'lib/woozie';

import { EARN_DATA } from './data';
import EarnPositions from './EarnPositions';

// i18n: assert on keys, not English copy. Interpolated values (e.g. APY) are
// discarded by this key-only stub, so those assertions target the key.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// Pull the mocked router/haptics fns back out for assertions.

// `lib/woozie` is the SPA router; stub `goBack`/`navigate` so we can assert the
// header back button and each position-card tap fire the right navigation.
jest.mock('lib/woozie', () => ({
  goBack: jest.fn(),
  navigate: jest.fn()
}));

// Native haptics — no-op mock so tapping a card doesn't reach into Capacitor.
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

// `app/icons/v2` is a heavy SVG barrel (coverage-ignored). Stub `Icon` to a
// probe span and expose only the two IconName members this screen references.
jest.mock('app/icons/v2', () => ({
  Icon: ({ name, className, fill }: { name: string; className?: string; fill?: string }) => (
    <span data-testid="icon" data-name={name} data-fill={fill} className={className} />
  ),
  IconName: {
    ChevronLeft: 'ChevronLeft',
    ChevronRightLucide: 'ChevronRightLucide'
  }
}));

// `components/CircleButton` itself pulls the icon barrel; stub it to a plain
// button that forwards `onClick`/`aria-label`/`icon` so the back affordance is
// assertable without the real presentational internals.
jest.mock('components/CircleButton', () => ({
  CircleButton: ({
    onClick,
    icon,
    'aria-label': ariaLabel
  }: {
    onClick?: () => void;
    icon?: string;
    'aria-label'?: string;
  }) => <button type="button" data-testid="circle-button" data-icon={icon} aria-label={ariaLabel} onClick={onClick} />
}));

// Sibling `./components` imports `aave.svg?url`, which jest's `\.svg$` mapper
// does NOT match (the `?url` suffix defeats the `$` anchor). Stub the two
// exports this screen consumes so the module never resolves that asset.
jest.mock('./components', () => ({
  EarnSummaryPanel: ({ summary, titleId }: { summary: { totalRewards: string }; titleId: string }) => (
    <div data-testid="earn-summary-panel" data-title-id={titleId}>
      {summary.totalRewards}
    </div>
  ),
  ProviderLogo: ({ protocol, className }: { protocol: string; className?: string }) => (
    <span data-testid="provider-logo" data-protocol={protocol} className={className} />
  )
}));

// The screen reads live Epoch data through `useEarnPositions`, which pulls in
// `useAccount` + SWR. Feed it the static demo fixture instead so the assertions
// below can stay pinned to `EARN_DATA`.
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

const mockGoBack = goBack as jest.Mock;
const mockNavigate = navigate as jest.Mock;
const mockHapticLight = hapticLight as jest.Mock;

describe('EarnPositions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the page shell with the "My positions" heading', () => {
    render(<EarnPositions />);

    expect(screen.getByTestId('earn-positions-page')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'earnPositionsTitle' })).toBeInTheDocument();
  });

  it('renders the summary panel wired to EARN_DATA.summary and the fixed titleId', () => {
    render(<EarnPositions />);

    const panel = screen.getByTestId('earn-summary-panel');
    expect(panel).toHaveAttribute('data-title-id', 'earn-positions-summary-title');
    expect(panel).toHaveTextContent(EARN_DATA.summary.totalRewards);
  });

  it('renders one position card per entry in EARN_DATA.positions', () => {
    render(<EarnPositions />);

    const region = screen.getByRole('region', { name: 'earnPositionsRegionLabel' });
    const cards = within(region).getAllByRole('button');
    expect(cards).toHaveLength(EARN_DATA.positions.length);

    // ProviderLogo + trailing sr-only chevron Icon appear once per card.
    expect(within(region).getAllByTestId('provider-logo')).toHaveLength(EARN_DATA.positions.length);
    expect(
      within(region)
        .getAllByTestId('icon')
        .filter(node => node.getAttribute('data-name') === 'ChevronRightLucide')
    ).toHaveLength(EARN_DATA.positions.length);
  });

  it('renders each card with its protocol/asset, APY, amount, rewards, deposited amount and active duration', () => {
    render(<EarnPositions />);

    const region = screen.getByRole('region', { name: 'earnPositionsRegionLabel' });
    const firstPosition = EARN_DATA.positions[0]!;

    // "{protocol} • {asset}" — one occurrence per position (both share the copy).
    expect(within(region).getAllByText(`${firstPosition.protocol} • ${firstPosition.asset}`)).toHaveLength(
      EARN_DATA.positions.length
    );
    // APY renders via t('earnPositionsApy', { apy }); the key-only stub drops the value.
    expect(within(region).getAllByText('earnPositionsApy')).toHaveLength(EARN_DATA.positions.length);
    expect(within(region).getAllByText(firstPosition.amount)).toHaveLength(EARN_DATA.positions.length);
    expect(within(region).getAllByText(firstPosition.rewards)).toHaveLength(EARN_DATA.positions.length);
    expect(within(region).getAllByText(firstPosition.depositedAmount)).toHaveLength(EARN_DATA.positions.length);
    expect(within(region).getAllByText(firstPosition.activeDuration)).toHaveLength(EARN_DATA.positions.length);

    // ProviderLogo receives the position's protocol.
    within(region)
      .getAllByTestId('provider-logo')
      .forEach(logo => expect(logo).toHaveAttribute('data-protocol', firstPosition.protocol));
  });

  it('calls goBack when the header back button is pressed', () => {
    render(<EarnPositions />);

    fireEvent.click(screen.getByRole('button', { name: 'back' }));

    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockHapticLight).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('exposes the back button with the ChevronLeft icon', () => {
    render(<EarnPositions />);

    expect(screen.getByTestId('circle-button')).toHaveAttribute('data-icon', 'ChevronLeft');
  });

  it('fires haptics and navigates to the position route when a card is tapped', () => {
    render(<EarnPositions />);

    const region = screen.getByRole('region', { name: 'earnPositionsRegionLabel' });
    const cards = within(region).getAllByRole('button');

    fireEvent.click(cards[0]!);

    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith(`/earn/positions/${EARN_DATA.positions[0]!.id}`);
  });

  it('navigates to the correct route for each distinct position id', () => {
    render(<EarnPositions />);

    const region = screen.getByRole('region', { name: 'earnPositionsRegionLabel' });
    const cards = within(region).getAllByRole('button');

    cards.forEach((card, index) => {
      fireEvent.click(card);
      expect(mockNavigate).toHaveBeenNthCalledWith(index + 1, `/earn/positions/${EARN_DATA.positions[index]!.id}`);
    });

    expect(mockHapticLight).toHaveBeenCalledTimes(EARN_DATA.positions.length);
    expect(mockNavigate).toHaveBeenCalledTimes(EARN_DATA.positions.length);
  });
});
