import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import RotateGuardianReview from './RotateGuardianReview';

const mockUnlock = jest.fn();
const mockInitiateSwitch = jest.fn();
const mockRequestProcessing = jest.fn();
const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
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

let mockCurrentEndpoint = 'https://old.example';
let mobileBackHandler: (() => boolean | void) | undefined;

jest.mock('app/hooks/useCurrentGuardianEndpoint', () => ({
  useCurrentGuardianEndpoint: () => ({ endpoint: mockCurrentEndpoint, refresh: jest.fn() })
}));

jest.mock('app/layouts/PageLayout', () => ({
  __esModule: true,
  default: ({
    children,
    pageTitle,
    navigationStyle,
    step,
    setStep
  }: {
    children: React.ReactNode;
    pageTitle?: React.ReactNode;
    navigationStyle?: string;
    step?: number;
    setStep?: (step: number) => void;
  }) => (
    <div data-navigation-style={navigationStyle}>
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

jest.mock('components/GuardianTransitionHero', () => ({
  GuardianTransitionHero: ({
    previousEndpoint,
    newEndpoint,
    variant
  }: {
    previousEndpoint?: string;
    newEndpoint?: string;
    variant?: string;
  }) => (
    <div
      data-testid="guardian-transition"
      data-previous={previousEndpoint}
      data-new={newEndpoint}
      data-variant={variant}
    />
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
  useMidenContext: () => ({ unlock: (...args: unknown[]) => mockUnlock(...args) })
}));

jest.mock('lib/miden/front/guardian-sync', () => ({ zustandProvider: { provider: true } }));

jest.mock('lib/platform', () => ({
  isExtension: () => mockIsExtension(),
  isMobile: () => mockIsMobile()
}));

jest.mock('lib/settings/helpers', () => ({ isDelegateProofEnabled: () => false }));

// Captured rather than executed: on mobile this is the only back affordance on
// the credential step, and the screen hides PageLayout's toolbar, so nothing
// else registers one.
jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: (handler: () => boolean | void) => {
    mobileBackHandler = handler;
  }
}));

jest.mock('lib/store', () => ({
  useWalletStore: (selector: (state: { currentAccount: typeof mockCurrentAccount }) => unknown) =>
    selector({ currentAccount: mockCurrentAccount })
}));

jest.mock('lib/woozie', () => ({
  useLocation: () => ({ search: '?endpoint=https%3A%2F%2Fnew.example', historyPosition: 1 }),
  navigate: (...args: unknown[]) => mockNavigate(...args),
  goBack: () => mockGoBack(),
  HistoryAction: { Push: 'push', Replace: 'replace' }
}));

beforeEach(() => {
  jest.clearAllMocks();
  mobileBackHandler = undefined;
  mockCurrentEndpoint = 'https://old.example';
  mockIsMobile.mockReturnValue(false);
  mockIsExtension.mockReturnValue(true);
  mockHasHardwareProtector.mockResolvedValue(false);
  mockUnlock.mockResolvedValue(undefined);
  mockInitiateSwitch.mockResolvedValue('switch-tx');
});

it('renders the current and destination endpoints in the shared transition hero', async () => {
  render(<RotateGuardianReview />);

  const hero = screen.getByTestId('guardian-transition');
  expect(hero).toHaveAttribute('data-previous', 'https://old.example');
  expect(hero).toHaveAttribute('data-new', 'https://new.example');
  expect(hero).toHaveAttribute('data-variant', 'review');
  // The review screen owns its header now (prominent NavigationHeader) instead
  // of PageLayout's toolbar title.
  expect(screen.getByRole('heading', { name: 'reviewRotation' })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByTestId('rotate-guardian-confirm')).toBeEnabled());
});

it('uses theme-aware text colors for the rotation warning', async () => {
  render(<RotateGuardianReview />);

  expect(screen.getByText('oldGuardianCantBlockTitle')).toHaveClass('text-heading-gray');
  expect(screen.getByText('oldGuardianCantBlockBody')).toHaveClass('text-heading-gray');
  await waitFor(() => expect(screen.getByTestId('rotate-guardian-confirm')).toBeEnabled());
});

it('hardware authentication succeeds once and only then queues the switch', async () => {
  mockHasHardwareProtector.mockResolvedValue(true);
  let finishAuthentication: (() => void) | undefined;
  mockUnlock.mockImplementation(
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
  expect(mockUnlock).toHaveBeenCalledTimes(1);
  expect(mockUnlock).toHaveBeenCalledWith(undefined);
  expect(mockInitiateSwitch).not.toHaveBeenCalled();

  finishAuthentication?.();
  await waitFor(() => expect(mockInitiateSwitch).toHaveBeenCalledTimes(1));
  expect(mockNavigate).toHaveBeenCalledWith('/generating-transaction-full/switch-tx');
});

it('hardware cancellation never queues a switch', async () => {
  mockHasHardwareProtector.mockResolvedValue(true);
  mockUnlock.mockRejectedValue(new Error('cancelled'));
  render(<RotateGuardianReview />);
  const confirm = await screen.findByTestId('rotate-guardian-confirm');
  await waitFor(() => expect(confirm).toBeEnabled());

  fireEvent.click(confirm);

  expect(await screen.findByText('cancelled')).toBeInTheDocument();
  expect(mockInitiateSwitch).not.toHaveBeenCalled();
  expect(mockNavigate).not.toHaveBeenCalled();
});

// Guardian failures carry long unbreakable strings (endpoint URLs, RPC/SDK
// errors, hashes). Without wrap-break-word they overflow the fixed-width extension
// popup and get clipped, hiding the failure reason. Both error sinks must wrap.
const LONG_GUARDIAN_ERROR =
  'GuardianHttpError: https://guardian.example.com/v1/operators/rotate?token=abcdef0123456789abcdef0123456789 failed';

// (The extension password-auth sink — FormField's errorCaption — is covered by
// its own unit test in FormField.test.tsx; this suite mocks FormField, so the
// real errorCaption classes aren't observable here.)
it('wraps the long guardian error on the mobile hardware-auth path so it is not clipped (#454)', async () => {
  // On mobile hasHardwareProtector() is true; the error renders in the review
  // page's own error row (line 207) instead of the auth-step FormField.
  mockHasHardwareProtector.mockResolvedValue(true);
  mockUnlock.mockRejectedValue(new Error(LONG_GUARDIAN_ERROR));
  render(<RotateGuardianReview />);
  const confirm = await screen.findByTestId('rotate-guardian-confirm');
  await waitFor(() => expect(confirm).toBeEnabled());
  fireEvent.click(confirm);

  expect(await screen.findByText(LONG_GUARDIAN_ERROR)).toHaveClass('wrap-break-word');
});

it('password authentication gates the extension flow and retries with fresh authentication', async () => {
  mockUnlock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
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
  expect(mockUnlock).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByTestId('rotate-guardian-auth-submit'));
  await waitFor(() => expect(mockUnlock).toHaveBeenCalledTimes(2));
  expect(mockUnlock).toHaveBeenNthCalledWith(2, 'correct-password');
  expect(mockNavigate).toHaveBeenCalledWith('/generating-transaction-full/retry-tx');
});

it('invalid credentials and back navigation leave the Guardian unchanged', async () => {
  mockUnlock.mockRejectedValue(new Error('Invalid password'));
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

  await waitFor(() => expect(mockUnlock).toHaveBeenCalledWith('123456'));
  expect(mockInitiateSwitch).toHaveBeenCalledTimes(1);
});

// The screen takes its target from the query string, so backing into it after the
// rotation landed asks it to switch to the Guardian that is now already current.
// The picker refuses that; so must this page — and it has to say so BEFORE asking
// for a credential, or the message reads as an auth failure on a step that could
// never have succeeded.
it('refuses a switch to the endpoint that is already current, before asking for anything', async () => {
  mockCurrentEndpoint = 'https://new.example';
  render(<RotateGuardianReview />);
  const confirm = await screen.findByTestId('rotate-guardian-confirm');
  await waitFor(() => expect(confirm).toBeEnabled());

  fireEvent.click(confirm);

  expect(await screen.findByText('guardianEndpointUnchanged')).toBeInTheDocument();
  // No credential step, and nothing queued.
  expect(document.querySelector('#rotate-guardian-password')).toBeNull();
  expect(mockUnlock).not.toHaveBeenCalled();
  expect(mockInitiateSwitch).not.toHaveBeenCalled();
  expect(mockNavigate).not.toHaveBeenCalled();
});

it('still refuses it from the password step, which submits straight past the first check', async () => {
  render(<RotateGuardianReview />);
  const confirm = await screen.findByTestId('rotate-guardian-confirm');
  await waitFor(() => expect(confirm).toBeEnabled());
  fireEvent.click(confirm);

  const password = document.querySelector<HTMLInputElement>('#rotate-guardian-password');
  if (!password) throw new Error('Password field did not render');
  // The rotation lands in another tab while this one sits on the credential step.
  mockCurrentEndpoint = 'https://new.example';
  fireEvent.change(password, { target: { value: 'correct-password' } });
  fireEvent.click(screen.getByTestId('rotate-guardian-auth-submit'));

  expect(await screen.findByText('guardianEndpointUnchanged')).toBeInTheDocument();
  expect(mockUnlock).not.toHaveBeenCalled();
  expect(mockInitiateSwitch).not.toHaveBeenCalled();
});

describe('hardware back', () => {
  it('backs out of the credential step rather than off the screen', async () => {
    render(<RotateGuardianReview />);
    const confirm = await screen.findByTestId('rotate-guardian-confirm');
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    expect(document.querySelector('#rotate-guardian-password')).not.toBeNull();

    // Wrapped: this handler is invoked by the native bridge, outside React's
    // event system, so the state it sets is not batched for us.
    let handled: boolean | void = undefined;
    act(() => {
      handled = mobileBackHandler!();
    });
    expect(handled).toBe(true);

    // Back to review, not out to Settings or the wallet home.
    expect(await screen.findByTestId('rotate-guardian-confirm')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('leaves the review screen for the picker it came from', async () => {
    render(<RotateGuardianReview />);
    await waitFor(() => expect(screen.getByTestId('rotate-guardian-confirm')).toBeEnabled());

    expect(mobileBackHandler!()).toBe(true);

    // It has to actually leave: returning true without navigating swallows the
    // press and traps the user on the screen. historyPosition is 1 in this
    // suite, so the pop is the expected route, not the '/rotate-guardian'
    // fallback.
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('swallows the press while a switch is in flight instead of abandoning it', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    let finishAuthentication: (() => void) | undefined;
    mockUnlock.mockImplementation(() => new Promise<void>(resolve => (finishAuthentication = resolve)));
    render(<RotateGuardianReview />);
    const confirm = await screen.findByTestId('rotate-guardian-confirm');
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);

    // Consumed and inert: navigating away mid-authentication would leave the
    // user with no indication whether the switch was queued.
    expect(mobileBackHandler!()).toBe(true);
    expect(mockNavigate).not.toHaveBeenCalled();

    finishAuthentication?.();
    await waitFor(() => expect(mockInitiateSwitch).toHaveBeenCalledTimes(1));
  });
});

it('keeps Continue out of the scroll region so it cannot land below the fold', async () => {
  const { container } = render(<RotateGuardianReview />);
  const confirm = await screen.findByTestId('rotate-guardian-confirm');

  // The illustration plus the prominent header cost ~220px of a 600px popup, so
  // a CTA inside the scroller sat below the fold — the user had to scroll to
  // find the only way forward, and a failure could render off-screen entirely.
  const scroller = container.querySelector('.flex-1.min-h-0.overflow-y-auto');
  expect(scroller).not.toBeNull();
  expect(scroller!.contains(confirm)).toBe(false);
});

it('ignores the chevron while a switch is in flight, as the hardware handler does', async () => {
  mockHasHardwareProtector.mockResolvedValue(true);
  mockUnlock.mockImplementation(() => new Promise<void>(() => {}));
  render(<RotateGuardianReview />);
  const confirm = await screen.findByTestId('rotate-guardian-confirm');
  await waitFor(() => expect(confirm).toBeEnabled());

  fireEvent.click(confirm);
  fireEvent.click(screen.getByRole('button', { name: 'back' }));

  // Leaving mid-flight would strand an in-flight promise that still redirects to
  // the progress page, and let the user re-enter and queue a second switch.
  expect(mockGoBack).not.toHaveBeenCalled();
  expect(mockNavigate).not.toHaveBeenCalled();
});

it('announces a failure rather than only rendering it above the button', async () => {
  mockHasHardwareProtector.mockResolvedValue(true);
  mockUnlock.mockRejectedValue(new Error('cancelled'));
  render(<RotateGuardianReview />);
  const confirm = await screen.findByTestId('rotate-guardian-confirm');
  await waitFor(() => expect(confirm).toBeEnabled());

  fireEvent.click(confirm);

  // Focus stays on Continue and the button just stops spinning, so without a
  // live region the reason is never conveyed.
  expect(await screen.findByRole('alert')).toHaveTextContent('cancelled');
});

it('fails closed when hardware-protector detection fails', async () => {
  mockHasHardwareProtector.mockRejectedValue(new Error('storage failed'));
  render(<RotateGuardianReview />);

  expect(await screen.findByText('guardianAuthenticationUnavailable')).toBeInTheDocument();
  expect(screen.getByTestId('rotate-guardian-confirm')).toBeDisabled();
  expect(mockUnlock).not.toHaveBeenCalled();
  expect(mockInitiateSwitch).not.toHaveBeenCalled();
});
