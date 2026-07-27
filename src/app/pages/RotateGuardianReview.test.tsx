/**
 * RotateGuardianReview — the confirm screen for a guardian rotation. It reads
 * the target endpoint off the query string, renders current → new operator
 * names, labels the hot key by how it's protected on this device, and on
 * Continue initiates the switch-guardian transaction and hands off to the
 * generating-transaction page. All collaborators are stubbed so only this
 * page's logic runs.
 */

import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import RotateGuardianReview from './RotateGuardianReview';

const mockUseCurrentGuardianEndpoint = jest.fn();
const mockGuardianOptionForEndpoint = jest.fn();
const mockGuardianEndpointHost = jest.fn();
jest.mock('app/hooks/useCurrentGuardianEndpoint', () => ({
  useCurrentGuardianEndpoint: () => mockUseCurrentGuardianEndpoint(),
  guardianOptionForEndpoint: (endpoint: string) => mockGuardianOptionForEndpoint(endpoint),
  guardianEndpointHost: (endpoint: string) => mockGuardianEndpointHost(endpoint)
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('app/layouts/PageLayout', () => ({
  __esModule: true,
  default: ({ pageTitle, children }: { pageTitle?: React.ReactNode; children?: React.ReactNode }) => (
    <div data-testid="page-layout">
      <div data-testid="page-title">{pageTitle}</div>
      {children}
    </div>
  )
}));

jest.mock('app/icons/v2', () => ({
  Icon: () => <span data-testid="icon" />,
  IconName: { ArrowDown: 'arrow-down' }
}));

jest.mock('components/Alert', () => ({
  Alert: ({ title }: { title?: React.ReactNode }) => <div data-testid="alert">{title}</div>,
  AlertVariant: { Warning: 'warning' }
}));

jest.mock('components/Button', () => ({
  Button: ({ title, onClick, disabled }: { title: string; onClick: () => void; disabled?: boolean }) => (
    <button onClick={onClick} disabled={disabled}>
      {title}
    </button>
  )
}));

jest.mock('lib/ui/DetailCard', () => ({
  DetailCard: ({ children }: { children: React.ReactNode }) => <div data-testid="detail-card">{children}</div>,
  DetailRow: ({ label, value }: { label: string; value: string }) => (
    <div data-testid="detail-row" data-label={label}>
      {value}
    </div>
  )
}));

const mockIsBiometricEnabled = jest.fn();
const mockCheckBiometricAvailability = jest.fn();
jest.mock('lib/biometric', () => ({
  isBiometricEnabled: () => mockIsBiometricEnabled(),
  checkBiometricAvailability: () => mockCheckBiometricAvailability()
}));

const mockInitiateSwitch = jest.fn();
const mockRequestSWProcessing = jest.fn();
jest.mock('lib/miden/activity', () => ({
  initiateSwitchGuardianTransaction: (...args: unknown[]) => mockInitiateSwitch(...args),
  requestSWTransactionProcessing: () => mockRequestSWProcessing()
}));

jest.mock('lib/miden/front/guardian-sync', () => ({ zustandProvider: { __provider: true } }));

const mockIsExtension = jest.fn();
jest.mock('lib/platform', () => ({ isExtension: () => mockIsExtension() }));

const mockIsDelegateProofEnabled = jest.fn();
jest.mock('lib/settings/helpers', () => ({ isDelegateProofEnabled: () => mockIsDelegateProofEnabled() }));

const storeState: { currentAccount: { publicKey: string } | null } = { currentAccount: { publicKey: 'pk_1' } };
jest.mock('lib/store', () => ({
  useWalletStore: (selector: (s: typeof storeState) => unknown) => selector(storeState)
}));

const mockNavigate = jest.fn();
const mockSearch = { value: '?endpoint=https%3A%2F%2Fnext.guardian' };
jest.mock('lib/woozie', () => ({
  navigate: (path: string) => mockNavigate(path),
  useLocation: () => ({ search: mockSearch.value })
}));

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  storeState.currentAccount = { publicKey: 'pk_1' };
  mockSearch.value = '?endpoint=https%3A%2F%2Fnext.guardian';
  mockUseCurrentGuardianEndpoint.mockReturnValue({ endpoint: 'https://current.guardian', refresh: jest.fn() });
  mockGuardianOptionForEndpoint.mockImplementation((endpoint: string) =>
    endpoint === 'https://current.guardian' ? { name: 'Current Op' } : { name: 'Next Op' }
  );
  mockGuardianEndpointHost.mockImplementation((endpoint: string) => endpoint);
  mockIsBiometricEnabled.mockResolvedValue(false);
  mockCheckBiometricAvailability.mockResolvedValue({ biometryType: 'none' });
  mockInitiateSwitch.mockResolvedValue('tx-1');
  mockIsExtension.mockReturnValue(false);
  mockIsDelegateProofEnabled.mockReturnValue(false);
});

const clickContinue = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'continue' }));
  });
};

describe('RotateGuardianReview — rendering', () => {
  it('renders the current and target operator names', async () => {
    render(<RotateGuardianReview />);
    await flush();

    expect(screen.getByTestId('page-title')).toHaveTextContent('reviewRotation');
    expect(screen.getByText('Current Op')).toBeInTheDocument();
    expect(screen.getByText('Next Op')).toBeInTheDocument();
  });

  it('falls back to the endpoint host for unmatched (custom) operators', async () => {
    mockGuardianOptionForEndpoint.mockReturnValue(undefined);
    mockGuardianEndpointHost.mockImplementation((endpoint: string) => `host(${endpoint})`);
    render(<RotateGuardianReview />);
    await flush();

    expect(screen.getByText('host(https://current.guardian)')).toBeInTheDocument();
    expect(screen.getByText('host(https://next.guardian)')).toBeInTheDocument();
  });

  it('shows a loading placeholder until the current endpoint resolves', async () => {
    mockUseCurrentGuardianEndpoint.mockReturnValue({ endpoint: '', refresh: jest.fn() });
    mockGuardianOptionForEndpoint.mockImplementation((endpoint: string) =>
      endpoint ? { name: 'Next Op' } : undefined
    );
    mockGuardianEndpointHost.mockImplementation((endpoint: string) => endpoint);
    render(<RotateGuardianReview />);
    await flush();

    expect(screen.getByText('loading')).toBeInTheDocument();
  });

  it('treats a missing endpoint param as empty and disables Continue', async () => {
    mockSearch.value = '';
    render(<RotateGuardianReview />);
    await flush();

    expect(screen.getByRole('button', { name: 'continue' })).toBeDisabled();
  });

  it('disables Continue when there is no current account', async () => {
    storeState.currentAccount = null;
    render(<RotateGuardianReview />);
    await flush();

    expect(screen.getByRole('button', { name: 'continue' })).toBeDisabled();
  });
});

describe('RotateGuardianReview — hot key label', () => {
  const hotKeyValue = () =>
    screen.getAllByTestId('detail-row').find(el => el.getAttribute('data-label') === 'walletKeyHot')?.textContent;

  it('defaults to password when biometrics are off', async () => {
    render(<RotateGuardianReview />);
    await flush();

    expect(hotKeyValue()).toBe('password');
    expect(mockCheckBiometricAvailability).not.toHaveBeenCalled();
  });

  it('labels a face-capable device with Face ID', async () => {
    mockIsBiometricEnabled.mockResolvedValue(true);
    mockCheckBiometricAvailability.mockResolvedValue({ biometryType: 'face' });
    render(<RotateGuardianReview />);

    await waitFor(() => expect(hotKeyValue()).toBe('faceId'));
  });

  it('labels any other enrolled biometric as a fingerprint', async () => {
    mockIsBiometricEnabled.mockResolvedValue(true);
    mockCheckBiometricAvailability.mockResolvedValue({ biometryType: 'touch' });
    render(<RotateGuardianReview />);

    await waitFor(() => expect(hotKeyValue()).toBe('fingerprint'));
  });

  it('keeps the password fallback when availability reports none', async () => {
    mockIsBiometricEnabled.mockResolvedValue(true);
    mockCheckBiometricAvailability.mockResolvedValue({ biometryType: 'none' });
    render(<RotateGuardianReview />);
    await flush();

    expect(hotKeyValue()).toBe('password');
  });

  it('keeps the password fallback when the biometric probe throws', async () => {
    mockIsBiometricEnabled.mockRejectedValue(new Error('no biometric stack'));
    render(<RotateGuardianReview />);
    await flush();

    expect(hotKeyValue()).toBe('password');
  });

  it('does not label after unmount (cancelled probe)', async () => {
    let resolveAvailability: (v: { biometryType: string }) => void = () => {};
    mockIsBiometricEnabled.mockResolvedValue(true);
    mockCheckBiometricAvailability.mockReturnValue(
      new Promise<{ biometryType: string }>(resolve => {
        resolveAvailability = resolve;
      })
    );
    const { unmount } = render(<RotateGuardianReview />);
    unmount();

    await act(async () => {
      resolveAvailability({ biometryType: 'face' });
    });

    // Nothing to assert on the DOM — the guard exists so React doesn't warn on
    // a post-unmount setState; reaching here without a throw is the assertion.
    expect(mockCheckBiometricAvailability).toHaveBeenCalledTimes(1);
  });
});

describe('RotateGuardianReview — submit', () => {
  it('initiates the switch and navigates to the transaction page', async () => {
    render(<RotateGuardianReview />);
    await flush();
    await clickContinue();

    expect(mockInitiateSwitch).toHaveBeenCalledWith('pk_1', 'https://next.guardian', false, { __provider: true });
    expect(mockRequestSWProcessing).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/generating-transaction-full/tx-1');
  });

  it('nudges the service worker on extension builds', async () => {
    mockIsExtension.mockReturnValue(true);
    render(<RotateGuardianReview />);
    await flush();
    await clickContinue();

    expect(mockRequestSWProcessing).toHaveBeenCalledTimes(1);
  });

  it('forwards the delegate-proving preference', async () => {
    mockIsDelegateProofEnabled.mockReturnValue(true);
    render(<RotateGuardianReview />);
    await flush();
    await clickContinue();

    expect(mockInitiateSwitch).toHaveBeenCalledWith('pk_1', 'https://next.guardian', true, { __provider: true });
  });

  it('surfaces an Error rejection and stays on the page', async () => {
    mockInitiateSwitch.mockRejectedValue(new Error('guardian refused'));
    render(<RotateGuardianReview />);
    await flush();
    await clickContinue();

    expect(screen.getByText('guardian refused')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('stringifies a non-Error rejection', async () => {
    mockInitiateSwitch.mockRejectedValue('plain string boom');
    render(<RotateGuardianReview />);
    await flush();
    await clickContinue();

    expect(screen.getByText('plain string boom')).toBeInTheDocument();
  });

  it('shows the loading label and blocks re-entry while a submit is in flight', async () => {
    let resolveInitiate: (v: string) => void = () => {};
    mockInitiateSwitch.mockReturnValue(
      new Promise<string>(resolve => {
        resolveInitiate = resolve;
      })
    );
    render(<RotateGuardianReview />);
    await flush();
    await clickContinue();

    const button = screen.getByRole('button');
    expect(button).toHaveTextContent('loading');
    expect(button).toBeDisabled();

    await act(async () => {
      resolveInitiate('tx-2');
    });

    expect(mockInitiateSwitch).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/generating-transaction-full/tx-2');
  });
});
