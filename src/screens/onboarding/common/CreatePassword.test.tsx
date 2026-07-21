import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { CreatePasswordScreen, PasswordStrengthIndicator, PasswordValidation } from './CreatePassword';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// `react-i18next` pulls the full i18n runtime; stub `useTranslation` so `t(key)`
// echoes the key back and every rendered label/placeholder/message is the raw
// key (mirrors the sibling `ExportFileSetNamePassword.test.tsx`).
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `Button` — presentational stub that forwards title/onClick/disabled so the
// CTA wiring and its `disabled={!isValidPassword}` binding are assertable.
jest.mock('components/Button', () => ({
  Button: ({ title, onClick, disabled }: { title?: string; onClick?: () => void; disabled?: boolean }) => (
    <button data-testid="continue-btn" onClick={onClick} disabled={disabled}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'Primary', Secondary: 'Secondary', Ghost: 'Ghost' }
}));

// `Icon` barrel stub: expose the icon name so eye-toggle state is assertable.
jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid="eye-icon" data-name={name} />,
  IconName: { Eye: 'eye', EyeOff: 'eye-off' }
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// len 9 (>= MIN 8, < STRONG 12), mixed case, letters+numbers, special char =>
// 4 validation checks (> 1) but strongPasswordLength false.
const VALID_PASSWORD = 'Abcdef12!';
// len 12 => flips strongPasswordLength true => all 5 checks true.
const STRONG_PASSWORD = 'Abcdef123!@#';

const buildValidation = (overrides: Partial<PasswordValidation> = {}): PasswordValidation => ({
  minChar: false,
  cases: false,
  number: false,
  specialChar: false,
  strongPasswordLength: false,
  ...overrides
});

// ---------------------------------------------------------------------------
// PasswordStrengthIndicator (exported component, tested in isolation so every
// message/color branch and the per-bar ternary are exercised directly).
// ---------------------------------------------------------------------------

describe('PasswordStrengthIndicator', () => {
  it('shows the minimum-chars hint when the password is empty (no bars rendered)', () => {
    render(<PasswordStrengthIndicator password="" validation={buildValidation()} />);
    expect(screen.getByText('minimumCharsWithAtLeast')).toBeInTheDocument();
    // The bar row is only rendered for non-empty passwords.
    expect(screen.queryByText('8chars1number')).not.toBeInTheDocument();
    expect(screen.queryByText('veryStrong')).not.toBeInTheDocument();
  });

  it('renders "veryStrong" with green bars when all five checks pass', () => {
    const { container } = render(
      <PasswordStrengthIndicator
        password="whatever"
        validation={buildValidation({
          minChar: true,
          cases: true,
          number: true,
          specialChar: true,
          strongPasswordLength: true
        })}
      />
    );
    expect(screen.getByText('veryStrong')).toBeInTheDocument();
    // checks === 5 >= every threshold [2,3,5] => all three bars coloured green.
    const bars = container.querySelectorAll('div.h-1.w-10');
    expect(bars).toHaveLength(3);
    bars.forEach(bar => expect(bar).toHaveClass('bg-green-500'));
  });

  it('renders "medium" with yellow bars when four checks pass (third bar stays gray)', () => {
    const { container } = render(
      <PasswordStrengthIndicator
        password="whatever"
        validation={buildValidation({ minChar: true, cases: true, number: true, specialChar: true })}
      />
    );
    expect(screen.getByText('medium')).toBeInTheDocument();
    const bars = container.querySelectorAll('div.h-1.w-10');
    // checks === 4: >= 2 and >= 3 => yellow; >= 5 is false => gray. Covers both
    // arms of the per-bar `validationChecks >= check ? color : 'bg-gray-100'`.
    expect(bars[0]).toHaveClass('bg-yellow-500');
    expect(bars[1]).toHaveClass('bg-yellow-500');
    expect(bars[2]).toHaveClass('bg-gray-100');
  });

  it('renders "medium" when exactly three checks pass (>= 3 boundary)', () => {
    render(
      <PasswordStrengthIndicator
        password="whatever"
        validation={buildValidation({ minChar: true, cases: true, number: true })}
      />
    );
    expect(screen.getByText('medium')).toBeInTheDocument();
  });

  it('renders "low" with red bars when exactly two checks pass', () => {
    const { container } = render(
      <PasswordStrengthIndicator password="whatever" validation={buildValidation({ minChar: true, cases: true })} />
    );
    expect(screen.getByText('low')).toBeInTheDocument();
    const bars = container.querySelectorAll('div.h-1.w-10');
    // checks === 2: only first bar (>= 2) coloured red; the rest gray.
    expect(bars[0]).toHaveClass('bg-red-500');
    expect(bars[1]).toHaveClass('bg-gray-100');
    expect(bars[2]).toHaveClass('bg-gray-100');
  });

  it('renders the "8chars1number" fallback with all-gray bars for a non-empty weak password', () => {
    const { container } = render(
      <PasswordStrengthIndicator password="a" validation={buildValidation({ minChar: true })} />
    );
    expect(screen.getByText('8chars1number')).toBeInTheDocument();
    const bars = container.querySelectorAll('div.h-1.w-10');
    // checks === 1: below every threshold => all bars gray (fallback color).
    bars.forEach(bar => expect(bar).toHaveClass('bg-gray-100'));
  });
});

// ---------------------------------------------------------------------------
// CreatePasswordScreen helpers
// ---------------------------------------------------------------------------

const renderScreen = (props: React.ComponentProps<typeof CreatePasswordScreen> = {}) => {
  const { container } = render(<CreatePasswordScreen {...props} />);

  const passwordInput = screen.getByPlaceholderText('enterPassword') as HTMLInputElement;
  const verifyInput = screen.getByPlaceholderText('enterPasswordAgain') as HTMLInputElement;
  const continueBtn = screen.getByTestId('continue-btn') as HTMLButtonElement;

  const [passwordEyeBtn, verifyEyeBtn] = screen
    .getAllByTestId('eye-icon')
    .map(icon => icon.closest('button') as HTMLButtonElement) as [HTMLButtonElement, HTMLButtonElement];

  const setPassword = (v: string) => fireEvent.change(passwordInput, { target: { value: v } });
  const setVerify = (v: string) => fireEvent.change(verifyInput, { target: { value: v } });

  return {
    container,
    passwordInput,
    verifyInput,
    continueBtn,
    passwordEyeBtn,
    verifyEyeBtn,
    setPassword,
    setVerify
  };
};

// ---------------------------------------------------------------------------
// CreatePasswordScreen
// ---------------------------------------------------------------------------

describe('CreatePasswordScreen', () => {
  afterEach(() => jest.clearAllMocks());

  it('renders headings, both password fields (masked), the terms/privacy links and a disabled CTA', () => {
    const { passwordInput, verifyInput, continueBtn } = renderScreen();

    expect(screen.getByText('createPassword')).toBeInTheDocument();
    expect(screen.getByText('createPasswordDescription')).toBeInTheDocument();

    expect(passwordInput).toHaveAttribute('type', 'password');
    expect(verifyInput).toHaveAttribute('type', 'password');

    const termsLink = screen.getByRole('link', { name: 'termsOfUsage' });
    const privacyLink = screen.getByRole('link', { name: 'privacyPolicy' });
    expect(termsLink).toHaveAttribute('href', 'https://0xmiden.github.io/wallet/privacy/');
    expect(privacyLink).toHaveAttribute('href', 'https://0xmiden.github.io/wallet/privacy/');

    // Nothing typed yet => CTA disabled and the empty-state strength hint shown.
    expect(continueBtn).toHaveTextContent('continue');
    expect(continueBtn).toBeDisabled();
    expect(screen.getByText('minimumCharsWithAtLeast')).toBeInTheDocument();
  });

  it('forwards extra props (className / arbitrary attrs) onto the root container', () => {
    const { container } = renderScreen({ className: 'custom-class', 'data-testid': 'create-pw-root' } as never);
    const root = container.firstChild as HTMLElement;
    expect(root).toHaveClass('custom-class');
    expect(root).toHaveAttribute('data-testid', 'create-pw-root');
  });

  it('updates the password value and recomputes validation as the user types', () => {
    const { passwordInput, setPassword } = renderScreen();

    setPassword(VALID_PASSWORD);
    expect(passwordInput).toHaveValue(VALID_PASSWORD);
    // password.length > 0 => strength row replaces the empty-state hint.
    expect(screen.queryByText('minimumCharsWithAtLeast')).not.toBeInTheDocument();
  });

  it('drives the embedded strength indicator to "veryStrong" for a >= 12 char password', () => {
    const { setPassword } = renderScreen();
    setPassword(STRONG_PASSWORD);
    expect(screen.getByText('veryStrong')).toBeInTheDocument();
  });

  it('toggles the password field visibility and swaps the eye icon both ways', () => {
    const { passwordInput, passwordEyeBtn } = renderScreen();

    expect(passwordInput).toHaveAttribute('type', 'password');
    expect(screen.getAllByTestId('eye-icon')[0]).toHaveAttribute('data-name', 'eye');

    fireEvent.click(passwordEyeBtn);
    expect(passwordInput).toHaveAttribute('type', 'text');
    expect(screen.getAllByTestId('eye-icon')[0]).toHaveAttribute('data-name', 'eye-off');

    fireEvent.click(passwordEyeBtn);
    expect(passwordInput).toHaveAttribute('type', 'password');
    expect(screen.getAllByTestId('eye-icon')[0]).toHaveAttribute('data-name', 'eye');
  });

  it('toggles the verify-password field visibility and swaps the eye icon both ways', () => {
    const { verifyInput, verifyEyeBtn } = renderScreen();

    expect(verifyInput).toHaveAttribute('type', 'password');
    expect(screen.getAllByTestId('eye-icon')[1]).toHaveAttribute('data-name', 'eye');

    fireEvent.click(verifyEyeBtn);
    expect(verifyInput).toHaveAttribute('type', 'text');
    expect(screen.getAllByTestId('eye-icon')[1]).toHaveAttribute('data-name', 'eye-off');

    fireEvent.click(verifyEyeBtn);
    expect(verifyInput).toHaveAttribute('type', 'password');
    expect(screen.getAllByTestId('eye-icon')[1]).toHaveAttribute('data-name', 'eye');
  });

  it('moves focus from the password field to the verify field on Tab', () => {
    const { passwordInput, verifyInput } = renderScreen();
    fireEvent.keyDown(passwordInput, { key: 'Tab' });
    expect(document.activeElement).toBe(verifyInput);
  });

  it('ignores non-Tab keys on the password field (no focus move)', () => {
    const { passwordInput, verifyInput } = renderScreen();
    passwordInput.focus();
    fireEvent.keyDown(passwordInput, { key: 'a' });
    expect(document.activeElement).toBe(passwordInput);
    expect(document.activeElement).not.toBe(verifyInput);
  });

  it('shows the match message and enables + submits the CTA when everything is valid', () => {
    const onSubmit = jest.fn();
    const { setPassword, setVerify, continueBtn } = renderScreen({ onSubmit });

    setPassword(VALID_PASSWORD);
    setVerify(VALID_PASSWORD);

    expect(screen.getByText('itsAMatch')).toHaveClass('block');
    expect(screen.getByText('passwordsDoNotMatch')).toHaveClass('hidden');

    expect(continueBtn).not.toBeDisabled();
    fireEvent.click(continueBtn);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(VALID_PASSWORD);
  });

  it('shows the mismatch message and keeps the CTA disabled when verify differs and is at least as long', () => {
    const onSubmit = jest.fn();
    const { setPassword, setVerify, continueBtn } = renderScreen({ onSubmit });

    setPassword(VALID_PASSWORD);
    setVerify(`${VALID_PASSWORD}X`); // longer + different

    expect(screen.getByText('passwordsDoNotMatch')).toHaveClass('block');
    expect(screen.getByText('itsAMatch')).toHaveClass('hidden');
    expect(continueBtn).toBeDisabled();

    // Clicking a disabled/invalid CTA must not invoke onSubmit.
    fireEvent.click(continueBtn);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps both match/mismatch messages hidden while verify is shorter than the password', () => {
    const { setPassword, setVerify } = renderScreen();

    setPassword(VALID_PASSWORD);
    setVerify('Abc'); // shorter => mismatch row stays hidden

    expect(screen.getByText('passwordsDoNotMatch')).toHaveClass('hidden');
    expect(screen.getByText('itsAMatch')).toHaveClass('hidden');
  });

  it('keeps the CTA disabled (and match hidden) for a too-weak password even when the fields are equal', () => {
    const { setPassword, setVerify, continueBtn } = renderScreen();

    // Single char => 0 validation checks => count not > 1 => isValidPassword false.
    setPassword('a');
    setVerify('a');

    expect(continueBtn).toBeDisabled();
    expect(screen.getByText('itsAMatch')).toHaveClass('hidden');
    // Equal values => mismatch row also hidden (password === verifyPassword).
    expect(screen.getByText('passwordsDoNotMatch')).toHaveClass('hidden');
  });

  it('submits on Enter in the verify field only when the password is valid', () => {
    const onSubmit = jest.fn();
    const { setPassword, setVerify, verifyInput } = renderScreen({ onSubmit });

    setPassword(VALID_PASSWORD);
    setVerify(VALID_PASSWORD);

    fireEvent.keyDown(verifyInput, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(VALID_PASSWORD);
  });

  it('does not submit on Enter when the passwords do not match', () => {
    const onSubmit = jest.fn();
    const { setPassword, setVerify, verifyInput } = renderScreen({ onSubmit });

    setPassword(VALID_PASSWORD);
    setVerify(`${VALID_PASSWORD}X`);

    fireEvent.keyDown(verifyInput, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('ignores non-Enter keys on the verify field', () => {
    const onSubmit = jest.fn();
    const { setPassword, setVerify, verifyInput } = renderScreen({ onSubmit });

    setPassword(VALID_PASSWORD);
    setVerify(VALID_PASSWORD);

    fireEvent.keyDown(verifyInput, { key: 'a' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not throw when a valid password is submitted with no onSubmit handler (click)', () => {
    const { setPassword, setVerify, continueBtn } = renderScreen();

    setPassword(VALID_PASSWORD);
    setVerify(VALID_PASSWORD);

    expect(continueBtn).not.toBeDisabled();
    // isValidPassword true but onSubmit undefined => the guard short-circuits.
    expect(() => fireEvent.click(continueBtn)).not.toThrow();
  });

  it('does not throw when Enter is pressed on a valid password with no onSubmit handler', () => {
    const { setPassword, setVerify, verifyInput } = renderScreen();

    setPassword(VALID_PASSWORD);
    setVerify(VALID_PASSWORD);

    // Enter + valid + onSubmit undefined => handleEnterKey guard short-circuits.
    expect(() => fireEvent.keyDown(verifyInput, { key: 'Enter' })).not.toThrow();
  });
});
