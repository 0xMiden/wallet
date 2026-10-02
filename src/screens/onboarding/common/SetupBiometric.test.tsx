import React from 'react';

import { render, screen, fireEvent, act } from '@testing-library/react';

import { authenticate, checkBiometricAvailability, checkBiometricSetup, openBiometricSettings } from 'lib/biometric';
import { hapticLight } from 'lib/mobile/haptics';
import { isAndroid, isIOS, isMobile } from 'lib/platform';

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
  isAndroid: jest.fn(),
  isIOS: jest.fn(),
  isMobile: jest.fn()
}));

// `lib/biometric` — the native availability probe + auth prompt. Avoids pulling
// the Capacitor plugin; controlled per test.
jest.mock('lib/biometric', () => ({
  checkBiometricAvailability: jest.fn(),
  checkBiometricSetup: jest.fn(),
  openBiometricSettings: jest.fn(),
  authenticate: jest.fn()
}));

// `lib/mobile/haptics` — the retry haptic; stub so no Capacitor Haptics import.
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

// ---------------------------------------------------------------------------
// Typed handles onto the mocked modules
// ---------------------------------------------------------------------------

const mockIsAndroid = isAndroid as jest.Mock;
const mockIsIOS = isIOS as jest.Mock;
const mockIsMobile = isMobile as jest.Mock;
const mockCheckAvailability = checkBiometricAvailability as jest.Mock;
const mockCheckSetup = checkBiometricSetup as jest.Mock;
const mockOpenSettings = openBiometricSettings as jest.Mock;
const mockAuthenticate = authenticate as jest.Mock;
const mockHapticLight = hapticLight as jest.Mock;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AVAILABLE = { available: true, reason: null, managedProfile: false };
const blockedBy = (reason: string, managedProfile = false) => ({ available: false, reason, managedProfile });

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
  mockIsAndroid.mockReturnValue(false);
  mockIsIOS.mockReturnValue(false);
  mockIsMobile.mockReturnValue(true);
  mockCheckAvailability.mockResolvedValue({ isAvailable: true, biometryType: 'fingerprint' });
  mockCheckSetup.mockResolvedValue(AVAILABLE);
  mockOpenSettings.mockResolvedValue(true);
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
      mockCheckSetup.mockResolvedValue(blockedBy('unknown'));

      renderComponent();
      await flush();

      expect(screen.getByText('biometricUnavailable')).toBeInTheDocument();
      expect(mockCheckSetup).toHaveBeenCalledTimes(1);
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
      expect(mockCheckSetup).toHaveBeenCalledTimes(1);
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
      const gate = deferred<typeof AVAILABLE>();
      // The mount-time attempt hangs on the availability probe, holding inFlightRef true.
      mockCheckSetup.mockReturnValue(gate.promise);
      mockAuthenticate.mockResolvedValue(true);

      renderComponent();
      await flush();

      // Probe was kicked off once by the mount effect and is still pending.
      expect(mockCheckSetup).toHaveBeenCalledTimes(1);

      // Tap the scan frame while the first attempt is in flight: haptic still fires,
      // but the guard short-circuits before a second availability probe.
      fireEvent.click(screen.getByRole('button', { name: 'biometricSetUp' }));
      await flush();

      expect(mockHapticLight).toHaveBeenCalledTimes(1);
      expect(mockCheckSetup).toHaveBeenCalledTimes(1);
      expect(screen.queryByText('biometricConfirmed')).not.toBeInTheDocument();

      // Release the gate; the original attempt completes into the success phase.
      await act(async () => {
        gate.resolve(AVAILABLE);
      });
      await flush();

      expect(screen.getByText('biometricConfirmed')).toBeInTheDocument();
      // Still only ever probed / authenticated once despite the extra tap.
      expect(mockCheckSetup).toHaveBeenCalledTimes(1);
      expect(mockAuthenticate).toHaveBeenCalledTimes(1);
    });
  });

  describe('why biometrics are unavailable (checkBiometricSetup)', () => {
    it('asks checkBiometricSetup, never the weaker checkBiometricAvailability', async () => {
      renderComponent();
      await flush();

      expect(mockCheckSetup).toHaveBeenCalledTimes(1);
      expect(mockCheckAvailability).not.toHaveBeenCalled();
      expect(screen.getByText('biometricConfirmed')).toBeInTheDocument();
    });

    it.each([
      ['none-enrolled', false, 'biometricNotEnrolled'],
      ['none-enrolled', true, 'biometricNotEnrolledWork'],
      ['no-strong-biometric', false, 'biometricNotStrong'],
      ['no-strong-biometric', true, 'biometricNotStrong'],
      ['hardware-unavailable', false, 'biometricHardwareUnavailable'],
      ['security-update-required', false, 'biometricSecurityUpdate'],
      ['passcode-not-set', false, 'biometricPasscodeNotSet'],
      ['locked-out', false, 'biometricLockedOut'],
      ['unknown', false, 'biometricUnavailable']
    ])('shows the %s message (managed profile: %s) with the passcode fallback', async (reason, managed, message) => {
      mockCheckSetup.mockResolvedValue(blockedBy(reason, managed));

      renderComponent();
      await flush();

      expect(screen.getByText(message)).toBeInTheDocument();
      expect(mockAuthenticate).not.toHaveBeenCalled();
      expect(screen.getByTestId('btn-usePasscodeInstead')).toBeInTheDocument();
    });

    it('keeps the work message to a managed profile', async () => {
      mockCheckSetup.mockResolvedValue(blockedBy('none-enrolled'));

      renderComponent();
      await flush();

      expect(screen.getByText('biometricNotEnrolled')).toBeInTheDocument();
      expect(screen.queryByText('biometricNotEnrolledWork')).not.toBeInTheDocument();
    });
  });

  describe('Open Settings', () => {
    it.each([false, true])(
      'sits above the passcode fallback on Android with no biometric enrolled (managed profile: %s)',
      async managed => {
        mockIsAndroid.mockReturnValue(true);
        mockCheckSetup.mockResolvedValue(blockedBy('none-enrolled', managed));

        renderComponent();
        await flush();

        const passcode = screen.getByTestId('btn-usePasscodeInstead');
        expect(screen.getByTestId('btn-openSettings').compareDocumentPosition(passcode)).toBe(
          Node.DOCUMENT_POSITION_FOLLOWING
        );
      }
    );

    it.each([
      ['none-enrolled', 'iOS', false],
      ['no-strong-biometric', 'Android', true],
      ['hardware-unavailable', 'Android', true],
      ['security-update-required', 'Android', true],
      ['unknown', 'Android', true]
    ])('is not offered for %s on %s', async (reason, _platform, android) => {
      mockIsAndroid.mockReturnValue(android);
      mockCheckSetup.mockResolvedValue(blockedBy(reason));

      renderComponent();
      await flush();

      expect(screen.getByTestId('btn-usePasscodeInstead')).toBeInTheDocument();
      expect(screen.queryByTestId('btn-openSettings')).not.toBeInTheDocument();
    });

    it('is not offered after a failed prompt on Android', async () => {
      mockIsAndroid.mockReturnValue(true);
      mockAuthenticate.mockResolvedValue(false);

      renderComponent();
      await flush();

      expect(mockCheckSetup).toHaveBeenCalledTimes(1);
      expect(screen.getByText('biometricFailed')).toBeInTheDocument();
      expect(screen.queryByTestId('btn-openSettings')).not.toBeInTheDocument();
    });

    it.each([true, false])('opens Settings on tap and leaves the screen as it is (opened: %s)', async opened => {
      mockIsAndroid.mockReturnValue(true);
      mockCheckSetup.mockResolvedValue(blockedBy('none-enrolled', true));
      mockOpenSettings.mockResolvedValue(opened);

      renderComponent();
      await flush();
      fireEvent.click(screen.getByTestId('btn-openSettings'));
      await flush();

      expect(mockOpenSettings).toHaveBeenCalledTimes(1);
      expect(screen.getByText('biometricNotEnrolledWork')).toBeInTheDocument();
      expect(screen.getByTestId('btn-openSettings')).toBeInTheDocument();
      expect(screen.getByTestId('btn-usePasscodeInstead')).toBeInTheDocument();
      expect(mockCheckSetup).toHaveBeenCalledTimes(1);
      expect(mockAuthenticate).not.toHaveBeenCalled();
    });
  });

  describe('returning to the app (visibilitychange)', () => {
    const spyVisibility = () => jest.spyOn(document, 'visibilityState', 'get');
    let visibility: ReturnType<typeof spyVisibility>;

    const switchTo = async (state: DocumentVisibilityState) => {
      visibility.mockReturnValue(state);
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await flush();
    };

    const returnToApp = async () => {
      await switchTo('hidden');
      await switchTo('visible');
    };

    beforeEach(() => {
      visibility = spyVisibility().mockReturnValue('visible');
    });

    afterEach(() => {
      visibility.mockRestore();
    });

    it('checks again on return after an availability failure, and prompts once a biometric is enrolled', async () => {
      mockIsAndroid.mockReturnValue(true);
      mockCheckSetup.mockResolvedValueOnce(blockedBy('none-enrolled', true));

      renderComponent();
      await flush();
      expect(screen.getByText('biometricNotEnrolledWork')).toBeInTheDocument();

      await returnToApp();

      expect(mockCheckSetup).toHaveBeenCalledTimes(2);
      expect(mockAuthenticate).toHaveBeenCalledTimes(1);
      expect(screen.getByText('biometricConfirmed')).toBeInTheDocument();
    });

    it('does not check again when the app only goes to the background', async () => {
      mockCheckSetup.mockResolvedValueOnce(blockedBy('none-enrolled'));

      renderComponent();
      await flush();
      await switchTo('hidden');

      expect(mockCheckSetup).toHaveBeenCalledTimes(1);
      expect(screen.getByText('biometricNotEnrolled')).toBeInTheDocument();
    });

    it('keeps the message and Open Settings when still unavailable, and checks again on the next return', async () => {
      mockIsAndroid.mockReturnValue(true);
      mockCheckSetup.mockResolvedValue(blockedBy('none-enrolled', true));

      renderComponent();
      await flush();
      await returnToApp();

      expect(mockCheckSetup).toHaveBeenCalledTimes(2);
      expect(screen.getByText('biometricNotEnrolledWork')).toBeInTheDocument();
      expect(screen.getByTestId('btn-openSettings')).toBeInTheDocument();

      await returnToApp();

      expect(mockCheckSetup).toHaveBeenCalledTimes(3);
      expect(mockAuthenticate).not.toHaveBeenCalled();
    });

    it('does not prompt again on return after the prompt was cancelled', async () => {
      mockAuthenticate.mockResolvedValue(false);

      renderComponent();
      await flush();
      expect(screen.getByText('biometricFailed')).toBeInTheDocument();

      await returnToApp();

      expect(mockCheckSetup).toHaveBeenCalledTimes(1);
      expect(mockAuthenticate).toHaveBeenCalledTimes(1);
    });

    it('does not prompt again on return after a re-check reached the prompt and it was cancelled', async () => {
      mockCheckSetup.mockResolvedValueOnce(blockedBy('none-enrolled'));
      mockAuthenticate.mockResolvedValue(false);

      renderComponent();
      await flush();
      await returnToApp();

      expect(mockAuthenticate).toHaveBeenCalledTimes(1);
      expect(screen.getByText('biometricFailed')).toBeInTheDocument();

      await returnToApp();

      expect(mockCheckSetup).toHaveBeenCalledTimes(2);
      expect(mockAuthenticate).toHaveBeenCalledTimes(1);
    });

    it('starts no second check or prompt while the prompt is open, even when it hides the app', async () => {
      const prompt = deferred<boolean>();
      mockCheckSetup.mockResolvedValueOnce(blockedBy('none-enrolled'));
      mockAuthenticate.mockReturnValue(prompt.promise);

      renderComponent();
      await flush();
      await returnToApp();
      expect(mockAuthenticate).toHaveBeenCalledTimes(1);

      await returnToApp();
      await returnToApp();

      expect(mockCheckSetup).toHaveBeenCalledTimes(2);
      expect(mockAuthenticate).toHaveBeenCalledTimes(1);

      await act(async () => {
        prompt.resolve(true);
      });
      await flush();

      expect(screen.getByText('biometricConfirmed')).toBeInTheDocument();
    });

    it('stops listening once setup succeeds', async () => {
      mockCheckSetup.mockResolvedValueOnce(blockedBy('none-enrolled'));

      renderComponent();
      await flush();
      await returnToApp();
      expect(screen.getByText('biometricConfirmed')).toBeInTheDocument();

      await returnToApp();

      expect(mockCheckSetup).toHaveBeenCalledTimes(2);
      expect(mockAuthenticate).toHaveBeenCalledTimes(1);
    });

    it('stops listening when the screen unmounts', async () => {
      mockCheckSetup.mockResolvedValue(blockedBy('none-enrolled'));

      const { unmount } = renderComponent();
      await flush();
      unmount();
      await returnToApp();

      expect(mockCheckSetup).toHaveBeenCalledTimes(1);
    });
  });

  it('exposes the same component as its default and named export', () => {
    expect(NamedSetupBiometricScreen).toBe(SetupBiometricScreen);
  });
});
