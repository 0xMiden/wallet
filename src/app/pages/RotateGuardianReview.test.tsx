import React from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import RotateGuardianReview from './RotateGuardianReview';

const mockReauthenticate = jest.fn();
const mockInitiateSwitch = jest.fn();
const mockRequestProcessing = jest.fn();
const mockNavigate = jest.fn();
const mockHasHardwareProtector = jest.fn();
const mockIsMobile = jest.fn(() => false);
const mockIsExtension = jest.fn(() => true);
const mockCurrentAccount = {
  publicKey: 'guardian-account',
  name: 'Guardian',
  isPublic: true,
  type: 'guardian',
  hdIndex: 0
};

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('app/hooks/useCurrentGuardianEndpoint', () => ({
  useCurrentGuardianEndpoint: () => ({ endpoint: 'https://old.example', refresh: jest.fn() })
}));

jest.mock('app/layouts/PageLayout', () => ({
  __esModule: true,
  default: ({
    children,
    pageTitle,
    step,
    setStep
  }: {
    children: React.ReactNode;
    pageTitle?: React.ReactNode;
    step?: number;
    setStep?: (step: number) => void;
  }) => (
    <div>
      <div data-testid="page-title">{pageTitle}</div>
      {step ? (
        <button data-testid="auth-back" onClick={() => setStep?.(0)}>
          back
        </button>
      ) : null}
      {children}
    </div>
  )
}));

jest.mock('app/templates/GuardianTransitionHero', () => ({
  GuardianTransitionHero: ({ previousEndpoint, newEndpoint }: { previousEndpoint?: string; newEndpoint?: string }) => (
    <div data-testid="guardian-transition" data-previous={previousEndpoint} data-new={newEndpoint} />
  )
}));

jest.mock('app/atoms/FormField', () => ({
  __esModule: true,
  default: ({
    id,
    value,
    onChange,
    errorCaption
  }: {
    id: string;
    value?: string;
    onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void;
    errorCaption?: React.ReactNode;
  }) => (
    <label>
      <input id={id} value={value} onChange={onChange} />
      {errorCaption ? <span role="alert">{errorCaption}</span> : null}
    </label>
  )
}));

jest.mock('components/Button', () => ({
  Button: ({
    title,
    onClick,
    disabled,
    'data-testid': testId
  }: {
    title?: string;
    onClick?: () => void;
    disabled?: boolean;
    'data-testid'?: string;
  }) => (
    <button data-testid={testId} disabled={disabled} onClick={onClick}>
      {title}
    </button>
  )
}));

jest.mock('components/PasscodeEntry', () => ({
  PasscodeEntry: ({
    onSubmit,
    error,
    isSubmitting
  }: {
    onSubmit: (code: string) => void;
    error?: string | null;
    isSubmitting?: boolean;
  }) => (
    <div data-testid="passcode-entry">
      {error ? <span role="alert">{error}</span> : null}
      <button disabled={isSubmitting} data-testid="passcode-submit" onClick={() => onSubmit('123456')}>
        submit
      </button>
    </div>
  )
}));

jest.mock('components/Alert', () => ({
  Alert: ({ title }: { title: React.ReactNode }) => <div>{title}</div>,
  AlertVariant: { Warning: 'warning' }
}));

jest.mock('lib/ui/DetailCard', () => ({
  DetailCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DetailRow: ({ label, value }: { label: string; value: string }) => (
    <div>
      {label}:{value}
    </div>
  )
}));

jest.mock('lib/biometric', () => ({
  isBiometricEnabled: jest.fn().mockResolvedValue(false),
  checkBiometricAvailability: jest.fn()
}));

jest.mock('lib/miden/activity', () => ({
  initiateSwitchGuardianTransaction: (...args: unknown[]) => mockInitiateSwitch(...args),
  requestSWTransactionProcessing: () => mockRequestProcessing()
}));

jest.mock('lib/miden/back/vault', () => ({
  Vault: { hasHardwareProtector: () => mockHasHardwareProtector() }
}));

jest.mock('lib/miden/front', () => ({
  useMidenContext: () => ({ reauthenticate: (...args: unknown[]) => mockReauthenticate(...args) })
}));

jest.mock('lib/miden/front/guardian-sync', () => ({ zustandProvider: { provider: true } }));

jest.mock('lib/platform', () => ({
  isExtension: () => mockIsExtension(),
  isMobile: () => mockIsMobile()
}));

jest.mock('lib/settings/helpers', () => ({ isDelegateProofEnabled: () => false }));

jest.mock('lib/store', () => ({
  useWalletStore: (selector: (state: { currentAccount: typeof mockCurrentAccount }) => unknown) =>
    selector({ currentAccount: mockCurrentAccount })
}));

jest.mock('lib/woozie', () => ({
  useLocation: () => ({ search: '?endpoint=https%3A%2F%2Fnew.example' }),
  navigate: (...args: unknown[]) => mockNavigate(...args)
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockIsMobile.mockReturnValue(false);
  mockIsExtension.mockReturnValue(true);
  mockHasHardwareProtector.mockResolvedValue(false);
  mockReauthenticate.mockResolvedValue(undefined);
  mockInitiateSwitch.mockResolvedValue('switch-tx');
});

it('renders the current and destination endpoints in the shared transition hero', async () => {
  render(<RotateGuardianReview />);

  const hero = screen.getByTestId('guardian-transition');
  expect(hero).toHaveAttribute('data-previous', 'https://old.example');
  expect(hero).toHaveAttribute('data-new', 'https://new.example');
  await waitFor(() => expect(screen.getByTestId('rotate-guardian-confirm')).toBeEnabled());
});

it('hardware authentication succeeds once and only then queues the switch', async () => {
  mockHasHardwareProtector.mockResolvedValue(true);
  let finishAuthentication: (() => void) | undefined;
  mockReauthenticate.mockImplementation(
    () =>
      new Promise<void>(resolve => {
        finishAuthentication = resolve;
      })
  );
  render(<RotateGuardianReview />);
  const confirm = await screen.findByTestId('rotate-guardian-confirm');
  await waitFor(() => expect(confirm).toBeEnabled());

  fireEvent.click(confirm);
  fireEvent.click(confirm);
  expect(mockReauthenticate).toHaveBeenCalledTimes(1);
  expect(mockReauthenticate).toHaveBeenCalledWith(undefined);
  expect(mockInitiateSwitch).not.toHaveBeenCalled();

  finishAuthentication?.();
  await waitFor(() => expect(mockInitiateSwitch).toHaveBeenCalledTimes(1));
  expect(mockNavigate).toHaveBeenCalledWith('/generating-transaction-full/switch-tx');
});

it('hardware cancellation never queues a switch', async () => {
  mockHasHardwareProtector.mockResolvedValue(true);
  mockReauthenticate.mockRejectedValue(new Error('cancelled'));
  render(<RotateGuardianReview />);
  const confirm = await screen.findByTestId('rotate-guardian-confirm');
  await waitFor(() => expect(confirm).toBeEnabled());

  fireEvent.click(confirm);

  expect(await screen.findByText('cancelled')).toBeInTheDocument();
  expect(mockInitiateSwitch).not.toHaveBeenCalled();
  expect(mockNavigate).not.toHaveBeenCalled();
});

it('password authentication gates the extension flow and retries with fresh authentication', async () => {
  mockReauthenticate.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
  mockInitiateSwitch.mockRejectedValueOnce(new Error('queue failed')).mockResolvedValueOnce('retry-tx');
  render(<RotateGuardianReview />);
  const confirm = await screen.findByTestId('rotate-guardian-confirm');
  await waitFor(() => expect(confirm).toBeEnabled());
  fireEvent.click(confirm);

  const password = document.querySelector<HTMLInputElement>('#rotate-guardian-password');
  if (!password) throw new Error('Password field did not render');
  fireEvent.change(password, { target: { value: 'correct-password' } });
  fireEvent.click(screen.getByTestId('rotate-guardian-auth-submit'));
  expect(await screen.findByText('queue failed')).toBeInTheDocument();
  expect(mockReauthenticate).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByTestId('rotate-guardian-auth-submit'));
  await waitFor(() => expect(mockReauthenticate).toHaveBeenCalledTimes(2));
  expect(mockReauthenticate).toHaveBeenNthCalledWith(2, 'correct-password');
  expect(mockNavigate).toHaveBeenCalledWith('/generating-transaction-full/retry-tx');
});

it('invalid credentials and back navigation leave the Guardian unchanged', async () => {
  mockReauthenticate.mockRejectedValue(new Error('Invalid password'));
  render(<RotateGuardianReview />);
  const confirm = await screen.findByTestId('rotate-guardian-confirm');
  await waitFor(() => expect(confirm).toBeEnabled());
  fireEvent.click(confirm);

  const password = document.querySelector<HTMLInputElement>('#rotate-guardian-password');
  if (!password) throw new Error('Password field did not render');
  fireEvent.change(password, { target: { value: 'wrong' } });
  fireEvent.click(screen.getByTestId('rotate-guardian-auth-submit'));
  expect(await screen.findByText('Invalid password')).toBeInTheDocument();
  expect(mockInitiateSwitch).not.toHaveBeenCalled();

  fireEvent.click(screen.getByTestId('auth-back'));
  expect(await screen.findByTestId('rotate-guardian-confirm')).toBeInTheDocument();
  expect(mockInitiateSwitch).not.toHaveBeenCalled();
});

it('uses PasscodeEntry for mobile credential authentication', async () => {
  mockIsMobile.mockReturnValue(true);
  render(<RotateGuardianReview />);
  const confirm = await screen.findByTestId('rotate-guardian-confirm');
  await waitFor(() => expect(confirm).toBeEnabled());
  fireEvent.click(confirm);

  fireEvent.click(await screen.findByTestId('passcode-submit'));

  await waitFor(() => expect(mockReauthenticate).toHaveBeenCalledWith('123456'));
  expect(mockInitiateSwitch).toHaveBeenCalledTimes(1);
});

it('fails closed when hardware-protector detection fails', async () => {
  mockHasHardwareProtector.mockRejectedValue(new Error('storage failed'));
  render(<RotateGuardianReview />);

  expect(await screen.findByText('guardianAuthenticationUnavailable')).toBeInTheDocument();
  expect(screen.getByTestId('rotate-guardian-confirm')).toBeDisabled();
  expect(mockReauthenticate).not.toHaveBeenCalled();
  expect(mockInitiateSwitch).not.toHaveBeenCalled();
});
