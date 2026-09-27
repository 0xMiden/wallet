import React from 'react';

import { App } from '@capacitor/app';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { initMobileBackHandler } from 'lib/mobile/back-handler';
import { SeedPhraseStatus } from 'lib/shared/types';

import RevealSeedPhrase from './RevealSeedPhrase';

let mockSeedStatus: SeedPhraseStatus = 'stored';
jest.mock('lib/store', () => ({
  useWalletStore: (selector: (state: { seedPhraseStatus: SeedPhraseStatus }) => SeedPhraseStatus) =>
    selector({ seedPhraseStatus: mockSeedStatus })
}));

// ---------------------------------------------------------------------------
// Mutable mock state read at call time (must be `mock`-prefixed for jest).
// ---------------------------------------------------------------------------
let mockSecret: string | null = null;
const mockSetSecret = jest.fn((v: string | null) => {
  mockSecret = v;
});
const mockRevealMnemonic = jest.fn();
const mockHasHardwareProtector = jest.fn();
const mockHasPasswordProtector = jest.fn();
const mockHapticLight = jest.fn();
const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
let mockHistoryPosition = 1;
const mockClipboardWrite = jest.fn();
let mockIsMobile = false;

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
// A spy, not a bare identity fn: `probeError` holds a translation KEY that the render
// site translates, while its sibling `authError` holds a message rendered raw. Under an
// identity `t` both look the same on screen, so dropping the `t()` call would ship a raw
// key in a user-facing banner with every test green. Asserting the CALL is the only way
// to tell them apart here.
const mockT = jest.fn((key: string) => key);
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT })
}));

jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name?: string }) => <span data-testid="icon" data-name={name} />,
  IconName: { Checkmark: 'Checkmark', CopyNew: 'CopyNew', EyeOff: 'EyeOff' }
}));

// Mirrors the real header's focus contract rather than stubbing it away: the title is
// an h1 that is focusable and claims focus from a MOUNT effect only when asked. That is
// what makes the step-change assertion meaningful - a header reconciled in place instead
// of remounted never re-runs the effect, so the announcement silently stops happening.
jest.mock('components/PageHeader', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    PageHeader: (props: { title?: string; onBack?: () => void; className?: string; focusTitleOnMount?: boolean }) => {
      const titleRef = ReactActual.useRef<HTMLHeadingElement>(null);
      ReactActual.useEffect(() => {
        if (props.focusTitleOnMount) titleRef.current?.focus();
      }, [props.focusTitleOnMount]);
      return (
        <div data-testid="nav-header" className={props.className}>
          <h1 data-testid="nh-title" ref={titleRef} tabIndex={props.focusTitleOnMount ? -1 : undefined}>
            {props.title}
          </h1>
          <button data-testid="nh-back" onClick={props.onBack} />
        </div>
      );
    }
  };
});

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

// Drawer stub: like vaul's portal, it renders its content only while open. It
// exposes buttons that fire onOpenChange with both `false` (close) and `true`
// (no-op) so the `!open && ...` branch is fully exercised.
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
      {open && children}
    </div>
  ),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-content">{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-header">{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-title">{children}</div>
}));

jest.mock('lib/miden/back/vault', () => ({
  Vault: {
    hasHardwareProtector: () => mockHasHardwareProtector(),
    hasPasswordProtector: () => mockHasPasswordProtector()
  }
}));

jest.mock('lib/miden/front', () => ({
  useSecretState: () => [mockSecret, mockSetSecret],
  useMidenContext: () => ({ revealMnemonic: mockRevealMnemonic })
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: () => mockHapticLight()
}));

jest.mock('lib/platform', () => ({
  isMobile: () => mockIsMobile,
  isAndroid: () => true
}));

// Hardware back runs through the real hook and registry; only the native listener is stubbed, so a
// test presses the handler the page registered under its deps (#1042).
let mockBackButton: (() => void) | undefined;
jest.mock('@capacitor/app', () => ({
  App: {
    addListener: jest.fn((event: string, callback: () => void) => {
      if (event === 'backButton') mockBackButton = callback;
      return Promise.resolve({ remove: jest.fn() });
    }),
    minimizeApp: jest.fn()
  }
}));

// On mobile the words wait for the screenshot guard, whose native plugin jsdom never answers.
jest.mock('lib/mobile/screenshot-guard', () => ({
  useScreenshotGuard: () => true
}));

jest.mock('@capacitor/clipboard', () => ({
  Clipboard: { write: (...args: unknown[]) => mockClipboardWrite(...args) }
}));

// The warning's Close and back go through useBackWithFallback, which reads live
// history: pop when there is an entry to pop, else route to the Settings root.
jest.mock('lib/woozie', () => ({
  goBack: () => mockGoBack(),
  navigate: (...args: unknown[]) => mockNavigate(...args),
  HistoryAction: { Push: 'push', Replace: 'replace' },
  createLocationState: () => ({
    historyPosition: mockHistoryPosition,
    href: 'http://localhost/#/settings/reveal-seed-phrase'
  }),
  listen: () => () => undefined
}));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
describe('RevealSeedPhrase', () => {
  let testRoot: ReturnType<typeof createRoot> | null = null;
  let testContainer: HTMLDivElement | null = null;

  beforeAll(async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    mockIsMobile = true;
    await initMobileBackHandler();
  });

  afterAll(() => {
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Only read when the hardware probe REJECTS, which no other test makes it do.
    mockHasPasswordProtector.mockResolvedValue(false);
    mockSecret = null;
    mockSeedStatus = 'stored';
    mockClipboardWrite.mockResolvedValue(undefined);
    mockIsMobile = false;
    mockHistoryPosition = 1;
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

  // The page opens on the privacy warning; View moves on to the auth gate.
  const clickView = async (container: HTMLElement) => {
    await act(async () => {
      buttonWithText(container, 'view')!.click();
    });
    await flush();
  };

  const renderAndView = async () => {
    const container = await render();
    await clickView(container);
    return container;
  };

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
  it.each<Exclude<SeedPhraseStatus, 'stored'>>(['removed', 'removing', 'unavailable'])(
    'does not request or display a phrase when its status is %s',
    async status => {
      mockSeedStatus = status;
      mockSecret = 'alpha beta gamma delta';
      const container = await render();
      // Three distinct states, spelled out as a literal table rather than
      // recomputed from the production map, which would make this tautological.
      // 'removing' is retried on the next unlock; 'unavailable' means a wallet
      // imported from a key that never had a phrase here, so neither may claim
      // the phrase was removed.
      const expectedNotice = {
        removing: 'seedRemovalIncomplete',
        removed: 'seedPhraseRemoved',
        unavailable: 'seedPhraseUnavailable'
      } as const;
      expect(container.querySelector('[role="status"]')?.textContent).toBe(expectedNotice[status]);
      expect(container.textContent).not.toContain('alpha');
      expect(mockSetSecret).toHaveBeenCalledWith(null);
      expect(mockHasHardwareProtector).not.toHaveBeenCalled();
      expect(mockRevealMnemonic).not.toHaveBeenCalled();
    }
  );

  it('discards a pending biometric reveal when the phrase is removed', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    let finishReveal: (phrase: string) => void = () => undefined;
    mockRevealMnemonic.mockReturnValue(
      new Promise<string>(resolve => {
        finishReveal = resolve;
      })
    );
    const container = await renderAndView();
    mockSeedStatus = 'removed';
    await act(async () => {
      testRoot?.render(<RevealSeedPhrase />);
    });
    await act(async () => {
      finishReveal('alpha beta gamma delta');
    });
    expect(mockSetSecret).not.toHaveBeenCalledWith('alpha beta gamma delta');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('seedPhraseRemoved');
  });

  // -------------------------------------------------------------------------
  // Warning step: the page's first screen, before any secret is asked for.
  // -------------------------------------------------------------------------
  it('opens on the warning, with View disabled until the hardware-protector check resolves', async () => {
    const container = renderNoFlush();
    expect(buttonWithText(container, 'view')!.disabled).toBe(true);
    await flush();
    await flush();
    expect(buttonWithText(container, 'view')!.disabled).toBe(false);
  });

  it.each([false, true])('shows the warning first and asks for nothing yet (hardware: %s)', async hasHw => {
    mockHasHardwareProtector.mockResolvedValue(hasHw);
    const container = await render();

    expect(container.querySelector('[data-testid="nh-title"]')!.textContent).toBe('recoveryPhrase');
    // PageHeader has no horizontal padding of its own; the page supplies it.
    expect(container.querySelector('[data-testid="nav-header"]')).toHaveClass('px-4');
    expect(container.querySelector('[data-name="EyeOff"]')).toBeTruthy();
    expect(container.textContent).toContain('viewThisInPrivatePlace');
    expect(container.textContent).toContain('anyoneWithRecoveryPhrase');
    expect(container.textContent).toContain('pleaseWriteDownRecoveryPhrase');
    expect(buttonWithText(container, 'close')).toBeTruthy();
    expect(buttonWithText(container, 'view')).toBeTruthy();

    // No auth prompt, the password drawer mounted but closed, and (the auto-close
    // effect must not mistake "no secret yet" for "secret expired") no navigation.
    expect(mockRevealMnemonic).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="drawer"]')!.getAttribute('data-open')).toBe('false');
    expect(mockGoBack).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('puts Close beside View in one padded row', async () => {
    const container = await render();
    const close = buttonWithText(container, 'close')!;
    const view = buttonWithText(container, 'view')!;
    expect(close.parentElement).toBe(view.parentElement);
    expect(close.parentElement).toHaveClass('flex', 'gap-2.5', 'px-4');
  });

  // A failed hardware probe says nothing about the password credential, so the page
  // asks the complement instead of guessing. Answering "no hardware" on a rejection
  // would send a hardware-only wallet into a password gate that cannot succeed.
  it('takes the password gate when the probe fails but a password credential exists', async () => {
    mockHasHardwareProtector.mockRejectedValue(new Error('storage'));
    mockHasPasswordProtector.mockResolvedValue(true);

    const container = await renderAndView();

    expect(container.querySelector('[data-testid="drawer"]')!.getAttribute('data-open')).toBe('true');
    expect(mockRevealMnemonic).not.toHaveBeenCalled();
  });

  it('takes the hardware gate when the probe fails and there is no password credential', async () => {
    mockHasHardwareProtector.mockRejectedValue(new Error('storage'));
    mockHasPasswordProtector.mockResolvedValue(false);
    mockRevealMnemonic.mockResolvedValue('alpha beta gamma delta');

    const container = await renderAndView();

    expect(mockRevealMnemonic).toHaveBeenCalledWith(undefined);
    expect(container.querySelector('[data-testid="drawer"]')).toBeNull();
  });

  // Both reads failing means storage is unavailable, not that the wallet has no
  // credential - a credential-less wallet resolves both to false. It is transient,
  // and the probe only runs on mount, so the surface carries its own Retry.
  it('surfaces an error with a working Retry when both protector reads fail', async () => {
    mockHasHardwareProtector.mockRejectedValue(new Error('storage'));
    mockHasPasswordProtector.mockRejectedValue(new Error('storage'));

    const container = await render();

    expect(container.querySelector('[data-testid="reveal-seed-probe-error"]')!.textContent).toContain(
      'couldNotCheckUnlockMethod'
    );
    // The banner must be TRANSLATED, not rendered as the bare key it stores.
    expect(mockT).toHaveBeenCalledWith('couldNotCheckUnlockMethod');
    expect(buttonWithText(container, 'view')!.disabled).toBe(true);
    expect(mockRevealMnemonic).not.toHaveBeenCalled();

    mockHasHardwareProtector.mockResolvedValue(true);
    await act(async () => {
      buttonWithText(container, 'retry')!.click();
    });
    await flush();

    expect(container.querySelector('[data-testid="reveal-seed-probe-error"]')).toBeNull();
    expect(buttonWithText(container, 'view')!.disabled).toBe(false);
  });

  // Retry must survive its own click: a read that HANGS rather than rejecting used to leave a
  // disabled View, no Retry and only Close. The error now stays on screen with a disabled, loading
  // Retry for the first 5 s; past the deadline the wait notice takes over (see 'swaps the error...').
  it('keeps the error and the Retry on screen while a retry is still in flight', async () => {
    mockHasHardwareProtector.mockRejectedValue(new Error('storage'));
    mockHasPasswordProtector.mockRejectedValue(new Error('storage'));
    const container = await render();

    mockHasHardwareProtector.mockReturnValue(new Promise<boolean>(() => {}));
    await act(async () => {
      buttonWithText(container, 'retry')!.click();
    });

    expect(container.querySelector('[data-testid="reveal-seed-probe-error"]')).not.toBeNull();
    const retry = buttonWithText(container, 'retry');
    expect(retry).toBeTruthy();
    expect(retry!.disabled).toBe(true);
  });

  // Names the contract that the mount-failure tests only cover incidentally: a retry
  // that fails AGAIN must hand the button back. The catch re-sets the identical key, so
  // React bails out of that re-render and only the probing flag returns the control.
  it('re-enables Retry after a retry fails again', async () => {
    mockHasHardwareProtector.mockRejectedValue(new Error('storage'));
    mockHasPasswordProtector.mockRejectedValue(new Error('storage'));
    const container = await render();

    await act(async () => {
      buttonWithText(container, 'retry')!.click();
    });
    await flush();

    expect(container.querySelector('[data-testid="reveal-seed-probe-error"]')).not.toBeNull();
    expect(buttonWithText(container, 'retry')!.disabled).toBe(false);
  });

  // Leaving the page mid-probe must not leave the deadline armed: on the hanging read the bound exists
  // for, the settle path that would clear it never runs.
  it('clears the probe deadline when the page is left mid-probe', async () => {
    jest.useFakeTimers();
    try {
      mockHasHardwareProtector.mockReturnValue(new Promise<boolean>(() => {}));
      renderNoFlush();
      await act(async () => {
        await Promise.resolve();
      });
      expect(jest.getTimerCount()).toBe(1);

      await act(async () => {
        testRoot!.unmount();
        testRoot = null;
      });

      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  // A hang has no other evidence (no rejection, no stack), so the log is its only trace.
  it('logs once when the probe deadline passes', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockHasHardwareProtector.mockReturnValue(new Promise<boolean>(() => {}));
      renderNoFlush();
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        jest.advanceTimersByTime(6000);
      });

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('still waiting after 5000ms'));
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });

  // Past the deadline the page keeps its one probe in flight and offers no Retry, so no two probes on
  // one page ever overlap; the notice's way to retry is leaving and reopening the page.
  it('shows the wait notice, not an error, when a probe hangs past the deadline', async () => {
    jest.useFakeTimers();
    try {
      mockHasHardwareProtector.mockReturnValue(new Promise<boolean>(() => {}));
      const container = renderNoFlush();
      await act(async () => {
        await Promise.resolve();
      });
      expect(container.querySelector('[data-testid="reveal-seed-probe-slow"]')).toBeNull();

      await act(async () => {
        jest.advanceTimersByTime(6000);
      });
      await act(async () => {
        await Promise.resolve();
      });

      const slow = container.querySelector('[data-testid="reveal-seed-probe-slow"]');
      expect(slow!.textContent).toContain('checkingUnlockMethodSlow');
      expect(mockT).toHaveBeenCalledWith('checkingUnlockMethodSlow');
      expect(slow!.getAttribute('role')).toBe('status');
      expect(container.querySelector('[data-testid="reveal-seed-probe-error"]')).toBeNull();
      expect(buttonWithText(container, 'retry')).toBeUndefined();
      expect(buttonWithText(container, 'view')!.disabled).toBe(true);
      // The deadline has fired and nothing re-armed it: the probe waits on its read alone.
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  // The deadline and the failure raise different surfaces (the wait notice, then the error), so
  // each gets its own line.
  it('logs the wait and then the failure when a probe times out and then fails', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let rejectRead!: (e: Error) => void;
      mockHasHardwareProtector.mockReturnValue(
        new Promise<boolean>((_res, rej) => {
          rejectRead = rej;
        })
      );
      mockHasPasswordProtector.mockRejectedValue(new Error('storage'));
      const container = renderNoFlush();
      await act(async () => {
        await Promise.resolve();
      });

      await act(async () => {
        jest.advanceTimersByTime(6000);
      });
      expect(warn).toHaveBeenCalledTimes(1);

      await act(async () => {
        rejectRead(new Error('storage'));
      });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('protector probe failed:'));
      expect(container.querySelector('[data-testid="reveal-seed-probe-slow"]')).toBeNull();
      expect(container.querySelector('[data-testid="reveal-seed-probe-error"]')).not.toBeNull();
      expect(buttonWithText(container, 'retry')!.disabled).toBe(false);
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });

  // A slow read is the common case on mobile (a native bridge call into a WebView the OS suspends
  // when backgrounded). Staying on the page adopts the first read's answer whenever it lands.
  it('adopts a slow answer that lands after the wait notice has appeared', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let settleRead!: (v: boolean) => void;
      mockHasHardwareProtector.mockReturnValue(
        new Promise<boolean>(res => {
          settleRead = res;
        })
      );
      const container = renderNoFlush();
      await act(async () => {
        await Promise.resolve();
      });

      await act(async () => {
        jest.advanceTimersByTime(6000);
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(container.querySelector('[data-testid="reveal-seed-probe-slow"]')).not.toBeNull();

      await act(async () => {
        settleRead(true);
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(container.querySelector('[data-testid="reveal-seed-probe-slow"]')).toBeNull();
      expect(container.querySelector('[data-testid="reveal-seed-probe-error"]')).toBeNull();
      expect(buttonWithText(container, 'view')!.disabled).toBe(false);
      expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('answered after the wait'));
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });

  // The wait notice's way to retry: leaving ends this page's probe with it, and the reopened page starts
  // a fresh read of its own, which answers when the first read was lost rather than wedged.
  it('reopening the page after the wait notice probes again and uses the new answer', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockHasHardwareProtector.mockReturnValueOnce(new Promise<boolean>(() => {}));
      renderNoFlush();
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        jest.advanceTimersByTime(6000);
      });
      expect(testContainer!.querySelector('[data-testid="reveal-seed-probe-slow"]')).not.toBeNull();

      await act(async () => {
        testRoot!.unmount();
        testRoot = null;
      });
      testContainer!.remove();
      testContainer = null;

      mockHasHardwareProtector.mockResolvedValueOnce(true);
      const container = renderNoFlush();
      await act(async () => {
        await Promise.resolve();
      });

      expect(mockHasHardwareProtector).toHaveBeenCalledTimes(2);
      expect(container.querySelector('[data-testid="reveal-seed-probe-slow"]')).toBeNull();
      expect(buttonWithText(container, 'view')!.disabled).toBe(false);
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });

  // A Retry from the error state keeps the error and its disabled Retry while it runs; if that read
  // then hangs past the deadline, the wait notice replaces the error, so the page never sits on a
  // disabled Retry that nothing will re-enable.
  it('swaps the error for the wait notice when a retry hangs past the deadline', async () => {
    mockHasHardwareProtector.mockRejectedValue(new Error('storage'));
    mockHasPasswordProtector.mockRejectedValue(new Error('storage'));
    const container = await render();
    expect(container.querySelector('[data-testid="reveal-seed-probe-error"]')).not.toBeNull();

    jest.useFakeTimers();
    try {
      mockHasHardwareProtector.mockReturnValue(new Promise<boolean>(() => {}));
      await act(async () => {
        buttonWithText(container, 'retry')!.click();
      });
      expect(container.querySelector('[data-testid="reveal-seed-probe-error"]')).not.toBeNull();
      expect(buttonWithText(container, 'retry')!.disabled).toBe(true);

      await act(async () => {
        jest.advanceTimersByTime(6000);
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(container.querySelector('[data-testid="reveal-seed-probe-error"]')).toBeNull();
      expect(container.querySelector('[data-testid="reveal-seed-probe-slow"]')).not.toBeNull();
      expect(buttonWithText(container, 'retry')).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  // Pins the bound from BELOW: a probe that settles normally never shows the wait notice and leaves no
  // timer behind.
  it('lets a normal probe settle without arming a lasting timer', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Timer-driven, so it settles strictly inside the bound; an instantly-resolving mock settles in a
      // microtask and would pass for any bound.
      mockHasHardwareProtector.mockReturnValue(
        new Promise<boolean>(res => {
          setTimeout(() => res(true), 4000);
        })
      );
      const container = renderNoFlush();
      await act(async () => {
        await Promise.resolve();
      });

      await act(async () => {
        jest.advanceTimersByTime(3999);
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(container.querySelector('[data-testid="reveal-seed-probe-slow"]')).toBeNull();
      expect(container.querySelector('[data-testid="reveal-seed-probe-error"]')).toBeNull();

      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(container.querySelector('[data-testid="reveal-seed-probe-slow"]')).toBeNull();
      expect(container.querySelector('[data-testid="reveal-seed-probe-error"]')).toBeNull();
      expect(buttonWithText(container, 'view')!.disabled).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
      // A probe that never waited has nothing to report.
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });

  it.each(['close', 'back'])('returns to Settings via %s on the warning', async control => {
    const container = await render();
    const target =
      control === 'close'
        ? buttonWithText(container, 'close')!
        : container.querySelector<HTMLButtonElement>('[data-testid="nh-back"]')!;

    await act(async () => {
      target.click();
    });

    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockRevealMnemonic).not.toHaveBeenCalled();
    // The real Button fires the tap buzz itself (the PageHeader stub's back does not),
    // so any count past that one is a SECOND buzz from the handler. The Settings overlay
    // this page replaced had the same pair and asserted the same thing.
    expect(mockHapticLight).toHaveBeenCalledTimes(control === 'close' ? 1 : 0);
  });

  it('routes to the Settings root from the warning when the page was opened cold', async () => {
    mockHistoryPosition = 0;
    const container = await render();

    await act(async () => {
      buttonWithText(container, 'close')!.click();
    });

    expect(mockGoBack).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/settings', 'replace');
  });

  it('keeps the warning on screen while the biometric prompt is pending', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    mockRevealMnemonic.mockReturnValue(new Promise<string>(() => undefined));
    const container = await renderAndView();

    expect(mockRevealMnemonic).toHaveBeenCalledWith(undefined);
    expect(container.textContent).toContain('viewThisInPrivatePlace');
    expect(buttonWithText(container, 'view')!.disabled).toBe(true);
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it('moves from the warning to the password drawer on View for a password-backed vault', async () => {
    mockHasHardwareProtector.mockResolvedValue(false);
    const container = await renderAndView();

    expect(container.textContent).not.toContain('viewThisInPrivatePlace');
    expect(container.querySelector('[data-testid="drawer"]')!.getAttribute('data-open')).toBe('true');
    expect(mockGoBack).not.toHaveBeenCalled();
    // Same rule as Close above: View must add no buzz of its own, past the Button's one.
    expect(mockHapticLight).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Hardware-backed success path -> revealed view.
  // -------------------------------------------------------------------------
  // #1042: hardware back does what the header back does on the screen showing, through `leave`,
  // which also abandons an in-flight reveal; a plain history pop would skip it. Android minimizes the
  // app only when no handler consumed the press.
  const hardwareBack = async () => {
    expect(mockBackButton).toBeDefined();
    await act(async () => {
      mockBackButton!();
    });
    expect(App.minimizeApp).not.toHaveBeenCalled();
  };

  it('hardware back on the warning leaves the page, as the header back does', async () => {
    mockIsMobile = true;
    await render();
    await hardwareBack();
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('hardware back on the revealed phrase hides it and leaves, as the header back does', async () => {
    mockIsMobile = true;
    mockHasHardwareProtector.mockResolvedValue(true);
    const container = await renderAndView();
    expect(container.querySelector('[data-testid="seed-word-0"]')).not.toBeNull();
    mockHapticLight.mockClear();
    mockSetSecret.mockClear();
    await hardwareBack();
    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(mockSetSecret).toHaveBeenCalledWith(null);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('hardware back while the biometric reveal is pending leaves, and the phrase it returns is dropped', async () => {
    mockIsMobile = true;
    mockHasHardwareProtector.mockResolvedValue(true);
    let finishReveal: (phrase: string) => void = () => undefined;
    mockRevealMnemonic.mockReturnValue(
      new Promise<string>(resolve => {
        finishReveal = resolve;
      })
    );
    const container = await renderAndView();
    await hardwareBack();
    await act(async () => {
      finishReveal('alpha beta gamma delta');
    });
    expect(mockSetSecret).not.toHaveBeenCalledWith('alpha beta gamma delta');
    expect(container.querySelector('[data-testid="seed-word-0"]')).toBeNull();
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('reveals the seed phrase via hardware unlock after View and shows the numbered word grid', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    mockRevealMnemonic.mockResolvedValue('alpha beta gamma delta');
    const container = await renderAndView();

    expect(mockRevealMnemonic).toHaveBeenCalledWith(undefined);
    expect(mockSetSecret).toHaveBeenCalledWith('alpha beta gamma delta');

    // Revealed view: PageHeader + the numbered words + copy/hide buttons.
    expect(container.querySelector('[data-testid="nh-title"]')!.textContent).toBe('recoveryPhrase');
    // PageHeader has no horizontal padding of its own — the page supplies it,
    // or the back button's hit area is clipped by an overflow-hidden ancestor.
    expect(container.querySelector('[data-testid="nav-header"]')).toHaveClass('px-4');
    // The same grid the verify flow draws: numbered, in the phrase's own casing.
    expect(container.querySelector('[data-testid="seed-word-0"]')!.textContent).toBe('alpha');
    expect(container.querySelector('[data-testid="seed-word-3"]')!.textContent).toBe('delta');
    // Not-yet-copied label + the shared copy glyph.
    expect(container.textContent).toContain('copyToClipboard');
    expect(container.querySelector('[data-copy-icon] [data-name="CopyNew"]')).toBeTruthy();
    expect(buttonWithText(container, 'hideRecoveryPhrase')).toBeTruthy();

    // Copy button click -> haptic + the phrase written through the shared clipboard.
    const copyBtn = buttonWithText(container, 'copyToClipboard') as HTMLButtonElement;
    await act(async () => {
      copyBtn.click();
    });
    expect(mockHapticLight).toHaveBeenCalled();
    expect(mockClipboardWrite).toHaveBeenCalledWith({ string: 'alpha beta gamma delta' });
  });

  it('shows the "copied" state once the write lands (the shared glyph morphed to a check + the label rolled to copied)', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    const container = await renderAndView();

    await act(async () => {
      (buttonWithText(container, 'copyToClipboard') as HTMLButtonElement).click();
    });

    // The label rolls, so the leaving one is still mounted mid-exit: read the one that is present.
    expect(container.querySelector('[data-copy-label] [data-present="true"]')!.textContent).toBe('copied');
    expect(container.querySelector('[data-copy-icon] [data-name="Checkmark"]')).toBeTruthy();
  });

  // The phrase is the one value where a false "Copied" costs the most: the page clears it after
  // 20s, and a user who read "Copied" believes they hold a backup.
  it('keeps the copy label when the clipboard write is refused', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    mockClipboardWrite.mockRejectedValue(new Error('write refused'));
    const container = await renderAndView();

    await act(async () => {
      (buttonWithText(container, 'copyToClipboard') as HTMLButtonElement).click();
    });

    expect(mockClipboardWrite).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-copy-label] [data-present="true"]')!.textContent).toBe('copyToClipboard');
    expect(container.querySelector('[data-copy-icon] [data-name="Checkmark"]')).toBeNull();
  });

  it('hides the phrase (haptic + clear secret + goBack) via the Hide button', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    const container = await renderAndView();

    const hideBtn = buttonWithText(container, 'hideRecoveryPhrase') as HTMLButtonElement;
    mockGoBack.mockClear();
    mockSetSecret.mockClear();
    await act(async () => {
      hideBtn.click();
    });

    expect(mockHapticLight).toHaveBeenCalled();
    expect(mockSetSecret).toHaveBeenCalledWith(null);
    // Hide leaves through leave(): one pop.
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('draws the revealed words on the shared fill surface, with copy as a shared pill', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    const container = await renderAndView();

    const grid = container.querySelector('[data-testid="seed-word-0"]')!.closest('.rounded-2xl')!;
    expect(grid).toHaveClass('bg-fill', 'rounded-2xl');
    expect(container.querySelector('[data-testid="seed-word-0"]')).toHaveClass('text-value', 'text-ink');
    // No lone white block and no bordered one-off copy button any more.
    expect(container.querySelector('.bg-white')).toBeNull();
    expect(container.querySelector('.border-border-card')).toBeNull();
  });

  it('runs handleHide from the revealed-view PageHeader back button', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    const container = await renderAndView();

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
  // Warning -> words is the boundary that needs the key. Before #1122 the password path
  // crossed it through the `!secret && isSubmitting` null return, which already unmounted
  // and remounted the header on its own, so a test written there would have passed with
  // the key deleted. The reveal now stays on the auth branch while submitting (no empty
  // render), so both paths depend on the key for this remount - hardware is used here
  // because it reaches the transition without a drawer interaction.
  it('mounts a fresh header at the words step so its title is announced', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    mockRevealMnemonic.mockResolvedValue('alpha beta gamma delta');

    const container = renderNoFlush();
    await flush();
    await flush();
    const warningTitle = container.querySelector('[data-testid="nh-title"]');

    await act(async () => {
      buttonWithText(container, 'view')!.click();
    });
    await flush();

    expect(container.textContent).toContain('alpha');
    const wordsTitle = container.querySelector('[data-testid="nh-title"]');
    // Node identity, not focus: this suite renders into a DETACHED container, so
    // element.focus() is a no-op and document.activeElement never leaves <body>.
    // A remount is the thing the key buys and the thing the focus effect needs -
    // PageHeader.test.tsx already pins that a mounted header with the prop takes
    // focus for real, so proving the remount completes the chain.
    expect(wordsTitle).not.toBe(warningTitle);
    expect(wordsTitle).toHaveAttribute('tabindex', '-1');
  });

  // Close stays live while the biometric prompt is up, and history.go(-1) settles on
  // a later task, so the page is still mounted when a late reveal resolves. Leaving
  // has to invalidate the request, not just navigate.
  it('discards a reveal that resolves after the user has already left', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    let resolveReveal!: (value: string) => void;
    mockRevealMnemonic.mockReturnValue(
      new Promise<string>(res => {
        resolveReveal = res;
      })
    );
    const container = await renderAndView();

    await act(async () => {
      buttonWithText(container, 'close')!.click();
    });
    await act(async () => {
      resolveReveal('alpha beta gamma delta');
    });
    await flush();

    expect(mockSetSecret).not.toHaveBeenCalledWith('alpha beta gamma delta');
    expect(container.textContent).not.toContain('alpha');
  });

  it('stands on the auth-error view instead of navigating away from it', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    mockRevealMnemonic.mockRejectedValue(new Error('biometric failed'));
    const container = await renderAndView();

    expect(mockSetSecret).not.toHaveBeenCalledWith(expect.stringContaining('alpha'));
    // The shared negative Notice carries the message, in place of the Alert atom.
    expect(container.querySelector('[data-tone="negative"] [data-slot="body"]')!.textContent).toBe('biometric failed');
    // BOTH at zero is the discriminating assertion. A count of 1 could not tell the
    // fix from the bug: the catch and the auto-close effect each wanted out, so
    // removing one merely promoted the other and the total stayed 1.
    expect(mockGoBack).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();

    // And the view must be usable, not just present: Close leaves, Retry re-reveals.
    expect(buttonWithText(container, 'retry')).toBeTruthy();
    await act(async () => {
      buttonWithText(container, 'close')!.click();
    });
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('retries the reveal from the error view and clears the error on success', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    mockRevealMnemonic.mockRejectedValue(new Error('biometric failed'));
    const container = await renderAndView();

    mockRevealMnemonic.mockResolvedValue('alpha beta gamma delta');
    await act(async () => {
      buttonWithText(container, 'retry')!.click();
    });
    await flush();

    expect(container.querySelector('[data-tone="negative"]')).toBeNull();
    expect(container.textContent).toContain('alpha');
    expect(mockGoBack).not.toHaveBeenCalled();

    // The words branch renders ahead of the error branch, so a stale authError is
    // INVISIBLE while a secret exists - asserting here alone would pass either way.
    // It only bites once the 20s auto-hide clears the secret: the auto-close effect
    // is gated on authError, so an uncleared one makes it refuse to leave and the
    // user lands back on a stale "biometric failed" screen until Close or Back.
    mockSecret = null;
    await act(async () => {
      testRoot!.render(<RevealSeedPhrase />);
    });
    await act(async () => {
      testRoot!.render(<RevealSeedPhrase />);
    });

    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-tone="negative"]')).toBeNull();
  });

  it('leaves to the Settings root exactly once when a cold-opened biometric reveal fails', async () => {
    mockHistoryPosition = 0;
    mockHasHardwareProtector.mockResolvedValue(true);
    mockRevealMnemonic.mockRejectedValue(new Error('biometric failed'));
    await renderAndView();

    // Cold open: nothing to pop. The error still stands rather than replacing the
    // route out from under it.
    expect(mockGoBack).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Desktop password path -> drawer with typed password.
  // -------------------------------------------------------------------------
  it('reveals the seed phrase via the desktop password drawer', async () => {
    mockIsMobile = false;
    mockHasHardwareProtector.mockResolvedValue(false);
    const container = await renderAndView();

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

  // A pending reveal used to blank the page entirely (`!secret && isSubmitting`
  // returned null), removing the drawer and the loading button it was waiting on (#1122).
  it('keeps the password step and a loading Continue on screen while the reveal is pending', async () => {
    mockIsMobile = false;
    mockHasHardwareProtector.mockResolvedValue(false);
    mockRevealMnemonic.mockReturnValue(new Promise<string>(() => undefined));
    const container = await renderAndView();

    await typePassword(container, 'my-password');
    await act(async () => {
      (buttonWithText(container, 'continue') as HTMLButtonElement).click();
    });
    await flush();

    expect(container.querySelector('[data-testid="reveal-seed-auth"]')).toBeTruthy();
    expect(container.querySelector('input[name="password"]')).toBeTruthy();
    expect(buttonWithText(container, 'continue')).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelector('[data-testid="drawer"]')!.getAttribute('data-open')).toBe('true');
  });

  // The generation guard on the SUCCESS branch (unchanged by this fix) must still discard a
  // reveal that resolves after the user has already left mid-submit. Asserting page text alone
  // would pass even with that guard deleted - leave() has already cleared `secret`, and nothing
  // re-renders the words from a value nobody set - so this asserts the call directly (#1122).
  it('discards a password reveal that resolves after the drawer is closed mid-submit', async () => {
    mockIsMobile = false;
    mockHasHardwareProtector.mockResolvedValue(false);
    let resolveReveal: (value: string) => void = () => undefined;
    mockRevealMnemonic.mockReturnValue(
      new Promise<string>(res => {
        resolveReveal = res;
      })
    );
    const container = await renderAndView();

    await typePassword(container, 'my-password');
    await act(async () => {
      (buttonWithText(container, 'continue') as HTMLButtonElement).click();
    });
    await flush();

    await act(async () => {
      (container.querySelector('[data-testid="drawer-close"]') as HTMLButtonElement).click();
    });
    await flush();

    await act(async () => {
      resolveReveal('alpha beta gamma delta');
    });
    await flush();

    expect(mockSetSecret).not.toHaveBeenCalledWith('alpha beta gamma delta');
  });

  // A REJECTED submit needs the same generation guard as the success branch just above -
  // otherwise a late error from a superseded submit writes a form error into an instance
  // the user has already left. `error-caption` is invisible on the warning branch either
  // way, so the only way to observe a leftover error is to reopen and check it isn't
  // already there before the user has done anything in the new attempt (#1122).
  it('discards a rejected password reveal that settles after the drawer is closed mid-submit', async () => {
    mockIsMobile = false;
    mockHasHardwareProtector.mockResolvedValue(false);
    let rejectReveal: (err: Error) => void = () => undefined;
    mockRevealMnemonic.mockReturnValueOnce(
      new Promise<string>((_res, rej) => {
        rejectReveal = rej;
      })
    );
    const container = await renderAndView();

    await typePassword(container, 'my-password');
    await act(async () => {
      (buttonWithText(container, 'continue') as HTMLButtonElement).click();
    });
    await flush();

    await act(async () => {
      (container.querySelector('[data-testid="drawer-close"]') as HTMLButtonElement).click();
    });
    await flush();

    await act(async () => {
      rejectReveal(new Error('wrong password'));
    });
    await flushErrorDelay();

    mockRevealMnemonic.mockResolvedValue('alpha beta gamma delta');
    await clickView(container);

    expect(container.querySelector('[data-testid="error-caption"]')).toBeNull();
  });

  // The rejection lands while the drawer is still open, so the catch is already inside
  // its 300ms delay when the user closes it; the guard has to hold across that await.
  it('discards a rejected password reveal when the drawer is closed during its error delay', async () => {
    mockIsMobile = false;
    mockHasHardwareProtector.mockResolvedValue(false);
    mockRevealMnemonic.mockRejectedValueOnce(new Error('wrong password'));
    const container = await renderAndView();

    await typePassword(container, 'my-password');
    await act(async () => {
      (buttonWithText(container, 'continue') as HTMLButtonElement).click();
    });
    await flush();

    await act(async () => {
      (container.querySelector('[data-testid="drawer-close"]') as HTMLButtonElement).click();
    });
    await flushErrorDelay();

    mockRevealMnemonic.mockResolvedValue('alpha beta gamma delta');
    await clickView(container);

    expect(container.querySelector('[data-testid="drawer"]')!.getAttribute('data-open')).toBe('true');
    expect(container.querySelector('[data-testid="error-caption"]')).toBeNull();
  });

  // Hide must land back on the warning, not on the auth branch's closed drawer with
  // nothing to interact with (#1122).
  it('returns to the warning when the phrase is hidden', async () => {
    mockIsMobile = false;
    mockHasHardwareProtector.mockResolvedValue(false);
    const container = await renderAndView();

    await typePassword(container, 'my-password');
    await act(async () => {
      (buttonWithText(container, 'continue') as HTMLButtonElement).click();
    });
    await flush();

    await act(async () => {
      (buttonWithText(container, 'hideRecoveryPhrase') as HTMLButtonElement).click();
    });
    await flush();

    expect(buttonWithText(container, 'view')).toBeTruthy();
    expect(container.textContent).not.toContain('alpha');
  });

  // The step reset in leave() (#1122) must not unmount the Drawer along with the 'auth'
  // branch it used to live inside - it has to stay in the tree, closed, so vaul's own CSS
  // close transition gets to run instead of the sheet vanishing with its parent.
  it('keeps the drawer mounted (closed) after its own close, instead of unmounting with the step reset', async () => {
    mockIsMobile = false;
    mockHasHardwareProtector.mockResolvedValue(false);
    const container = await renderAndView();

    const before = container.querySelector('[data-testid="drawer"]');
    expect(before!.getAttribute('data-open')).toBe('true');

    await act(async () => {
      (container.querySelector('[data-testid="drawer-close"]') as HTMLButtonElement).click();
    });
    await flush();

    expect(buttonWithText(container, 'view')).toBeTruthy();
    // The same element, not merely a closed one: a remount loses vaul's close transition.
    expect(container.querySelector('[data-testid="drawer"]')).toBe(before);
    expect(before!.getAttribute('data-open')).toBe('false');
  });

  it('surfaces a submit error caption after a failed desktop password unlock', async () => {
    mockIsMobile = false;
    mockHasHardwareProtector.mockResolvedValue(false);
    mockRevealMnemonic.mockRejectedValue(new Error('wrong password'));
    const container = await renderAndView();

    await typePassword(container, 'bad-password');
    const cont = buttonWithText(container, 'continue') as HTMLButtonElement;
    await act(async () => {
      cont.click();
    });
    await flushErrorDelay();

    expect(mockRevealMnemonic).toHaveBeenCalledWith('bad-password');
    expect(mockSetSecret).not.toHaveBeenCalledWith('alpha beta gamma delta');
    expect(container.querySelector('[data-testid="error-caption"]')!.textContent).toBe('wrong password');
    // The drawer must stay open on the same auth branch - a submit error is not an exit.
    expect(container.querySelector('[data-testid="drawer"]')!.getAttribute('data-open')).toBe('true');
    expect(container.querySelector('[data-testid="reveal-seed-auth"]')).toBeTruthy();
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it('closes the desktop drawer (goBack) via onOpenChange(false); onOpenChange(true) is a no-op', async () => {
    mockHasHardwareProtector.mockResolvedValue(false);
    const container = await renderAndView();

    // onOpenChange(true) must NOT trigger close/goBack.
    mockGoBack.mockClear();
    await act(async () => {
      (container.querySelector('[data-testid="drawer-open"]') as HTMLButtonElement).click();
    });
    expect(mockGoBack).not.toHaveBeenCalled();

    // onOpenChange(false) -> leave() -> goBack, exactly once.
    await act(async () => {
      (container.querySelector('[data-testid="drawer-close"]') as HTMLButtonElement).click();
    });
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('goes back from the drawer-view PageHeader back button', async () => {
    mockHasHardwareProtector.mockResolvedValue(false);
    const container = await renderAndView();

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
    const container = await renderAndView();

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

  // The mobile counterpart of the desktop pending test above: a pending reveal must keep the
  // numpad's own submitting indicator on screen instead of blanking the page (#1122).
  it('marks the passcode entry as submitting while a mobile reveal is pending', async () => {
    mockIsMobile = true;
    mockHasHardwareProtector.mockResolvedValue(false);
    mockRevealMnemonic.mockReturnValue(new Promise<string>(() => undefined));
    const container = await renderAndView();

    await act(async () => {
      (container.querySelector('[data-testid="passcode-submit"]') as HTMLButtonElement).click();
    });
    await flush();

    expect(container.querySelector('[data-testid="reveal-seed-auth"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="passcode-submitting"]')!.textContent).toBe('true');
  });

  it('surfaces a passcode error in the numpad after a failed mobile unlock', async () => {
    mockIsMobile = true;
    mockHasHardwareProtector.mockResolvedValue(false);
    mockRevealMnemonic.mockRejectedValue(new Error('wrong passcode'));
    const container = await renderAndView();

    await act(async () => {
      (container.querySelector('[data-testid="passcode-submit"]') as HTMLButtonElement).click();
    });
    await flushErrorDelay();

    // The form error is threaded into PasscodeEntry's `error` prop (not `null`).
    expect(mockRevealMnemonic).toHaveBeenCalledWith('123456');
    expect(mockSetSecret).not.toHaveBeenCalledWith('alpha beta gamma delta');
    expect(container.querySelector('[data-testid="passcode-error"]')!.textContent).toBe('wrong passcode');
  });

  it('leaves the page exactly once when the revealed phrase auto-hides', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    const container = await renderAndView();
    expect(buttonWithText(container, 'hideRecoveryPhrase')).toBeTruthy();
    mockGoBack.mockClear();

    // useSecretState clears the secret after 20s; stand in for that timer.
    mockSecret = null;
    await act(async () => {
      testRoot!.render(<RevealSeedPhrase />);
    });
    await act(async () => {
      testRoot!.render(<RevealSeedPhrase />);
    });

    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
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
