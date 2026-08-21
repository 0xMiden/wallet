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

// Telemetry: each beginFlow() records the flow name and returns a fresh spy
// handle, so a test can assert how many unlock attempts were reported and how
// each one was settled. classifyError is stubbed to a constant — the real
// classifier has its own suite.
type TelemetryHandle = { complete: jest.Mock; cancel: jest.Mock; fail: jest.Mock };
const mockFlowHandles: Array<{ flow: string; handle: TelemetryHandle }> = [];
const mockBeginFlow = jest.fn((flow: string) => {
  const handle: TelemetryHandle = { complete: jest.fn(), cancel: jest.fn(), fail: jest.fn() };
  mockFlowHandles.push({ flow, handle });
  return handle;
});
const mockClassifyError = jest.fn<string, [unknown]>(() => 'auth');
jest.mock('lib/telemetry', () => ({
  beginFlow: (flow: string) => mockBeginFlow(flow),
  classifyError: (error: unknown) => mockClassifyError(error)
}));

const flowsBegun = () => mockFlowHandles.map(entry => entry.flow);

// Throwing accessor (rather than a `!`) so a missing attempt fails with a
// message naming what was actually begun.
function attempt(index: number): TelemetryHandle {
  const entry = mockFlowHandles[index];
  if (!entry) throw new Error(`no unlock attempt at index ${index} (begun: ${flowsBegun().join(', ') || 'none'})`);
  return entry.handle;
}

const telemetryCallArgs = () => JSON.stringify([mockBeginFlow.mock.calls, mockClassifyError.mock.calls]);

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
jest.mock('lib/biometric', () => ({ hasHardwareKey: () => mockBioHasKey() }));
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
    isLoading
  }: {
    id?: string;
    title?: string;
    onClick?: () => void;
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
    isLoading?: boolean;
  }) => (
    <button
      id={id}
      type={type ?? 'button'}
      onClick={onClick}
      disabled={disabled}
      data-loading={isLoading ? 'true' : 'false'}
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
  Numpad: ({ onDigit, onDelete }: { onDigit: (d: string) => void; onDelete: () => void }) => (
    <div data-testid="numpad">
      {['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].map(d => (
        <button key={d} type="button" data-testid={`digit-${d}`} onClick={() => onDigit(d)}>
          {d}
        </button>
      ))}
      <button type="button" data-testid="numpad-delete" onClick={onDelete}>
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

  mockFlowHandles.length = 0;
  mockBeginFlow.mockClear();
  mockClassifyError.mockClear();
  mockClassifyError.mockReturnValue('auth');

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

    expect(screen.getByText(/unlockPasswordErrorDelay/)).toBeInTheDocument();
    expect(screen.getByText(/10:00/)).toBeInTheDocument();

    // Digits and delete are ignored while disabled (handleDigit/handleDelete guards).
    type(container, '5');
    fireEvent.click(container.querySelector('[data-testid="numpad-delete"]') as HTMLButtonElement);
    await advance(200);
    expect(mockUnlock).not.toHaveBeenCalled();

    // Interval keeps counting without lifting the lock (false branch).
    await advance(1100);
    expect(screen.getByText(/unlockPasswordErrorDelay/)).toBeInTheDocument();
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

    // Retry succeeds -> setAttempt(1) + navigate('/').
    fireEvent.click(container.querySelector('#retry-biometric') as HTMLButtonElement);
    await flushMicro();
    expect(mockUnlock).toHaveBeenCalledTimes(2);
    expect(mockLsStore.PasswordAttempts).toBe(1);
    expect(mockNavigate).toHaveBeenCalledWith('/');
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

// ---------------------------------------------------------------------------
// Telemetry — the `unlock` flow
//
// A flow is reported per unlock ATTEMPT rather than per screen mount: a wrong
// password is retryable, so a mount-scoped flow could only ever complete or be
// abandoned, and settling it as errored would make the eventual successful
// retry a no-op on the idempotent handle. Per-attempt keeps every attempt a
// matched started/ended pair with a meaningful duration.
// ---------------------------------------------------------------------------
describe('Unlock — telemetry', () => {
  it('does not report an unlock flow just for showing the screen', async () => {
    mockIsExtension = true;
    await renderUnlock();

    expect(screen.getByTestId('unlock-password')).toBeInTheDocument();
    expect(flowsBegun()).toEqual([]);
  });

  it('reports a completed unlock when the typed password is accepted', async () => {
    mockIsExtension = true;
    mockUnlock.mockResolvedValue(undefined);
    const { container } = await renderUnlock();

    fireEvent.change(container.querySelector('#unlock-password') as HTMLInputElement, {
      target: { value: 'hunter2' }
    });
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    await flushMicro();

    expect(mockUnlock).toHaveBeenCalledWith('hunter2');
    expect(flowsBegun()).toEqual(['unlock']);
    expect(attempt(0).complete).toHaveBeenCalledTimes(1);
    expect(attempt(0).fail).not.toHaveBeenCalled();
  });

  it('reports errored with a broad kind when the password is rejected', async () => {
    mockIsExtension = true;
    const boom = new Error('bad password');
    mockUnlock.mockRejectedValue(boom);
    const { container } = await renderUnlock();

    fireEvent.change(container.querySelector('#unlock-password') as HTMLInputElement, {
      target: { value: 'wrong' }
    });
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    await advance(500);

    expect(flowsBegun()).toEqual(['unlock']);
    expect(mockClassifyError).toHaveBeenCalledWith(boom);
    expect(attempt(0).fail).toHaveBeenCalledWith('auth');
    expect(attempt(0).complete).not.toHaveBeenCalled();
  });

  it('reports a failed attempt and a later successful one as two separate flows', async () => {
    mockIsExtension = true;
    mockUnlock.mockRejectedValueOnce(new Error('bad password')).mockResolvedValue(undefined);
    const { container } = await renderUnlock();

    const input = container.querySelector('#unlock-password') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'wrong' } });
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    await advance(500);

    fireEvent.change(input, { target: { value: 'right' } });
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    await flushMicro();

    expect(mockUnlock).toHaveBeenCalledTimes(2);
    expect(flowsBegun()).toEqual(['unlock', 'unlock']);
    // The retry's success is NOT swallowed by the first attempt's failure.
    expect(attempt(0).fail).toHaveBeenCalledWith('auth');
    expect(attempt(1).complete).toHaveBeenCalledTimes(1);
  });

  it('reports a completed unlock for an accepted mobile passcode', async () => {
    mockIsMobile = true;
    mockBioHasKey.mockResolvedValue(false);
    mockUnlock.mockResolvedValue(undefined);
    const { container } = await renderUnlock();

    for (const digit of '123456') {
      fireEvent.click(container.querySelector(`[data-testid="digit-${digit}"]`) as HTMLButtonElement);
    }
    await advance(200);

    expect(mockUnlock).toHaveBeenCalledWith('123456');
    expect(flowsBegun()).toEqual(['unlock']);
    expect(attempt(0).complete).toHaveBeenCalledTimes(1);
  });

  it('reports a completed unlock for a successful mount-time hardware unlock', async () => {
    mockIsDesktop = true;
    mockDesktopHasKey.mockResolvedValue(true);
    mockUnlock.mockResolvedValue(undefined);

    await renderUnlock();

    expect(mockUnlock).toHaveBeenCalledWith();
    expect(flowsBegun()).toEqual(['unlock']);
    expect(attempt(0).complete).toHaveBeenCalledTimes(1);
  });

  it('does not report a flow when there is no hardware key to attempt', async () => {
    mockIsDesktop = true;
    mockDesktopHasKey.mockResolvedValue(false);

    await renderUnlock();

    expect(mockUnlock).not.toHaveBeenCalled();
    expect(flowsBegun()).toEqual([]);
  });

  it('reports errored when the mount-time biometric unlock fails', async () => {
    mockIsMobile = true;
    mockBioHasKey.mockResolvedValue(true);
    const boom = new Error('biometric cancelled');
    mockUnlock.mockRejectedValue(boom);
    mockHasPasswordProtector.mockResolvedValue(true);

    await renderUnlock();

    expect(flowsBegun()).toEqual(['unlock']);
    expect(mockClassifyError).toHaveBeenCalledWith(boom);
    expect(attempt(0).fail).toHaveBeenCalledWith('auth');
    expect(attempt(0).complete).not.toHaveBeenCalled();
  });

  it('reports the biometric retry as its own flow, completed on success', async () => {
    mockIsMobile = true;
    mockBioHasKey.mockResolvedValue(true);
    mockUnlock.mockRejectedValueOnce(new Error('cancelled')).mockResolvedValue(undefined);
    mockHasPasswordProtector.mockResolvedValue(false);

    const { container } = await renderUnlock();
    expect(flowsBegun()).toEqual(['unlock']); // the failed mount attempt

    fireEvent.click(container.querySelector('#retry-biometric') as HTMLButtonElement);
    await flushMicro();

    expect(mockUnlock).toHaveBeenCalledTimes(2);
    expect(flowsBegun()).toEqual(['unlock', 'unlock']);
    expect(attempt(0).fail).toHaveBeenCalledWith('auth');
    expect(attempt(1).complete).toHaveBeenCalledTimes(1);
  });

  it('reports errored when the biometric retry also fails', async () => {
    mockIsMobile = true;
    mockBioHasKey.mockResolvedValue(true);
    mockUnlock.mockRejectedValue(new Error('always fails'));
    mockHasPasswordProtector.mockResolvedValue(false);

    const { container } = await renderUnlock();
    fireEvent.click(container.querySelector('#retry-biometric') as HTMLButtonElement);
    await flushMicro();

    expect(flowsBegun()).toEqual(['unlock', 'unlock']);
    expect(attempt(1).fail).toHaveBeenCalledWith('auth');
    expect(attempt(1).complete).not.toHaveBeenCalled();
  });

  it('never passes the entered password to the telemetry layer', async () => {
    mockIsExtension = true;
    mockUnlock.mockRejectedValue(new Error('bad password'));
    const { container } = await renderUnlock();

    fireEvent.change(container.querySelector('#unlock-password') as HTMLInputElement, {
      target: { value: 'super-secret-passphrase' }
    });
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    await advance(500);

    // Positive fact first: telemetry really was exercised on this path.
    expect(flowsBegun()).toEqual(['unlock']);
    expect(attempt(0).fail).toHaveBeenCalledWith('auth');

    expect(telemetryCallArgs()).not.toContain('super-secret-passphrase');
  });
});
