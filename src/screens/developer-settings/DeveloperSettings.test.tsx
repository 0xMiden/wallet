import React from 'react';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
jest.mock('lib/woozie', () => ({
  navigate: (p: string) => mockNavigate(p),
  goBack: () => mockGoBack()
}));

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
      networkName: n,
      presetName: n
    })
  };
});

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

  it('read-only mode leaves the Network ID picker inert', () => {
    render(<DeveloperSettings readOnly />);
    const networkPicker = screen.getByTestId('tab-picker');
    fireEvent.click(within(networkPicker).getByTestId('tab-devnet'));

    expect(within(networkPicker).getByTestId('tab-testnet')).toHaveAttribute('data-active', 'true');
    expect(within(networkPicker).getByTestId('tab-devnet')).toHaveAttribute('data-active', 'false');
  });

  it('clicking Reset in read-only mode clears the override, wipes storage, and navigates home', async () => {
    render(<DeveloperSettings readOnly />);
    fireEvent.click(screen.getByTestId('dev-endpoints-reset'));

    await waitFor(() => expect(resetStorageDestructive).toHaveBeenCalledTimes(1));
    expect(hapticMedium).toHaveBeenCalledTimes(1);
    expect(clearEndpointOverride).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/');
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
