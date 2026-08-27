import React from 'react';

import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';

import { useConnectivityState } from 'lib/miden/activity/use-connectivity-state';
import { requestImmediateSync } from 'lib/miden/front/useSyncTrigger';
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

jest.mock('lib/miden/front/useSyncTrigger', () => ({
  requestImmediateSync: jest.fn()
}));

// The SW poke goes through the store's intercom client. Expose a spyable
// `request` so we can assert the SyncRequest payload and drive its resolve /
// reject paths. `useWalletStore` feeds the current-account pubkey the
// guardian-outage lookup keys on.
const mockRequest = jest.fn();
// Mutable so a test can switch accounts mid-session — the guardian outage flag
// is per-account, so which account is current decides which banner shows and
// which dismiss applies.
const currentAccount = { publicKey: 'acct-1' };
jest.mock('lib/store', () => ({
  getIntercom: () => ({ request: mockRequest }),
  useWalletStore: (selector: (s: { currentAccount: { publicKey: string } }) => unknown) => selector({ currentAccount })
}));

// Guardian-outage flag: a mutable holder so tests can arm/clear it and fire
// the subscription like the real sync loop does.
const guardianOutage = { accounts: new Set<string>(), listeners: new Set<() => void>() };
jest.mock('lib/miden/front/guardian-sync', () => ({
  isGuardianSyncOutage: (pk: string) => guardianOutage.accounts.has(pk),
  subscribeGuardianSyncOutage: (listener: () => void) => {
    guardianOutage.listeners.add(listener);
    return () => guardianOutage.listeners.delete(listener);
  }
}));

jest.mock('lib/woozie', () => ({ navigate: jest.fn() }));

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
const mockRequestImmediateSync = requestImmediateSync as jest.MockedFunction<typeof requestImmediateSync>;

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
    guardianOutage.accounts.clear();
    guardianOutage.listeners.clear();
    currentAccount.publicKey = 'acct-1';
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
    expect(screen.queryByRole('button', { name: 'connectivityRetry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'connectivityRetrySync' })).not.toBeInTheDocument();
    expect(screen.getByTestId('icon-InformationFill')).toHaveAttribute('data-fill', '#5b8def');
  });

  it('renders the resolving banner with the refresh icon and no CTA', () => {
    setState({ resolving: true });
    render(<ConnectivityIssueBanner />);

    expect(screen.getByTestId('connectivity-banner-resolving')).toBeInTheDocument();
    expect(screen.getByText('connectivityResolvingTitle')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'connectivityRetry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'connectivityRetrySync' })).not.toBeInTheDocument();
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

  // -- guardian outage ------------------------------------------------------
  it('renders the guardian banner with the Switch Guardian CTA when the current account is flagged', () => {
    guardianOutage.accounts.add('acct-1');
    render(<ConnectivityIssueBanner />);

    expect(screen.getByTestId('connectivity-banner-guardian')).toBeInTheDocument();
    expect(screen.getByText('connectivityGuardianTitle')).toBeInTheDocument();
    expect(screen.getByText('connectivityGuardianBody')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'connectivityGuardianCta' }));
    expect(mockHapticLight).toHaveBeenCalled();
    expect(jest.requireMock('lib/woozie').navigate).toHaveBeenCalledWith('/rotate-guardian');
    // The guardian CTA is a route, never a sync poke.
    expect(mockRequestImmediateSync).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('does not render the guardian banner for an outage on a DIFFERENT account', () => {
    guardianOutage.accounts.add('someone-else');
    const { container } = render(<ConnectivityIssueBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('node outranks guardian (a dead node masks the guardian signal); guardian outranks prover', () => {
    guardianOutage.accounts.add('acct-1');
    setState({ node: true, prover: true });
    render(<ConnectivityIssueBanner />);
    expect(screen.getByTestId('connectivity-banner-node')).toBeInTheDocument();

    setState({ prover: true });
    guardianOutage.listeners.forEach(listener => listener());
    render(<ConnectivityIssueBanner />);
    expect(screen.getByTestId('connectivity-banner-guardian')).toBeInTheDocument();
  });

  it('guardian dismiss is banner-local (no shared-category dismiss) and the banner clears with the flag', () => {
    guardianOutage.accounts.add('acct-1');
    render(<ConnectivityIssueBanner />);

    fireEvent.click(screen.getByLabelText('close'));
    expect(mockDismiss).not.toHaveBeenCalled();
    expect(screen.queryByTestId('connectivity-banner-guardian')).not.toBeInTheDocument();
  });

  // The dismiss is keyed by ACCOUNT, not a bare boolean. Two guardian accounts
  // on two dead operators keep `guardianOutage` true across the switch, so a
  // boolean's reset effect would never fire and the first dismiss would silently
  // suppress the second account's banner.
  it('does not carry a guardian dismiss across an account switch to another flagged account', () => {
    guardianOutage.accounts.add('acct-1');
    guardianOutage.accounts.add('acct-2');
    const { rerender } = render(<ConnectivityIssueBanner />);

    fireEvent.click(screen.getByLabelText('close'));
    expect(screen.queryByTestId('connectivity-banner-guardian')).not.toBeInTheDocument();

    act(() => {
      currentAccount.publicKey = 'acct-2';
    });
    rerender(<ConnectivityIssueBanner />);

    expect(screen.getByTestId('connectivity-banner-guardian')).toBeInTheDocument();
  });

  it('keeps the guardian dismiss when switching back to the account it was made on', () => {
    guardianOutage.accounts.add('acct-1');
    guardianOutage.accounts.add('acct-2');
    const { rerender } = render(<ConnectivityIssueBanner />);

    fireEvent.click(screen.getByLabelText('close'));

    act(() => {
      currentAccount.publicKey = 'acct-2';
    });
    rerender(<ConnectivityIssueBanner />);
    expect(screen.getByTestId('connectivity-banner-guardian')).toBeInTheDocument();

    act(() => {
      currentAccount.publicKey = 'acct-1';
    });
    rerender(<ConnectivityIssueBanner />);
    expect(screen.queryByTestId('connectivity-banner-guardian')).not.toBeInTheDocument();
  });

  // The commonest switch of all: one guardian account in outage plus a healthy
  // (or non-guardian) second account. Expiring the dismiss on the CURRENT
  // account's flag threw it away the moment the healthy account was selected,
  // so coming back re-surfaced a banner the user had already dismissed — and
  // this view stays mounted across account switches, so nothing else reset it.
  it('keeps the guardian dismiss across a switch to a HEALTHY account and back', () => {
    guardianOutage.accounts.add('acct-1');
    const { rerender } = render(<ConnectivityIssueBanner />);

    fireEvent.click(screen.getByLabelText('close'));
    expect(screen.queryByTestId('connectivity-banner-guardian')).not.toBeInTheDocument();

    act(() => {
      currentAccount.publicKey = 'healthy-acct';
    });
    rerender(<ConnectivityIssueBanner />);
    expect(screen.queryByTestId('connectivity-banner-guardian')).not.toBeInTheDocument();

    act(() => {
      currentAccount.publicKey = 'acct-1';
    });
    rerender(<ConnectivityIssueBanner />);
    expect(screen.queryByTestId('connectivity-banner-guardian')).not.toBeInTheDocument();
  });

  // The other half of keying the expiry on the dismissed account: a recovery
  // that lands while the user is elsewhere must still expire the dismiss, so a
  // later, genuinely new outage is not suppressed by a stale one.
  it('expires the dismiss when the dismissed account recovers while another account is selected', () => {
    guardianOutage.accounts.add('acct-1');
    const { rerender } = render(<ConnectivityIssueBanner />);
    fireEvent.click(screen.getByLabelText('close'));

    act(() => {
      currentAccount.publicKey = 'healthy-acct';
    });
    rerender(<ConnectivityIssueBanner />);

    act(() => {
      guardianOutage.accounts.delete('acct-1');
      guardianOutage.listeners.forEach(listener => listener());
    });

    act(() => {
      currentAccount.publicKey = 'acct-1';
      guardianOutage.accounts.add('acct-1');
      guardianOutage.listeners.forEach(listener => listener());
    });
    rerender(<ConnectivityIssueBanner />);

    expect(screen.getByTestId('connectivity-banner-guardian')).toBeInTheDocument();
  });

  it('clears the guardian banner when the sync loop stands the flag down', () => {
    guardianOutage.accounts.add('acct-1');
    render(<ConnectivityIssueBanner />);
    expect(screen.getByTestId('connectivity-banner-guardian')).toBeInTheDocument();

    act(() => {
      guardianOutage.accounts.delete('acct-1');
      guardianOutage.listeners.forEach(listener => listener());
    });
    expect(screen.queryByTestId('connectivity-banner-guardian')).not.toBeInTheDocument();
  });

  // -- onRetry --------------------------------------------------------------
  it('on retry off-extension: buzzes and requests an immediate sync', () => {
    mockIsExtension.mockReturnValue(false);
    setState({ network: true });
    render(<ConnectivityIssueBanner />);

    fireEvent.click(screen.getByRole('button', { name: 'connectivityRetry' }));

    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(mockRequestImmediateSync).toHaveBeenCalledTimes(1);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('on retry in the extension: pokes the SW with a SyncRequest', () => {
    mockIsExtension.mockReturnValue(true);
    setState({ network: true });
    render(<ConnectivityIssueBanner />);

    fireEvent.click(screen.getByRole('button', { name: 'connectivityRetry' }));

    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(mockRequestImmediateSync).not.toHaveBeenCalled();
    expect(mockRequest).toHaveBeenCalledWith({ type: 'SyncRequest', force: true });
  });

  it('swallows an intercom rejection on retry (no unhandled error)', async () => {
    mockIsExtension.mockReturnValue(true);
    mockRequest.mockRejectedValue(new Error('SW unreachable'));
    setState({ node: true });
    render(<ConnectivityIssueBanner />);

    fireEvent.click(screen.getByRole('button', { name: 'connectivityRetrySync' }));

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith({ type: 'SyncRequest', force: true }));
    // Let the rejected promise settle so the `.catch(() => {})` handler runs.
    await Promise.resolve();
    await Promise.resolve();
  });

  // -- onDismiss ------------------------------------------------------------
  it('dismisses the active category and buzzes when the close icon is tapped', () => {
    setState({ prover: true });
    render(<ConnectivityIssueBanner />);

    fireEvent.click(screen.getByRole('button', { name: 'close' }));

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
