import React from 'react';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { useConfirm } from 'lib/ui/dialog';

import DeveloperSettings from './DeveloperSettings';

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
  hapticMedium: () => hapticMedium()
}));

// `isExtension` gates which reload path handleReset takes; a mutable flag lets
// tests drive both branches.
const mockIsExtension = { value: false };
jest.mock('lib/platform', () => ({
  isExtension: () => mockIsExtension.value
}));

// `browser.runtime.reload` (extension reload path) — spy-able, unlike
// `window.location.reload`, which jsdom exposes as a non-configurable getter
// (see CLAUDE.md testing gotchas) and so can't be mocked/asserted on directly.
const runtimeReload = jest.fn();
jest.mock('webextension-polyfill', () => ({
  __esModule: true,
  default: { runtime: { reload: () => runtimeReload() } }
}));

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
jest.mock('lib/woozie', () => ({
  navigate: (p: string) => mockNavigate(p),
  goBack: () => mockGoBack()
}));

// The destructive reset is gated behind the app's standard confirm dialog
// (same `useConfirm()` hook `options.tsx`'s "Reset Wallet" uses) — mocked the
// same way `AddressBook.test.tsx`/`DAppSettings.test.tsx` mock it, so the
// resolved value drives whether the wipe proceeds.
jest.mock('lib/ui/dialog', () => ({
  useConfirm: jest.fn()
}));
const mockUseConfirm = useConfirm as jest.Mock;
const confirm = jest.fn();

const applyEndpointOverride = jest.fn().mockResolvedValue(undefined);
const clearEndpointOverride = jest.fn().mockResolvedValue(undefined);
jest.mock('lib/miden-chain/effective-endpoints', () => {
  const { MIDEN_NETWORK_NAME } = jest.requireActual('lib/miden-chain/constants');
  return {
    getActiveOverride: () => null,
    applyEndpointOverride: (o: unknown) => applyEndpointOverride(o),
    clearEndpointOverride: () => clearEndpointOverride(),
    getEffectiveNetworkName: () => MIDEN_NETWORK_NAME.TESTNET,
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
      presetName: n
    })
  };
});

jest.mock('components/Checkbox', () => ({
  Checkbox: ({ value }: { value: boolean }) => <span data-testid="checkbox" data-checked={String(value)} />
}));

type HealthStatus = 'idle' | 'pending' | 'reachable' | 'error';
const mockHealthStatus: { value: HealthStatus } = { value: 'idle' };
jest.mock('lib/miden-chain/endpoint-health', () => ({
  useEndpointHealth: () => mockHealthStatus.value
}));

const resetStorageDestructive = jest.fn().mockResolvedValue(undefined);
jest.mock('lib/miden/reset', () => ({
  resetStorageDestructive: () => resetStorageDestructive()
}));

// House components — replace with lightweight stand-ins that forward the
// props DeveloperSettings actually passes, so testids/values stay assertable
// without pulling in framer-motion / icon assets.
jest.mock('components/ScreenHeader', () => ({
  ScreenHeader: ({
    title,
    onBack,
    backLabel
  }: {
    title?: React.ReactNode;
    onBack?: () => void;
    backLabel?: string;
  }) => (
    <div data-testid="screen-header">
      <span>{title}</span>
      <button type="button" aria-label={backLabel} onClick={onBack}>
        back
      </button>
    </div>
  )
}));

jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' },
  Button: ({
    title,
    onClick,
    isLoading,
    disabled,
    'data-testid': testId
  }: {
    title?: string;
    onClick?: () => void;
    isLoading?: boolean;
    disabled?: boolean;
    'data-testid'?: string;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled} data-loading={String(!!isLoading)} data-testid={testId}>
      {title}
    </button>
  )
}));

jest.mock('components/Input', () => ({
  Input: ({
    label,
    value,
    onChange,
    disabled,
    'data-testid': testId
  }: {
    label?: string;
    value?: string;
    onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
    disabled?: boolean;
    'data-testid'?: string;
  }) => (
    <label>
      {label}
      <input data-testid={testId} value={value} disabled={disabled} onChange={onChange} readOnly={!onChange} />
    </label>
  )
}));

jest.mock('components/TabPicker', () => ({
  TabPicker: ({
    tabs,
    onTabChange
  }: {
    tabs: { id: string; title: string; active?: boolean }[];
    onTabChange?: (index: number) => void;
  }) => (
    <div data-testid="tab-picker">
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          type="button"
          data-testid={`tab-${tab.id}`}
          data-active={String(!!tab.active)}
          onClick={() => onTabChange?.(index)}
        >
          {tab.title}
        </button>
      ))}
    </div>
  )
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockHealthStatus.value = 'idle';
  mockIsExtension.value = false;
  confirm.mockResolvedValue(true);
  mockUseConfirm.mockReturnValue(confirm);
});

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

  it('read-only mode disables inputs and shows the reset action', () => {
    render(<DeveloperSettings readOnly />);
    expect(screen.getByTestId('dev-endpoint-rpcUrl')).toBeDisabled();
    expect(screen.getByTestId('dev-endpoints-reset')).toBeInTheDocument();
    expect(screen.queryByTestId('dev-endpoints-save')).not.toBeInTheDocument();
  });

  it('switching to a different preset prefills the fields and marks it active', () => {
    render(<DeveloperSettings />);
    const presetPicker = screen.getAllByTestId('tab-picker')[0]!;
    fireEvent.click(within(presetPicker).getByTestId('tab-devnet'));

    expect(screen.getByTestId('dev-endpoint-rpcUrl')).toHaveValue('https://rpc.devnet');
    expect(within(presetPicker).getByTestId('tab-devnet')).toHaveAttribute('data-active', 'true');
    expect(within(presetPicker).getByTestId('tab-testnet')).toHaveAttribute('data-active', 'false');
  });

  it('editing a field value flips the preset picker to custom', () => {
    render(<DeveloperSettings />);
    fireEvent.change(screen.getByTestId('dev-endpoint-rpcUrl'), { target: { value: 'https://custom.example' } });

    expect(screen.getByTestId('dev-endpoint-rpcUrl')).toHaveValue('https://custom.example');
    const presetPicker = screen.getAllByTestId('tab-picker')[0]!;
    expect(within(presetPicker).getByTestId('tab-custom')).toHaveAttribute('data-active', 'true');
  });

  it('selecting the Custom preset tab directly marks it active without touching field values', () => {
    render(<DeveloperSettings />);
    const presetPicker = screen.getAllByTestId('tab-picker')[0]!;
    fireEvent.click(within(presetPicker).getByTestId('tab-custom'));

    expect(within(presetPicker).getByTestId('tab-custom')).toHaveAttribute('data-active', 'true');
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
    const [presetPicker, networkPicker] = screen.getAllByTestId('tab-picker');
    fireEvent.click(within(networkPicker!).getByTestId('tab-localnet'));

    expect(within(networkPicker!).getByTestId('tab-localnet')).toHaveAttribute('data-active', 'true');
    expect(within(presetPicker!).getByTestId('tab-custom')).toHaveAttribute('data-active', 'true');
  });

  it('offers Mainnet on the Network ID picker but not on the preset/URL-prefill picker', () => {
    render(<DeveloperSettings />);
    const [presetPicker, networkPicker] = screen.getAllByTestId('tab-picker');

    expect(within(networkPicker!).getByTestId('tab-mainnet')).toBeInTheDocument();
    expect(within(presetPicker!).queryByTestId('tab-mainnet')).not.toBeInTheDocument();
  });

  it('capitalizes the preset and network-id tab labels for display, keeping the raw id for logic', () => {
    render(<DeveloperSettings />);
    const [presetPicker, networkPicker] = screen.getAllByTestId('tab-picker');

    expect(within(presetPicker!).getByTestId('tab-testnet')).toHaveTextContent('Testnet');
    expect(within(presetPicker!).getByTestId('tab-devnet')).toHaveTextContent('Devnet');
    expect(within(presetPicker!).getByTestId('tab-localnet')).toHaveTextContent('Localnet');
    expect(within(presetPicker!).getByTestId('tab-custom')).toHaveTextContent('devEndpointCustom');

    expect(within(networkPicker!).getByTestId('tab-mainnet')).toHaveTextContent('Mainnet');
    expect(within(networkPicker!).getByTestId('tab-testnet')).toHaveTextContent('Testnet');
  });

  it('read-only mode leaves the Network ID picker inert', () => {
    render(<DeveloperSettings readOnly />);
    const networkPicker = screen.getByTestId('tab-picker');
    fireEvent.click(within(networkPicker).getByTestId('tab-devnet'));

    expect(within(networkPicker).getByTestId('tab-testnet')).toHaveAttribute('data-active', 'true');
    expect(within(networkPicker).getByTestId('tab-devnet')).toHaveAttribute('data-active', 'false');
  });

  it('asks for confirmation before resetting, with a clearly-worded destructive message', async () => {
    render(<DeveloperSettings readOnly />);
    fireEvent.click(screen.getByTestId('dev-endpoints-reset'));

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith({
      title: 'actionConfirmation',
      children: 'devEndpointResetConfirm'
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

  it('confirming the reset clears the override and wipes storage (mobile/desktop reload path)', async () => {
    render(<DeveloperSettings readOnly />);
    fireEvent.click(screen.getByTestId('dev-endpoints-reset'));

    await waitFor(() => expect(resetStorageDestructive).toHaveBeenCalledTimes(1));
    expect(hapticMedium).toHaveBeenCalledTimes(1);
    expect(clearEndpointOverride).toHaveBeenCalledTimes(1);
    // Non-extension reload goes through `window.location.reload`, which jsdom exposes
    // as a non-configurable getter and so can't be spied on directly (see CLAUDE.md).
    // A clean (non-throwing) completion that never took the extension branch, and
    // never fell back to an in-app navigate, is the observable proxy for that call.
    expect(runtimeReload).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('confirming the reset on extension reloads via the dynamically-imported webextension-polyfill', async () => {
    mockIsExtension.value = true;
    render(<DeveloperSettings readOnly />);
    fireEvent.click(screen.getByTestId('dev-endpoints-reset'));

    await waitFor(() => expect(runtimeReload).toHaveBeenCalledTimes(1));
    expect(clearEndpointOverride).toHaveBeenCalledTimes(1);
    expect(resetStorageDestructive).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
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

  it('the back affordance calls goBack', () => {
    render(<DeveloperSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'back' }));
    expect(mockGoBack).toHaveBeenCalledTimes(1);
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
