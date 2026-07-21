import React from 'react';

import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import RevealSeedPhrase from './RevealSeedPhrase';

// ---------------------------------------------------------------------------
// Mutable mock state read at call time (must be `mock`-prefixed for jest).
// ---------------------------------------------------------------------------
let mockSecret: string | null = null;
const mockSetSecret = jest.fn((v: string | null) => {
  mockSecret = v;
});
const mockRevealMnemonic = jest.fn();
const mockHasHardwareProtector = jest.fn();
const mockHapticLight = jest.fn();
const mockGoBack = jest.fn();
const mockCopy = jest.fn();
let mockCopied = false;
let mockIsMobile = false;

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// Alert echoes its description so the auth-error branch is assertable.
jest.mock('app/atoms/Alert', () => ({
  __esModule: true,
  default: ({ description }: { description?: string }) => <div data-testid="alert">{description}</div>
}));

// Functional input mock so react-hook-form can register the password field
// and we can drive the software-unlock path. Forwards the ref + the handlers
// the form wires up, and echoes errorCaption for the submit-error assertion.
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

// type="button" so a click never doubles as a native form submit.
jest.mock('components/Button', () => ({
  __esModule: true,
  Button: ({ onClick, title, disabled }: { onClick?: () => void; title: string; disabled?: boolean }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'Primary', Secondary: 'Secondary' }
}));

jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name?: string }) => <span data-testid="icon" data-name={name} />,
  IconName: { CheckboxCircleFill: 'CheckboxCircleFill', FileCopy: 'FileCopy' }
}));

jest.mock('components/NavigationHeader', () => ({
  __esModule: true,
  NavigationHeader: (props: { title?: string; onBack?: () => void }) => (
    <div data-testid="nav-header">
      <span data-testid="nh-title">{props.title}</span>
      <button data-testid="nh-back" onClick={props.onBack} />
    </div>
  )
}));

// Mobile passcode-protected vaults render the numpad instead of a password
// field. Mock exposes onChange/onSubmit + echoes error/isSubmitting props.
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
      <button data-testid="passcode-change" onClick={() => onChange('1')}>
        passcode-change
      </button>
      <button data-testid="passcode-submit" onClick={() => onSubmit('123456')}>
        passcode-submit
      </button>
      <span data-testid="passcode-error">{error ?? ''}</span>
      <span data-testid="passcode-submitting">{String(Boolean(isSubmitting))}</span>
    </div>
  )
}));

// Passthrough Drawer stub — keeps children in the DOM and exposes buttons that
// fire onOpenChange with both `false` (close) and `true` (no-op) so the
// `!open && ...` branch is fully exercised.
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({
    open,
    onOpenChange,
    children
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: React.ReactNode;
  }) => (
    <div data-testid="drawer" data-open={String(open)}>
      <button data-testid="drawer-close" onClick={() => onOpenChange(false)} />
      <button data-testid="drawer-open" onClick={() => onOpenChange(true)} />
      {children}
    </div>
  ),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-content">{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-header">{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-title">{children}</div>
}));

jest.mock('lib/miden/back/vault', () => ({
  Vault: { hasHardwareProtector: () => mockHasHardwareProtector() }
}));

jest.mock('lib/miden/front', () => ({
  useSecretState: () => [mockSecret, mockSetSecret],
  useMidenContext: () => ({ revealMnemonic: mockRevealMnemonic })
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: () => mockHapticLight()
}));

jest.mock('lib/platform', () => ({
  isMobile: () => mockIsMobile
}));

jest.mock('lib/ui/useCopyToClipboard', () => ({
  __esModule: true,
  default: () => ({ fieldRef: { current: null }, copy: mockCopy, copied: mockCopied })
}));

jest.mock('lib/woozie', () => ({
  goBack: () => mockGoBack()
}));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
describe('RevealSeedPhrase', () => {
  let testRoot: ReturnType<typeof createRoot> | null = null;
  let testContainer: HTMLDivElement | null = null;

  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockSecret = null;
    mockCopied = false;
    mockIsMobile = false;
    mockHasHardwareProtector.mockResolvedValue(false);
    mockRevealMnemonic.mockResolvedValue('alpha beta gamma delta');
  });

  afterEach(async () => {
    if (testRoot) {
      await act(async () => {
        testRoot!.unmount();
      });
      testRoot = null;
    }
    if (testContainer) {
      testContainer.remove();
      testContainer = null;
    }
  });

  const renderNoFlush = () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);
    act(() => {
      testRoot!.render(<RevealSeedPhrase />);
    });
    return testContainer!;
  };

  const flush = async () => {
    await act(async () => {
      await new Promise(res => setTimeout(res, 0));
    });
  };

  // Wait past the 300ms "human delay" the password-error path inserts.
  const flushErrorDelay = async () => {
    await act(async () => {
      await new Promise(res => setTimeout(res, 350));
    });
  };

  const render = async () => {
    const container = renderNoFlush();
    await flush();
    // A second pass to settle the chained reveal/finally microtasks.
    await flush();
    return container;
  };

  const buttonWithText = (container: HTMLElement, text: string) =>
    Array.from(container.querySelectorAll('button')).find(b => b.textContent === text);

  const typePassword = async (container: HTMLElement, value: string) => {
    const input = container.querySelector('input[name="password"]') as HTMLInputElement;
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      nativeSetter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  // -------------------------------------------------------------------------
  // Initial null render (hasHardwareProtector still resolving).
  // -------------------------------------------------------------------------
  it('renders nothing until the hardware-protector check resolves', async () => {
    const container = renderNoFlush();
    // hasHardwareProtector === null -> component returns null.
    expect(container.textContent).toBe('');
    await flush();
    await flush();
  });

  // -------------------------------------------------------------------------
  // Hardware-backed success path -> revealed view.
  // -------------------------------------------------------------------------
  it('auto-reveals the seed phrase via hardware unlock and shows the capitalized word grid', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    mockRevealMnemonic.mockResolvedValue('alpha beta gamma delta');
    const container = await render();

    expect(mockRevealMnemonic).toHaveBeenCalledWith(undefined);
    expect(mockSetSecret).toHaveBeenCalledWith('alpha beta gamma delta');

    // Revealed view: NavigationHeader + capitalized words + copy/hide buttons.
    expect(container.querySelector('[data-testid="nh-title"]')!.textContent).toBe('recoveryPhrase');
    expect(container.textContent).toContain('Alpha');
    expect(container.textContent).toContain('Delta');
    // Not-yet-copied label + icon.
    expect(container.textContent).toContain('copyToClipboard');
    expect(container.querySelector('[data-name="FileCopy"]')).toBeTruthy();
    expect(buttonWithText(container, 'hideRecoveryPhrase')).toBeTruthy();

    // Copy button click -> haptic + copy().
    const copyBtn = buttonWithText(container, 'copyToClipboard') as HTMLButtonElement;
    await act(async () => {
      copyBtn.click();
    });
    expect(mockHapticLight).toHaveBeenCalled();
    expect(mockCopy).toHaveBeenCalled();
  });

  it('shows the "copied" state (checkmark icon + copied label)', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    mockCopied = true;
    const container = await render();

    expect(container.textContent).toContain('copied');
    expect(container.textContent).not.toContain('copyToClipboard');
    expect(container.querySelector('[data-name="CheckboxCircleFill"]')).toBeTruthy();
  });

  it('hides the phrase (haptic + clear secret + goBack) via the Hide button', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    const container = await render();

    const hideBtn = buttonWithText(container, 'hideRecoveryPhrase') as HTMLButtonElement;
    mockGoBack.mockClear();
    mockSetSecret.mockClear();
    await act(async () => {
      hideBtn.click();
    });

    expect(mockHapticLight).toHaveBeenCalled();
    expect(mockSetSecret).toHaveBeenCalledWith(null);
    expect(mockGoBack).toHaveBeenCalled();
  });

  it('runs handleHide from the revealed-view NavigationHeader back button', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    const container = await render();

    mockGoBack.mockClear();
    mockSetSecret.mockClear();
    await act(async () => {
      (container.querySelector('[data-testid="nh-back"]') as HTMLButtonElement).click();
    });
    expect(mockHapticLight).toHaveBeenCalled();
    expect(mockSetSecret).toHaveBeenCalledWith(null);
    expect(mockGoBack).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Hardware-backed failure path -> auth-error view.
  // -------------------------------------------------------------------------
  it('shows the auth-error view and goes back when hardware unlock rejects', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    mockRevealMnemonic.mockRejectedValue(new Error('biometric failed'));
    const container = await render();

    expect(mockSetSecret).not.toHaveBeenCalledWith(expect.stringContaining('alpha'));
    expect(container.querySelector('[data-testid="alert"]')!.textContent).toBe('biometric failed');
    // goBack fired from the catch (and/or the auto-close effect).
    expect(mockGoBack).toHaveBeenCalled();

    // The error view's NavigationHeader back button also calls goBack.
    mockGoBack.mockClear();
    await act(async () => {
      (container.querySelector('[data-testid="nh-back"]') as HTMLButtonElement).click();
    });
    expect(mockGoBack).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Desktop password path -> drawer with typed password.
  // -------------------------------------------------------------------------
  it('reveals the seed phrase via the desktop password drawer', async () => {
    mockIsMobile = false;
    mockHasHardwareProtector.mockResolvedValue(false);
    const container = await render();

    // Password drawer (not passcode) is open with the password title.
    expect(container.querySelector('[data-testid="drawer"]')!.getAttribute('data-open')).toBe('true');
    expect(container.querySelector('[data-testid="drawer-title"]')!.textContent).toBe('password');
    expect(container.querySelector('input[name="password"]')).toBeTruthy();

    // Continue is disabled until a password is typed.
    const disabledContinue = buttonWithText(container, 'continue') as HTMLButtonElement;
    expect(disabledContinue.disabled).toBe(true);

    await typePassword(container, 'my-password');
    const enabledContinue = buttonWithText(container, 'continue') as HTMLButtonElement;
    expect(enabledContinue.disabled).toBe(false);

    await act(async () => {
      enabledContinue.click();
    });
    await flush();

    expect(mockRevealMnemonic).toHaveBeenCalledWith('my-password');
    expect(mockSetSecret).toHaveBeenCalledWith('alpha beta gamma delta');
    // Secret set -> revealed view now renders.
    expect(buttonWithText(container, 'hideRecoveryPhrase')).toBeTruthy();
  });

  it('surfaces a submit error caption after a failed desktop password unlock', async () => {
    mockIsMobile = false;
    mockHasHardwareProtector.mockResolvedValue(false);
    mockRevealMnemonic.mockRejectedValue(new Error('wrong password'));
    const container = await render();

    await typePassword(container, 'bad-password');
    const cont = buttonWithText(container, 'continue') as HTMLButtonElement;
    await act(async () => {
      cont.click();
    });
    await flushErrorDelay();

    expect(mockRevealMnemonic).toHaveBeenCalledWith('bad-password');
    expect(mockSetSecret).not.toHaveBeenCalledWith('alpha beta gamma delta');
    expect(container.querySelector('[data-testid="error-caption"]')!.textContent).toBe('wrong password');
  });

  it('closes the desktop drawer (goBack) via onOpenChange(false); onOpenChange(true) is a no-op', async () => {
    mockHasHardwareProtector.mockResolvedValue(false);
    const container = await render();

    // onOpenChange(true) must NOT trigger close/goBack.
    mockGoBack.mockClear();
    await act(async () => {
      (container.querySelector('[data-testid="drawer-open"]') as HTMLButtonElement).click();
    });
    expect(mockGoBack).not.toHaveBeenCalled();

    // onOpenChange(false) -> handlePasswordDrawerClose -> goBack.
    await act(async () => {
      (container.querySelector('[data-testid="drawer-close"]') as HTMLButtonElement).click();
    });
    expect(mockGoBack).toHaveBeenCalled();
  });

  it('goes back from the drawer-view NavigationHeader back button', async () => {
    mockHasHardwareProtector.mockResolvedValue(false);
    const container = await render();

    mockGoBack.mockClear();
    await act(async () => {
      (container.querySelector('[data-testid="nh-back"]') as HTMLButtonElement).click();
    });
    expect(mockGoBack).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Mobile passcode path -> numpad instead of password field.
  // -------------------------------------------------------------------------
  it('reveals via the mobile passcode numpad (onChange clears errors, onSubmit reveals)', async () => {
    mockIsMobile = true;
    mockHasHardwareProtector.mockResolvedValue(false);
    const container = await render();

    // Passcode entry, not a password field.
    expect(container.querySelector('input[name="password"]')).toBeFalsy();
    expect(container.querySelector('[data-testid="drawer-title"]')!.textContent).toBe('enterYourPasscode');

    // onChange -> clearErrors (no throw), then onSubmit -> reveal.
    await act(async () => {
      (container.querySelector('[data-testid="passcode-change"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="passcode-submit"]') as HTMLButtonElement).click();
    });
    await flush();

    expect(mockRevealMnemonic).toHaveBeenCalledWith('123456');
    expect(mockSetSecret).toHaveBeenCalledWith('alpha beta gamma delta');
  });

  it('surfaces a passcode error in the numpad after a failed mobile unlock', async () => {
    mockIsMobile = true;
    mockHasHardwareProtector.mockResolvedValue(false);
    mockRevealMnemonic.mockRejectedValue(new Error('wrong passcode'));
    const container = await render();

    await act(async () => {
      (container.querySelector('[data-testid="passcode-submit"]') as HTMLButtonElement).click();
    });
    await flushErrorDelay();

    // The form error is threaded into PasscodeEntry's `error` prop (not `null`).
    expect(mockRevealMnemonic).toHaveBeenCalledWith('123456');
    expect(mockSetSecret).not.toHaveBeenCalledWith('alpha beta gamma delta');
    expect(container.querySelector('[data-testid="passcode-error"]')!.textContent).toBe('wrong passcode');
  });

  // -------------------------------------------------------------------------
  // Unmount cleanup.
  // -------------------------------------------------------------------------
  it('clears the secret on unmount', async () => {
    mockHasHardwareProtector.mockResolvedValue(false);
    await render();

    mockSetSecret.mockClear();
    await act(async () => {
      testRoot!.unmount();
      testRoot = null;
    });
    expect(mockSetSecret).toHaveBeenCalledWith(null);
  });
});
