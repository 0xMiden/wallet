import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import VerifySeedPhraseFlow from './VerifySeedPhraseFlow';

// ---------------------------------------------------------------------------
// Mutable state the mocks read at call time (must be `mock`-prefixed for jest).
// ---------------------------------------------------------------------------
const mockRevealMnemonic = jest.fn();
const mockHasHardwareProtector = jest.fn();
const mockCompleteWalletPrompt = jest.fn();
const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockHapticLight = jest.fn();
const mockHapticMedium = jest.fn();
let mockIsMobile = false;

// ---------------------------------------------------------------------------
// Module mocks. Each external/native dependency is replaced with a light stub
// so the flow renders in jsdom without pulling in Capacitor / wasm / woozie.
// ---------------------------------------------------------------------------
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// Alert surfaces the hardware-unlock `authError`; render its description so we
// can assert the error text made it to the screen.
jest.mock('app/atoms/Alert', () => ({
  __esModule: true,
  default: ({ description }: { description?: string }) => <div role="alert">{description}</div>
}));

// A functional input mock so react-hook-form can register the password field
// and drive `watch('password')`. Forwards ref/name/type/onChange plus the
// error caption so the submit-error path is observable.
jest.mock('app/atoms/FormField', () =>
  React.forwardRef(
    (
      {
        name,
        type,
        id,
        placeholder,
        onChange,
        onBlur,
        errorCaption
      }: {
        name?: string;
        type?: string;
        id?: string;
        placeholder?: string;
        onChange?: React.ChangeEventHandler<HTMLInputElement>;
        onBlur?: React.FocusEventHandler<HTMLInputElement>;
        errorCaption?: string;
      },
      ref: React.Ref<HTMLInputElement>
    ) => (
      <div>
        <input
          ref={ref}
          name={name}
          type={type}
          id={id}
          placeholder={placeholder}
          onChange={onChange}
          onBlur={onBlur}
        />
        {errorCaption ? <span data-testid="error-caption">{errorCaption}</span> : null}
      </div>
    )
  )
);

jest.mock('components/Button', () => ({
  Button: ({
    onClick,
    title,
    disabled,
    isLoading
  }: {
    onClick?: () => void;
    title: string;
    disabled?: boolean;
    isLoading?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled} data-loading={String(!!isLoading)}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'Primary', Secondary: 'Secondary' }
}));

jest.mock('components/NavigationHeader', () => ({
  NavigationHeader: ({ title, onBack }: { title: string; onBack?: () => void }) => (
    <div>
      <span data-testid="nav-title">{title}</span>
      {onBack ? (
        <button data-testid="nav-back" onClick={onBack}>
          back
        </button>
      ) : null}
    </div>
  )
}));

// Mobile passcode-protected vaults render the numpad instead of a password
// field. Mock it so we can drive its onChange/onSubmit callbacks.
jest.mock('components/PasscodeEntry', () => ({
  PasscodeEntry: ({
    onSubmit,
    onChange,
    error,
    isSubmitting
  }: {
    onSubmit: (code: string) => void;
    onChange: (code: string) => void;
    error?: string | null;
    isSubmitting?: boolean;
  }) => (
    <div>
      <span data-testid="passcode-error">{error ?? ''}</span>
      <span data-testid="passcode-submitting">{String(!!isSubmitting)}</span>
      <button data-testid="passcode-change" onClick={() => onChange('1')}>
        passcode-change
      </button>
      <button data-testid="passcode-submit" onClick={() => onSubmit('123456')}>
        passcode-submit
      </button>
    </div>
  )
}));

jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: { EyeOff: 'EyeOff' }
}));

jest.mock('lib/miden/back/vault', () => ({
  Vault: { hasHardwareProtector: () => mockHasHardwareProtector() }
}));

jest.mock('lib/miden/front', () => ({
  useMidenContext: () => ({ revealMnemonic: mockRevealMnemonic })
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: () => mockHapticLight(),
  hapticMedium: () => mockHapticMedium()
}));

jest.mock('lib/platform', () => ({
  isMobile: () => mockIsMobile
}));

jest.mock('lib/wallet-prompts', () => ({
  completeWalletPrompt: (...args: unknown[]) => mockCompleteWalletPrompt(...args),
  WalletPromptType: { VerifySeedPhrase: 'verifySeedPhrase' }
}));

jest.mock('lib/woozie', () => ({
  navigate: (...args: unknown[]) => mockNavigate(...args),
  goBack: (...args: unknown[]) => mockGoBack(...args)
}));

// The quiz step delegates to the onboarding VerifySeedPhraseScreen. Mock it to
// expose the words it received plus a button that fires its onSubmit.
jest.mock('screens/onboarding/create-wallet-flow/VerifySeedPhrase', () => ({
  VerifySeedPhraseScreen: ({ seedPhrase, onSubmit }: { seedPhrase: string[]; onSubmit?: () => void }) => (
    <div data-testid="quiz-screen" data-words={seedPhrase.join(',')}>
      <button data-testid="quiz-submit" onClick={() => onSubmit?.()}>
        quiz-submit
      </button>
    </div>
  )
}));

const TWELVE = 'w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12';

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

// Render, then flush the Vault.hasHardwareProtector() promise so the warning
// view settles into a known hasHardwareProtector state.
const renderFlow = async () => {
  const utils = render(<VerifySeedPhraseFlow />);
  await flush();
  return utils;
};

const clickText = (text: string) => {
  fireEvent.click(screen.getByText(text));
};

describe('VerifySeedPhraseFlow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsMobile = false;
    mockHasHardwareProtector.mockResolvedValue(false);
    mockRevealMnemonic.mockResolvedValue(TWELVE);
    mockCompleteWalletPrompt.mockResolvedValue(undefined);
  });

  it('disables the continue button while the hardware-protector probe is pending', async () => {
    // Never-resolving probe keeps hasHardwareProtector === null.
    mockHasHardwareProtector.mockReturnValue(new Promise(() => {}));
    render(<VerifySeedPhraseFlow />);

    expect((screen.getByText('continue') as HTMLButtonElement).disabled).toBe(true);
    // Warning view has no authError alert on first render.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('falls back to hasHardwareProtector=false when the probe rejects', async () => {
    mockHasHardwareProtector.mockRejectedValue(new Error('probe failed'));
    await renderFlow();

    // With the probe rejected, continue is enabled and leads to the auth step.
    expect((screen.getByText('continue') as HTMLButtonElement).disabled).toBe(false);
    clickText('continue');
    expect(screen.getByText('enterPassword')).toBeTruthy();
  });

  it('exits from the warning header back button', async () => {
    await renderFlow();
    fireEvent.click(screen.getByTestId('nav-back'));
    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('exits from the warning close button', async () => {
    await renderFlow();
    clickText('close');
    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('goes to the desktop password step when no hardware protector is present', async () => {
    mockIsMobile = false;
    await renderFlow();
    clickText('continue');
    expect(mockHapticMedium).toHaveBeenCalledTimes(1);
    expect(screen.getByText('enterPassword')).toBeTruthy();
    // Password empty -> submit disabled.
    expect((screen.getByText('continue') as HTMLButtonElement).disabled).toBe(true);
  });

  it('returns to the warning step from the auth header back button', async () => {
    await renderFlow();
    clickText('continue');
    fireEvent.click(screen.getByTestId('nav-back'));
    // Back on the warning step: the private-place heading is shown again.
    expect(screen.getByText('viewThisInPrivatePlace')).toBeTruthy();
  });

  it('reveals the phrase with a typed password and advances to review', async () => {
    await renderFlow();
    clickText('continue');

    const input = screen.getByPlaceholderText('********') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'my-password' } });

    const submit = screen.getByText('continue') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await flush();

    expect(mockRevealMnemonic).toHaveBeenCalledWith('my-password');
    // Review step lists all 12 words.
    expect(screen.getByText('w1')).toBeTruthy();
    expect(screen.getByText('w12')).toBeTruthy();
  });

  it('submits the desktop password form via its onSubmit handler', async () => {
    await renderFlow();
    clickText('continue');

    const input = screen.getByPlaceholderText('********') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'form-pass' } });
    // Submit through the <form> element rather than the button.
    fireEvent.submit(input.closest('form')!);
    await flush();

    expect(mockRevealMnemonic).toHaveBeenCalledWith('form-pass');
  });

  it('surfaces a form error after a failed password unlock', async () => {
    mockRevealMnemonic.mockRejectedValue(new Error('bad password'));
    await renderFlow();
    clickText('continue');

    const input = screen.getByPlaceholderText('********') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'wrong' } });
    fireEvent.click(screen.getByText('continue'));

    // The catch waits 300ms before setError; waitFor polls until it lands.
    await waitFor(() => expect(screen.getByTestId('error-caption')).toHaveTextContent('bad password'));
    // Still on the auth step; no review words rendered.
    expect(screen.queryByText('w1')).toBeNull();
  });

  it('drives the mobile passcode numpad to reveal the phrase', async () => {
    mockIsMobile = true;
    await renderFlow();
    clickText('continue');

    // No password field in the mobile passcode flow.
    expect(screen.queryByPlaceholderText('********')).toBeNull();
    expect(screen.getByText('enterYourPasscode')).toBeTruthy();

    fireEvent.click(screen.getByTestId('passcode-change'));
    fireEvent.click(screen.getByTestId('passcode-submit'));
    await flush();

    expect(mockRevealMnemonic).toHaveBeenCalledWith('123456');
    expect(screen.getByText('w1')).toBeTruthy();
  });

  it('ignores a second submit while a reveal is already in flight', async () => {
    mockIsMobile = true;
    let resolveReveal: (v: string) => void = () => {};
    mockRevealMnemonic.mockImplementation(
      () =>
        new Promise<string>(res => {
          resolveReveal = res;
        })
    );
    await renderFlow();
    clickText('continue');

    // First submit starts the (still pending) reveal.
    fireEvent.click(screen.getByTestId('passcode-submit'));
    await flush();
    // Second submit hits the `isSubmitting` guard and is a no-op.
    fireEvent.click(screen.getByTestId('passcode-submit'));
    await flush();

    expect(mockRevealMnemonic).toHaveBeenCalledTimes(1);
    // isSubmitting is reflected onto the PasscodeEntry.
    expect(screen.getByTestId('passcode-submitting')).toHaveTextContent('true');

    await act(async () => {
      resolveReveal(TWELVE);
      await Promise.resolve();
    });
  });

  it('returns to the warning step from the mobile auth header back button', async () => {
    mockIsMobile = true;
    await renderFlow();
    clickText('continue');
    expect(screen.getByText('enterYourPasscode')).toBeTruthy();

    fireEvent.click(screen.getByTestId('nav-back'));
    expect(screen.getByText('viewThisInPrivatePlace')).toBeTruthy();
  });

  it('reveals immediately via the hardware protector, skipping the auth step', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    await renderFlow();
    clickText('continue');
    await flush();

    expect(mockHapticMedium).toHaveBeenCalledTimes(1);
    expect(mockRevealMnemonic).toHaveBeenCalledWith(undefined);
    // Straight to review, no password prompt.
    expect(screen.queryByText('enterPassword')).toBeNull();
    expect(screen.getByText('w1')).toBeTruthy();
  });

  it('shows an inline alert when the hardware unlock fails (Error)', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    mockRevealMnemonic.mockRejectedValue(new Error('device locked'));
    await renderFlow();
    clickText('continue');
    await flush();

    // Stays on warning with the error alert populated.
    expect(screen.getByRole('alert')).toHaveTextContent('device locked');
    expect(screen.getByText('viewThisInPrivatePlace')).toBeTruthy();
  });

  it('stringifies non-Error hardware unlock rejections in the alert', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    mockRevealMnemonic.mockRejectedValue('boom-string');
    await renderFlow();
    clickText('continue');
    await flush();

    expect(screen.getByRole('alert')).toHaveTextContent('boom-string');
  });

  it('advances review -> quiz and completes the flow', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    await renderFlow();
    clickText('continue');
    await flush();

    // Review step: continue to the quiz.
    clickText('continue');
    const quiz = screen.getByTestId('quiz-screen');
    expect(quiz.getAttribute('data-words')).toBe('w1,w2,w3,w4,w5,w6,w7,w8,w9,w10,w11,w12');

    fireEvent.click(screen.getByTestId('quiz-submit'));
    await flush();

    expect(mockHapticMedium).toHaveBeenCalledTimes(2); // warning-continue + complete
    expect(mockCompleteWalletPrompt).toHaveBeenCalledWith('verifySeedPhrase');
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('returns from the quiz step to review via the header back button', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    await renderFlow();
    clickText('continue');
    await flush();
    clickText('continue');
    expect(screen.getByTestId('quiz-screen')).toBeTruthy();

    fireEvent.click(screen.getByTestId('nav-back'));
    // Back on review: the review body text is shown and quiz screen is gone.
    expect(screen.getByText('verifySeedPhraseReviewBody')).toBeTruthy();
    expect(screen.queryByTestId('quiz-screen')).toBeNull();
  });

  it('exits from the review header back button', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    await renderFlow();
    clickText('continue');
    await flush();

    fireEvent.click(screen.getByTestId('nav-back'));
    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('resets to the warning step when the revealed phrase is not 12 words', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    mockRevealMnemonic.mockResolvedValue('only three words');
    await renderFlow();
    clickText('continue');
    await flush();

    // The guard effect bounces an invalid-length phrase back to the warning step.
    expect(screen.getByText('viewThisInPrivatePlace')).toBeTruthy();
    expect(screen.queryByTestId('quiz-screen')).toBeNull();
  });

  it('clears the passcode error via the numpad onChange', async () => {
    mockIsMobile = true;
    mockRevealMnemonic.mockRejectedValue(new Error('nope'));
    await renderFlow();
    clickText('continue');

    // Trigger a failed submit so a form error is registered, then clear it.
    fireEvent.click(screen.getByTestId('passcode-submit'));
    await waitFor(() => expect(screen.getByTestId('passcode-error')).toHaveTextContent('nope'));

    fireEvent.click(screen.getByTestId('passcode-change'));
    await flush();
    expect(screen.getByTestId('passcode-error')).toHaveTextContent('');
  });
});
