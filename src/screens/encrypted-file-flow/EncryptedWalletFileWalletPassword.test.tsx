import React from 'react';

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

import EncryptedWalletFileWalletPassword, {
  EncryptedWalletFileWalletPasswordProps
} from './EncryptedWalletFileWalletPassword';

// ---------------------------------------------------------------------------
// Mutable state the mocks read at call time (must be `mock`-prefixed for jest).
// ---------------------------------------------------------------------------
const mockUnlock = jest.fn();
const mockHasHardwareProtector = jest.fn();
let mockIsMobile = false;
// Backing store for the mocked `useLocalStorage` — seed keys per-test to drive
// the attempt/timelock branches.
let mockStore: Record<string, unknown> = {};

const ATTEMPT_KEY = 'TridentSharedStorageKey.PasswordAttempts';
const TIMELOCK_KEY = 'TridentSharedStorageKey.TimeLock';

// ---------------------------------------------------------------------------
// Module mocks.
// ---------------------------------------------------------------------------
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/platform', () => ({
  isMobile: () => mockIsMobile
}));

jest.mock('lib/miden/back/vault', () => ({
  Vault: { hasHardwareProtector: () => mockHasHardwareProtector() }
}));

jest.mock('lib/miden/front', () => {
  const ReactMod = require('react');
  return {
    useMidenContext: () => ({ unlock: mockUnlock }),
    useLocalStorage: (key: string, initial: unknown) => {
      const [val, setVal] = ReactMod.useState(
        Object.prototype.hasOwnProperty.call(mockStore, key) ? mockStore[key] : initial
      );
      const set = ReactMod.useCallback(
        (v: unknown) => {
          mockStore[key] = v;
          setVal(v);
        },
        [key]
      );
      return [val, set];
    }
  };
});

// A functional Input mock: forwards the props the component drives (type toggles
// with visibility, onChange -> onPasswordChange, onKeyDown -> handleEnterKey,
// disabled -> isDisabled) and renders `icon` so the eye toggle button is clickable.
jest.mock('components/Input', () => ({
  Input: ({
    type,
    value,
    disabled,
    placeholder,
    icon,
    onChange,
    onKeyDown
  }: {
    type?: string;
    value?: string;
    disabled?: boolean;
    placeholder?: string;
    icon?: React.ReactNode;
    onChange?: React.ChangeEventHandler<HTMLInputElement>;
    onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  }) => (
    <div>
      <input
        data-testid="password-input"
        type={type}
        value={value ?? ''}
        disabled={disabled}
        placeholder={placeholder}
        onChange={onChange}
        onKeyDown={onKeyDown}
      />
      {icon}
    </div>
  )
}));

jest.mock('components/Checkbox', () => ({
  Checkbox: ({ value }: { value: boolean }) => <span data-testid="checkbox" data-checked={String(!!value)} />
}));

jest.mock('components/Button', () => ({
  Button: ({
    title,
    onClick,
    disabled,
    isLoading
  }: {
    title?: string;
    onClick?: () => void;
    disabled?: boolean;
    isLoading?: boolean;
  }) => (
    <button data-testid="action-button" onClick={onClick} disabled={disabled} data-loading={String(!!isLoading)}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'Primary', Secondary: 'Secondary' }
}));

jest.mock('components/PasscodeEntry', () => ({
  PasscodeEntry: ({
    onSubmit,
    onChange,
    error,
    disabled,
    isSubmitting
  }: {
    onSubmit: (code: string) => void;
    onChange?: (code: string) => void;
    error?: string | null;
    disabled?: boolean;
    isSubmitting?: boolean;
  }) => (
    <div data-testid="passcode-entry" data-disabled={String(!!disabled)} data-submitting={String(!!isSubmitting)}>
      <span data-testid="passcode-error">{error ?? ''}</span>
      <button data-testid="passcode-change" onClick={() => onChange?.('12')}>
        change
      </button>
      <button data-testid="passcode-submit" disabled={disabled} onClick={() => onSubmit('123456')}>
        submit
      </button>
    </div>
  )
}));

jest.mock('app/atoms/Alert', () => ({
  __esModule: true,
  default: ({ title, description }: { title?: React.ReactNode; description?: React.ReactNode }) => (
    <div data-testid="alert" role="alert">
      <span data-testid="alert-title">{title}</span>
      <span data-testid="alert-desc">{description}</span>
    </div>
  )
}));

jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid="icon" data-name={name} />,
  IconName: { Eye: 'Eye', EyeOff: 'EyeOff' }
}));

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------
const makeProps = (
  overrides: Partial<EncryptedWalletFileWalletPasswordProps> = {}
): EncryptedWalletFileWalletPasswordProps => ({
  onGoNext: jest.fn(),
  onGoBack: jest.fn(),
  onPasswordChange: jest.fn(),
  walletPassword: undefined,
  ...overrides
});

// Renders and flushes the async `Vault.hasHardwareProtector()` promise so the
// body mounts (the component renders null until it resolves).
const renderComp = async (props: EncryptedWalletFileWalletPasswordProps) => {
  const utils = render(<EncryptedWalletFileWalletPassword {...props} />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return utils;
};

const clickConfirm = () => {
  fireEvent.click(screen.getByTestId('checkbox').closest('button')!);
};

describe('EncryptedWalletFileWalletPassword', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStore = {};
    mockIsMobile = false;
    mockHasHardwareProtector.mockResolvedValue(false);
    mockUnlock.mockResolvedValue(undefined);
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders nothing while the hardware-protector check is pending', () => {
    // Never-resolving promise keeps hasHardwareProtector === null.
    mockHasHardwareProtector.mockReturnValue(new Promise(() => {}));
    const { container } = render(<EncryptedWalletFileWalletPassword {...makeProps()} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the software-unlock UI (password field + continue) with no hardware protector', async () => {
    await renderComp(makeProps({ walletPassword: 'pw' }));
    expect(screen.getByTestId('password-input')).toBeInTheDocument();
    expect(screen.getByTestId('action-button')).toHaveTextContent('continue');
    expect(screen.getByText('encryptedWalletFileDescription')).toBeInTheDocument();
    // Software field defaults to a masked password input.
    expect(screen.getByTestId('password-input')).toHaveAttribute('type', 'password');
  });

  it('renders the hardware-unlock UI (unlock button, no password field)', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    await renderComp(makeProps());
    expect(screen.queryByTestId('password-input')).not.toBeInTheDocument();
    const button = screen.getByTestId('action-button');
    expect(button).toHaveTextContent('unlock');
    // continueEnabled = confirmed && !isSubmitting -> disabled before confirming.
    expect(button).toBeDisabled();
    expect(screen.getByText('encryptedWalletFileDescriptionHardware')).toBeInTheDocument();
  });

  it('toggles password visibility via the eye button', async () => {
    await renderComp(makeProps({ walletPassword: 'pw' }));
    const input = screen.getByTestId('password-input');
    expect(input).toHaveAttribute('type', 'password');
    expect(screen.getByTestId('icon')).toHaveAttribute('data-name', 'Eye');

    fireEvent.click(screen.getByTestId('icon').closest('button')!);
    expect(screen.getByTestId('password-input')).toHaveAttribute('type', 'text');
    expect(screen.getByTestId('icon')).toHaveAttribute('data-name', 'EyeOff');

    fireEvent.click(screen.getByTestId('icon').closest('button')!);
    expect(screen.getByTestId('password-input')).toHaveAttribute('type', 'password');
  });

  it('forwards password edits through onPasswordChange', async () => {
    const onPasswordChange = jest.fn();
    await renderComp(makeProps({ walletPassword: '', onPasswordChange }));
    fireEvent.change(screen.getByTestId('password-input'), { target: { value: 'abc' } });
    expect(onPasswordChange).toHaveBeenCalledWith('abc');
  });

  it('enables continue only after confirming and disables it without a password', async () => {
    await renderComp(makeProps({ walletPassword: undefined }));
    const button = screen.getByTestId('action-button');
    // confirmed=false -> disabled.
    expect(button).toBeDisabled();

    clickConfirm();
    expect(screen.getByTestId('checkbox')).toHaveAttribute('data-checked', 'true');
    // confirmed=true but walletPassword is empty -> still disabled (!!walletPassword branch).
    expect(button).toBeDisabled();
  });

  it('unlocks with the wallet password and advances on success (software path)', async () => {
    const onGoNext = jest.fn();
    await renderComp(makeProps({ walletPassword: 'pw', onGoNext }));
    clickConfirm();
    expect(screen.getByTestId('action-button')).toBeEnabled();

    fireEvent.click(screen.getByTestId('action-button'));

    await waitFor(() => expect(onGoNext).toHaveBeenCalledTimes(1));
    expect(mockUnlock).toHaveBeenCalledWith('pw');
    // Successful unlock resets the attempt counter to 1.
    expect(mockStore[ATTEMPT_KEY]).toBe(1);
  });

  it('shows an inline error and does not advance on a failed software unlock', async () => {
    const onGoNext = jest.fn();
    mockUnlock.mockRejectedValue(new Error('bad-pass'));
    await renderComp(makeProps({ walletPassword: 'pw', onGoNext }));
    clickConfirm();
    fireEvent.click(screen.getByTestId('action-button'));

    await waitFor(() => expect(screen.getByText('bad-pass')).toBeInTheDocument());
    expect(onGoNext).not.toHaveBeenCalled();
    // attempt started at 1 (< LAST_ATTEMPT) -> incremented, no time-lock set.
    expect(mockStore[ATTEMPT_KEY]).toBe(2);
    expect(mockStore[TIMELOCK_KEY]).toBeUndefined();
  });

  it('engages the time-lock delay after reaching the last attempt', async () => {
    mockStore[ATTEMPT_KEY] = 3; // LAST_ATTEMPT
    mockUnlock.mockRejectedValue(new Error('bad-pass'));
    await renderComp(makeProps({ walletPassword: 'pw' }));
    clickConfirm();
    fireEvent.click(screen.getByTestId('action-button'));

    // attempt (3) >= LAST_ATTEMPT -> setTimeLock(now) + attempt incremented to 4.
    await waitFor(() => expect(mockStore[TIMELOCK_KEY]).toEqual(expect.any(Number)));
    expect(mockStore[ATTEMPT_KEY]).toBe(4);
    // The lock renders the delay alert and disables the input.
    await waitFor(() => expect(screen.getByText(/unlockPasswordErrorDelay/)).toBeInTheDocument());
    expect(screen.getByTestId('password-input')).toBeDisabled();
  });

  it('applies the extra human delay once past the last attempt on success', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0); // -> 1000ms delay branch
    mockStore[ATTEMPT_KEY] = 4; // > LAST_ATTEMPT
    const onGoNext = jest.fn();
    await renderComp(makeProps({ walletPassword: 'pw', onGoNext }));
    clickConfirm();
    fireEvent.click(screen.getByTestId('action-button'));

    await waitFor(() => expect(onGoNext).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(mockUnlock).toHaveBeenCalledWith('pw');
    expect(mockStore[ATTEMPT_KEY]).toBe(1);
  });

  it('unlocks without a password on the hardware path', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    const onGoNext = jest.fn();
    await renderComp(makeProps({ onGoNext }));
    clickConfirm();
    fireEvent.click(screen.getByTestId('action-button'));

    await waitFor(() => expect(onGoNext).toHaveBeenCalledTimes(1));
    expect(mockUnlock).toHaveBeenCalledWith(undefined);
  });

  it('surfaces a hardware-unlock failure in the alert', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    mockUnlock.mockRejectedValue(new Error('hw-fail'));
    await renderComp(makeProps());
    clickConfirm();
    fireEvent.click(screen.getByTestId('action-button'));

    await waitFor(() => expect(screen.getByTestId('alert-desc')).toHaveTextContent('hw-fail'));
    // Hardware failures skip the attempt/time-lock accounting.
    expect(mockStore[ATTEMPT_KEY]).toBeUndefined();
    expect(mockStore[TIMELOCK_KEY]).toBeUndefined();
  });

  it('falls back to an empty alert description when the hardware error has no message', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    mockUnlock.mockRejectedValue(new Error('')); // message '' -> `|| ''` fallback
    await renderComp(makeProps());
    clickConfirm();
    fireEvent.click(screen.getByTestId('action-button'));

    await waitFor(() => expect(screen.getByTestId('alert-title')).toHaveTextContent('error'));
    expect(screen.getByTestId('alert-desc')).toHaveTextContent('');
  });

  it('forwards a failed passcode unlock error into the numpad', async () => {
    mockIsMobile = true;
    mockUnlock.mockRejectedValue(new Error('pc-fail'));
    await renderComp(makeProps());
    clickConfirm();
    fireEvent.click(screen.getByTestId('passcode-submit'));

    await waitFor(() => expect(screen.getByTestId('passcode-error')).toHaveTextContent('pc-fail'));
    expect(mockUnlock).toHaveBeenCalledWith('123456');
  });

  it('uses the passcode numpad on mobile without a hardware protector', async () => {
    mockIsMobile = true;
    const onGoNext = jest.fn();
    const onPasswordChange = jest.fn();
    await renderComp(makeProps({ onGoNext, onPasswordChange }));

    expect(screen.queryByTestId('password-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('action-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('passcode-entry')).toBeInTheDocument();

    clickConfirm();
    expect(screen.getByTestId('passcode-submit')).toBeEnabled();

    fireEvent.click(screen.getByTestId('passcode-change'));
    expect(onPasswordChange).toHaveBeenCalledWith('12');

    fireEvent.click(screen.getByTestId('passcode-submit'));
    await waitFor(() => expect(onGoNext).toHaveBeenCalledTimes(1));
    expect(mockUnlock).toHaveBeenCalledWith('123456');
  });

  it('disables the passcode numpad until the confirmation is checked', async () => {
    mockIsMobile = true;
    await renderComp(makeProps());
    expect(screen.getByTestId('passcode-entry')).toHaveAttribute('data-disabled', 'true');
    expect(screen.getByTestId('passcode-submit')).toBeDisabled();
  });

  it('submits on Enter only when confirmed and ignores other keys', async () => {
    const onGoNext = jest.fn();
    await renderComp(makeProps({ walletPassword: 'pw', onGoNext }));
    const input = screen.getByTestId('password-input');

    // Not confirmed -> Enter is a no-op.
    fireEvent.keyDown(input, { key: 'Enter' });
    // Non-Enter key -> no-op even when confirmed.
    clickConfirm();
    fireEvent.keyDown(input, { key: 'a' });
    expect(mockUnlock).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onGoNext).toHaveBeenCalledTimes(1));
    expect(mockUnlock).toHaveBeenCalledWith('pw');
  });

  it('guards against a concurrent second submit while one is in flight', async () => {
    let resolveUnlock: () => void = () => {};
    mockUnlock.mockImplementation(() => new Promise<void>(res => (resolveUnlock = res)));
    const onGoNext = jest.fn();
    await renderComp(makeProps({ walletPassword: 'pw', onGoNext }));
    clickConfirm();

    fireEvent.click(screen.getByTestId('action-button'));
    // isSubmitting -> button reports loading/disabled.
    await waitFor(() => expect(screen.getByTestId('action-button')).toHaveAttribute('data-loading', 'true'));

    // Second submit via Enter is swallowed by the isSubmitting guard.
    fireEvent.keyDown(screen.getByTestId('password-input'), { key: 'Enter' });
    expect(mockUnlock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveUnlock();
      await Promise.resolve();
    });
    await waitFor(() => expect(onGoNext).toHaveBeenCalledTimes(1));
    expect(mockUnlock).toHaveBeenCalledTimes(1);
  });

  it('renders the time-lock delay countdown when locked out', async () => {
    // High attempt count -> lockLevel = 11 minutes; timelock = now -> isDisabled.
    mockStore[ATTEMPT_KEY] = 33;
    mockStore[TIMELOCK_KEY] = Date.now();
    await renderComp(makeProps({ walletPassword: 'pw' }));

    const desc = screen.getByTestId('alert-desc');
    expect(desc).toHaveTextContent('unlockPasswordErrorDelay');
    // ~11 minutes exercises checkTime's >= 10 branch (two-digit minutes),
    // regardless of the few ms of jitter between seeding and rendering.
    expect(desc.textContent).toMatch(/1[01]:\d{2}/);
    expect(screen.getByTestId('password-input')).toBeDisabled();
    expect(screen.getByTestId('action-button')).toBeDisabled();
  });
});
