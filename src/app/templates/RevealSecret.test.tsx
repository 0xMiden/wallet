import React from 'react';

import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { PROTECTOR_PROBE_DEADLINE_MS } from 'app/hooks/useHardwareProtector';
import { SubPageHeaderConfig, SubPageHeaderProvider } from 'components/ui/SubPageLayout';
import { SeedPhraseStatus } from 'lib/shared/types';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';

import RevealSecret from './RevealSecret';

jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));

// The private-key reveal names its account in a real ListRow. It used to be an
// AccountBanner rendered without an `account` prop, which crashed on
// `account!.name` for standard accounts; the regression test below still reads
// the account name off the page.

const mockAccount = { name: 'My Test Account', publicKey: 'mtst1qtestaddress0000' };
const mockWalletState: { seedPhraseStatus: SeedPhraseStatus } = { seedPhraseStatus: 'stored' };

jest.mock('lib/store', () => ({
  useWalletStore: <T,>(selector: (state: typeof mockWalletState) => T) => selector(mockWalletState)
}));

// Mutable state the mocks read at call time (must be `mock`-prefixed for jest).
let mockSecret: string | null = null;
const mockSetSecret = jest.fn((v: string | null) => {
  mockSecret = v;
});
const mockHasHardwareProtector = jest.fn();
const mockHasPasswordProtector = jest.fn();
const mockRevealPrivateKey = jest.fn();
const mockRevealMnemonic = jest.fn();
const mockRevealHotKey = jest.fn();
jest.mock(
  'qr-code-styling',
  () =>
    class {
      append() {}
    }
);
const mockGetAccount = jest.fn();
const mockResolveCommitments = jest.fn();
let mockIsMobile = false;

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

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
  IconName: { Wallet: 'Wallet', Eye: 'Eye', EyeOff: 'EyeOff' }
}));

// Mobile passcode-protected vaults render the numpad instead of a password
// field. Mock it so we can drive its onChange/onSubmit callbacks.
let mockRenderActualPasscode = false;
jest.mock('components/PasscodeEntry', () => {
  const stub = {
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
  };
  return {
    PasscodeEntry: (
      props: import('components/PasscodeEntry').PasscodeEntryProps & { onChange: (code: string) => void }
    ) => {
      const RealPasscodeEntry =
        jest.requireActual<typeof import('components/PasscodeEntry')>('components/PasscodeEntry').PasscodeEntry;
      return (
        <>
          <stub.PasscodeEntry {...props} />
          {mockRenderActualPasscode && <RealPasscodeEntry {...props} />}
        </>
      );
    }
  };
});

jest.mock('lib/miden/back/vault', () => ({
  Vault: {
    hasHardwareProtector: () => mockHasHardwareProtector(),
    hasPasswordProtector: () => mockHasPasswordProtector()
  }
}));

jest.mock('lib/miden/front', () => ({
  useAccount: () => mockAccount,
  useSecretState: () => [mockSecret, mockSetSecret],
  useMidenContext: () => ({
    revealMnemonic: mockRevealMnemonic,
    revealPrivateKey: mockRevealPrivateKey,
    revealHotKey: mockRevealHotKey
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

type Reveal = 'private-key' | 'seed-phrase' | 'hot-key';

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
    mockRenderActualPasscode = false;
    jest.clearAllMocks();
    mockWalletState.seedPhraseStatus = 'stored';
    mockSecret = null;
    mockAccount.publicKey = 'mtst1qtestaddress0000';
    mockIsMobile = false;
    mockGuardReady = true;
    mockHasHardwareProtector.mockResolvedValue(false);
    mockHasPasswordProtector.mockResolvedValue(true);
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

  // `header` stands in for the Settings route that hands the page its title and focus policy.
  const renderReveal = async (reveal: Reveal, header?: SubPageHeaderConfig) => {
    testContainer = document.createElement('div');
    // Attached: a detached subtree cannot hold focus in jsdom, so `.focus()` is a
    // silent no-op there and `document.activeElement` stays on <body>. Every
    // focus assertion in this suite would pass or fail for that reason alone.
    document.body.appendChild(testContainer);
    testRoot = createRoot(testContainer);
    const page = <RevealSecret reveal={reveal} />;
    await act(async () => {
      testRoot!.render(header ? <SubPageHeaderProvider value={header}>{page}</SubPageHeaderProvider> : page);
    });
    // Flush the Vault.hasHardwareProtector() promise so the body mounts
    // (until hasHardwareProtector resolves, the component renders its header over an empty body).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    return testContainer!;
  };

  const buttonWithText = (container: HTMLElement, text: string) =>
    Array.from(container.querySelectorAll('button')).find(b => b.textContent === text);

  it.each<Reveal>(['private-key', 'seed-phrase'])('hides %s after seed removal', async reveal => {
    mockWalletState.seedPhraseStatus = 'removed';
    const container = await renderReveal(reveal);

    expect(container.childElementCount).toBe(0);
    expect(mockRevealPrivateKey).not.toHaveBeenCalled();
    expect(mockRevealMnemonic).not.toHaveBeenCalled();
  });

  it('keeps everyday key reveal available after seed removal', async () => {
    mockWalletState.seedPhraseStatus = 'removed';
    const container = await renderReveal('hot-key');

    expect(container.childElementCount).toBeGreaterThan(0);
  });

  // The private-key reveal gates the action button behind an
  // "I understand" checkbox; tick it so the button enables. It is the shared
  // selection mark on a `role="checkbox"` button, not a native input.
  const acknowledge = async (container: HTMLElement) => {
    const checkbox = container.querySelector('[role="checkbox"]') as HTMLElement;
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
  // the only branch that names the account. The old banner was rendered without
  // an `account` prop and threw "Cannot read properties of undefined (reading
  // 'name')" on mount.
  it('names the current account in a list row on the private-key reveal', async () => {
    const container = await renderReveal('private-key');
    const row = container.querySelector('[data-testid="reveal-secret-account"]')!;
    expect(row.querySelector('[data-slot="title"]')).toHaveTextContent('My Test Account');
    // `fill`: one identification block embedded in a form page, not a page-wide list.
    expect(row.parentElement).toHaveClass('bg-fill', 'rounded-2xl');
    expect(buttonWithText(container, 'continue')).toBeTruthy();
  });

  it('renders through SubPageLayout with Continue pinned in its footer', async () => {
    const container = await renderReveal('private-key');

    const page = container.querySelector('[data-testid="reveal-secret"]')!;
    const body = page.querySelector('[data-slot="body"]')!;
    const footer = page.querySelector('[data-slot="footer"]')!;
    expect(body).toHaveClass('px-4', 'gap-5', 'overflow-y-auto');
    // The page action sits in the footer, outside the scrolling body.
    expect(footer).toContainElement(buttonWithText(container, 'continue')!);
    expect(body).not.toContainElement(buttonWithText(container, 'continue')!);
    // The password is the shared TextField: its 13px muted label names the field.
    const password = container.querySelector<HTMLInputElement>('#reveal-secret-password')!;
    expect(password.closest('div.bg-fill')).not.toBeNull();
    expect(container.querySelector('label[for="reveal-secret-password"]')).toHaveTextContent('password');
  });

  it('gates the private-key reveal behind a shared warning notice and selection mark', async () => {
    const container = await renderReveal('private-key');

    const notice = container.querySelector('[data-tone="warning"]')!;
    expect(notice.querySelector('[data-slot="title"]')).toHaveTextContent('privateKeyRevealWarningTitle');
    expect(notice.querySelector('[data-slot="body"]')).toHaveTextContent('privateKeyRevealWarningBody');

    const check = container.querySelector('[role="checkbox"]')!;
    expect(check).toHaveAttribute('aria-checked', 'false');
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(buttonWithText(container, 'continue')).toBeDisabled();
    await acknowledge(container);
    expect(check).toHaveAttribute('aria-checked', 'true');
  });

  it('covers a revealed secret in the shared field until it is looked at', async () => {
    const container = await renderReveal('seed-phrase');
    await typePassword(container, 'pass');
    await act(async () => {
      buttonWithText(container, 'continue')!.click();
    });
    await flush();

    const mask = container.querySelector('[data-testid="reveal-secret-mask"]')!;
    expect(mask).toHaveAttribute('data-slot', 'masked-secret');
    expect(mask).toHaveAttribute('aria-label', 'recoveryPhraseHidden');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="seed-reveal-toggle"]')!.click();
    });
    const field = container.querySelector<HTMLTextAreaElement>('#reveal-secret-secret')!;
    // The shared multi-line field on `fill`. Off mobile the page focuses it on reveal, so the
    // words are readable; they go back behind the design system's cover the moment focus leaves.
    expect(field.tagName).toBe('TEXTAREA');
    expect(field.closest('div.bg-fill')).not.toBeNull();
    expect(document.activeElement).toBe(field);
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, field.value.length]);
    expect(container.querySelector('[data-slot="secret-cover"]')).toBeNull();
    await act(async () => {
      field.blur();
    });
    expect(container.querySelector('[data-slot="secret-cover"]')).toBeInTheDocument();
  });

  it('keeps the header frame while the protector check is pending, with no body or footer yet', async () => {
    mockHasHardwareProtector.mockReturnValue(new Promise(() => undefined));
    const container = await renderReveal('private-key');

    const page = container.querySelector('[data-testid="reveal-secret"]')!;
    expect(page.querySelector('[data-slot="body"]')!.childElementCount).toBe(0);
    expect(page.querySelector('[data-slot="footer"]')).toBeNull();
  });

  // #1056: a failed hardware read is resolved through the password protector, never guessed.
  // A macrotask lets that second read and the hook's state update land.
  const settleProbe = () => act(() => new Promise<void>(resolve => setTimeout(resolve, 0)));

  it('takes the password step-up when the hardware read fails and a password key exists', async () => {
    mockHasHardwareProtector.mockRejectedValue(new Error('hw-boom'));
    mockHasPasswordProtector.mockResolvedValue(true);
    const container = await renderReveal('seed-phrase');
    await settleProbe();

    expect(container.querySelector('input[name="password"]')).not.toBeNull();
    expect(buttonWithText(container, 'continue')).toBeTruthy();
    expect(buttonWithText(container, 'unlock')).toBeFalsy();
  });

  it('unlocks through the hardware protector when the hardware read fails and no password key exists', async () => {
    mockHasHardwareProtector.mockRejectedValue(new Error('hw-boom'));
    mockHasPasswordProtector.mockResolvedValue(false);
    const container = await renderReveal('seed-phrase');
    await settleProbe();

    expect(container.querySelector('input[name="password"]')).toBeNull();
    await act(async () => {
      buttonWithText(container, 'unlock')!.click();
    });
    expect(mockRevealMnemonic).toHaveBeenCalledWith(undefined);
  });

  it('shows an error and offers no credential step when both protector reads fail', async () => {
    mockHasHardwareProtector.mockRejectedValue(new Error('hw-boom'));
    mockHasPasswordProtector.mockRejectedValue(new Error('pw-boom'));
    const container = await renderReveal('seed-phrase');
    await settleProbe();

    const notice = container.querySelector('[data-testid="protector-probe-error"]')!;
    expect(notice.querySelector('[data-slot="body"]')!.textContent).toBe('couldNotCheckUnlockMethod');
    expect(container.querySelector('input[name="password"]')).toBeNull();
    expect(buttonWithText(container, 'continue')).toBeFalsy();
    expect(buttonWithText(container, 'unlock')).toBeFalsy();
  });

  it('shows an error and no passcode entry on mobile when both protector reads fail', async () => {
    mockIsMobile = true;
    mockHasHardwareProtector.mockRejectedValue(new Error('hw-boom'));
    mockHasPasswordProtector.mockRejectedValue(new Error('pw-boom'));
    const container = await renderReveal('seed-phrase');
    await settleProbe();

    const notice = container.querySelector('[data-testid="protector-probe-error"]')!;
    expect(notice.querySelector('[data-slot="body"]')!.textContent).toBe('couldNotCheckUnlockMethod');
    expect(container.querySelector('[data-testid="passcode-submit"]')).toBeNull();
    expect(buttonWithText(container, 'continue')).toBeFalsy();
    expect(buttonWithText(container, 'unlock')).toBeFalsy();
  });

  it('shows the error with Retry when the protector probe does not answer in time, and Retry reaches the credential step (#1241)', async () => {
    jest.useFakeTimers();
    try {
      mockHasHardwareProtector.mockReturnValueOnce(new Promise(() => undefined)).mockResolvedValueOnce(false);
      mockHasPasswordProtector.mockResolvedValue(true);
      const container = await renderReveal('seed-phrase');

      await act(async () => {
        jest.advanceTimersByTime(PROTECTOR_PROBE_DEADLINE_MS);
      });
      const notice = container.querySelector('[data-testid="protector-probe-error"]')!;
      expect(notice.querySelector('[data-slot="body"]')!.textContent).toBe('couldNotCheckUnlockMethod');
      expect(container.querySelector('input[name="password"]')).toBeNull();

      const retryButton = container.querySelector<HTMLButtonElement>('[data-testid="protector-probe-retry"]')!;
      await act(async () => {
        retryButton.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(container.querySelector('input[name="password"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="protector-probe-error"]')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
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

  it('puts the caret in the password field on desktop', async () => {
    // The effect depends on `hasHardwareProtector` because this component's body
    // waits for that to resolve. Without it in the deps it ran once against the
    // empty first commit, when the form ref was still null, and never again - so
    // the field was never focused, while Settings suppressed its own title focus
    // on the strength of this effect and left focus on <body> with the page
    // unannounced. On the two screens that hand out recovery material.
    const container = await renderReveal('private-key');

    const password = container.querySelector<HTMLInputElement>("input[name='password']");
    expect(password).not.toBeNull();
    expect(document.activeElement).toBe(password);
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

  // #417 parity: RevealSeedPhrase blocks screenshots/recordings while the phrase
  // is on screen. The private key and the hot key
  // are material of equal sensitivity (both confer spending authority) and used to
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
      expect(container.querySelector('[data-testid="reveal-secret-mask"]')).toBeTruthy();
    });

    // Off mobile the mask alone keeps the key out of the DOM, so each case also checks what
    // only the guard withholds: the mask and its Show control, or on mobile the key itself.
    it('withholds the secret field until the native guard reports it is enabled', async () => {
      mockGuardReady = false;
      mockSecret = 'PRIVATE_KEY_HEX';
      const container = await renderReveal('private-key');

      expect(mockUseScreenshotGuard).toHaveBeenCalledWith(true);
      expect(container.querySelector('#reveal-secret-secret')).toBeNull();
      expect(container.querySelector('[data-testid="reveal-secret-mask"]')).toBeNull();
      expect(container.querySelector('[data-testid="seed-reveal-toggle"]')).toBeNull();
    });

    it('withholds the secret field on mobile until the native guard reports it is enabled', async () => {
      mockIsMobile = true;
      mockGuardReady = false;
      mockSecret = 'PRIVATE_KEY_HEX';
      const container = await renderReveal('private-key');

      expect(container.querySelector('#reveal-secret-secret')).toBeNull();
      expect(container.innerHTML).not.toContain('PRIVATE_KEY_HEX');
    });

    it.each([false, true])('withholds the hot key until the native guard is enabled (mobile=%s)', async mobile => {
      mockIsMobile = mobile;
      mockGuardReady = false;
      mockSecret = `${'ab'.repeat(32)}:${'cd'.repeat(32)}`;
      const container = await renderReveal('hot-key');

      expect(container.querySelector('[role="img"]')).toBeNull();
      expect(container.querySelector('[data-masked]')).toBeNull();
      expect(container.querySelector('[data-testid="seed-reveal-toggle"]')).toBeNull();
    });
  });

  // Off mobile a revealed key stays masked until Show, as the recovery phrase does.
  describe('reveal mask', () => {
    const toggleOf = (container: HTMLElement) =>
      container.querySelector<HTMLButtonElement>('[data-testid="seed-reveal-toggle"]');
    const pressShow = async (container: HTMLElement) => {
      await act(async () => {
        toggleOf(container)!.click();
      });
    };

    it('keeps a private key out of the DOM until Show, then hides it again on blur', async () => {
      mockSecret = 'PRIVATE_KEY_HEX';
      const container = await renderReveal('private-key');

      expect(container.querySelector('#reveal-secret-secret')).toBeNull();
      expect(container.innerHTML).not.toContain('PRIVATE_KEY_HEX');
      const mask = container.querySelector('[data-testid="reveal-secret-mask"]')!;
      expect(mask).toHaveAttribute('data-masked', 'true');
      expect(mask).toHaveAttribute('data-slot', 'masked-secret');
      expect(mask).toHaveAttribute('aria-label', 'privateKeyHidden');
      expect(mask.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
      expect(toggleOf(container)).toHaveAttribute('aria-pressed', 'false');

      await pressShow(container);
      expect(container.querySelector<HTMLTextAreaElement>('#reveal-secret-secret')!.value).toBe('PRIVATE_KEY_HEX');
      expect(toggleOf(container)).toHaveAttribute('aria-pressed', 'true');

      await act(async () => {
        window.dispatchEvent(new Event('blur'));
      });
      expect(container.querySelector('#reveal-secret-secret')).toBeNull();
      expect(container.innerHTML).not.toContain('PRIVATE_KEY_HEX');
    });

    it('hides a shown private key when the document is hidden', async () => {
      mockSecret = 'PRIVATE_KEY_HEX';
      const container = await renderReveal('private-key');
      await pressShow(container);
      try {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        await act(async () => {
          document.dispatchEvent(new Event('visibilitychange'));
        });
      } finally {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      }
      expect(container.querySelector('#reveal-secret-secret')).toBeNull();
    });

    it('shows a private key at once with no Show control on mobile', async () => {
      mockIsMobile = true;
      mockSecret = 'PRIVATE_KEY_HEX';
      const container = await renderReveal('private-key');

      expect(container.querySelector<HTMLTextAreaElement>('#reveal-secret-secret')!.value).toBe('PRIVATE_KEY_HEX');
      expect(toggleOf(container)).toBeNull();
    });

    it('keeps a hot key out of the DOM until Show, then hides it again on blur', async () => {
      mockSecret = `${'ab'.repeat(32)}:${'cd'.repeat(32)}`;
      const container = await renderReveal('hot-key');

      expect(container.querySelector('[role="img"]')).toBeNull();
      expect(container.querySelector('[data-masked="true"]')).not.toBeNull();
      expect(toggleOf(container)).toHaveAttribute('aria-pressed', 'false');

      await pressShow(container);
      expect(container.querySelector('[role="img"]')).not.toBeNull();
      expect(container.querySelector('[data-masked="true"]')).toBeNull();

      await act(async () => {
        window.dispatchEvent(new Event('blur'));
      });
      expect(container.querySelector('[role="img"]')).toBeNull();
      expect(container.querySelector('[data-masked="true"]')).not.toBeNull();
    });

    it('shows a hot key at once with no Show control on mobile', async () => {
      mockIsMobile = true;
      mockSecret = `${'ab'.repeat(32)}:${'cd'.repeat(32)}`;
      const container = await renderReveal('hot-key');

      expect(container.querySelector('[role="img"]')).not.toBeNull();
      expect(toggleOf(container)).toBeNull();
    });
  });

  // A reveal that starts masked leaves no field to focus and unmounts the control that held
  // focus, so the page title takes it, as the recovery phrase's reveal does.
  describe('focus after a masked reveal', () => {
    const hotKeyPair = `${'ab'.repeat(32)}:${'cd'.repeat(32)}`;

    it.each<[Reveal, string]>([
      ['private-key', 'PRIVATE_KEY_HEX'],
      ['hot-key', hotKeyPair],
      ['seed-phrase', 'word1 word2 word3']
    ])('moves focus to the page title once the %s is revealed', async (reveal, secret) => {
      mockRevealHotKey.mockResolvedValue(hotKeyPair);
      const container = await renderReveal(reveal, { title: 'Private key', focusTitleOnMount: true });
      if (reveal === 'private-key') await acknowledge(container);
      await typePassword(container, 'pass');
      expect(document.activeElement).toBe(container.querySelector('input[name="password"]'));

      await act(async () => {
        buttonWithText(container, 'continue')!.click();
      });
      await flush();

      expect(document.activeElement).toBe(container.querySelector('h1'));
      expect(container.querySelector('[data-masked="true"]')).not.toBeNull();
      expect(container.innerHTML).not.toContain(secret);
    });

    it('moves focus to the page title even under a host that does not focus it', async () => {
      const container = await renderReveal('hot-key', { title: 'Private key', focusTitleOnMount: false });
      mockRevealHotKey.mockResolvedValue(hotKeyPair);
      await typePassword(container, 'pass');
      expect(document.activeElement).toBe(container.querySelector('input[name="password"]'));

      await act(async () => {
        buttonWithText(container, 'continue')!.click();
      });
      await flush();

      expect(document.activeElement).toBe(container.querySelector('h1'));
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

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 1050));
    });
    expect(reportUserVisibleError).toHaveBeenCalledWith('raw_secret_reveal_failed', 'field');
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

  it.each(['hardware', 'passcode'])('reports the %s secret-reveal error on its visible surface', async mode => {
    mockRenderActualPasscode = mode === 'passcode';
    mockIsMobile = mode === 'passcode';
    mockHasHardwareProtector.mockResolvedValue(mode === 'hardware');
    mockRevealPrivateKey.mockRejectedValue(new Error('private reveal failure'));
    const container = await renderReveal('private-key');
    await acknowledge(container);
    await act(async () => {
      if (mode === 'hardware') buttonWithText(container, 'unlock')!.click();
      else (container.querySelector('[data-testid="passcode-submit"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 350));
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 1050));
    });
    expect(reportUserVisibleError).toHaveBeenCalledWith(
      'raw_secret_reveal_failed',
      mode === 'hardware' ? 'notice' : 'passcode'
    );
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

  it('discards a late authenticated reveal when the selected account changes', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    let finish = (value: string) => {
      expect(value).toBe('late-secret');
    };
    mockRevealHotKey.mockReturnValue(
      new Promise<string>(resolve => {
        finish = resolve;
      })
    );
    const container = await renderReveal('hot-key');
    await act(async () => {
      buttonWithText(container, 'unlock')?.click();
    });
    mockAccount.publicKey = 'different-account';
    await act(async () => {
      testRoot?.render(<RevealSecret reveal="hot-key" />);
    });
    mockSetSecret.mockClear();
    await act(async () => {
      finish('late-secret');
    });
    expect(mockSetSecret).not.toHaveBeenCalledWith('late-secret');
  });

  it('discards a late reveal after unmount', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    let finish = (value: string) => {
      expect(value).toBe('late-secret');
    };
    mockRevealHotKey.mockReturnValue(
      new Promise<string>(resolve => {
        finish = resolve;
      })
    );
    const container = await renderReveal('hot-key');
    await act(async () => {
      buttonWithText(container, 'unlock')?.click();
    });
    await act(async () => {
      testRoot?.unmount();
      testRoot = null;
    });
    mockSetSecret.mockClear();
    await act(async () => {
      finish('late-secret');
    });
    expect(mockSetSecret).not.toHaveBeenCalledWith('late-secret');
  });
});
