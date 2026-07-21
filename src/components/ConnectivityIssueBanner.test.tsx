import React from 'react';

import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { useConnectivityState } from 'lib/miden/activity/use-connectivity-state';
import { hapticLight } from 'lib/mobile/haptics';
import { isExtension } from 'lib/platform';

import { ConnectivityIssueBanner, ExtensionMessageListener } from './ConnectivityIssueBanner';

// ---------------------------------------------------------------------------
// Mocks. The component's only runtime deps are: the connectivity-state hook
// (drives which banner shows), i18n (identity `t`), the icon barrel (SVG
// re-exports), haptics, the platform detector, and the store's intercom
// client. Everything else is either a pure constant or the `clsx` helper,
// which we exercise for real.
// ---------------------------------------------------------------------------

// i18n: identity translator so we can assert on the raw message keys.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// Haptics wrap the native Capacitor plugin; a spy lets us assert the light
// buzz fires on retry / dismiss without touching the device layer.
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

// Platform detector is a pure boolean in production; a mock fn drives both the
// mobile/desktop early-return and the extension intercom branch of `onRetry`.
jest.mock('lib/platform', () => ({
  isExtension: jest.fn()
}));

// The SW poke goes through the store's intercom client. Expose a spyable
// `request` so we can assert the SyncRequest payload and drive its resolve /
// reject paths.
const mockRequest = jest.fn();
jest.mock('lib/store', () => ({
  getIntercom: () => ({ request: mockRequest })
}));

// Message-type enum: only `SyncRequest` is referenced by the component.
jest.mock('lib/shared/types', () => ({
  WalletMessageType: { SyncRequest: 'SyncRequest' }
}));

// `connectivity-state` is imported for the `ConnectivityCategory` type only
// (erased by the transform), but mock it defensively so no heavy storage
// module is pulled into the graph if the import survives.
jest.mock('lib/miden/activity/connectivity-state', () => ({}));

// Icons are SVG re-exports. Render a lightweight span that surfaces the icon
// name (for the dismiss-icon query), the fill colour (to assert per-category
// colouring), and forwards `onClick` so the Close icon is clickable.
jest.mock('app/icons/v2', () => ({
  IconName: {
    WarningFill: 'WarningFill',
    InformationFill: 'InformationFill',
    Refresh: 'Refresh',
    Close: 'Close'
  },
  Icon: ({ name, fill, onClick, size }: any) => (
    <span data-testid={`icon-${name}`} data-fill={fill} data-size={size} onClick={onClick} />
  )
}));

// The connectivity-state hook is the single source of what renders. A mock fn
// lets each test hand-craft the snapshot and observe the dismiss callback.
jest.mock('lib/miden/activity/use-connectivity-state', () => ({
  useConnectivityState: jest.fn()
}));

const mockUseConnectivityState = useConnectivityState as jest.MockedFunction<typeof useConnectivityState>;
const mockIsExtension = isExtension as jest.MockedFunction<typeof isExtension>;
const mockHapticLight = hapticLight as jest.MockedFunction<typeof hapticLight>;

const mockDismiss = jest.fn();

type Category = 'network' | 'node' | 'prover' | 'resolving';

function makeState(active: Partial<Record<Category, boolean>> = {}) {
  return {
    network: { active: Boolean(active.network), since: active.network ? 1 : null },
    node: { active: Boolean(active.node), since: active.node ? 1 : null },
    prover: { active: Boolean(active.prover), since: active.prover ? 1 : null },
    resolving: { active: Boolean(active.resolving), since: active.resolving ? 1 : null }
  };
}

function setState(active: Partial<Record<Category, boolean>> = {}) {
  mockUseConnectivityState.mockReturnValue({
    state: makeState(active) as any,
    hasAnyIssue: Object.values(active).some(Boolean),
    dismiss: mockDismiss
  });
}

describe('ConnectivityIssueBanner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsExtension.mockReturnValue(false);
    mockRequest.mockResolvedValue(undefined);
    setState({});
  });

  it('renders nothing when no connectivity category is active', () => {
    setState({});
    const { container } = render(<ConnectivityIssueBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the network banner with a retry CTA and warning colour', () => {
    setState({ network: true });
    render(<ConnectivityIssueBanner />);

    expect(screen.getByTestId('connectivity-banner-network')).toBeInTheDocument();
    expect(screen.getByText('connectivityNetworkTitle')).toBeInTheDocument();
    expect(screen.getByText('connectivityNetworkBody')).toBeInTheDocument();
    // Retry CTA present with the network-specific label.
    expect(screen.getByRole('button', { name: 'connectivityRetry' })).toBeInTheDocument();
    // Leading icon uses the warning fill.
    expect(screen.getByTestId('icon-WarningFill')).toHaveAttribute('data-fill', '#FEA644');
  });

  it('renders the node banner with the sync-retry CTA', () => {
    setState({ node: true });
    render(<ConnectivityIssueBanner />);

    expect(screen.getByTestId('connectivity-banner-node')).toBeInTheDocument();
    expect(screen.getByText('connectivityNodeTitle')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'connectivityRetrySync' })).toBeInTheDocument();
  });

  it('renders the prover banner with NO retry CTA and info colour', () => {
    setState({ prover: true });
    render(<ConnectivityIssueBanner />);

    expect(screen.getByTestId('connectivity-banner-prover')).toBeInTheDocument();
    expect(screen.getByText('connectivityProverTitle')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByTestId('icon-InformationFill')).toHaveAttribute('data-fill', '#5b8def');
  });

  it('renders the resolving banner with the refresh icon and no CTA', () => {
    setState({ resolving: true });
    render(<ConnectivityIssueBanner />);

    expect(screen.getByTestId('connectivity-banner-resolving')).toBeInTheDocument();
    expect(screen.getByText('connectivityResolvingTitle')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByTestId('icon-Refresh')).toBeInTheDocument();
  });

  // -- pickActiveCategory priority: network > node > prover > resolving -----
  it('prefers network over every other active category', () => {
    setState({ network: true, node: true, prover: true, resolving: true });
    render(<ConnectivityIssueBanner />);
    expect(screen.getByTestId('connectivity-banner-network')).toBeInTheDocument();
  });

  it('prefers node when network is clear but node/prover/resolving are active', () => {
    setState({ node: true, prover: true, resolving: true });
    render(<ConnectivityIssueBanner />);
    expect(screen.getByTestId('connectivity-banner-node')).toBeInTheDocument();
  });

  it('prefers prover over resolving', () => {
    setState({ prover: true, resolving: true });
    render(<ConnectivityIssueBanner />);
    expect(screen.getByTestId('connectivity-banner-prover')).toBeInTheDocument();
  });

  // -- onRetry --------------------------------------------------------------
  it('on retry off-extension: buzzes but does not poke the intercom', () => {
    mockIsExtension.mockReturnValue(false);
    setState({ network: true });
    render(<ConnectivityIssueBanner />);

    fireEvent.click(screen.getByRole('button', { name: 'connectivityRetry' }));

    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('on retry in the extension: pokes the SW with a SyncRequest', () => {
    mockIsExtension.mockReturnValue(true);
    setState({ network: true });
    render(<ConnectivityIssueBanner />);

    fireEvent.click(screen.getByRole('button', { name: 'connectivityRetry' }));

    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledWith({ type: 'SyncRequest' });
  });

  it('swallows an intercom rejection on retry (no unhandled error)', async () => {
    mockIsExtension.mockReturnValue(true);
    mockRequest.mockRejectedValue(new Error('SW unreachable'));
    setState({ node: true });
    render(<ConnectivityIssueBanner />);

    fireEvent.click(screen.getByRole('button', { name: 'connectivityRetrySync' }));

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith({ type: 'SyncRequest' }));
    // Let the rejected promise settle so the `.catch(() => {})` handler runs.
    await Promise.resolve();
    await Promise.resolve();
  });

  // -- onDismiss ------------------------------------------------------------
  it('dismisses the active category and buzzes when the close icon is tapped', () => {
    setState({ prover: true });
    render(<ConnectivityIssueBanner />);

    fireEvent.click(screen.getByTestId('icon-Close'));

    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(mockDismiss).toHaveBeenCalledWith('prover');
  });

  // -- className passthrough ------------------------------------------------
  it('merges a custom className into the banner container', () => {
    setState({ network: true });
    render(<ConnectivityIssueBanner className="custom-banner-class" />);

    const banner = screen.getByTestId('connectivity-banner-network');
    expect(banner).toHaveClass('custom-banner-class');
    // Base classes are still present alongside the custom one.
    expect(banner).toHaveClass('rounded-t-3xl');
  });
});

describe('ExtensionMessageListener', () => {
  it('renders nothing (legacy no-op)', () => {
    const { container } = render(<ExtensionMessageListener />);
    expect(container.firstChild).toBeNull();
  });
});
