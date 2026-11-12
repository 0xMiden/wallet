import React from 'react';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { __resetSyncFuseStateForTests, isSyncFused, noteSyncWatchdogEviction } from 'lib/miden/front/sync-fuse';
import { MAX_CONSECUTIVE_WATCHDOG_EVICTIONS } from 'lib/miden/sync-backoff';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/constants';
import { buildDefaultOverrideFor } from 'lib/miden-chain/effective-endpoints';
import { WalletStatus } from 'lib/shared/types';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';
import { useAlert, useConfirm } from 'lib/ui/dialog';

import DeveloperSettings from './DeveloperSettings';

jest.mock('lib/telemetry/user-visible-error', () => ({
  ...jest.requireActual('lib/telemetry/user-visible-error'),
  reportUserVisibleError: jest.fn()
}));

// `react-i18next` pulls in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes the key back and every rendered label is the raw key.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `hapticMedium` is a native Capacitor wrapper; replace it with a spy so the
// reset-action wiring can be asserted without touching the plugin.
const hapticMedium = jest.fn();
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn(),
  hapticMedium: () => hapticMedium(),
  hapticSelection: jest.fn()
}));

// `isExtension` gates which reload path handleReset takes; a mutable flag lets
// tests drive both branches.
const mockIsExtension = { value: false };
const mockReloadInPlace = jest.fn();
// False on an extension page an extension reload or update orphaned.
const mockHasExtensionRuntime = { value: true };
jest.mock('lib/platform', () => ({
  isExtension: () => mockIsExtension.value,
  hasExtensionRuntime: () => mockIsExtension.value && mockHasExtensionRuntime.value,
  reloadInPlace: () => mockReloadInPlace(),
  // The pinned footer's slide (useSlideOnReflow) reads this to decide whether to animate at all.
  isMobile: () => false
}));

// `browser.runtime.reload` (extension reload path) — spy-able, unlike
// `window.location.reload`, which jsdom exposes as a non-configurable getter
// (see CLAUDE.md testing gotchas) and so can't be mocked/asserted on directly.
const runtimeReload = jest.fn();
jest.mock('webextension-polyfill', () => ({
  __esModule: true,
  default: { runtime: { reload: () => runtimeReload() } }
}));
// The suite's own mock, kept so a test can count its loads and afterEach can put it back after a test swaps it.
const polyfill: unknown = jest.requireMock('webextension-polyfill');

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
let mockHistoryPosition = 1;

jest.mock('lib/woozie', () => ({
  // Forwards EVERY argument: useBackWithFallback passes the history action as a second one, and a
  // single-parameter stub would drop it and make any assertion about it fail on arity.
  navigate: (...args: unknown[]) => mockNavigate(...args),
  goBack: () => mockGoBack(),
  // useBackWithFallback reads live history at call time, and useOncePerLocation calls listen() in a
  // mount effect, so without these the whole suite throws on render.
  createLocationState: () => ({ historyPosition: mockHistoryPosition, href: 'http://localhost/#/developer-settings' }),
  listen: () => () => undefined,
  HistoryAction: { Pop: 'popstate', Push: 'pushstate', Replace: 'replacestate' }
}));

// The destructive reset is gated behind the app's standard confirm dialog
// (same `useConfirm()` hook `options.tsx`'s "Reset Wallet" uses) — mocked the
// same way `AddressBook.test.tsx`/`DAppSettings.test.tsx` mock it, so the
// resolved value drives whether the wipe proceeds. `useAlert()` is how a wipe
// that rejected is reported.
jest.mock('lib/ui/dialog', () => ({
  useConfirm: jest.fn(),
  useAlert: jest.fn()
}));
const mockUseConfirm = useConfirm as jest.Mock;
const confirm = jest.fn();
const mockUseAlert = jest.mocked(useAlert);
let alert: jest.Mock;

const applyEndpointOverride = jest.fn();
const clearEndpointOverride = jest.fn();
// The override the screen OPENS on. Null is the fresh-install case the rest of the suite wants;
// opening on a SAVED custom override is a real entry path, and the one the mount-time half of the
// restore is about, so it has to be settable.
let activeOverride: unknown = null;
// The effective network's test-network key; null stands for mainnet.
let mockTestNetworkKey: 'testnet' | 'devnet' | 'localnet' | null = 'testnet';
jest.mock('lib/miden-chain/effective-endpoints', () => {
  return {
    getActiveOverride: () => activeOverride,
    getTestNetworkNameKey: () => mockTestNetworkKey,
    applyEndpointOverride: (o: unknown) => applyEndpointOverride(o),
    clearEndpointOverride: () => clearEndpointOverride(),
    // Read lazily: the constants module is loaded first now and imports this one, so a factory-time read sees it half built.
    getEffectiveNetworkName: () => jest.requireActual('lib/miden-chain/constants').MIDEN_NETWORK_NAME.TESTNET,
    buildDefaultOverrideFor: (n: string) => ({
      rpcUrl: `https://rpc.${n}`,
      proverUrl: `https://prover.${n}`,
      noteTransportUrl: `https://ntl.${n}`,
      faucetUrl: `https://faucet.${n}`,
      faucetApiUrl: `https://faucet-api.${n}`,
      explorerUrl: `https://scan.${n}`,
      guardianUrl: `https://guardian.${n}`,
      allowNoGuardian: false,
      networkName: n,
      presetName: n,
      feeFaucetId: ''
    })
  };
});

jest.mock('components/ui/Checkbox', () => ({
  CheckboxIndicator: ({ checked }: { checked: boolean }) => (
    <span data-testid="checkbox" data-checked={String(checked)} />
  )
}));

type HealthStatus = 'idle' | 'pending' | 'reachable' | 'error';
const mockHealthStatus: { value: HealthStatus } = { value: 'idle' };
jest.mock('lib/miden-chain/endpoint-health', () => ({
  useEndpointHealth: () => mockHealthStatus.value
}));

const resetStorageDestructive = jest.fn();
jest.mock('lib/miden/reset', () => ({
  resetStorageDestructive: (...args: unknown[]) => resetStorageDestructive(...args)
}));

// The other half of the endpoint-change contract. Clearing the fuse discards what the old
// node taught us; this retires the passes still in flight AGAINST it, whose pending-rotation
// recheck would otherwise demote rows and roll the guardian binding back from chain reads
// taken before the save. Spied rather than driven behaviourally: the generation counter is
// module-private to guardian-sync and is observed there, so what this screen owes is the call.
const mockRetireGuardianSyncPasses = jest.fn();
jest.mock('lib/miden/front/guardian-sync', () => ({
  retireGuardianSyncPasses: () => mockRetireGuardianSyncPasses()
}));
// The durable-write half of the same retirement; spied so the save's order can be read off the calls.
const mockRetireGuardianWrites = jest.fn();
jest.mock('lib/miden/sync-backoff', () => ({
  ...jest.requireActual<typeof import('lib/miden/sync-backoff')>('lib/miden/sync-backoff'),
  retireGuardianWritesForEndpointChange: () => mockRetireGuardianWrites()
}));

// The save rebuilds this realm's client on mobile and desktop; spied, since the rebuild is the client module's.
const mockResetMidenClient = jest.fn();
jest.mock('lib/miden/sdk/miden-client', () => ({
  resetMidenClient: () => mockResetMidenClient()
}));

// The save has the bridge config follow the new network in this realm; spied, since the load itself is the runtime's.
const mockFollowEffectiveNetwork = jest.fn();
jest.mock('lib/remote-config/runtime', () => ({
  ...jest.requireActual<typeof import('lib/remote-config/runtime')>('lib/remote-config/runtime'),
  followEffectiveNetwork: () => mockFollowEffectiveNetwork()
}));

// `reloadEndpointOverridesInSW` nudges the service worker on the extension
// (separate JS realm); handleSave's gating on `isExtension()` is asserted
// against this spy below.
const reloadEndpointOverridesInSW = jest.fn();
// `useWalletStore(selectIsIdle)` gates the SW nudge to pre-wallet (onboarding) —
// `/developer-settings` is also reachable read-write from a live wallet (gated on
// `!locked`, not `!ready`), so the nudge must not fire once a wallet exists. Default
// to idle (no wallet) so the existing extension/non-extension save tests, which predate
// this gate, keep exercising the "onboarding" case unchanged; a dedicated test below
// flips it to Ready.
// The save drops every cached balance in this realm; spied, since what the drop does is the store's.
const mockClearBalances = jest.fn();
const mockWalletState: { status: number; clearBalances: () => void } = {
  status: 0,
  clearBalances: () => mockClearBalances()
};
jest.mock('lib/store', () => {
  const { WalletStatus } = jest.requireActual('lib/shared/types');
  return {
    reloadEndpointOverridesInSW: () => reloadEndpointOverridesInSW(),
    useWalletStore: (selector: (s: typeof mockWalletState) => unknown) => selector(mockWalletState),
    selectIsIdle: (s: typeof mockWalletState) => s.status === WalletStatus.Idle
  };
});

// The banner's own code-first switch, rendered here as a stand-in that shows whether it is open: the
// banner's suite drives the real sheet.
const mockSwitchSheet = jest.fn<void, [{ open: boolean }]>();
jest.mock('components/MainnetSwitchSheet', () => ({
  MainnetSwitchSheet: ({ open }: { open: boolean; onOpenChange: (open: boolean) => void }) => {
    mockSwitchSheet({ open });
    return open ? <div data-testid="mainnet-switch-sheet" /> : null;
  }
}));

// House components — replace with lightweight stand-ins that forward the
// props DeveloperSettings actually passes, so testids/values stay assertable
// without pulling in framer-motion / icon assets.
jest.mock('components/PageHeader', () => ({
  PageHeader: ({ title, onBack }: { title?: React.ReactNode; onBack?: () => void }) => (
    <div data-testid="screen-header">
      <span>{title}</span>
      <button type="button" aria-label="back" onClick={onBack}>
        back
      </button>
    </div>
  )
}));

jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Destructive: 'destructive', Ghost: 'ghost' },
  Button: ({
    title,
    onClick,
    isLoading,
    disabled,
    variant,
    'data-testid': testId
  }: {
    title?: string;
    onClick?: () => void;
    isLoading?: boolean;
    disabled?: boolean;
    variant?: string;
    'data-testid'?: string;
  }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-loading={String(!!isLoading)}
      data-variant={variant}
      data-testid={testId}
    >
      {title}
    </button>
  )
}));

beforeEach(() => {
  mockHistoryPosition = 1;
  activeOverride = null;
  __resetSyncFuseStateForTests();
  jest.clearAllMocks();
  // clearAllMocks keeps queued once-values, so one a failing test never used would reach the next.
  for (const service of [
    applyEndpointOverride,
    clearEndpointOverride,
    resetStorageDestructive,
    reloadEndpointOverridesInSW,
    mockResetMidenClient
  ]) {
    service.mockReset().mockResolvedValue(undefined);
  }
  runtimeReload.mockReset();
  mockReloadInPlace.mockReset();
  mockHealthStatus.value = 'idle';
  mockIsExtension.value = false;
  mockHasExtensionRuntime.value = true;
  mockWalletState.status = WalletStatus.Idle;
  mockTestNetworkKey = 'testnet';
  mockClearBalances.mockReset();
  confirm.mockResolvedValue(true);
  mockUseConfirm.mockReturnValue(confirm);
  alert = jest.fn().mockResolvedValue(undefined);
  mockUseAlert.mockReturnValue(alert);
});

// Here rather than at the end of a test, so a failing assertion cannot leave a spy in place, or a
// polyfill factory that throws for the next test.
afterEach(() => {
  jest.restoreAllMocks();
  jest.doMock('webextension-polyfill', () => polyfill);
});

/** A stored override: testnet's defaults with one endpoint the user authored. `allowNoGuardian`
 * differs from every preset's `false` in the case that asserts the restore carries URLs only. */
const saved = (rpcUrl: string, allowNoGuardian = false) => ({
  rpcUrl,
  proverUrl: 'https://prover.testnet',
  noteTransportUrl: 'https://ntl.testnet',
  faucetUrl: 'https://faucet.testnet',
  faucetApiUrl: 'https://faucet-api.testnet',
  explorerUrl: 'https://scan.testnet',
  guardianUrl: 'https://guardian.testnet',
  allowNoGuardian,
  networkName: 'testnet'
});

/** Lights the idle-sync fuse as consecutive watchdog evictions do. Stubs console.warn for the rest
 * of the test, since both the fuse and the save it is paired with log. */
const armIdleSyncFuse = () => {
  jest.spyOn(console, 'warn').mockImplementation();
  for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i++) noteSyncWatchdogEviction('idle-sync');
  expect(isSyncFused('idle-sync')).toBe(true);
};

describe('DeveloperSettings', () => {
  it('renders the warning banner and the RPC field', () => {
    render(<DeveloperSettings />);
    expect(screen.getByText('developerSettingsWarning')).toBeInTheDocument();
    expect(screen.getByTestId('dev-endpoint-rpcUrl')).toBeInTheDocument();
  });

  it('saves the current values and navigates home on save', async () => {
    render(<DeveloperSettings />);
    fireEvent.click(screen.getByTestId('dev-endpoints-save'));
    await waitFor(() => expect(applyEndpointOverride).toHaveBeenCalledTimes(1));
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('stores the saved network as the developer choice', async () => {
    render(<DeveloperSettings />);
    fireEvent.click(within(screen.getByTestId('dev-endpoint-preset')).getByTestId('dev-endpoint-preset-testnet'));
    fireEvent.click(screen.getByTestId('dev-endpoints-save'));
    await waitFor(() => expect(applyEndpointOverride).toHaveBeenCalledTimes(1));
    expect(applyEndpointOverride).toHaveBeenCalledWith({
      ...buildDefaultOverrideFor(MIDEN_NETWORK_NAME.TESTNET),
      developerChoice: true
    });
  });

  it('has the bridge config follow the new network once the override is applied', async () => {
    const order: string[] = [];
    applyEndpointOverride.mockImplementationOnce(async () => {
      order.push('apply');
    });
    mockFollowEffectiveNetwork.mockImplementationOnce(() => {
      order.push('follow');
    });
    render(<DeveloperSettings />);
    fireEvent.click(screen.getByTestId('dev-endpoints-save'));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/'));
    expect(mockFollowEffectiveNetwork).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['apply', 'follow']);
  });

  it('does not follow the network when the endpoint write fails', async () => {
    applyEndpointOverride.mockRejectedValueOnce(new Error('quota exceeded'));
    render(<DeveloperSettings />);
    fireEvent.click(screen.getByTestId('dev-endpoints-save'));

    await screen.findByRole('alert');
    expect(mockFollowEffectiveNetwork).not.toHaveBeenCalled();
  });

  it('drops the cached balances once the override is applied, since every one was read from the OLD node', async () => {
    const order: string[] = [];
    applyEndpointOverride.mockImplementationOnce(async () => {
      order.push('apply');
    });
    mockClearBalances.mockImplementationOnce(() => {
      order.push('clear');
    });
    render(<DeveloperSettings />);
    fireEvent.click(screen.getByTestId('dev-endpoints-save'));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/'));
    expect(mockClearBalances).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['apply', 'clear']);
  });

  it('keeps the cached balances and the client when the endpoint write fails', async () => {
    applyEndpointOverride.mockRejectedValueOnce(new Error('quota exceeded'));
    render(<DeveloperSettings />);
    fireEvent.click(screen.getByTestId('dev-endpoints-save'));

    await screen.findByRole('alert');
    expect(mockClearBalances).not.toHaveBeenCalled();
    expect(mockResetMidenClient).not.toHaveBeenCalled();
  });

  it('rebuilds the client once the old node is retired and before the balances drop, without waiting for it', async () => {
    // Never settles: a reset queued behind a long hold must not keep the save from navigating.
    armIdleSyncFuse();
    let fusedWhenResetStarted: boolean | undefined;
    mockResetMidenClient.mockImplementation(() => {
      fusedWhenResetStarted = isSyncFused('idle-sync');
      return new Promise<void>(() => undefined);
    });
    render(<DeveloperSettings />);
    fireEvent.click(screen.getByTestId('dev-endpoints-save'));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/'));
    expect(mockResetMidenClient).toHaveBeenCalledTimes(1);
    expect(mockRetireGuardianSyncPasses).toHaveBeenCalledTimes(1);
    expect(mockRetireGuardianWrites).toHaveBeenCalledTimes(1);
    expect(fusedWhenResetStarted).toBe(false);
    const [resetAt] = mockResetMidenClient.mock.invocationCallOrder;
    if (resetAt === undefined) throw new Error('the save never started the client reset');
    expect(applyEndpointOverride.mock.invocationCallOrder[0]).toBeLessThan(resetAt);
    expect(mockRetireGuardianSyncPasses.mock.invocationCallOrder[0]).toBeLessThan(resetAt);
    expect(mockRetireGuardianWrites.mock.invocationCallOrder[0]).toBeLessThan(resetAt);
    expect(mockClearBalances.mock.invocationCallOrder[0]).toBeGreaterThan(resetAt);
  });

  it('logs a client rebuild that fails, and still saves', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    const failure = new Error('dispose failed');
    mockResetMidenClient.mockRejectedValueOnce(failure);
    render(<DeveloperSettings />);
    fireEvent.click(screen.getByTestId('dev-endpoints-save'));

    await waitFor(() => expect(warn).toHaveBeenCalledWith(expect.any(String), failure));
    expect(mockNavigate).toHaveBeenCalledWith('/');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('offers no save on the extension once a wallet exists, which would switch only this page', () => {
    // The worker and offscreen would keep the old network, and the wallet would look broken.
    mockIsExtension.value = true;
    mockWalletState.status = WalletStatus.Ready;
    render(<DeveloperSettings />);

    expect(screen.queryByTestId('dev-endpoints-save')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dev-endpoints-reset-defaults')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dev-endpoint-preset')).not.toBeInTheDocument();
    expect(applyEndpointOverride).not.toHaveBeenCalled();
    expect(mockClearBalances).not.toHaveBeenCalled();
    expect(mockResetMidenClient).not.toHaveBeenCalled();
  });

  it('drops the balances but leaves the client to the worker on the extension before a wallet exists', async () => {
    mockIsExtension.value = true;
    mockWalletState.status = WalletStatus.Idle;
    render(<DeveloperSettings />);
    fireEvent.click(screen.getByTestId('dev-endpoints-save'));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/'));
    expect(mockClearBalances).toHaveBeenCalledTimes(1);
    expect(mockResetMidenClient).not.toHaveBeenCalled();
  });

  it('stops the spinner and shows an error when the endpoint write fails, and stays on the screen', async () => {
    armIdleSyncFuse();

    applyEndpointOverride.mockRejectedValueOnce(new Error('quota exceeded'));
    render(<DeveloperSettings />);
    fireEvent.click(screen.getByTestId('dev-endpoints-save'));

    expect(await screen.findByRole('alert')).toHaveTextContent('devEndpointSaveFailed');
    expect(screen.getByTestId('dev-endpoints-save')).toHaveAttribute('data-loading', 'false');
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(isSyncFused('idle-sync')).toBe(true);
  });

  it('clears the error as soon as a later save starts, and navigates home once it succeeds', async () => {
    applyEndpointOverride.mockRejectedValueOnce(new Error('quota exceeded'));
    render(<DeveloperSettings />);
    fireEvent.click(screen.getByTestId('dev-endpoints-save'));
    await screen.findByRole('alert');

    let finishRetry!: () => void;
    applyEndpointOverride.mockReturnValueOnce(new Promise<void>(resolve => (finishRetry = resolve)));
    fireEvent.click(screen.getByTestId('dev-endpoints-save'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('dev-endpoints-save')).toHaveAttribute('data-loading', 'true');

    finishRetry();
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('writes once when Save is pressed again while a save is still running', async () => {
    let finishSave!: () => void;
    applyEndpointOverride.mockReturnValueOnce(new Promise<void>(resolve => (finishSave = resolve)));
    render(<DeveloperSettings />);
    fireEvent.click(screen.getByTestId('dev-endpoints-save'));
    fireEvent.click(screen.getByTestId('dev-endpoints-save'));
    expect(applyEndpointOverride).toHaveBeenCalledTimes(1);

    finishSave();
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/'));
    expect(applyEndpointOverride).toHaveBeenCalledTimes(1);
  });

  it('discards the sync fuse on save, since every conclusion in it was about the OLD node', async () => {
    // Mobile and desktop own the idle loop, and this is their only repoint affordance. A
    // fused wallet pointed at a working RPC would otherwise probe once per 30 min — the
    // repoint reads as "nothing happened", and the successful sync that puts the fuse out
    // is exactly what the wallet stops giving itself the chance to observe (#777).
    armIdleSyncFuse();

    render(<DeveloperSettings />);
    fireEvent.click(screen.getByTestId('dev-endpoints-save'));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/'));
    expect(isSyncFused('idle-sync')).toBe(false);
  });

  it('retires the guardian passes still in flight against the OLD node on save', async () => {
    render(<DeveloperSettings />);
    fireEvent.click(screen.getByTestId('dev-endpoints-save'));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/'));
    expect(mockRetireGuardianSyncPasses).toHaveBeenCalledTimes(1);
  });

  it('nudges the service worker to reload endpoint overrides on save when running as an extension with no wallet yet (onboarding)', async () => {
    mockIsExtension.value = true;
    mockWalletState.status = WalletStatus.Idle;
    render(<DeveloperSettings />);
    fireEvent.click(screen.getByTestId('dev-endpoints-save'));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/'));
    expect(reloadEndpointOverridesInSW).toHaveBeenCalledTimes(1);
  });

  it('does not nudge the service worker on save outside the extension (mobile/desktop share the realm)', async () => {
    mockIsExtension.value = false;
    mockWalletState.status = WalletStatus.Idle;
    render(<DeveloperSettings />);
    fireEvent.click(screen.getByTestId('dev-endpoints-save'));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/'));
    expect(reloadEndpointOverridesInSW).not.toHaveBeenCalled();
  });

  it('leaves the endpoints read-only once a wallet exists (reachable via /developer-settings without onlyReady), so nothing reaches the service worker', () => {
    mockIsExtension.value = true;
    mockWalletState.status = WalletStatus.Ready;
    render(<DeveloperSettings />);

    expect(screen.getByTestId('dev-endpoint-rpcUrl')).toBeDisabled();
    expect(screen.getByTestId('dev-endpoint-feeFaucetId')).toBeDisabled();
    expect(
      within(screen.getByTestId('dev-endpoint-network-id')).getByTestId('dev-endpoint-network-mainnet')
    ).toBeDisabled();
    expect(screen.getByTestId('dev-allow-no-guardian')).toBeDisabled();
    expect(reloadEndpointOverridesInSW).not.toHaveBeenCalled();
  });

  it.each<[string, boolean]>([
    ['the standalone route', false],
    ['the Settings sub-page', true]
  ])('offers the code-first switch to mainnet for an existing wallet on %s', (_route, readOnly) => {
    mockWalletState.status = WalletStatus.Ready;
    render(<DeveloperSettings readOnly={readOnly} />);
    expect(screen.queryByTestId('mainnet-switch-sheet')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('dev-switch-to-mainnet'));

    expect(screen.getByTestId('mainnet-switch-sheet')).toBeInTheDocument();
    expect(screen.getByTestId('dev-switch-to-mainnet')).toHaveTextContent('switchToMainnet');
    expect(applyEndpointOverride).not.toHaveBeenCalled();
    expect(resetStorageDestructive).not.toHaveBeenCalled();
  });

  it('keeps the standalone route free of any way back to the build network once a wallet exists', () => {
    mockWalletState.status = WalletStatus.Ready;
    mockTestNetworkKey = null;
    render(<DeveloperSettings />);
    expect(screen.queryByTestId('dev-endpoints-reset')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dev-endpoints-save')).not.toBeInTheDocument();
  });

  it('does not offer the switch on mainnet', () => {
    mockWalletState.status = WalletStatus.Ready;
    mockTestNetworkKey = null;
    render(<DeveloperSettings readOnly />);
    expect(screen.queryByTestId('dev-switch-to-mainnet')).not.toBeInTheDocument();
    expect(screen.getByTestId('dev-endpoints-reset')).toBeInTheDocument();
  });

  it('does not offer the switch before a wallet exists, where the edit mode saves as before', () => {
    render(<DeveloperSettings />);
    expect(screen.queryByTestId('dev-switch-to-mainnet')).not.toBeInTheDocument();
    expect(screen.getByTestId('dev-endpoints-save')).toBeInTheDocument();
    expect(screen.getByTestId('dev-endpoint-rpcUrl')).toBeEnabled();
  });

  it('read-only mode disables inputs and shows the reset action', () => {
    render(<DeveloperSettings readOnly />);
    expect(screen.getByTestId('dev-endpoint-rpcUrl')).toBeDisabled();
    expect(screen.getByTestId('dev-endpoints-reset')).toBeInTheDocument();
    expect(screen.queryByTestId('dev-endpoints-save')).not.toBeInTheDocument();
  });

  it('switching to a different preset prefills the fields and marks it active', () => {
    render(<DeveloperSettings />);
    const presetPicker = screen.getByTestId('dev-endpoint-preset');
    fireEvent.click(within(presetPicker).getByTestId('dev-endpoint-preset-devnet'));

    expect(screen.getByTestId('dev-endpoint-rpcUrl')).toHaveValue('https://rpc.devnet');
    expect(within(presetPicker).getByTestId('dev-endpoint-preset-devnet')).toHaveAttribute('aria-checked', 'true');
    expect(within(presetPicker).getByTestId('dev-endpoint-preset-testnet')).toHaveAttribute('aria-checked', 'false');
  });

  // The picker is a radio group, so arrow keys commit every item they pass over. A typed endpoint
  // must survive the trip away from Custom and back, however many presets it passes through.
  it('gives back the typed endpoints when Custom is chosen again', () => {
    render(<DeveloperSettings />);
    fireEvent.change(screen.getByTestId('dev-endpoint-rpcUrl'), { target: { value: 'https://typed.example' } });
    const picker = screen.getByTestId('dev-endpoint-preset');

    fireEvent.click(within(picker).getByTestId('dev-endpoint-preset-devnet'));
    expect(screen.getByTestId('dev-endpoint-rpcUrl')).toHaveValue('https://rpc.devnet');

    fireEvent.click(within(picker).getByTestId('dev-endpoint-preset-custom'));
    expect(screen.getByTestId('dev-endpoint-rpcUrl')).toHaveValue('https://typed.example');
  });

  it('gives them back after a walk through more than one preset', () => {
    render(<DeveloperSettings />);
    fireEvent.change(screen.getByTestId('dev-endpoint-rpcUrl'), { target: { value: 'https://typed.example' } });
    const picker = screen.getByTestId('dev-endpoint-preset');

    fireEvent.click(within(picker).getByTestId('dev-endpoint-preset-testnet'));
    fireEvent.click(within(picker).getByTestId('dev-endpoint-preset-devnet'));
    fireEvent.click(within(picker).getByTestId('dev-endpoint-preset-custom'));

    // Not testnet's and not devnet's: what the user typed.
    expect(screen.getByTestId('dev-endpoint-rpcUrl')).toHaveValue('https://typed.example');
  });

  // A control that flips the form to Custom without touching a URL - the Network ID picker, the
  // no-guardian checkbox - leaves a PRESET's URLs in the fields. Those must never become "what the
  // user typed", or the next preset hop stores them and the typed endpoints are gone.
  it('keeps the typed endpoints when the Network ID is changed between two presets', () => {
    render(<DeveloperSettings />);
    fireEvent.change(screen.getByTestId('dev-endpoint-rpcUrl'), { target: { value: 'https://typed.example' } });
    const picker = screen.getByTestId('dev-endpoint-preset');
    const networkPicker = screen.getByTestId('dev-endpoint-network-id');

    fireEvent.click(within(picker).getByTestId('dev-endpoint-preset-testnet'));
    fireEvent.click(within(networkPicker).getByTestId('dev-endpoint-network-localnet'));
    fireEvent.click(within(picker).getByTestId('dev-endpoint-preset-devnet'));
    fireEvent.click(within(picker).getByTestId('dev-endpoint-preset-custom'));

    expect(screen.getByTestId('dev-endpoint-rpcUrl')).toHaveValue('https://typed.example');
    // Only the URL fields come back: the network id is the one the last preset set, not the
    // localnet that a whole-form capture would have carried into the restore.
    expect(within(networkPicker).getByTestId('dev-endpoint-network-devnet')).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps the typed endpoints when the no-guardian toggle is used between two presets', () => {
    render(<DeveloperSettings />);
    fireEvent.change(screen.getByTestId('dev-endpoint-rpcUrl'), { target: { value: 'https://typed.example' } });
    const picker = screen.getByTestId('dev-endpoint-preset');

    fireEvent.click(within(picker).getByTestId('dev-endpoint-preset-testnet'));
    fireEvent.click(screen.getByTestId('dev-allow-no-guardian'));
    fireEvent.click(within(picker).getByTestId('dev-endpoint-preset-devnet'));
    fireEvent.click(within(picker).getByTestId('dev-endpoint-preset-custom'));

    expect(screen.getByTestId('dev-endpoint-rpcUrl')).toHaveValue('https://typed.example');
    // Likewise: the toggle reads what the last preset set, not the `true` a whole-form capture
    // would have restored alongside the URLs.
    expect(screen.getByTestId('checkbox')).toHaveAttribute('data-checked', 'false');
  });

  // The screen is most often opened ON a saved custom override, and those endpoints are remembered
  // exactly like ones typed here: the restore reads them from the form it opened with.
  it('gives back endpoints saved in an earlier session, after a hop through a preset', () => {
    // `allowNoGuardian: true` differs from every preset's `false`, and the fixture's networkName
    // ('testnet') differs from the devnet hop: between them they make the URL-ONLY half of the
    // restore observable, which is otherwise invisible to a green suite.
    activeOverride = { ...saved('https://saved.example', true), presetName: 'custom' };
    render(<DeveloperSettings />);
    const picker = screen.getByTestId('dev-endpoint-preset');

    fireEvent.click(within(picker).getByTestId('dev-endpoint-preset-devnet'));
    fireEvent.click(within(picker).getByTestId('dev-endpoint-preset-custom'));

    expect(screen.getByTestId('dev-endpoint-rpcUrl')).toHaveValue('https://saved.example');
    // Only the URL fields come back: the network id and the toggle read what the last preset set.
    expect(
      within(screen.getByTestId('dev-endpoint-network-id')).getByTestId('dev-endpoint-network-devnet')
    ).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('checkbox')).toHaveAttribute('data-checked', 'false');
  });

  // The two sources in one walk: what was typed here outranks what the screen opened with.
  it('prefers an endpoint typed now over the one it opened with', () => {
    activeOverride = { ...saved('https://saved.example'), presetName: 'custom' };
    render(<DeveloperSettings />);
    const picker = screen.getByTestId('dev-endpoint-preset');

    fireEvent.change(screen.getByTestId('dev-endpoint-rpcUrl'), { target: { value: 'https://typed.example' } });
    fireEvent.click(within(picker).getByTestId('dev-endpoint-preset-devnet'));
    fireEvent.click(within(picker).getByTestId('dev-endpoint-preset-custom'));

    expect(screen.getByTestId('dev-endpoint-rpcUrl')).toHaveValue('https://typed.example');
  });

  // The other side of the same rule, and what pins the guard: a screen opened on a PRESET has
  // nothing authored to remember, so Custom must show the form as it stands - the LAST preset's
  // URLs, not the one it opened on.
  it('remembers nothing when it opened on a preset, so Custom keeps the last preset chosen', () => {
    render(<DeveloperSettings />);
    const picker = screen.getByTestId('dev-endpoint-preset');

    fireEvent.click(within(picker).getByTestId('dev-endpoint-preset-devnet'));
    fireEvent.click(within(picker).getByTestId('dev-endpoint-preset-custom'));

    expect(screen.getByTestId('dev-endpoint-rpcUrl')).toHaveValue('https://rpc.devnet');
  });

  // Reset to defaults shows the defaults; tapping Custom afterwards is an explicit request for the
  // user's own endpoints, so they come back. Reset is not a discard.
  it('brings saved endpoints back after Reset to defaults, when Custom is chosen again', () => {
    activeOverride = { ...saved('https://saved.example'), presetName: 'custom' };
    render(<DeveloperSettings />);

    fireEvent.click(screen.getByTestId('dev-endpoints-reset-defaults'));
    expect(screen.getByTestId('dev-endpoint-rpcUrl')).toHaveValue('https://rpc.testnet');

    fireEvent.click(within(screen.getByTestId('dev-endpoint-preset')).getByTestId('dev-endpoint-preset-custom'));
    expect(screen.getByTestId('dev-endpoint-rpcUrl')).toHaveValue('https://saved.example');
  });

  it('editing a field value flips the preset picker to custom', () => {
    render(<DeveloperSettings />);
    fireEvent.change(screen.getByTestId('dev-endpoint-rpcUrl'), { target: { value: 'https://custom.example' } });

    expect(screen.getByTestId('dev-endpoint-rpcUrl')).toHaveValue('https://custom.example');
    const presetPicker = screen.getByTestId('dev-endpoint-preset');
    expect(within(presetPicker).getByTestId('dev-endpoint-preset-custom')).toHaveAttribute('aria-checked', 'true');
  });

  it('selecting the Custom preset tab directly marks it active without touching field values', () => {
    render(<DeveloperSettings />);
    const presetPicker = screen.getByTestId('dev-endpoint-preset');
    fireEvent.click(within(presetPicker).getByTestId('dev-endpoint-preset-custom'));

    expect(within(presetPicker).getByTestId('dev-endpoint-preset-custom')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('dev-endpoint-rpcUrl')).toHaveValue('https://rpc.testnet');
  });

  it('Reset to defaults restores the effective network defaults after an edit', () => {
    render(<DeveloperSettings />);
    fireEvent.change(screen.getByTestId('dev-endpoint-rpcUrl'), { target: { value: 'https://custom.example' } });
    fireEvent.click(screen.getByTestId('dev-endpoints-reset-defaults'));

    expect(screen.getByTestId('dev-endpoint-rpcUrl')).toHaveValue('https://rpc.testnet');
  });

  it('switching the Network ID picker updates the network and flips the preset to custom', () => {
    render(<DeveloperSettings />);
    const presetPicker = screen.getByTestId('dev-endpoint-preset');
    const networkPicker = screen.getByTestId('dev-endpoint-network-id');
    fireEvent.click(within(networkPicker).getByTestId('dev-endpoint-network-localnet'));

    expect(within(networkPicker).getByTestId('dev-endpoint-network-localnet')).toHaveAttribute('aria-checked', 'true');
    expect(within(presetPicker).getByTestId('dev-endpoint-preset-custom')).toHaveAttribute('aria-checked', 'true');
  });

  it('offers Mainnet on the Network ID picker and as the first preset tab', () => {
    render(<DeveloperSettings />);
    const presetPicker = screen.getByTestId('dev-endpoint-preset');
    const networkPicker = screen.getByTestId('dev-endpoint-network-id');

    expect(within(networkPicker).getByTestId('dev-endpoint-network-mainnet')).toBeInTheDocument();
    expect(within(presetPicker).getByTestId('dev-endpoint-preset-mainnet')).toHaveTextContent('Mainnet');
    expect(within(presetPicker).getAllByRole('radio')[0]).toHaveAttribute('data-testid', 'dev-endpoint-preset-mainnet');
  });

  it('the Mainnet preset selects the mainnet network id', () => {
    render(<DeveloperSettings />);
    const presetPicker = screen.getByTestId('dev-endpoint-preset');
    const networkPicker = screen.getByTestId('dev-endpoint-network-id');

    fireEvent.click(within(presetPicker).getByTestId('dev-endpoint-preset-mainnet'));

    expect(within(presetPicker).getByTestId('dev-endpoint-preset-mainnet')).toHaveAttribute('aria-checked', 'true');
    expect(within(networkPicker).getByTestId('dev-endpoint-network-mainnet')).toHaveAttribute('aria-checked', 'true');
  });

  it('capitalizes the preset and network-id tab labels for display, keeping the raw id for logic', () => {
    render(<DeveloperSettings />);
    const presetPicker = screen.getByTestId('dev-endpoint-preset');
    const networkPicker = screen.getByTestId('dev-endpoint-network-id');

    expect(within(presetPicker).getByTestId('dev-endpoint-preset-testnet')).toHaveTextContent('Testnet');
    expect(within(presetPicker).getByTestId('dev-endpoint-preset-devnet')).toHaveTextContent('Devnet');
    expect(within(presetPicker).getByTestId('dev-endpoint-preset-localnet')).toHaveTextContent('Localnet');
    expect(within(presetPicker).getByTestId('dev-endpoint-preset-custom')).toHaveTextContent('devEndpointCustom');

    expect(within(networkPicker).getByTestId('dev-endpoint-network-mainnet')).toHaveTextContent('Mainnet');
    expect(within(networkPicker).getByTestId('dev-endpoint-network-testnet')).toHaveTextContent('Testnet');
  });

  it('read-only mode leaves the Network ID picker inert', () => {
    render(<DeveloperSettings readOnly />);
    const networkPicker = screen.getByTestId('dev-endpoint-network-id');
    expect(within(networkPicker).getByTestId('dev-endpoint-network-devnet')).toBeDisabled();
    fireEvent.click(within(networkPicker).getByTestId('dev-endpoint-network-devnet'));

    expect(within(networkPicker).getByTestId('dev-endpoint-network-testnet')).toHaveAttribute('aria-checked', 'true');
    expect(within(networkPicker).getByTestId('dev-endpoint-network-devnet')).toHaveAttribute('aria-checked', 'false');
  });

  it('asks for confirmation before resetting, with a clearly-worded destructive message', async () => {
    render(<DeveloperSettings readOnly />);
    fireEvent.click(screen.getByTestId('dev-endpoints-reset'));

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith({
      title: 'actionConfirmation',
      children: 'devEndpointResetConfirm',
      confirmLabel: 'reset',
      destructive: true
    });
  });

  it('cancelling the confirmation does NOT wipe storage or clear the override', async () => {
    confirm.mockResolvedValueOnce(false);
    render(<DeveloperSettings readOnly />);
    fireEvent.click(screen.getByTestId('dev-endpoints-reset'));

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(clearEndpointOverride).not.toHaveBeenCalled();
    expect(resetStorageDestructive).not.toHaveBeenCalled();
    expect(hapticMedium).not.toHaveBeenCalled();
    expect(runtimeReload).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('confirming the reset wipes storage and the override together (mobile/desktop reload path)', async () => {
    render(<DeveloperSettings readOnly />);
    fireEvent.click(screen.getByTestId('dev-endpoints-reset'));

    await waitFor(() => expect(resetStorageDestructive).toHaveBeenCalledTimes(1));
    expect(hapticMedium).toHaveBeenCalledTimes(1);
    expect(resetStorageDestructive).toHaveBeenCalledWith({ keepEndpointOverride: false });
    expect(clearEndpointOverride).not.toHaveBeenCalled();
    // Non-extension reload goes through `window.location.reload`, which jsdom exposes
    // as a non-configurable getter and so can't be spied on directly (see CLAUDE.md).
    // A clean (non-throwing) completion that never took the extension branch, and
    // never fell back to an in-app navigate, is the observable proxy for that call.
    expect(runtimeReload).not.toHaveBeenCalled();
    expect(mockReloadInPlace).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('confirming the reset on extension reloads via the dynamically-imported webextension-polyfill', async () => {
    mockIsExtension.value = true;
    render(<DeveloperSettings readOnly />);
    fireEvent.click(screen.getByTestId('dev-endpoints-reset'));

    await waitFor(() => expect(runtimeReload).toHaveBeenCalledTimes(1));
    expect(mockReloadInPlace).not.toHaveBeenCalled();
    expect(resetStorageDestructive).toHaveBeenCalledTimes(1);
    expect(resetStorageDestructive).toHaveBeenCalledWith({ keepEndpointOverride: false });
    expect(clearEndpointOverride).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('reloads in place on an extension page that has lost its runtime, which cannot reload the extension', async () => {
    mockIsExtension.value = true;
    mockHasExtensionRuntime.value = false;
    render(<DeveloperSettings readOnly />);
    fireEvent.click(screen.getByTestId('dev-endpoints-reset'));

    await waitFor(() => expect(resetStorageDestructive).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(runtimeReload).not.toHaveBeenCalled();
    expect(mockReloadInPlace).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('dev-endpoints-error')).not.toBeInTheDocument();
  });

  // The key-value clear comes first, so a partial wipe leaves no vault. The delete closes every storage handle;
  // this realm reopens its own at once, and a reload reopens the other realms' handles (and this realm's, when
  // no reopen succeeded) and drops in-memory state, so a caller reports a rejected wipe and then reloads, and
  // reports a reload that cannot start. The reload does not depend on the page staying open at any point: on the
  // extension, where closing the page leaves the service worker running, a caller arms a `pagehide` reload before
  // the wipe and keeps it until its own reload has been attempted, and the extension reloads once either way.
  it('forwards resetDidNotFinish from the actual developer-settings wipe catch', async () => {
    jest.spyOn(console, 'warn').mockImplementation();
    resetStorageDestructive.mockRejectedValueOnce(new Error('private storage detail'));
    render(<DeveloperSettings readOnly />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('dev-endpoints-reset'));
    });

    await waitFor(() => expect(mockReloadInPlace).toHaveBeenCalledTimes(1));
    expect(resetStorageDestructive).toHaveBeenCalledWith({ keepEndpointOverride: false });
    expect(alert.mock.calls).toEqual([
      [{ title: 'error', children: 'resetDidNotFinish', errorId: 'resetDidNotFinish' }]
    ]);
  });

  it('says the reset did not finish, then reloads, when the wipe fails partway', async () => {
    jest.spyOn(console, 'warn').mockImplementation();
    mockIsExtension.value = true;
    resetStorageDestructive.mockRejectedValueOnce(new Error('storage write failed'));
    let closeAlert!: () => void;
    alert.mockReturnValueOnce(new Promise<void>(resolve => (closeAlert = resolve)));
    render(<DeveloperSettings readOnly />);
    fireEvent.click(screen.getByTestId('dev-endpoints-reset'));

    await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
    try {
      expect(alert).toHaveBeenCalledWith({
        title: 'error',
        children: 'resetDidNotFinish',
        errorId: 'resetDidNotFinish'
      });
      // While the alert is open nothing reloads, and the reset stays pending.
      expect(runtimeReload).not.toHaveBeenCalled();
      expect(screen.getByTestId('dev-endpoints-reset')).toHaveAttribute('data-loading', 'true');
    } finally {
      await act(async () => closeAlert());
    }
    await waitFor(() => expect(runtimeReload).toHaveBeenCalledTimes(1));
    expect(alert.mock.invocationCallOrder[0]!).toBeLessThan(runtimeReload.mock.invocationCallOrder[0]!);
    // The inline error is only for a reload that cannot start.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // A loaded module stays cached, so the load before the wipe fails only in a fresh registry. Every reset's load
  // fails until afterEach puts the suite's mock back.
  const failEveryPolyfillLoad = () => {
    jest.resetModules();
    jest.doMock('webextension-polyfill', () => {
      throw new Error('webextension-polyfill failed to load');
    });
  };

  // The popup that hosts this page closes when it loses focus, and nothing after the await it is in runs then,
  // the wipe's or the alert's.
  it('reloads the extension once when the page closes while the wipe runs', async () => {
    mockIsExtension.value = true;
    let finishWipe!: () => void;
    resetStorageDestructive.mockReturnValueOnce(new Promise<void>(resolve => (finishWipe = resolve)));
    render(<DeveloperSettings readOnly />);
    fireEvent.click(screen.getByTestId('dev-endpoints-reset'));

    try {
      await waitFor(() => expect(resetStorageDestructive).toHaveBeenCalledTimes(1));

      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });
      expect(runtimeReload).toHaveBeenCalledTimes(1);
    } finally {
      // A finished reset takes its listener off the window, so none is left for a later test's pagehide.
      finishWipe();
    }
    await waitFor(() => expect(screen.getByTestId('dev-endpoints-reset')).toHaveAttribute('data-loading', 'false'));
    expect(runtimeReload).toHaveBeenCalledTimes(1);
  });

  it('reloads the extension once when the page closes while the did-not-finish alert is open', async () => {
    jest.spyOn(console, 'warn').mockImplementation();
    mockIsExtension.value = true;
    resetStorageDestructive.mockRejectedValueOnce(new Error('storage write failed'));
    let closeAlert!: () => void;
    alert.mockReturnValueOnce(new Promise<void>(resolve => (closeAlert = resolve)));
    render(<DeveloperSettings readOnly />);
    fireEvent.click(screen.getByTestId('dev-endpoints-reset'));
    await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(runtimeReload).toHaveBeenCalledTimes(1);

    closeAlert();
    await waitFor(() => expect(screen.getByTestId('dev-endpoints-reset')).toHaveAttribute('data-loading', 'false'));
    expect(runtimeReload).toHaveBeenCalledTimes(1);
  });

  it('reloads the extension once when the page closes after the did-not-finish alert', async () => {
    jest.spyOn(console, 'warn').mockImplementation();
    mockIsExtension.value = true;
    resetStorageDestructive.mockRejectedValueOnce(new Error('storage write failed'));
    render(<DeveloperSettings readOnly />);
    fireEvent.click(screen.getByTestId('dev-endpoints-reset'));
    await waitFor(() => expect(runtimeReload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('dev-endpoints-reset')).toHaveAttribute('data-loading', 'false'));

    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(runtimeReload).toHaveBeenCalledTimes(1);
  });

  it('retries the extension reload when the one the page close started throws', async () => {
    jest.spyOn(console, 'warn').mockImplementation();
    mockIsExtension.value = true;
    resetStorageDestructive.mockRejectedValueOnce(new Error('storage write failed'));
    runtimeReload.mockImplementationOnce(() => {
      throw new Error('reload failed');
    });
    let closeAlert!: () => void;
    alert.mockReturnValueOnce(new Promise<void>(resolve => (closeAlert = resolve)));
    render(<DeveloperSettings readOnly />);
    fireEvent.click(screen.getByTestId('dev-endpoints-reset'));
    await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));

    // jsdom treats an exception thrown by an event listener as uncaught unless the page handles 'error'.
    const handleError = (event: ErrorEvent) => event.preventDefault();
    window.addEventListener('error', handleError);
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    window.removeEventListener('error', handleError);
    expect(runtimeReload).toHaveBeenCalledTimes(1);

    closeAlert();
    await waitFor(() => expect(runtimeReload).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('dev-endpoints-reset')).toHaveAttribute('data-loading', 'false'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // A fresh registry, so the factory runs at the first load and its call order says when that was.
  it('loads the polyfill before the wipe, then reloads through it', async () => {
    mockIsExtension.value = true;
    const loadPolyfill = jest.fn(() => polyfill);
    jest.resetModules();
    jest.doMock('webextension-polyfill', loadPolyfill);
    render(<DeveloperSettings readOnly />);
    fireEvent.click(screen.getByTestId('dev-endpoints-reset'));

    await waitFor(() => expect(runtimeReload).toHaveBeenCalledTimes(1));
    expect(loadPolyfill.mock.invocationCallOrder[0]!).toBeLessThan(
      resetStorageDestructive.mock.invocationCallOrder[0]!
    );
  });

  it('refuses to wipe when the polyfill cannot load before the wipe', async () => {
    jest.spyOn(console, 'warn').mockImplementation();
    mockIsExtension.value = true;
    failEveryPolyfillLoad();
    render(<DeveloperSettings readOnly />);
    fireEvent.click(screen.getByTestId('dev-endpoints-reset'));

    expect(await screen.findByRole('alert')).toHaveTextContent('resetDidNotFinish');
    await waitFor(() => expect(screen.getByTestId('dev-endpoints-reset')).toHaveAttribute('data-loading', 'false'));
    // Checked once the reset has ended, since straight after the click no wipe has started either way.
    expect(resetStorageDestructive).not.toHaveBeenCalled();
  });

  it('says the reset did not finish when the extension reload cannot be started', async () => {
    jest.spyOn(console, 'warn').mockImplementation();
    mockIsExtension.value = true;
    runtimeReload.mockImplementationOnce(() => {
      throw new Error('reload failed');
    });
    render(<DeveloperSettings readOnly />);
    fireEvent.click(screen.getByTestId('dev-endpoints-reset'));

    expect(await screen.findByRole('alert')).toHaveTextContent('resetDidNotFinish');
    expect(resetStorageDestructive).toHaveBeenCalledTimes(1);
    expect(runtimeReload).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId('dev-endpoints-reset')).toHaveAttribute('data-loading', 'false'));
  });

  it('clears the reset error when a new reset starts', async () => {
    jest.spyOn(console, 'warn').mockImplementation();
    mockIsExtension.value = true;
    runtimeReload.mockImplementationOnce(() => {
      throw new Error('reload failed');
    });
    render(<DeveloperSettings readOnly />);
    fireEvent.click(screen.getByTestId('dev-endpoints-reset'));
    await screen.findByRole('alert');

    // Held in the wipe, so the error is gone before any of the reset has finished.
    let finishWipe!: () => void;
    resetStorageDestructive.mockReturnValueOnce(new Promise<void>(resolve => (finishWipe = resolve)));
    fireEvent.click(screen.getByTestId('dev-endpoints-reset'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(runtimeReload).toHaveBeenCalledTimes(1);

    finishWipe();
    await waitFor(() => expect(runtimeReload).toHaveBeenCalledTimes(2));
  });

  it('ignores a second Reset press while the reset runs', async () => {
    mockIsExtension.value = true;
    let finishWipe!: () => void;
    resetStorageDestructive.mockReturnValueOnce(new Promise<void>(resolve => (finishWipe = resolve)));
    render(<DeveloperSettings readOnly />);
    fireEvent.click(screen.getByTestId('dev-endpoints-reset'));
    await waitFor(() => expect(resetStorageDestructive).toHaveBeenCalledTimes(1));

    // Inside act, so an unguarded press gets as far as its confirm and its wipe before the checks.
    await act(async () => {
      fireEvent.click(screen.getByTestId('dev-endpoints-reset'));
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(resetStorageDestructive).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('dev-endpoints-reset')).toHaveAttribute('data-loading', 'true');

    finishWipe();
    await waitFor(() => expect(runtimeReload).toHaveBeenCalledTimes(1));
  });

  // jsdom's reload never unloads the page, so these end the way a reload that does not unload would.
  it('stops the reset spinner when the mobile/desktop reload does not unload the page', async () => {
    let finishWipe!: () => void;
    resetStorageDestructive.mockReturnValueOnce(new Promise<void>(resolve => (finishWipe = resolve)));
    render(<DeveloperSettings readOnly />);
    fireEvent.click(screen.getByTestId('dev-endpoints-reset'));
    await waitFor(() => expect(screen.getByTestId('dev-endpoints-reset')).toHaveAttribute('data-loading', 'true'));

    finishWipe();
    await waitFor(() => expect(screen.getByTestId('dev-endpoints-reset')).toHaveAttribute('data-loading', 'false'));
    expect(clearEndpointOverride).not.toHaveBeenCalled();
    expect(runtimeReload).not.toHaveBeenCalled();
  });

  it('says the reset did not finish on mobile and desktop too', async () => {
    jest.spyOn(console, 'warn').mockImplementation();
    resetStorageDestructive.mockRejectedValueOnce(new Error('storage write failed'));
    let closeAlert!: () => void;
    alert.mockReturnValueOnce(new Promise<void>(resolve => (closeAlert = resolve)));
    render(<DeveloperSettings readOnly />);
    fireEvent.click(screen.getByTestId('dev-endpoints-reset'));

    await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
    try {
      expect(alert).toHaveBeenCalledWith({
        title: 'error',
        children: 'resetDidNotFinish',
        errorId: 'resetDidNotFinish'
      });
      expect(screen.getByTestId('dev-endpoints-reset')).toHaveAttribute('data-loading', 'true');
    } finally {
      await act(async () => closeAlert());
    }
    await waitFor(() => expect(screen.getByTestId('dev-endpoints-reset')).toHaveAttribute('data-loading', 'false'));
    expect(runtimeReload).not.toHaveBeenCalled();
    // The inline error is only for a reload that cannot start.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('stops the reset spinner when the extension reload does not unload the page', async () => {
    mockIsExtension.value = true;
    let finishWipe!: () => void;
    resetStorageDestructive.mockReturnValueOnce(new Promise<void>(resolve => (finishWipe = resolve)));
    render(<DeveloperSettings readOnly />);
    fireEvent.click(screen.getByTestId('dev-endpoints-reset'));
    await waitFor(() => expect(screen.getByTestId('dev-endpoints-reset')).toHaveAttribute('data-loading', 'true'));

    finishWipe();
    await waitFor(() => expect(runtimeReload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('dev-endpoints-reset')).toHaveAttribute('data-loading', 'false'));
  });

  it('shows a pending health note while a probe is in flight', () => {
    mockHealthStatus.value = 'pending';
    render(<DeveloperSettings />);
    expect(screen.getAllByText('devEndpointChecking').length).toBeGreaterThan(0);
  });

  it('shows a reachable health note once a probe succeeds', () => {
    mockHealthStatus.value = 'reachable';
    render(<DeveloperSettings />);
    expect(screen.getAllByText('devEndpointReachable').length).toBeGreaterThan(0);
  });

  it('shows a no-response health note once a probe fails', () => {
    mockHealthStatus.value = 'error';
    render(<DeveloperSettings />);
    expect(screen.getAllByText('devEndpointNoResponse').length).toBeGreaterThan(0);
  });

  // Both routes are full-screen pages outside the Settings host, so neither inherits its fallback:
  // on a cold open goBack() is a no-op and the chevron has to route instead. Both arms are needed -
  // with only the default one, replacing the ternary with a constant '/' would stay green.
  it('routes to home when the standalone route is opened cold', () => {
    mockHistoryPosition = 0;
    render(<DeveloperSettings />);

    fireEvent.click(screen.getByRole('button', { name: 'back' }));

    expect(mockNavigate).toHaveBeenCalledWith('/', 'replacestate');
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it('routes to the settings root when the read-only sub-page is opened cold', () => {
    mockHistoryPosition = 0;
    render(<DeveloperSettings readOnly />);

    fireEvent.click(screen.getByRole('button', { name: 'back' }));

    expect(mockNavigate).toHaveBeenCalledWith('/me', 'replacestate');
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it('the back affordance calls goBack', () => {
    render(<DeveloperSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'back' }));
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('renders through SubPageLayout: labelled sections, shared fields and the actions pinned in its footer', () => {
    render(<DeveloperSettings />);

    const page = screen.getByTestId('developer-settings');
    const footer = page.querySelector('[data-slot="footer"]')!;
    expect(footer).toContainElement(screen.getByTestId('dev-endpoints-save'));
    expect(footer).toContainElement(screen.getByTestId('dev-endpoints-reset-defaults'));
    expect(screen.getByTestId('dev-endpoints-reset-defaults')).toHaveAttribute('data-variant', 'secondary');
    // The warning is a labelled section with muted copy, not a hand-painted card.
    expect(screen.getByRole('heading', { name: 'developerSettingsWarningTitle' })).toHaveClass('text-muted');
    expect(screen.getByText('developerSettingsWarning')).toHaveClass('text-body', 'text-muted');
    // Every URL is the shared TextField, labelled, at 16px so iOS does not zoom.
    expect(screen.getByLabelText('devEndpointRpc')).toBe(screen.getByTestId('dev-endpoint-rpcUrl'));
    expect(screen.getByTestId('dev-endpoint-rpcUrl')).toHaveClass('text-body');
    // The no-guardian option is a ListRow in a labelled `plain` group.
    const optionGroup = screen.getByTestId('dev-allow-no-guardian').parentElement!;
    expect(optionGroup).toHaveClass('[&>*]:px-0', '[&>*]:before:left-0');
    expect(optionGroup).not.toHaveClass('bg-fill');
    expect(screen.getByRole('heading', { name: 'options' })).toHaveClass('text-title-section', 'text-ink');
  });

  // settings-2.svg's path has no fill and its root says `fill="none"`, so without a fill the glyph
  // draws nothing and the section shows an empty circle.
  it('draws the Options glyph in the text colour', () => {
    render(<DeveloperSettings />);
    const header = screen.getByRole('heading', { name: 'options' }).parentElement!;
    expect(header.querySelector('[data-slot="icon"] svg')).toHaveAttribute('fill', 'currentColor');
  });

  it('makes the read-only reset destructive, since it wipes the wallet', () => {
    render(<DeveloperSettings readOnly />);
    expect(screen.getByTestId('dev-endpoints-reset')).toHaveAttribute('data-variant', 'destructive');
  });

  it('renders no health note while idle', () => {
    render(<DeveloperSettings />);
    expect(screen.queryByText('devEndpointChecking')).not.toBeInTheDocument();
    expect(screen.queryByText('devEndpointReachable')).not.toBeInTheDocument();
    expect(screen.queryByText('devEndpointNoResponse')).not.toBeInTheDocument();
  });
});

describe('DeveloperSettings — allowNoGuardian', () => {
  beforeEach(() => {
    applyEndpointOverride.mockClear();
    mockUseConfirm.mockReturnValue(confirm);
  });

  it('renders the no-guardian toggle row', () => {
    render(<DeveloperSettings />);
    expect(screen.getByTestId('dev-allow-no-guardian')).toBeInTheDocument();
    expect(screen.getByTestId('checkbox')).toHaveAttribute('data-checked', 'false');
  });

  // The indicator is aria-hidden, so the row itself has to carry the state.
  it('reports the no-guardian state on the row', () => {
    render(<DeveloperSettings />);
    const row = screen.getByTestId('dev-allow-no-guardian');
    expect(row).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-pressed', 'true');
  });

  it('persists allowNoGuardian=true when toggled on and saved', async () => {
    render(<DeveloperSettings />);
    fireEvent.click(screen.getByTestId('dev-allow-no-guardian'));
    fireEvent.click(screen.getByTestId('dev-endpoints-save'));
    await waitFor(() => expect(applyEndpointOverride).toHaveBeenCalled());
    expect(applyEndpointOverride).toHaveBeenCalledWith(expect.objectContaining({ allowNoGuardian: true }));
  });

  it('disables the toggle row in read-only mode', () => {
    render(<DeveloperSettings readOnly />);
    expect(screen.getByTestId('dev-allow-no-guardian')).toBeDisabled();
  });
});

describe('DeveloperSettings module evaluation (desktop boot safety)', () => {
  // `webextension-polyfill` throws at module-evaluation time when `chrome.runtime.id`
  // is absent (e.g. on desktop/Tauri, which has no vite alias for it, unlike mobile).
  // `DeveloperSettings` is statically imported by `PageRouter` at module scope, so a
  // top-level `import browser from 'webextension-polyfill'` here would white-screen
  // desktop on every boot. Simulate that throw and prove merely *loading* the module
  // (no rendering, no `isExtension()` branch taken) never reaches it — i.e. the import
  // is confined to the dynamic `await import(...)` inside `handleReset`'s extension branch.
  it('never touches webextension-polyfill while the module is only being loaded, not rendered', () => {
    jest.resetModules();
    jest.doMock('webextension-polyfill', () => {
      throw new Error('webextension-polyfill must not be evaluated at import time');
    });

    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('./DeveloperSettings');
    }).not.toThrow();
  });
});

describe('user-visible error reporting', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it.each(['save', 'reload', 'polyfill'])('reports the %s refusal using its known inline key', async operation => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    if (operation === 'save')
      applyEndpointOverride.mockRejectedValueOnce(new Error('private endpoint https://private.invalid'));
    if (operation === 'reload')
      mockReloadInPlace.mockImplementationOnce(() => {
        throw new Error('private reload');
      });
    if (operation === 'polyfill') {
      mockIsExtension.value = true;
      jest.resetModules();
      jest.doMock('webextension-polyfill', () => {
        throw new Error('private polyfill');
      });
    }
    render(<DeveloperSettings readOnly={operation !== 'save'} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId(operation === 'save' ? 'dev-endpoints-save' : 'dev-endpoints-reset'));
    });
    const id = operation === 'save' ? 'devEndpointSaveFailed' : 'resetDidNotFinish';
    expect(screen.getByTestId('dev-endpoints-error')).toHaveTextContent(id);
    act(() => jest.advanceTimersByTime(999));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([[id, 'inline']]);
    act(() => jest.advanceTimersByTime(1000));
    expect(reportUserVisibleError).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('cancels a save failure report when a new save clears the error', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    applyEndpointOverride.mockRejectedValueOnce(new Error('private endpoint'));
    render(<DeveloperSettings />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('dev-endpoints-save'));
    });
    expect(screen.getByTestId('dev-endpoints-error')).toHaveTextContent('devEndpointSaveFailed');
    act(() => jest.advanceTimersByTime(999));
    applyEndpointOverride.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => {
      fireEvent.click(screen.getByTestId('dev-endpoints-save'));
    });
    expect(screen.queryByTestId('dev-endpoints-error')).not.toBeInTheDocument();
    act(() => jest.advanceTimersByTime(2000));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });

  it.each<HealthStatus>(['idle', 'pending', 'reachable', 'error'])(
    'keeps the developer warning, helper fields and %s health note silent',
    status => {
      mockHealthStatus.value = status;
      render(<DeveloperSettings />);
      expect(screen.getByText('developerSettingsWarning')).toBeInTheDocument();
      act(() => jest.advanceTimersByTime(2000));
      expect(reportUserVisibleError).not.toHaveBeenCalled();
    }
  );
});
