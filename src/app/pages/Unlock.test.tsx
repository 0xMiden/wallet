import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import Unlock from './Unlock';

// ---------------------------------------------------------------------------
// Mutable platform / env state (mock-prefixed so jest's hoisted factories may
// reference them). Arrow getters below read these lazily at call time, so each
// test can flip the platform before rendering.
// ---------------------------------------------------------------------------
let mockIsExtension = false;
let mockIsDesktop = false;
let mockIsMobile = false;
let mockCompact = false;

// Backing store for the stateful `useLocalStorage` stub. Seed it per-test to
// drive `attempt` / `timelock`; reset to `{}` in beforeEach for defaults.
let mockLsStore: Record<string, unknown> = {};

const mockUnlock = jest.fn();
const mockNavigate = jest.fn();
const mockOpenInFullPage = jest.fn();
const mockBioHasKey = jest.fn();
const mockDesktopHasKey = jest.fn();
const mockHasPasswordProtector = jest.fn();
// Identity translator: assertions match raw i18n keys.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/platform', () => ({
  isExtension: () => mockIsExtension,
  isDesktop: () => mockIsDesktop,
  isMobile: () => mockIsMobile
}));

jest.mock('lib/woozie', () => ({
  navigate: (...args: unknown[]) => mockNavigate(...args)
}));

jest.mock('app/env', () => ({
  openInFullPage: (...args: unknown[]) => mockOpenInFullPage(...args),
  useAppEnv: () => ({ compact: mockCompact })
}));

jest.mock('lib/miden/types', () => ({
  MidenSharedStorageKey: {
    DAppEnabled: 'DAppEnabled',
    PasswordAttempts: 'PasswordAttempts',
    TimeLock: 'TimeLock'
  }
}));

// Stateful useLocalStorage: real React state seeded from `mockLsStore`, with a
// stable setter (so the memoized callbacks in Unlock keep referential
// identity). `useMidenContext` hands back the shared unlock spy.
jest.mock('lib/miden/front', () => {
  const R = require('react');
  return {
    __esModule: true,
    useMidenContext: () => ({ unlock: mockUnlock }),
    useLocalStorage: (key: string, initial: unknown) => {
      const [value, setValue] = R.useState(
        Object.prototype.hasOwnProperty.call(mockLsStore, key) ? mockLsStore[key] : initial
      );
      const setter = R.useCallback(
        (next: unknown) => {
          setValue((prev: unknown) => {
            const resolved = typeof next === 'function' ? (next as (p: unknown) => unknown)(prev) : next;
            mockLsStore[key] = resolved;
            return resolved;
          });
        },
        [key]
      );
      return [value, setter];
    }
  };
});

// Dynamic-import targets exercised by the mount hardware-unlock effect.
const mockBiometryType = jest.fn(() => Promise.resolve({ biometryType: 'face' }));
jest.mock('lib/biometric', () => ({
  hasHardwareKey: () => mockBioHasKey(),
  checkBiometricAvailability: () => mockBiometryType()
}));
jest.mock('lib/desktop/secure-storage', () => ({ hasHardwareKey: () => mockDesktopHasKey() }));
jest.mock('lib/miden/back/vault', () => ({
  Vault: { hasPasswordProtector: () => mockHasPasswordProtector() }
}));

// Presentational children stubbed to probes so coverage stays scoped to
// Unlock.tsx's own wiring.
jest.mock('app/layouts/SimplePageLayout', () => ({
  __esModule: true,
  default: ({ icon, children }: { icon?: React.ReactNode; children?: React.ReactNode }) => (
    <div data-testid="simple-layout">
      {icon}
      {children}
    </div>
  )
}));

jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid="icon" data-name={name} />,
  IconName: { Eye: 'Eye', EyeOff: 'EyeOff' }
}));

jest.mock('components/Button', () => ({
  __esModule: true,
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' },
  Button: ({
    id,
    title,
    onClick,
    type,
    disabled,
    isLoading,
    className
  }: {
    id?: string;
    title?: string;
    onClick?: () => void;
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
    isLoading?: boolean;
    className?: string;
  }) => (
    <button
      id={id}
      type={type ?? 'button'}
      onClick={onClick}
      disabled={disabled}
      data-loading={isLoading ? 'true' : 'false'}
      className={className}
    >
      {title}
    </button>
  )
}));

jest.mock('components/Input', () => ({
  Input: ({
    id,
    type,
    value,
    onChange,
    disabled,
    placeholder,
    label,
    icon
  }: {
    id?: string;
    type?: string;
    value?: string;
    onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
    disabled?: boolean;
    placeholder?: string;
    label?: string;
    icon?: React.ReactNode;
  }) => (
    <div>
      <label htmlFor={id}>{label}</label>
      <input id={id} type={type} value={value} placeholder={placeholder} disabled={disabled} onChange={onChange} />
      <span data-testid="input-icon">{icon}</span>
    </div>
  )
}));

jest.mock('components/Numpad', () => ({
  // Both refusal props are forwarded onto the keys, as the real component does: a stub that dropped
  // them would make every assertion about a refused press a statement about the stub. The two are
  // separate because a lockout refuses entry while the biometric key stays usable.
  Numpad: ({
    onDigit,
    onDelete,
    onBiometric,
    biometryType,
    disabled,
    biometricDisabled
  }: {
    onDigit: (d: string) => void;
    onDelete: () => void;
    onBiometric?: () => void;
    biometryType?: string;
    disabled?: boolean;
    biometricDisabled?: boolean;
  }) => (
    <div data-testid="numpad">
      {onBiometric && (
        <button
          type="button"
          data-testid="numpad-biometric"
          data-biometry={biometryType}
          disabled={biometricDisabled}
          onClick={onBiometric}
        >
          bio
        </button>
      )}
      {['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].map(d => (
        <button key={d} type="button" data-testid={`digit-${d}`} disabled={disabled} onClick={() => onDigit(d)}>
          {d}
        </button>
      ))}
      <button type="button" data-testid="numpad-delete" disabled={disabled} onClick={onDelete}>
        del
      </button>
    </div>
  )
}));

const BASE = new Date('2026-06-01T00:00:00.000Z').getTime();

let logSpy: jest.SpyInstance;

async function flushMicro() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

// Render + settle the async mount effect (dynamic imports resolve as microtasks).
async function renderUnlock(props: { openForgotPasswordInFullPage?: boolean } = {}) {
  const utils = render(<Unlock {...props} />);
  await flushMicro();
  return utils;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(BASE);

  mockIsExtension = false;
  mockIsDesktop = false;
  mockIsMobile = false;
  mockCompact = false;
  mockLsStore = {};

  mockUnlock.mockReset();
  mockNavigate.mockReset();
  mockOpenInFullPage.mockReset();
  mockBioHasKey.mockReset();
  mockDesktopHasKey.mockReset();
  mockHasPasswordProtector.mockReset();

  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  // jsdom's window.location is a non-configurable getter, so reload() can't be
  // spied — it's a harmless no-op here. window.close is a plain method we can spy;
  // tests assert against `window.close` directly, so no local handle is kept.
  jest.spyOn(window, 'close').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Extension password form
// ---------------------------------------------------------------------------
describe('Unlock — extension password form', () => {
  beforeEach(() => {
    mockIsExtension = true; // isMobile()/isDesktop() stay false
  });

  it('renders the password form (extension skips the hardware check)', async () => {
    const { container } = await renderUnlock();

    expect(screen.getByTestId('unlock-password')).toBeInTheDocument();
    expect(screen.getByText('enterYourPassword')).toBeInTheDocument();
    // Hardware unlock helpers must never be touched in the extension path.
    expect(mockBioHasKey).not.toHaveBeenCalled();
    expect(mockDesktopHasKey).not.toHaveBeenCalled();
    expect(mockUnlock).not.toHaveBeenCalled();
    // Submit button starts disabled (empty password).
    expect(container.querySelector('button[type="submit"]')).toBeDisabled();
  });

  it('unlocks with the typed password and reloads the extension on success', async () => {
    mockUnlock.mockResolvedValue(undefined);
    const { container } = await renderUnlock();

    const input = container.querySelector('#unlock-password') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'hunter2' } });
    expect(container.querySelector('button[type="submit"]')).not.toBeDisabled();

    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    await flushMicro();

    expect(mockUnlock).toHaveBeenCalledWith('hunter2');
    expect(mockLsStore.PasswordAttempts).toBe(1);
    // Extension reloads to sync with the background worker (window.location.reload
    // is a jsdom no-op) — the tell-tale of that branch is that it never navigates.
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('shows the incorrect-password error and resets it on the next keystroke', async () => {
    mockUnlock.mockRejectedValue(new Error('bad'));
    const { container } = await renderUnlock();

    const input = container.querySelector('#unlock-password') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'wrong' } });
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    await advance(500); // clears the 300ms pre-error delay

    expect(screen.getByText('incorrectPassword')).toBeInTheDocument();
    expect(mockLsStore.PasswordAttempts).toBe(2); // 1 -> 2, no time-lock yet

    // Typing again clears the error subtitle (onPasswordChange isError branch).
    fireEvent.change(input, { target: { value: 'wrong2' } });
    expect(screen.queryByText('incorrectPassword')).not.toBeInTheDocument();
  });

  // The same clear reaches this arm: the password form's error line derives from the same isError
  // the passcode screen's does, and the lockout interval is shared.
  it('empties the error line once a lockout ends', async () => {
    mockLsStore = { PasswordAttempts: 3, TimeLock: 0 };
    mockUnlock.mockRejectedValueOnce(new Error('bad'));
    const { container } = await renderUnlock();

    const input = container.querySelector('#unlock-password') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'wrong' } });
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    await advance(500);
    expect(screen.getByTestId('unlock-error')).toHaveTextContent('unlockPasswordErrorDelay');

    await advance(61_000);

    expect(screen.getByTestId('unlock-error')).toBeEmptyDOMElement();
  });

  it('toggles password visibility via the eye button', async () => {
    const { container } = await renderUnlock();

    const input = container.querySelector('#unlock-password') as HTMLInputElement;
    expect(input.getAttribute('type')).toBe('password');

    const eyeButton = screen.getByTestId('input-icon').querySelector('button') as HTMLButtonElement;
    fireEvent.click(eyeButton);
    expect((container.querySelector('#unlock-password') as HTMLInputElement).getAttribute('type')).toBe('text');
    expect(screen.getByTestId('icon')).toHaveAttribute('data-name', 'EyeOff');

    fireEvent.click(eyeButton);
    expect((container.querySelector('#unlock-password') as HTMLInputElement).getAttribute('type')).toBe('password');
    expect(screen.getByTestId('icon')).toHaveAttribute('data-name', 'Eye');
  });

  it('ignores submit while the password is empty', async () => {
    const { container } = await renderUnlock();

    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    await flushMicro();

    expect(mockUnlock).not.toHaveBeenCalled();
  });

  it('disables the form and shows the countdown after too many attempts', async () => {
    // attempt 5 -> lockLevel = 60s; timelock = now -> isDisabled true.
    mockLsStore = { PasswordAttempts: 5, TimeLock: BASE };
    const { container } = await renderUnlock();

    expect(screen.getByText(/unlockPasswordErrorDelay/)).toBeInTheDocument();
    expect(screen.getByText(/01:00/)).toBeInTheDocument();
    expect(container.querySelector('#unlock-password')).toBeDisabled();

    // Submitting while disabled is a no-op (onPasswordSubmit isDisabled branch).
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    await flushMicro();
    expect(mockUnlock).not.toHaveBeenCalled();

    // Interval keeps the lock active (Date.now()-timelock <= lockLevel branch).
    await advance(1100);
    expect(screen.getByText(/unlockPasswordErrorDelay/)).toBeInTheDocument();
  });

  it('navigates to forgot-password without full-page handoff by default', async () => {
    const { container } = await renderUnlock();

    fireEvent.click(container.querySelector('#forgot-password') as HTMLButtonElement);
    expect(mockNavigate).toHaveBeenCalledWith('/forgot-password-info');
    expect(mockOpenInFullPage).not.toHaveBeenCalled();
    expect(window.close).not.toHaveBeenCalled();
  });

  it('opens forgot-password in a full page and closes a compact popup', async () => {
    mockCompact = true;
    const { container } = await renderUnlock({ openForgotPasswordInFullPage: true });

    fireEvent.click(container.querySelector('#forgot-password') as HTMLButtonElement);
    expect(mockNavigate).toHaveBeenCalledWith('/forgot-password-info');
    expect(mockOpenInFullPage).toHaveBeenCalledTimes(1);
    expect(window.close).toHaveBeenCalledTimes(1);
  });

  it('opens forgot-password in a full page but keeps a non-compact window open', async () => {
    mockCompact = false;
    const { container } = await renderUnlock({ openForgotPasswordInFullPage: true });

    fireEvent.click(container.querySelector('#forgot-password') as HTMLButtonElement);
    expect(mockOpenInFullPage).toHaveBeenCalledTimes(1);
    expect(window.close).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Mobile passcode numpad
// ---------------------------------------------------------------------------
describe('Unlock — mobile passcode numpad', () => {
  beforeEach(() => {
    mockIsMobile = true;
    mockBioHasKey.mockResolvedValue(false); // no biometric key -> fall through to numpad
  });

  const type = (container: HTMLElement, digits: string) => {
    for (const d of digits) {
      fireEvent.click(container.querySelector(`[data-testid="digit-${d}"]`) as HTMLButtonElement);
    }
  };

  it('renders the numpad after the hardware check finds no key', async () => {
    await renderUnlock();

    expect(screen.getByTestId('unlock-passcode')).toBeInTheDocument();
    expect(screen.getByText('enterYour6DigitCode')).toBeInTheDocument();
    expect(mockBioHasKey).toHaveBeenCalledTimes(1);
    expect(mockUnlock).not.toHaveBeenCalled();

    // Interval tick with no time-lock hits the Date.now()-timelock > lockLevel branch.
    await advance(1100);
    expect(screen.getByTestId('unlock-passcode')).toBeInTheDocument();
  });

  it('accumulates six digits (with a delete) and auto-submits successfully', async () => {
    mockUnlock.mockResolvedValue(undefined);
    const { container } = await renderUnlock();

    type(container, '123'); // 1,2,3
    fireEvent.click(container.querySelector('[data-testid="numpad-delete"]') as HTMLButtonElement); // -> 12
    type(container, '3456'); // -> 123456

    await advance(200); // fire the 150ms auto-submit timer

    expect(mockUnlock).toHaveBeenCalledWith('123456');
    expect(mockLsStore.PasswordAttempts).toBe(1);
    // Mobile navigates instead of reloading.
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('ignores a seventh digit once the passcode is full', async () => {
    mockUnlock.mockResolvedValue(undefined);
    const { container } = await renderUnlock();

    type(container, '1234567'); // 7th press is dropped before the auto-submit timer
    await advance(200);

    expect(mockUnlock).toHaveBeenCalledWith('123456');
  });

  it('shows the incorrect-passcode error, clears the code, and resets on next digit', async () => {
    mockUnlock.mockRejectedValue(new Error('nope'));
    const { container } = await renderUnlock();

    type(container, '111111');
    await advance(600); // 150ms auto-submit + 300ms pre-error delay

    expect(screen.getByText('incorrectPasscode')).toBeInTheDocument();
    expect(mockLsStore.PasswordAttempts).toBe(2);

    // A fresh digit clears the error (handleDigit isError branch).
    type(container, '9');
    expect(screen.queryByText('incorrectPasscode')).not.toBeInTheDocument();
    expect(screen.getByText('enterYour6DigitCode')).toBeInTheDocument();
  });

  it('applies the random back-off delay and time-lock past the last attempt', async () => {
    // attempt 5 (> LAST_ATTEMPT) triggers the randomized pre-unlock delay and,
    // on failure, sets the time-lock (attempt >= LAST_ATTEMPT).
    jest.spyOn(Math, 'random').mockReturnValue(0); // delay -> 1000ms
    mockUnlock.mockRejectedValue(new Error('nope'));
    mockLsStore = { PasswordAttempts: 5, TimeLock: 0 };
    const { container } = await renderUnlock();

    type(container, '222222');
    // 150 auto-submit + 1000 back-off + 300 error = ~1450ms. Stay under 2000ms
    // so the once-per-second interval (which resets an *expired* time-lock)
    // can't fire again after the failure sets it.
    await advance(1700);

    expect(mockUnlock).toHaveBeenCalledWith('222222');
    expect(mockLsStore.PasswordAttempts).toBe(6);
    expect(typeof mockLsStore.TimeLock).toBe('number');
    expect(mockLsStore.TimeLock).not.toBe(0); // setTimeLock(Date.now()) ran
  });

  it('clears the incorrect-passcode error when a digit is deleted', async () => {
    mockUnlock.mockRejectedValue(new Error('nope'));
    const { container } = await renderUnlock();

    type(container, '111111');
    await advance(600);
    expect(screen.getByText('incorrectPasscode')).toBeInTheDocument();

    // Deleting after an error clears it (handleDelete isError branch).
    fireEvent.click(container.querySelector('[data-testid="numpad-delete"]') as HTMLButtonElement);
    expect(screen.queryByText('incorrectPasscode')).not.toBeInTheDocument();
    expect(screen.getByText('enterYour6DigitCode')).toBeInTheDocument();
  });

  it('blocks input and shows a two-digit countdown while time-locked', async () => {
    // attempt 30 -> lockLevel = 600s -> "10:00" exercises checkTime >= 10.
    mockLsStore = { PasswordAttempts: 30, TimeLock: BASE };
    const { container } = await renderUnlock();

    // Announced once, with the time left (all of it, as the lockout starts here); shown separately as
    // a ticking countdown.
    const status = screen.getByRole('status');
    const visible = screen.getByTestId('passcode-message');
    expect(status).toHaveTextContent('unlockPasswordErrorDelay 10:00');
    expect(visible).toHaveTextContent('unlockPasswordErrorDelay 10:00');

    // Digits and delete are ignored while disabled (handleDigit/handleDelete guards).
    type(container, '5');
    fireEvent.click(container.querySelector('[data-testid="numpad-delete"]') as HTMLButtonElement);
    await advance(200);
    expect(mockUnlock).not.toHaveBeenCalled();

    // Interval keeps counting without lifting the lock (false branch).
    await advance(1100);
    expect(visible).toHaveTextContent('unlockPasswordErrorDelay');
    // The countdown the user SEES moves; the live region does not. Inside the region the time was
    // re-announced once a second for the whole lockout.
    expect(visible).not.toHaveTextContent('10:00');
    expect(status).toHaveTextContent('unlockPasswordErrorDelay 10:00');
  });

  it('announces the time LEFT on a screen opened mid-lockout, and still never ticks', async () => {
    // A 10-minute lockout that started 9 minutes ago: one minute left, not ten.
    mockLsStore = { PasswordAttempts: 30, TimeLock: BASE - 9 * 60_000 };
    await renderUnlock();

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('unlockPasswordErrorDelay 01:00');

    await advance(1100);
    expect(screen.getByTestId('passcode-message')).not.toHaveTextContent('01:00');
    expect(status).toHaveTextContent('unlockPasswordErrorDelay 01:00');
  });

  // A lockout that ends is not the moment to repeat the failure that started it: the line and the
  // live region both read the instruction again.
  it('drops the failure that started a lockout once the lockout ends', async () => {
    mockLsStore = { PasswordAttempts: 3, TimeLock: 0 };
    mockUnlock.mockRejectedValueOnce(new Error('nope'));
    const { container } = await renderUnlock();

    type(container, '111111');
    await advance(600);
    expect(screen.getByRole('status')).toHaveTextContent('unlockPasswordErrorDelay');

    await advance(61_000);
    expect(screen.getByRole('status')).toHaveTextContent('enterYour6DigitCode');
    expect(screen.getByRole('status')).not.toHaveClass('text-negative-ink');
  });

  // THE TRAP: the interval's "lockout is over" branch is true every second when nothing is locked,
  // so a clear hung off it would wipe this error a second after it appears.
  it('keeps an error from a failure that started no lockout', async () => {
    mockLsStore = { PasswordAttempts: 1, TimeLock: 0 };
    mockUnlock.mockRejectedValueOnce(new Error('nope'));
    const { container } = await renderUnlock();

    type(container, '111111');
    await advance(600);
    await advance(2000);

    expect(screen.getByRole('status')).toHaveTextContent('incorrectPasscode');
  });

  // The same trap with a stale stamp: a lockout that expired while this screen was unmounted, or a
  // biometric unlock taken during one, leaves TimeLock set with no lockout on screen.
  it('keeps that error when a stale expired lockout stamp is still stored', async () => {
    mockLsStore = { PasswordAttempts: 1, TimeLock: BASE - 10 * 60_000 };
    mockUnlock.mockRejectedValueOnce(new Error('nope'));
    const { container } = await renderUnlock();

    type(container, '111111');
    await advance(600);
    await advance(2000);

    expect(screen.getByRole('status')).toHaveTextContent('incorrectPasscode');
  });

  it('draws the shared passcode screen with the keypad docked at the bottom', async () => {
    await renderUnlock();

    const root = screen.getByTestId('unlock-passcode');
    expect(root).toContainElement(screen.getByTestId('passcode-screen-layout'));
    expect(screen.getByTestId('passcode-keypad-dock')).toContainElement(screen.getByTestId('numpad'));
    // Forgot passcode is a 44px text action centred under the keypad, after it in DOM order.
    const forgot = root.querySelector('#forgot-password') as HTMLButtonElement;
    expect(forgot).toHaveClass('text-accent-tint-ink', 'min-h-11');
    expect(screen.getByTestId('passcode-screen-action')).toContainElement(forgot);
    expect(
      screen.getByTestId('numpad').compareDocumentPosition(forgot) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('has no biometric key when the device holds no biometric key', async () => {
    await renderUnlock();

    expect(screen.queryByTestId('numpad-biometric')).not.toBeInTheDocument();
  });

  it('shakes the dots and shows the error line in negative-ink on a wrong passcode', async () => {
    mockUnlock.mockRejectedValue(new Error('nope'));
    const { container } = await renderUnlock();

    expect(screen.getByTestId('passcode-dots')).not.toHaveAttribute('data-shake');
    type(container, '111111');
    await advance(600);

    expect(screen.getByTestId('passcode-dots')).toHaveAttribute('data-shake', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('incorrectPasscode');
    expect(screen.getByRole('status')).toHaveClass('text-negative-ink');
  });

  it('routes forgot-passcode to the reset info screen', async () => {
    const { container } = await renderUnlock();

    fireEvent.click(container.querySelector('#forgot-password') as HTMLButtonElement);
    expect(mockNavigate).toHaveBeenCalledWith('/forgot-password-info');
  });

  it('skips the duplicate in-flight hardware unlock under StrictMode double-invoke', async () => {
    render(
      <React.StrictMode>
        <Unlock />
      </React.StrictMode>
    );
    await flushMicro();

    expect(logSpy).toHaveBeenCalledWith('[Unlock] Hardware unlock already in progress, skipping');
    expect(screen.getByTestId('unlock-passcode')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Mount-time hardware unlock (mobile + desktop) and biometric-only UI
// ---------------------------------------------------------------------------
describe('Unlock — hardware unlock on mount', () => {
  it('auto-unlocks on desktop when a hardware key is present', async () => {
    mockIsDesktop = true;
    mockDesktopHasKey.mockResolvedValue(true);
    mockUnlock.mockResolvedValue(undefined);

    await renderUnlock();

    expect(mockDesktopHasKey).toHaveBeenCalledTimes(1);
    expect(mockUnlock).toHaveBeenCalledWith();
    expect(mockLsStore.PasswordAttempts).toBe(1);
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('falls back to the desktop password form when no hardware key exists', async () => {
    mockIsDesktop = true;
    mockDesktopHasKey.mockResolvedValue(false);

    await renderUnlock();

    expect(mockUnlock).not.toHaveBeenCalled();
    expect(screen.getByTestId('unlock-password')).toBeInTheDocument();
  });

  it('auto-unlocks on mobile when a biometric key is present', async () => {
    mockIsMobile = true;
    mockBioHasKey.mockResolvedValue(true);
    mockUnlock.mockResolvedValue(undefined);

    await renderUnlock();

    expect(mockBioHasKey).toHaveBeenCalledTimes(1);
    expect(mockUnlock).toHaveBeenCalledWith();
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('shows the biometric-only UI when unlock fails and there is no password protector', async () => {
    mockIsMobile = true;
    mockBioHasKey.mockResolvedValue(true);
    mockUnlock.mockRejectedValueOnce(new Error('cancelled')).mockResolvedValue(undefined);
    mockHasPasswordProtector.mockResolvedValue(false);

    const { container } = await renderUnlock();

    expect(screen.getByText('biometricUnlockRequired')).toBeInTheDocument();
    expect(screen.getByText('tryAgain')).toBeInTheDocument();
    expect(screen.getByText('resetWallet')).toBeInTheDocument();

    // Both hardware-unlock buttons used to carry an inline style object
    // (fontSize/lineHeight/padding) fighting the canonical Button anatomy;
    // only layout (`w-full`, `mb-3`) should remain.
    const retryBtn = container.querySelector('#retry-biometric') as HTMLButtonElement;
    const resetBtn = container.querySelector('#reset-wallet') as HTMLButtonElement;
    expect(retryBtn).toHaveClass('w-full', 'mb-3');
    expect(retryBtn.className).not.toMatch(/justify-center/);
    expect(resetBtn).toHaveClass('w-full');
    expect(resetBtn.className).not.toMatch(/justify-center/);

    // Retry succeeds -> setAttempt(1) + navigate('/').
    fireEvent.click(container.querySelector('#retry-biometric') as HTMLButtonElement);
    await flushMicro();
    expect(mockUnlock).toHaveBeenCalledTimes(2);
    expect(mockLsStore.PasswordAttempts).toBe(1);
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  // The only unlock control on this screen: it must show its attempt, like the password form's own
  // button does, instead of looking idle for the whole OS prompt while a second tap is dropped.
  it('disables the retry button while its attempt is in flight', async () => {
    mockIsMobile = true;
    mockBioHasKey.mockResolvedValue(true);
    mockHasPasswordProtector.mockResolvedValue(false);
    mockUnlock.mockRejectedValueOnce(new Error('cancelled'));
    let rejectRetry: (error: Error) => void = () => undefined;
    const { container } = await renderUnlock();

    mockUnlock.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectRetry = reject;
        })
    );
    const retry = container.querySelector('#retry-biometric') as HTMLButtonElement;
    fireEvent.click(retry);
    await flushMicro();
    expect(retry).toBeDisabled();
    expect(retry).toHaveAttribute('data-loading', 'true');

    await act(async () => rejectRetry(new Error('cancelled again')));
    await flushMicro();
    expect(container.querySelector('#retry-biometric')).not.toBeDisabled();
  });

  it('logs and stays on the biometric UI when the retry fails', async () => {
    mockIsMobile = true;
    mockBioHasKey.mockResolvedValue(true);
    mockUnlock.mockRejectedValue(new Error('always fails'));
    mockHasPasswordProtector.mockResolvedValue(false);

    const { container } = await renderUnlock();

    expect(screen.getByText('biometricUnlockRequired')).toBeInTheDocument();

    fireEvent.click(container.querySelector('#retry-biometric') as HTMLButtonElement);
    await flushMicro();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('[Unlock] Hardware unlock retry failed:', expect.any(Error));

    // The reset button on the biometric UI still routes to forgot-password.
    fireEvent.click(container.querySelector('#reset-wallet') as HTMLButtonElement);
    expect(mockNavigate).toHaveBeenCalledWith('/forgot-password-info');
  });

  it('falls through to the numpad when unlock fails but a password protector exists', async () => {
    mockIsMobile = true;
    mockBioHasKey.mockResolvedValue(true);
    mockUnlock.mockRejectedValue(new Error('cancelled'));
    mockHasPasswordProtector.mockResolvedValue(true);

    await renderUnlock();

    expect(mockHasPasswordProtector).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('unlock-passcode')).toBeInTheDocument();
    expect(screen.queryByText('biometricUnlockRequired')).not.toBeInTheDocument();
  });

  it('offers a biometric key on the keypad when the biometric unlock was cancelled', async () => {
    mockIsMobile = true;
    mockBioHasKey.mockResolvedValue(true);
    mockUnlock.mockRejectedValueOnce(new Error('cancelled'));
    mockHasPasswordProtector.mockResolvedValue(true);

    await renderUnlock();

    const key = screen.getByTestId('numpad-biometric');
    // Tapping it retries the same hardware unlock (no passcode argument).
    mockUnlock.mockResolvedValueOnce(undefined);
    fireEvent.click(key);
    await flushMicro();
    expect(mockUnlock).toHaveBeenLastCalledWith();
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('swallows a password-protector check error and still shows the fallback UI', async () => {
    mockIsMobile = true;
    mockBioHasKey.mockResolvedValue(true);
    mockUnlock.mockRejectedValue(new Error('cancelled'));
    mockHasPasswordProtector.mockRejectedValue(new Error('vault exploded'));

    await renderUnlock();

    expect(logSpy).toHaveBeenCalledWith('[Unlock] Failed to check password protector:', expect.any(Error));
    expect(screen.getByTestId('unlock-passcode')).toBeInTheDocument();
  });

  it('renders the password form on plain web (neither mobile nor desktop)', async () => {
    // isExtension/isMobile/isDesktop all false -> hardware branch is skipped
    // entirely, then the !isMobile() password form renders.
    await renderUnlock();

    expect(mockUnlock).not.toHaveBeenCalled();
    expect(mockBioHasKey).not.toHaveBeenCalled();
    expect(mockDesktopHasKey).not.toHaveBeenCalled();
    expect(screen.getByTestId('unlock-password')).toBeInTheDocument();
  });

  it('still reaches the passcode UI when the hardware key check never resolves', async () => {
    // The brand-only loading placeholder (rendered while hardwareUnlockChecked
    // is false) is the very first paint. React then re-runs the mount effect
    // because `hardwareUnlockAttempted` flipped, and that second pass
    // short-circuits to setHardwareUnlockChecked(true) — so the numpad appears
    // even though `hasHardwareKey()` here hangs forever.
    mockIsMobile = true;
    mockBioHasKey.mockReturnValue(new Promise(() => undefined));

    render(<Unlock />);
    await flushMicro();

    expect(mockBioHasKey).toHaveBeenCalledTimes(1);
    expect(mockUnlock).not.toHaveBeenCalled();
    expect(screen.getByTestId('unlock-passcode')).toBeInTheDocument();
  });
});

// One unlock() at a time. The keypad's biometric key and the auto-submitting passcode share a
// screen, so without a shared in-flight guard they could both reach unlock(). The guard is taken at
// the ENTRY of each path: submitPasscode can sleep 1-3s for the post-lockout throttle before it
// calls unlock(), and a guard taken at the call would leave that window open.
describe('the biometric key and the passcode never unlock concurrently', () => {
  const type = (container: HTMLElement, digits: string) => {
    for (const d of digits) {
      fireEvent.click(container.querySelector(`[data-testid="digit-${d}"]`) as HTMLButtonElement);
    }
  };

  // A mobile wallet with a biometric key whose mount-time unlock was cancelled, so the keypad shows
  // with the biometric key on it.
  beforeEach(() => {
    mockIsMobile = true;
    mockBioHasKey.mockResolvedValue(true);
    mockHasPasswordProtector.mockResolvedValue(true);
    mockUnlock.mockRejectedValueOnce(new Error('cancelled'));
  });

  it('refuses a biometric tap while a passcode submit is in flight', async () => {
    const { container } = await renderUnlock();
    mockUnlock.mockImplementationOnce(() => new Promise(() => {})); // the passcode never settles
    type(container, '123456');
    await advance(200); // past the auto-submit delay: submitPasscode now holds the guard

    fireEvent.click(screen.getByTestId('numpad-biometric'));
    await flushMicro();

    // Once at mount, once for the passcode - and NOT a third time for the biometric tap.
    expect(mockUnlock).toHaveBeenCalledTimes(2);
  });

  it('refuses a biometric tap during the post-lockout throttle, before unlock() is reached', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0); // throttle -> 1000ms
    mockLsStore = { PasswordAttempts: 5, TimeLock: 0 };
    const { container } = await renderUnlock();
    type(container, '123456');
    await advance(400); // submitPasscode has started and is sleeping; it has NOT called unlock() yet

    expect(mockUnlock).toHaveBeenCalledTimes(1); // the mount attempt only
    fireEvent.click(screen.getByTestId('numpad-biometric'));
    await flushMicro();

    expect(mockUnlock).toHaveBeenCalledTimes(1);
  });

  it('shows a failed biometric attempt on screen', async () => {
    await renderUnlock();
    mockUnlock.mockRejectedValueOnce(new Error('cancelled again'));

    fireEvent.click(screen.getByTestId('numpad-biometric'));
    await flushMicro();

    expect(screen.getByRole('status')).toHaveTextContent('biometricFailed');
  });

  it('lets the biometric key try again after a failed attempt', async () => {
    await renderUnlock();
    mockUnlock.mockRejectedValueOnce(new Error('cancelled again'));
    fireEvent.click(screen.getByTestId('numpad-biometric'));
    await flushMicro();

    // The guard was released in `finally`. A latch that is never cleared - which is what the
    // mount-time `unlockInProgressRef` is - would turn this second tap into a silent no-op.
    mockUnlock.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByTestId('numpad-biometric'));
    await flushMicro();

    expect(mockUnlock).toHaveBeenCalledTimes(3);
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });
});

// The attempt in flight is visible to every input, not just to the guard: a keypad, auto-submit or
// password form that started behind it would be refused by the guard without a word. And the most
// recent failure, from either path, is what the screen shows.
describe('an unlock attempt in flight holds every input, and the latest failure shows', () => {
  const type = (container: HTMLElement, digits: string) => {
    for (const d of digits) {
      fireEvent.click(container.querySelector(`[data-testid="digit-${d}"]`) as HTMLButtonElement);
    }
  };
  const filledDots = () =>
    screen.getAllByTestId('passcode-dot').filter(dot => dot.getAttribute('data-filled') === 'true').length;

  beforeEach(() => {
    mockIsMobile = true;
    mockBioHasKey.mockResolvedValue(true);
    mockHasPasswordProtector.mockResolvedValue(true);
  });

  it('refuses the biometric key while the mount-time attempt is still in flight', async () => {
    mockUnlock.mockImplementationOnce(() => new Promise(() => {})); // the mount attempt never settles
    await renderUnlock();
    await flushMicro();

    fireEvent.click(screen.getByTestId('numpad-biometric'));
    await flushMicro();

    expect(mockUnlock).toHaveBeenCalledTimes(1);
  });

  describe('once the mount-time attempt was cancelled', () => {
    beforeEach(() => {
      mockUnlock.mockRejectedValueOnce(new Error('cancelled'));
    });

    it('holds the keypad while a biometric retry is in flight, then takes the passcode', async () => {
      const { container } = await renderUnlock();
      let rejectRetry: (error: Error) => void = () => undefined;
      mockUnlock.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectRetry = reject;
          })
      );
      fireEvent.click(screen.getByTestId('numpad-biometric'));
      await flushMicro();

      type(container, '123456');
      await advance(200);
      expect(filledDots()).toBe(0);
      expect(mockUnlock).toHaveBeenCalledTimes(2); // mount, then the retry - nothing for the code

      await act(async () => rejectRetry(new Error('cancelled again')));
      await flushMicro();
      mockUnlock.mockImplementationOnce(() => new Promise(() => {}));
      type(container, '123456');
      await advance(200);
      expect(mockUnlock).toHaveBeenLastCalledWith('123456');
    });

    it('holds delete too while a biometric retry is in flight', async () => {
      const { container } = await renderUnlock();
      type(container, '12');
      mockUnlock.mockImplementationOnce(() => new Promise(() => {}));
      fireEvent.click(screen.getByTestId('numpad-biometric'));
      await flushMicro();

      fireEvent.click(screen.getByTestId('numpad-delete'));

      expect(filledDots()).toBe(2);
    });

    it('shows a failed biometric attempt after a wrong passcode, not the stale passcode error', async () => {
      const { container } = await renderUnlock();
      mockUnlock.mockRejectedValueOnce(new Error('wrong passcode'));
      type(container, '111111');
      await advance(600);
      expect(screen.getByRole('status')).toHaveTextContent('incorrectPasscode');

      mockUnlock.mockRejectedValueOnce(new Error('cancelled again'));
      fireEvent.click(screen.getByTestId('numpad-biometric'));
      await flushMicro();

      expect(screen.getByRole('status')).toHaveTextContent('biometricFailed');
    });

    it('refuses the entry keys during a lockout while the biometric key still works', async () => {
      mockLsStore = { PasswordAttempts: 30, TimeLock: BASE };
      const { container } = await renderUnlock();

      expect(container.querySelector('[data-testid="digit-5"]')).toBeDisabled();
      expect(container.querySelector('[data-testid="numpad-delete"]')).toBeDisabled();
      // The biometric key is a separate factor the OS rate-limits, and it stays usable.
      const bio = screen.getByTestId('numpad-biometric');
      expect(bio).not.toBeDisabled();
      mockUnlock.mockRejectedValueOnce(new Error('cancelled again'));
      fireEvent.click(bio);
      await flushMicro();
      expect(mockUnlock).toHaveBeenCalledTimes(2); // the mount attempt, then this one
    });

    it('refuses every key while an attempt is in flight, and releases them when it fails', async () => {
      const { container } = await renderUnlock();
      let rejectRetry: (error: Error) => void = () => undefined;
      mockUnlock.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectRetry = reject;
          })
      );
      fireEvent.click(screen.getByTestId('numpad-biometric'));
      await flushMicro();

      expect(container.querySelector('[data-testid="digit-5"]')).toBeDisabled();
      expect(screen.getByTestId('numpad-biometric')).toBeDisabled();

      await act(async () => rejectRetry(new Error('cancelled again')));
      await flushMicro();

      expect(container.querySelector('[data-testid="digit-5"]')).not.toBeDisabled();
      expect(screen.getByTestId('numpad-biometric')).not.toBeDisabled();
    });

    it('announces the lockout WITH a biometric failure, never instead of it', async () => {
      mockLsStore = { PasswordAttempts: 30, TimeLock: BASE };
      await renderUnlock();
      mockUnlock.mockRejectedValueOnce(new Error('cancelled again'));
      fireEvent.click(screen.getByTestId('numpad-biometric'));
      await flushMicro();

      const status = screen.getByRole('status');
      expect(status).toHaveTextContent('biometricFailed');
      // The countdown is aria-hidden, so a region naming only the failure would leave a screen
      // reader with no way to learn the wallet is locked or for how long.
      expect(status).toHaveTextContent('unlockPasswordErrorDelay 10:00');
    });

    it('clears a partly typed code when a biometric retry fails, as a rejected passcode does', async () => {
      const { container } = await renderUnlock();
      type(container, '12');
      mockUnlock.mockRejectedValueOnce(new Error('cancelled again'));
      fireEvent.click(screen.getByTestId('numpad-biometric'));
      await flushMicro();

      // The dots are empty when they shake: PasscodeDots replays the row from rest on a new errorKey.
      expect(filledDots()).toBe(0);
      expect(screen.getByTestId('passcode-dots')).toHaveAttribute('data-shake', 'true');
    });

    it('during a lockout, shakes the dots and announces a failed biometric while the countdown stays', async () => {
      mockLsStore = { PasswordAttempts: 30, TimeLock: BASE };
      await renderUnlock();
      // The mount-time attempt was cancelled: not an error, so nothing shook.
      expect(screen.getByTestId('passcode-dots')).not.toHaveAttribute('data-shake');

      mockUnlock.mockRejectedValueOnce(new Error('cancelled again'));
      fireEvent.click(screen.getByTestId('numpad-biometric'));
      await flushMicro();

      expect(screen.getByTestId('passcode-dots')).toHaveAttribute('data-shake', 'true');
      expect(screen.getByRole('status')).toHaveTextContent('biometricFailed');
      expect(screen.getByTestId('passcode-message')).toHaveTextContent('unlockPasswordErrorDelay');
    });

    // The announcement is captured, so every time it is re-derived it must capture again: otherwise
    // the tap after a failed attempt announces the time the screen was opened with.
    it('recaptures the time left when the announcement returns after a failed biometric', async () => {
      mockLsStore = { PasswordAttempts: 30, TimeLock: BASE }; // a 10-minute lockout, from now
      await renderUnlock();
      await advance(5 * 60_000);

      mockUnlock.mockRejectedValueOnce(new Error('cancelled again'));
      fireEvent.click(screen.getByTestId('numpad-biometric'));
      await flushMicro();
      expect(screen.getByRole('status')).toHaveTextContent('biometricFailed');

      mockUnlock.mockImplementationOnce(() => new Promise(() => {})); // the next attempt stays pending
      fireEvent.click(screen.getByTestId('numpad-biometric'));
      await flushMicro();

      expect(screen.getByRole('status')).toHaveTextContent('unlockPasswordErrorDelay 05:00');
    });

    it('drops a biometric failure from during a lockout once the lockout ends', async () => {
      mockLsStore = { PasswordAttempts: 3, TimeLock: BASE }; // a 60-second lockout
      await renderUnlock();
      mockUnlock.mockRejectedValueOnce(new Error('cancelled again'));
      fireEvent.click(screen.getByTestId('numpad-biometric'));
      await flushMicro();
      expect(screen.getByRole('status')).toHaveTextContent('biometricFailed');

      await advance(61_000);

      expect(screen.getByRole('status')).toHaveTextContent('enterYour6DigitCode');
    });

    it('still reports a retry that fails after the lockout lifted under it', async () => {
      mockLsStore = { PasswordAttempts: 3, TimeLock: BASE };
      await renderUnlock();
      let rejectRetry: (error: Error) => void = () => undefined;
      mockUnlock.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectRetry = reject;
          })
      );
      fireEvent.click(screen.getByTestId('numpad-biometric'));
      await flushMicro();

      await advance(61_000); // the lockout lifts while the retry is still in flight
      await act(async () => rejectRetry(new Error('cancelled again')));
      await flushMicro();

      expect(screen.getByRole('status')).toHaveTextContent('biometricFailed');
    });
  });
});

describe('the desktop password form waits for the mount-time Touch ID attempt', () => {
  it('disables Unlock while the attempt is in flight, then takes the password', async () => {
    mockIsDesktop = true;
    mockDesktopHasKey.mockResolvedValue(true);
    mockHasPasswordProtector.mockResolvedValue(true);
    let rejectMount: (error: Error) => void = () => undefined;
    mockUnlock.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectMount = reject;
        })
    );
    const { container } = await renderUnlock();
    await flushMicro();

    fireEvent.change(container.querySelector('#unlock-password') as HTMLInputElement, {
      target: { value: 'hunter2' }
    });
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit).toBeDisabled();

    await act(async () => rejectMount(new Error('cancelled')));
    await flushMicro();
    expect(submit).not.toBeDisabled();

    mockUnlock.mockImplementationOnce(() => new Promise(() => {}));
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    await flushMicro();
    expect(mockUnlock).toHaveBeenLastCalledWith('hunter2');
  });
});

// The glyph is chosen from the sensor Unlock reads at mount. Without a case here, a typo in that
// call would be swallowed by the defensive catch around it and ship the fallback glyph to every
// device with this suite green.
describe('the biometric key shows the sensor the device actually has', () => {
  beforeEach(() => {
    mockIsMobile = true;
    mockBioHasKey.mockResolvedValue(true);
    mockHasPasswordProtector.mockResolvedValue(true);
    mockUnlock.mockRejectedValueOnce(new Error('cancelled'));
  });

  it.each(['face', 'fingerprint'] as const)('hands the keypad a %s sensor', async biometryType => {
    mockBiometryType.mockResolvedValueOnce({ biometryType });
    await renderUnlock();

    expect(screen.getByTestId('numpad-biometric')).toHaveAttribute('data-biometry', biometryType);
  });

  it('still unlocks when the sensor cannot be read', async () => {
    mockBiometryType.mockRejectedValueOnce(new Error('plugin missing'));
    mockUnlock.mockReset();
    mockUnlock.mockResolvedValueOnce(undefined);
    await renderUnlock();

    // Only the glyph depends on the sensor, so failing to read it must not stop the unlock.
    expect(mockUnlock).toHaveBeenCalledWith();
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });
});
