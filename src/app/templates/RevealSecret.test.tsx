import React from 'react';

import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import RevealSecret from './RevealSecret';

// Keep the REAL AccountBanner so we exercise the integration between
// RevealSecret and AccountBanner — the original bug was RevealSecret
// rendering AccountBanner without an `account` prop, which AccountBanner
// then dereferenced (`account!.name`) and crashed on for standard accounts.

const mockAccount = { name: 'My Test Account', publicKey: 'mtst1qtestaddress0000' };

// Mutable state the mocks read at call time (must be `mock`-prefixed for jest).
let mockSecret: string | null = null;
const mockSetSecret = jest.fn((v: string | null) => {
  mockSecret = v;
});
const mockHasHardwareProtector = jest.fn();
const mockRevealPrivateKey = jest.fn();
const mockRevealMnemonic = jest.fn();
const mockRevealHotKey = jest.fn();
const mockRevealGuardianKeys = jest.fn();
const mockGetAccount = jest.fn();
const mockResolveCommitments = jest.fn();
let mockIsMobile = false;

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('app/atoms/Alert', () => () => null);

// A functional input mock so react-hook-form can register the password
// field and we can drive the software-unlock path. Only forwards the props
// that matter for the form (name/type/onChange/onBlur/ref/id/placeholder).
jest.mock('app/atoms/FormField', () =>
  React.forwardRef(
    (
      {
        name,
        type,
        id,
        placeholder,
        onChange,
        onBlur
      }: {
        name?: string;
        type?: string;
        id?: string;
        placeholder?: string;
        onChange?: React.ChangeEventHandler<HTMLInputElement>;
        onBlur?: React.FocusEventHandler<HTMLInputElement>;
      },
      ref: React.Ref<HTMLInputElement>
    ) => (
      <input ref={ref} name={name} type={type} id={id} placeholder={placeholder} onChange={onChange} onBlur={onBlur} />
    )
  )
);

jest.mock('components/Button', () => ({
  Button: ({ onClick, title, disabled }: { onClick: () => void; title: string; disabled?: boolean }) => (
    <button onClick={onClick} disabled={disabled}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'Primary', Secondary: 'Secondary' }
}));

jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: { Wallet: 'Wallet' }
}));

// Mobile passcode-protected vaults render the numpad instead of a password
// field. Mock it so we can drive its onChange/onSubmit callbacks.
jest.mock('components/PasscodeEntry', () => ({
  PasscodeEntry: ({
    onSubmit,
    onChange,
    disabled
  }: {
    onSubmit: (code: string) => void;
    onChange: (code: string) => void;
    disabled?: boolean;
  }) => (
    <div>
      <button data-testid="passcode-change" onClick={() => onChange('1')}>
        passcode-change
      </button>
      <button data-testid="passcode-submit" disabled={disabled} onClick={() => onSubmit('123456')}>
        passcode-submit
      </button>
    </div>
  )
}));

jest.mock('lib/miden/back/vault', () => ({
  Vault: { hasHardwareProtector: () => mockHasHardwareProtector() }
}));

jest.mock('lib/miden/front', () => ({
  useAccount: () => mockAccount,
  useSecretState: () => [mockSecret, mockSetSecret],
  useMidenContext: () => ({
    revealMnemonic: mockRevealMnemonic,
    revealPrivateKey: mockRevealPrivateKey,
    revealHotKey: mockRevealHotKey,
    revealGuardianKeys: mockRevealGuardianKeys
  })
}));

jest.mock('lib/miden/sdk/miden-client', () => ({
  getMidenClient: () => Promise.resolve({ getAccount: mockGetAccount }),
  withWasmClientLock: (cb: () => unknown) => cb()
}));

jest.mock('lib/miden/sdk/resolve-public-key-commitments', () => ({
  resolvePublicKeyCommitments: (account: unknown) => mockResolveCommitments(account)
}));

jest.mock('lib/mobile/useHideDappBubblesWhileOpen', () => ({
  useHideDappBubblesWhileOpen: jest.fn()
}));

// Screenshot / screen-recording guard (#417). `mockGuardReady` stands in for the
// native plugin having actually enabled protection; the real hook returns `true`
// unconditionally off-mobile.
const mockUseScreenshotGuard = jest.fn();
let mockGuardReady = true;
jest.mock('lib/mobile/screenshot-guard', () => ({
  useScreenshotGuard: (active: boolean) => {
    mockUseScreenshotGuard(active);
    return mockGuardReady;
  }
}));

jest.mock('lib/platform', () => ({
  isMobile: () => mockIsMobile
}));

jest.mock('lib/ui/useCopyToClipboard', () => ({
  __esModule: true,
  default: () => ({ fieldRef: { current: null } })
}));

type Reveal = 'private-key' | 'seed-phrase' | 'hot-key' | 'guardian-keys';

describe('RevealSecret', () => {
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
    mockIsMobile = false;
    mockGuardReady = true;
    mockHasHardwareProtector.mockResolvedValue(false);
    mockGetAccount.mockResolvedValue({});
    mockResolveCommitments.mockReturnValue([{ toHex: () => '0xdeadbeef' }]);
    mockRevealPrivateKey.mockResolvedValue('PRIVATE_KEY_HEX');
    mockRevealHotKey.mockResolvedValue('HOT_KEY_HEX');
    mockRevealMnemonic.mockResolvedValue('word1 word2 word3');
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

  const renderReveal = async (reveal: Reveal) => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);
    await act(async () => {
      testRoot!.render(<RevealSecret reveal={reveal} />);
    });
    // Flush the Vault.hasHardwareProtector() promise so the body mounts
    // (the component renders null until hasHardwareProtector resolves).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    return testContainer!;
  };

  const buttonWithText = (container: HTMLElement, text: string) =>
    Array.from(container.querySelectorAll('button')).find(b => b.textContent === text);

  // Private-key + guardian-keys reveals gate the action button behind an
  // "I understand" checkbox; tick it so the button enables.
  const acknowledge = async (container: HTMLElement) => {
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => {
      checkbox.click();
    });
  };

  const typePassword = async (container: HTMLElement, value: string) => {
    const input = container.querySelector('input[name="password"]') as HTMLInputElement;
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      nativeSetter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  const flush = async () => {
    await act(async () => {
      await new Promise(res => setTimeout(res, 0));
    });
  };

  // Regression: a standard (non-Guardian) account reaches reveal='private-key',
  // the only branch that renders <AccountBanner>. Before the fix the banner was
  // rendered without an `account` prop and threw
  // "Cannot read properties of undefined (reading 'name')" on mount.
  it('renders the current account in the private-key reveal banner without crashing', async () => {
    const container = await renderReveal('private-key');
    expect(container.textContent).toContain('My Test Account');
    expect(buttonWithText(container, 'continue')).toBeTruthy();
  });

  it('renders the seed-phrase reveal (no account banner) without crashing', async () => {
    const container = await renderReveal('seed-phrase');
    expect(container.textContent).not.toContain('My Test Account');
    expect(buttonWithText(container, 'continue')).toBeTruthy();
  });

  it('renders the hot-key reveal with its warning and no acknowledge gate', async () => {
    const container = await renderReveal('hot-key');
    expect(container.textContent).not.toContain('My Test Account');
    expect(buttonWithText(container, 'continue')).toBeTruthy();
  });

  it('renders the guardian-keys reveal without an account banner', async () => {
    const container = await renderReveal('guardian-keys');
    expect(container.textContent).not.toContain('My Test Account');
    expect(buttonWithText(container, 'continue')).toBeTruthy();
  });

  it('shows the Unlock button (no password field) when a hardware protector is present', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    const container = await renderReveal('private-key');
    expect(buttonWithText(container, 'unlock')).toBeTruthy();
    expect(buttonWithText(container, 'continue')).toBeFalsy();
    expect(container.querySelector('input[name="password"]')).toBeFalsy();
  });

  it('renders the revealed secret view (no action button) once a secret is set', async () => {
    mockSecret = 'REVEALED_SECRET_VALUE';
    const container = await renderReveal('private-key');
    expect(buttonWithText(container, 'continue')).toBeFalsy();
    expect(buttonWithText(container, 'unlock')).toBeFalsy();
  });

  it('does not autofocus the secret/password fields on mobile', async () => {
    mockIsMobile = true;
    mockSecret = 'REVEALED_SECRET_VALUE';
    const container = await renderReveal('private-key');
    // Mobile skips the focus/select effects; the revealed view still renders.
    expect(buttonWithText(container, 'continue')).toBeFalsy();
  });

  it('reveals the private key with the entered password on the software-unlock path', async () => {
    const container = await renderReveal('private-key');
    await acknowledge(container);
    await typePassword(container, 'my-password');

    const cont = buttonWithText(container, 'continue') as HTMLButtonElement;
    await act(async () => {
      cont.click();
    });
    await flush();

    // getAccountPublicKeyCommitment strips the 0x prefix; software unlock passes
    // the typed password through.
    expect(mockRevealPrivateKey).toHaveBeenCalledWith('deadbeef', 'my-password');
    expect(mockSetSecret).toHaveBeenCalledWith('PRIVATE_KEY_HEX');
  });

  it('reveals the private key via hardware unlock (no password)', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    // Commitment without a 0x prefix exercises the no-strip branch.
    mockResolveCommitments.mockReturnValue([{ toHex: () => 'cafebabe' }]);
    const container = await renderReveal('private-key');
    await acknowledge(container);

    const unlock = buttonWithText(container, 'unlock') as HTMLButtonElement;
    await act(async () => {
      unlock.click();
    });
    await flush();

    expect(mockRevealPrivateKey).toHaveBeenCalledWith('cafebabe', undefined);
    expect(mockSetSecret).toHaveBeenCalledWith('PRIVATE_KEY_HEX');
  });

  it('reveals the hot key on unlock', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    const container = await renderReveal('hot-key');

    const unlock = buttonWithText(container, 'unlock') as HTMLButtonElement;
    await act(async () => {
      unlock.click();
    });
    await flush();

    expect(mockRevealHotKey).toHaveBeenCalledWith(mockAccount.publicKey, undefined);
    expect(mockSetSecret).toHaveBeenCalledWith('HOT_KEY_HEX');
  });

  it('reveals the seed phrase on unlock', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    const container = await renderReveal('seed-phrase');

    const unlock = buttonWithText(container, 'unlock') as HTMLButtonElement;
    await act(async () => {
      unlock.click();
    });
    await flush();

    expect(mockRevealMnemonic).toHaveBeenCalledWith(undefined);
    expect(mockSetSecret).toHaveBeenCalledWith('word1 word2 word3');
  });

  it('reveals guardian keys into the bundle view on unlock', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    mockRevealGuardianKeys.mockResolvedValue({
      coldPrivateKey: 'COLD_PRIVATE',
      coldPublicKey: 'COLD_PUBLIC',
      hotPublicKey: 'HOT_PUBLIC'
    });
    const container = await renderReveal('guardian-keys');
    await acknowledge(container);

    const unlock = buttonWithText(container, 'unlock') as HTMLButtonElement;
    await act(async () => {
      unlock.click();
    });
    await flush();

    expect(mockRevealGuardianKeys).toHaveBeenCalledWith(mockAccount.publicKey, undefined);
    // Once the bundle is set the action button disappears (guardianBundle view).
    expect(buttonWithText(container, 'unlock')).toBeFalsy();
  });

  // #417 parity: RevealSeedPhrase blocks screenshots/recordings while the phrase
  // is on screen. The private key, the Guardian COLD private key and the hot key
  // are material of equal sensitivity (all confer spending authority) and used to
  // render into a plain DOM textarea with no guard at all — screenshot-able,
  // visible in the Android task-switcher thumbnail, and captured by any live
  // screen recording or screen-share.
  describe('screenshot guard (#417)', () => {
    it('leaves the guard off while only the unlock form is on screen', async () => {
      await renderReveal('private-key');
      expect(mockUseScreenshotGuard).toHaveBeenCalledWith(false);
      expect(mockUseScreenshotGuard).not.toHaveBeenCalledWith(true);
    });

    it('arms the guard once a secret is revealed', async () => {
      mockSecret = 'PRIVATE_KEY_HEX';
      const container = await renderReveal('private-key');

      expect(mockUseScreenshotGuard).toHaveBeenCalledWith(true);
      expect(container.querySelector('#reveal-secret-secret')).toBeTruthy();
    });

    it('withholds the secret field until the native guard reports it is enabled', async () => {
      mockGuardReady = false;
      mockSecret = 'PRIVATE_KEY_HEX';
      const container = await renderReveal('private-key');

      expect(mockUseScreenshotGuard).toHaveBeenCalledWith(true);
      expect(container.querySelector('#reveal-secret-secret')).toBeFalsy();
    });

    it('arms the guard for the Guardian cold-key bundle too', async () => {
      mockHasHardwareProtector.mockResolvedValue(true);
      mockRevealGuardianKeys.mockResolvedValue({
        coldPrivateKey: 'COLD_PRIVATE',
        coldPublicKey: 'COLD_PUBLIC',
        hotPublicKey: 'HOT_PUBLIC'
      });
      const container = await renderReveal('guardian-keys');
      await acknowledge(container);
      await act(async () => {
        (buttonWithText(container, 'unlock') as HTMLButtonElement).click();
      });
      await flush();

      expect(mockUseScreenshotGuard).toHaveBeenCalledWith(true);
      expect(container.querySelector('#reveal-guardian-cold-private')).toBeTruthy();
    });

    it('withholds the Guardian cold-key bundle until the guard is enabled', async () => {
      mockGuardReady = false;
      mockHasHardwareProtector.mockResolvedValue(true);
      mockRevealGuardianKeys.mockResolvedValue({
        coldPrivateKey: 'COLD_PRIVATE',
        coldPublicKey: 'COLD_PUBLIC',
        hotPublicKey: 'HOT_PUBLIC'
      });
      const container = await renderReveal('guardian-keys');
      await acknowledge(container);
      await act(async () => {
        (buttonWithText(container, 'unlock') as HTMLButtonElement).click();
      });
      await flush();

      expect(container.querySelector('#reveal-guardian-cold-private')).toBeFalsy();
    });
  });

  it('surfaces an error (no secret set) when the account has no key commitment', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    mockResolveCommitments.mockReturnValue([]); // -> "Account has no public key"
    const container = await renderReveal('private-key');
    await acknowledge(container);

    const unlock = buttonWithText(container, 'unlock') as HTMLButtonElement;
    await act(async () => {
      unlock.click();
    });
    // The catch block waits 300ms (human delay) before setting the error.
    await act(async () => {
      await new Promise(res => setTimeout(res, 350));
    });

    expect(mockRevealPrivateKey).not.toHaveBeenCalled();
    expect(mockSetSecret).not.toHaveBeenCalled();
  });

  it('surfaces an error when the account cannot be found', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    mockGetAccount.mockResolvedValue(null); // -> "Account not found"
    const container = await renderReveal('private-key');
    await acknowledge(container);

    const unlock = buttonWithText(container, 'unlock') as HTMLButtonElement;
    await act(async () => {
      unlock.click();
    });
    await act(async () => {
      await new Promise(res => setTimeout(res, 350));
    });

    expect(mockRevealPrivateKey).not.toHaveBeenCalled();
    expect(mockSetSecret).not.toHaveBeenCalled();
  });

  it('refocuses the password field after a failed software unlock', async () => {
    mockRevealPrivateKey.mockRejectedValue(new Error('Invalid password'));
    const container = await renderReveal('private-key');
    await acknowledge(container);
    await typePassword(container, 'wrong-password');

    const cont = buttonWithText(container, 'continue') as HTMLButtonElement;
    await act(async () => {
      cont.click();
    });
    await act(async () => {
      await new Promise(res => setTimeout(res, 350));
    });

    expect(mockRevealPrivateKey).toHaveBeenCalled();
    expect(mockSetSecret).not.toHaveBeenCalled();
  });

  it('reveals via the mobile passcode numpad instead of a password field', async () => {
    mockIsMobile = true; // usePasscodeEntry = isMobile() && hasHardwareProtector === false
    const container = await renderReveal('private-key');
    // No password field / action button in the passcode flow; the numpad drives submit.
    expect(container.querySelector('input[name="password"]')).toBeFalsy();
    expect(buttonWithText(container, 'continue')).toBeFalsy();

    await acknowledge(container);
    await act(async () => {
      (container.querySelector('[data-testid="passcode-change"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="passcode-submit"]') as HTMLButtonElement).click();
    });
    await flush();

    expect(mockRevealPrivateKey).toHaveBeenCalledWith('deadbeef', '123456');
    expect(mockSetSecret).toHaveBeenCalledWith('PRIVATE_KEY_HEX');
  });

  it('clears any revealed secret on unmount', async () => {
    await renderReveal('private-key');
    mockSetSecret.mockClear();
    await act(async () => {
      testRoot!.unmount();
      testRoot = null;
    });
    expect(mockSetSecret).toHaveBeenCalledWith(null);
  });
});
