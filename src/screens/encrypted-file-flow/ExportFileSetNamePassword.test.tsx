import React, { useState } from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import ExportFilePassword, { ExportFilePasswordProps } from './ExportFileSetNamePassword';

// --- i18n: t returns the key verbatim so labels/placeholders/messages are
//     assertable by their translation key.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// --- Button: presentational stub that forwards title/onClick/disabled.
jest.mock('components/Button', () => ({
  Button: ({ title, onClick, disabled }: { title?: string; onClick?: () => void; disabled?: boolean }) => (
    <button data-testid="continue-btn" onClick={onClick} disabled={disabled}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'Primary', Secondary: 'Secondary', Ghost: 'Ghost' }
}));

// --- Icon barrel stub: expose the icon name so eye-toggle state is assertable.
jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid="eye-icon" data-name={name} />,
  IconName: { Eye: 'eye', EyeOff: 'eye-off' }
}));

// --- Password strength indicator: lightweight stub (its internals live in
//     CreatePassword.tsx and are out of scope for this file's coverage).
jest.mock('screens/onboarding/common/CreatePassword', () => ({
  __esModule: true,
  PasswordStrengthIndicator: ({
    password,
    validation
  }: {
    password: string;
    validation: Record<string, boolean | undefined>;
  }) => (
    <div
      data-testid="password-strength"
      data-password={password}
      data-valid-count={Object.values(validation).filter(Boolean).length}
    />
  )
}));

// A strong, mutually-consistent password: len 9 (>= MIN 8, < STRONG 12),
// mixed case, letters+numbers, special char => 4 validation checks (> 1).
const VALID_PASSWORD = 'Abcdef12!';

// A harness that owns `passwordValue` and `fileName` (which the SUT treats as
// controlled props) so typing actually round-trips through the component.
const Harness: React.FC<{
  onGoNext?: () => void;
  onGoBack?: () => void;
  initialPassword?: string;
  initialFileName?: string;
}> = ({ onGoNext = jest.fn(), onGoBack = jest.fn(), initialPassword = '', initialFileName = '' }) => {
  const [passwordValue, setPasswordValue] = useState(initialPassword);
  const [fileName, setFileName] = useState(initialFileName);
  const props: ExportFilePasswordProps = {
    onGoNext,
    onGoBack,
    passwordValue,
    handlePasswordChange: e => setPasswordValue(e.target.value),
    fileName,
    onFileNameChange: e => setFileName(e.target.value)
  };
  return <ExportFilePassword {...props} />;
};

const renderHarness = (overrides: Partial<React.ComponentProps<typeof Harness>> = {}) => {
  const onGoNext = overrides.onGoNext ?? jest.fn();
  const onGoBack = overrides.onGoBack ?? jest.fn();
  render(<Harness {...overrides} onGoNext={onGoNext} onGoBack={onGoBack} />);

  const nameInput = screen.getByPlaceholderText('Encrypted Wallet File') as HTMLInputElement;
  const passwordInput = screen.getByPlaceholderText('enterPassword') as HTMLInputElement;
  const verifyInput = screen.getByPlaceholderText('enterPasswordAgain') as HTMLInputElement;
  const continueBtn = screen.getByTestId('continue-btn') as HTMLButtonElement;

  const [passwordEyeBtn, verifyEyeBtn] = screen
    .getAllByTestId('eye-icon')
    .map(icon => icon.closest('button') as HTMLButtonElement);

  const setName = (v: string) => fireEvent.change(nameInput, { target: { value: v } });
  const setPassword = (v: string) => fireEvent.change(passwordInput, { target: { value: v } });
  const setVerify = (v: string) => fireEvent.change(verifyInput, { target: { value: v } });

  return {
    onGoNext,
    onGoBack,
    nameInput,
    passwordInput,
    verifyInput,
    continueBtn,
    passwordEyeBtn,
    verifyEyeBtn,
    setName,
    setPassword,
    setVerify
  };
};

describe('ExportFilePassword', () => {
  afterEach(() => jest.clearAllMocks());

  it('renders the name field (with .json suffix), both password fields and the disabled CTA', () => {
    const { nameInput, passwordInput, verifyInput, continueBtn } = renderHarness();

    expect(nameInput).toBeInTheDocument();
    expect(passwordInput).toHaveAttribute('type', 'password');
    expect(verifyInput).toHaveAttribute('type', 'password');

    // Static copy rendered via the key-returning t().
    expect(screen.getByText('enterPasswordToEncrypt')).toBeInTheDocument();
    expect(screen.getByText('.json')).toBeInTheDocument();
    expect(continueBtn).toHaveTextContent('continue');

    // Nothing entered yet => CTA disabled.
    expect(continueBtn).toBeDisabled();
  });

  it('reflects password validation counts through to the strength indicator', () => {
    const { setPassword } = renderHarness();
    // Starts with an empty password (0 checks).
    expect(screen.getByTestId('password-strength')).toHaveAttribute('data-valid-count', '0');

    setPassword(VALID_PASSWORD);
    const strength = screen.getByTestId('password-strength');
    expect(strength).toHaveAttribute('data-password', VALID_PASSWORD);
    // minChar + cases + number + specialChar = 4 (strongPasswordLength is false at len 9).
    expect(strength).toHaveAttribute('data-valid-count', '4');
  });

  it('toggles password field visibility and swaps the eye icon', () => {
    const { passwordInput, passwordEyeBtn } = renderHarness();

    expect(passwordInput).toHaveAttribute('type', 'password');
    expect(screen.getAllByTestId('eye-icon')[0]).toHaveAttribute('data-name', 'eye');

    fireEvent.click(passwordEyeBtn);
    expect(passwordInput).toHaveAttribute('type', 'text');
    expect(screen.getAllByTestId('eye-icon')[0]).toHaveAttribute('data-name', 'eye-off');

    fireEvent.click(passwordEyeBtn);
    expect(passwordInput).toHaveAttribute('type', 'password');
    expect(screen.getAllByTestId('eye-icon')[0]).toHaveAttribute('data-name', 'eye');
  });

  it('toggles verify-password field visibility and swaps the eye icon', () => {
    const { verifyInput, verifyEyeBtn } = renderHarness();

    expect(verifyInput).toHaveAttribute('type', 'password');
    expect(screen.getAllByTestId('eye-icon')[1]).toHaveAttribute('data-name', 'eye');

    fireEvent.click(verifyEyeBtn);
    expect(verifyInput).toHaveAttribute('type', 'text');
    expect(screen.getAllByTestId('eye-icon')[1]).toHaveAttribute('data-name', 'eye-off');

    fireEvent.click(verifyEyeBtn);
    expect(verifyInput).toHaveAttribute('type', 'password');
  });

  it('Tab on the name field moves focus to the password field', () => {
    const { nameInput, passwordInput } = renderHarness();
    fireEvent.keyDown(nameInput, { key: 'Tab' });
    expect(document.activeElement).toBe(passwordInput);
  });

  it('Tab on the password field moves focus to the verify field', () => {
    const { passwordInput, verifyInput } = renderHarness();
    fireEvent.keyDown(passwordInput, { key: 'Tab' });
    expect(document.activeElement).toBe(verifyInput);
  });

  it('ignores non-Tab keys on the name and password fields (no focus move)', () => {
    const { nameInput, passwordInput, verifyInput } = renderHarness();

    nameInput.focus();
    fireEvent.keyDown(nameInput, { key: 'a' });
    expect(document.activeElement).toBe(nameInput);

    passwordInput.focus();
    fireEvent.keyDown(passwordInput, { key: 'a' });
    expect(document.activeElement).toBe(passwordInput);
    expect(document.activeElement).not.toBe(verifyInput);
  });

  it('shows the match message and enables the CTA when everything is valid', () => {
    const { setName, setPassword, setVerify, continueBtn, onGoNext } = renderHarness();

    setName('My Wallet');
    setPassword(VALID_PASSWORD);
    setVerify(VALID_PASSWORD);

    // Green "it's a match" visible, red "do not match" hidden.
    expect(screen.getByText('itsAMatch')).toHaveClass('block');
    expect(screen.getByText('passwordsDoNotMatch')).toHaveClass('hidden');

    expect(continueBtn).not.toBeDisabled();
    fireEvent.click(continueBtn);
    expect(onGoNext).toHaveBeenCalledTimes(1);
  });

  it('shows the mismatch message when the verify password differs and is at least as long', () => {
    const { setName, setPassword, setVerify, continueBtn } = renderHarness();

    setName('My Wallet');
    setPassword(VALID_PASSWORD);
    setVerify(`${VALID_PASSWORD}X`); // longer + different

    expect(screen.getByText('passwordsDoNotMatch')).toHaveClass('block');
    expect(screen.getByText('itsAMatch')).toHaveClass('hidden');
    // Not a valid (matching) password => CTA disabled.
    expect(continueBtn).toBeDisabled();
  });

  it('keeps both messages hidden while the verify password is shorter than the password', () => {
    const { setName, setPassword, setVerify } = renderHarness();

    setName('My Wallet');
    setPassword(VALID_PASSWORD);
    setVerify('Abc'); // shorter than password => mismatch row stays hidden

    expect(screen.getByText('passwordsDoNotMatch')).toHaveClass('hidden');
    expect(screen.getByText('itsAMatch')).toHaveClass('hidden');
  });

  it('submits on Enter in the verify field only when the password is valid', () => {
    const { setName, setPassword, setVerify, verifyInput, onGoNext } = renderHarness();

    setName('My Wallet');
    setPassword(VALID_PASSWORD);
    setVerify(VALID_PASSWORD);

    fireEvent.keyDown(verifyInput, { key: 'Enter' });
    expect(onGoNext).toHaveBeenCalledTimes(1);
  });

  it('does not submit on Enter when the passwords do not match', () => {
    const { setName, setPassword, setVerify, verifyInput, onGoNext } = renderHarness();

    setName('My Wallet');
    setPassword(VALID_PASSWORD);
    setVerify(`${VALID_PASSWORD}X`);

    fireEvent.keyDown(verifyInput, { key: 'Enter' });
    expect(onGoNext).not.toHaveBeenCalled();
  });

  it('ignores non-Enter keys on the verify field', () => {
    const { setName, setPassword, setVerify, verifyInput, onGoNext } = renderHarness();

    setName('My Wallet');
    setPassword(VALID_PASSWORD);
    setVerify(VALID_PASSWORD);

    fireEvent.keyDown(verifyInput, { key: 'a' });
    expect(onGoNext).not.toHaveBeenCalled();
  });

  it('keeps the CTA disabled when the file name is missing', () => {
    const { setPassword, setVerify, continueBtn } = renderHarness();
    setPassword(VALID_PASSWORD);
    setVerify(VALID_PASSWORD);
    // fileName still empty => disabled.
    expect(continueBtn).toBeDisabled();
  });

  it('keeps the CTA disabled when the verify password is empty', () => {
    const { setName, setPassword, continueBtn } = renderHarness();
    setName('My Wallet');
    setPassword(VALID_PASSWORD);
    // verify empty => disabled.
    expect(continueBtn).toBeDisabled();
  });

  it('keeps the CTA disabled when the password is too weak even if the fields match', () => {
    const { setName, setPassword, setVerify, continueBtn } = renderHarness();
    setName('My Wallet');
    setPassword('Ab'); // only 1 validation check => isValidPassword false
    setVerify('Ab');
    expect(continueBtn).toBeDisabled();
  });

  it('accepts initial props for password and file name', () => {
    const { passwordInput, nameInput } = renderHarness({
      initialPassword: VALID_PASSWORD,
      initialFileName: 'Preset'
    });
    expect(passwordInput).toHaveValue(VALID_PASSWORD);
    expect(nameInput).toHaveValue('Preset');
    // strongPasswordLength branch: seed a >=12 char password to flip it true.
    expect(screen.getByTestId('password-strength')).toHaveAttribute('data-valid-count', '4');
  });
});
