import React from 'react';

import { render, screen, fireEvent, act } from '@testing-library/react';

import { authenticate, checkBiometricAvailability } from 'lib/biometric';
import { hapticLight } from 'lib/mobile/haptics';
import { isIOS, isMobile } from 'lib/platform';

import SetupBiometricScreen, { SetupBiometricScreen as NamedSetupBiometricScreen } from './SetupBiometric';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// `react-i18next` pulls in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes the key back. Crucially the `t` reference is created ONCE
// (module scope of the mock) and returned unchanged on every call — mirroring
// react-i18next's memoisation. The component's `tryAuthenticate` is a
// `useCallback([t])` that the mount effect depends on, so a fresh `t` per
// render would re-run the effect every render (an infinite set/clear-error
// loop). A stable `t` keeps the effect firing exactly once.
jest.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});

// `Button` — render the title and forward the click so each `onClick` wiring
// and the chosen variant can be verified. Ghost is used by the passcode button.
jest.mock('components/Button', () => ({
  Button: ({ title, onClick, variant }: { title: string; onClick?: () => void; variant?: string }) => (
    <button data-testid={`btn-${title}`} data-variant={variant ?? 'default'} onClick={onClick}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' }
}));

// `app/icons/v2` — the success checkmark. Stub the barrel of SVG re-exports so
// only a lightweight marker renders; expose the `Checkmark` name the component uses.
jest.mock('app/icons/v2', () => ({
  Icon: (props: { name?: string }) => <span data-testid="icon" data-name={props.name} />,
  IconName: { Checkmark: 'Checkmark' }
}));

// `lib/platform` — `isIOS`/`isMobile` drive the Face-ID-vs-fingerprint and the
// mobile-vs-extension branches. Controlled per test.
jest.mock('lib/platform', () => ({
  isIOS: jest.fn(),
  isMobile: jest.fn()
}));

// `lib/biometric` — the native availability probe + auth prompt. Avoids pulling
// the Capacitor plugin; controlled per test.
jest.mock('lib/biometric', () => ({
  checkBiometricAvailability: jest.fn(),
  authenticate: jest.fn()
}));

// `lib/mobile/haptics` — the retry haptic; stub so no Capacitor Haptics import.
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

// ---------------------------------------------------------------------------
// Typed handles onto the mocked modules
// ---------------------------------------------------------------------------

const mockIsIOS = isIOS as jest.Mock;
const mockIsMobile = isMobile as jest.Mock;
const mockCheckAvailability = checkBiometricAvailability as jest.Mock;
const mockAuthenticate = authenticate as jest.Mock;
const mockHapticLight = hapticLight as jest.Mock;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const renderComponent = (props: Partial<React.ComponentProps<typeof SetupBiometricScreen>> = {}) =>
  render(<SetupBiometricScreen {...props} />);

/**
 * Drain the mount effect's async chain (two awaited promises + the follow-up
 * `setState`s) inside `act`. Wrapping in `act` forces React to flush its
 * scheduler synchronously — plain `setTimeout`/`waitFor` under real timers
 * leaves the commit pending. Ten microtask ticks comfortably cover the chain.
 */
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
};

/** A promise whose resolution is controlled by the test (for the in-flight guard). */
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
};

beforeEach(() => {
  jest.clearAllMocks();
  // Sensible defaults; individual tests override as needed.
  mockIsIOS.mockReturnValue(false);
  mockIsMobile.mockReturnValue(true);
  mockCheckAvailability.mockResolvedValue({ isAvailable: true, biometryType: 'fingerprint' });
  mockAuthenticate.mockResolvedValue(true);
  mockHapticLight.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SetupBiometricScreen', () => {
  describe('prompt phase — title + icon branch (isIOS)', () => {
    it('renders the Face ID copy and prompt on iOS', async () => {
      mockIsIOS.mockReturnValue(true);
      mockIsMobile.mockReturnValue(false); // keep it in the prompt phase via the unavailable error

      renderComponent();
      await flush();

      // The container + the retry button (aria-labelled by the prompt title) render.
      expect(screen.getByTestId('onboarding-setup-biometric')).toBeInTheDocument();
      expect(screen.getByText('biometricUnavailable')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('faceIdSetUp');
      expect(screen.getByRole('button', { name: 'faceIdSetUp' })).toBeInTheDocument();
    });

    it('renders the generic biometric copy off iOS (fingerprint branch)', async () => {
      mockIsIOS.mockReturnValue(false);
      mockIsMobile.mockReturnValue(false);

      renderComponent();
      await flush();

      expect(screen.getByText('biometricUnavailable')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('biometricSetUp');
      expect(screen.getByRole('button', { name: 'biometricSetUp' })).toBeInTheDocument();
    });

    it('renders the primary-coloured scan frame brackets in the prompt phase', async () => {
      mockIsMobile.mockReturnValue(false);
      const { container } = renderComponent();
      await flush();

      // ScanFrame color="primary" -> text-primary-500 brackets.
      expect(container.querySelector('.text-primary-500')).toBeInTheDocument();
      expect(container.querySelector('.text-status-positive')).not.toBeInTheDocument();
    });
  });

  describe('tryAuthenticate — availability / auth branches (auto-fired on mount)', () => {
    it('surfaces the unavailable error and never probes the native APIs on non-mobile', async () => {
      mockIsMobile.mockReturnValue(false);

      renderComponent();
      await flush();

      expect(screen.getByText('biometricUnavailable')).toBeInTheDocument();
      expect(mockCheckAvailability).not.toHaveBeenCalled();
      expect(mockAuthenticate).not.toHaveBeenCalled();
      // Stays in the prompt phase (passcode fallback button visible).
      expect(screen.getByTestId('btn-usePasscodeInstead')).toBeInTheDocument();
    });

    it('surfaces the unavailable error when the device reports no biometrics', async () => {
      mockIsMobile.mockReturnValue(true);
      mockCheckAvailability.mockResolvedValue({ isAvailable: false, biometryType: 'none' });

      renderComponent();
      await flush();

      expect(screen.getByText('biometricUnavailable')).toBeInTheDocument();
      expect(mockCheckAvailability).toHaveBeenCalledTimes(1);
      expect(mockAuthenticate).not.toHaveBeenCalled();
    });

    it('shows the failure error when the OS prompt is declined', async () => {
      mockIsMobile.mockReturnValue(true);
      mockCheckAvailability.mockResolvedValue({ isAvailable: true, biometryType: 'fingerprint' });
      mockAuthenticate.mockResolvedValue(false);

      renderComponent();
      await flush();

      expect(screen.getByText('biometricFailed')).toBeInTheDocument();
      expect(mockAuthenticate).toHaveBeenCalledWith('biometricSetupReason');
      // Still in the prompt phase — no success heading.
      expect(screen.queryByText('biometricConfirmed')).not.toBeInTheDocument();
      expect(screen.getByTestId('btn-usePasscodeInstead')).toBeInTheDocument();
    });
  });

  describe('success phase', () => {
    it('transitions to the confirmed state when authentication succeeds', async () => {
      mockIsMobile.mockReturnValue(true);
      mockAuthenticate.mockResolvedValue(true);

      const { container } = renderComponent();
      await flush();

      expect(screen.getByText('biometricConfirmed')).toBeInTheDocument();
      expect(screen.getByText('onlyOneMoreStep')).toBeInTheDocument();
      // Checkmark icon + positive-coloured scan frame.
      expect(screen.getByTestId('icon')).toHaveAttribute('data-name', 'Checkmark');
      expect(container.querySelector('.text-status-positive')).toBeInTheDocument();
      // Prompt-phase affordances are gone; the continue button replaces them.
      expect(screen.queryByTestId('btn-usePasscodeInstead')).not.toBeInTheDocument();
      expect(screen.getByTestId('btn-continue')).toBeInTheDocument();
      expect(screen.queryByText('biometricFailed')).not.toBeInTheDocument();
    });

    it('fires the auth flow exactly once even though the phase change re-runs the effect', async () => {
      mockIsMobile.mockReturnValue(true);
      mockAuthenticate.mockResolvedValue(true);

      renderComponent();
      await flush();

      expect(screen.getByText('biometricConfirmed')).toBeInTheDocument();
      // The effect re-runs when phase flips to 'success', but the `phase === 'prompt'`
      // guard keeps it from re-triggering another authentication.
      expect(mockCheckAvailability).toHaveBeenCalledTimes(1);
      expect(mockAuthenticate).toHaveBeenCalledTimes(1);
    });
  });

  describe('button wiring', () => {
    it('invokes onSwitchToPasscode from the ghost passcode button in the prompt phase', async () => {
      mockIsMobile.mockReturnValue(false);
      const onSwitchToPasscode = jest.fn();

      renderComponent({ onSwitchToPasscode });
      await flush();

      const button = screen.getByTestId('btn-usePasscodeInstead');
      expect(button).toHaveAttribute('data-variant', 'ghost');
      fireEvent.click(button);
      expect(onSwitchToPasscode).toHaveBeenCalledTimes(1);
    });

    it('invokes onContinue from the continue button in the success phase', async () => {
      mockIsMobile.mockReturnValue(true);
      mockAuthenticate.mockResolvedValue(true);
      const onContinue = jest.fn();

      renderComponent({ onContinue });
      await flush();

      fireEvent.click(screen.getByTestId('btn-continue'));
      expect(onContinue).toHaveBeenCalledTimes(1);
    });

    it('does not throw when the passcode button is clicked without a handler', async () => {
      mockIsMobile.mockReturnValue(false);
      renderComponent();
      await flush();

      expect(() => fireEvent.click(screen.getByTestId('btn-usePasscodeInstead'))).not.toThrow();
    });
  });

  describe('handleRetry (tapping the scan frame)', () => {
    it('fires a light haptic and re-runs authentication, reaching success on retry', async () => {
      // First mount fails (extension context) and stays in the prompt phase.
      mockIsMobile.mockReturnValue(false);
      renderComponent();
      await flush();

      expect(screen.getByText('biometricUnavailable')).toBeInTheDocument();
      expect(mockHapticLight).not.toHaveBeenCalled();

      // Now the environment "becomes" a capable mobile device and the user retries.
      mockIsMobile.mockReturnValue(true);
      mockAuthenticate.mockResolvedValue(true);

      fireEvent.click(screen.getByRole('button', { name: 'biometricSetUp' }));
      await flush();

      expect(mockHapticLight).toHaveBeenCalledTimes(1);
      expect(screen.getByText('biometricConfirmed')).toBeInTheDocument();
    });
  });

  describe('in-flight guard (inFlightRef)', () => {
    it('ignores a retry tap while an authentication attempt is still pending', async () => {
      mockIsMobile.mockReturnValue(true);
      const gate = deferred<{ isAvailable: boolean; biometryType: string }>();
      // The mount-time attempt hangs on the availability probe, holding inFlightRef true.
      mockCheckAvailability.mockReturnValue(gate.promise);
      mockAuthenticate.mockResolvedValue(true);

      renderComponent();
      await flush();

      // Probe was kicked off once by the mount effect and is still pending.
      expect(mockCheckAvailability).toHaveBeenCalledTimes(1);

      // Tap the scan frame while the first attempt is in flight: haptic still fires,
      // but the guard short-circuits before a second availability probe.
      fireEvent.click(screen.getByRole('button', { name: 'biometricSetUp' }));
      await flush();

      expect(mockHapticLight).toHaveBeenCalledTimes(1);
      expect(mockCheckAvailability).toHaveBeenCalledTimes(1);
      expect(screen.queryByText('biometricConfirmed')).not.toBeInTheDocument();

      // Release the gate; the original attempt completes into the success phase.
      await act(async () => {
        gate.resolve({ isAvailable: true, biometryType: 'fingerprint' });
      });
      await flush();

      expect(screen.getByText('biometricConfirmed')).toBeInTheDocument();
      // Still only ever probed / authenticated once despite the extra tap.
      expect(mockCheckAvailability).toHaveBeenCalledTimes(1);
      expect(mockAuthenticate).toHaveBeenCalledTimes(1);
    });
  });

  it('exposes the same component as its default and named export', () => {
    expect(NamedSetupBiometricScreen).toBe(SetupBiometricScreen);
  });
});
