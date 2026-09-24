import React from 'react';

import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

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
const mockCopy = jest.fn();
let mockCopied = false;
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
  isMobile: () => mockIsMobile
}));

jest.mock('lib/ui/useCopyToClipboard', () => ({
  __esModule: true,
  default: () => ({ fieldRef: { current: null }, copy: mockCopy, copied: mockCopied })
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

  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
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
    mockCopied = false;
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

    // No auth prompt, no password drawer, and (the auto-close effect must not
    // mistake "no secret yet" for "secret expired") no navigation.
    expect(mockRevealMnemonic).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="drawer"]')).toBeNull();
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

    expect(container.querySelector('[data-testid="alert"]')!.textContent).toContain('couldNotCheckUnlockMethod');
    // The banner must be TRANSLATED, not rendered as the bare key it stores.
    expect(mockT).toHaveBeenCalledWith('couldNotCheckUnlockMethod');
    expect(buttonWithText(container, 'view')!.disabled).toBe(true);
    expect(mockRevealMnemonic).not.toHaveBeenCalled();

    mockHasHardwareProtector.mockResolvedValue(true);
    await act(async () => {
      buttonWithText(container, 'retry')!.click();
    });
    await flush();

    expect(container.querySelector('[data-testid="alert"]')).toBeNull();
    expect(buttonWithText(container, 'view')!.disabled).toBe(false);
  });

  // Retry must survive its own click. Clearing the error at the START of a probe
  // unmounted the block the button lives in, so a read that HANGS rather than
  // rejecting left a disabled View, no Retry and only Close.
  it('keeps the error and the Retry on screen while a retry is still in flight', async () => {
    mockHasHardwareProtector.mockRejectedValue(new Error('storage'));
    mockHasPasswordProtector.mockRejectedValue(new Error('storage'));
    const container = await render();

    mockHasHardwareProtector.mockReturnValue(new Promise<boolean>(() => {}));
    await act(async () => {
      buttonWithText(container, 'retry')!.click();
    });

    expect(container.querySelector('[data-testid="alert"]')).not.toBeNull();
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

    expect(container.querySelector('[data-testid="alert"]')).not.toBeNull();
    expect(buttonWithText(container, 'retry')!.disabled).toBe(false);
  });

  // The generation bump invalidates the WRITE; this pins that the cleanup also owns the
  // TIMER. Leaving the page mid-probe otherwise leaves a live handle and a closure
  // holding the read - on exactly the hanging case the bound exists for, where the
  // settle path that would clear it never runs.
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

  // The deadline is the one failure with no other evidence - no rejection, no stack, no
  // network error - so the log is its only trace. It used to be the one cause that did
  // not emit one, while the comment claimed it did.
  it('logs when the probe deadline is what raised the banner', async () => {
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

      // "waiting", not "failed": the read may still answer, and calling it a failure is
      // what made the common slow-mobile case report an error that never happened.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('still waiting'));
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });

  // The deadline releases the button WITHOUT settling the read, so a second probe can be
  // started while the first is outstanding. The first one's late settle must not disarm
  // the second one's deadline - that would leave the live probe unbounded and put the
  // page back in the dead end the bound exists to remove.
  it('keeps the live deadline when a superseded probe settles late', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let settleFirst!: (v: boolean) => void;
      mockHasHardwareProtector.mockReturnValueOnce(
        new Promise<boolean>(res => {
          settleFirst = res;
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
      expect(buttonWithText(container, 'retry')!.disabled).toBe(false);

      // Second probe, also hanging.
      mockHasHardwareProtector.mockReturnValue(new Promise<boolean>(() => {}));
      await act(async () => {
        buttonWithText(container, 'retry')!.click();
      });
      expect(jest.getTimerCount()).toBe(1);

      // The FIRST read finally lands, long after it was superseded.
      await act(async () => {
        settleFirst(true);
      });
      await act(async () => {
        await Promise.resolve();
      });

      // Its settle must not have disarmed the live probe's deadline.
      expect(jest.getTimerCount()).toBe(1);
      await act(async () => {
        jest.advanceTimersByTime(6000);
      });
      await act(async () => {
        await Promise.resolve();
      });
      // NOT the banner: it has been up since the first deadline and nothing here clears
      // it, so asserting it cannot fail and would read as proof of something it never
      // tested. A second log line is the only thing the SECOND deadline can produce.
      expect(warn).toHaveBeenCalledTimes(2);
      expect(buttonWithText(container, 'retry')!.disabled).toBe(false);
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });

  // One run can raise the banner twice - the deadline fires, then the read rejects - and
  // two lines for one banner would over-count probes in a report. The stale-settle test
  // cannot see this: it drives two runs whose reads never settle, so each logs once
  // whether or not the guard exists.
  it('logs once when a probe both times out and then fails', async () => {
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
      renderNoFlush();
      await act(async () => {
        await Promise.resolve();
      });

      await act(async () => {
        jest.advanceTimersByTime(6000);
      });
      expect(warn).toHaveBeenCalledTimes(1);

      // The same run's read now rejects, well after its deadline already spoke.
      await act(async () => {
        rejectRead(new Error('storage'));
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });

  // The deadline must DEGRADE, not truncate. A slow read is the common case on mobile,
  // where this is a native bridge call into a WebView the OS suspends when backgrounded -
  // and this page invites the user to walk somewhere private and come back. Discarding
  // the true answer because it arrived late would trade a rare hang for a routine failure.
  it('adopts a slow answer that lands after the banner has appeared', async () => {
    jest.useFakeTimers();
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
      expect(container.querySelector('[data-testid="alert"]')).not.toBeNull();

      // The read finally comes back, well past the deadline.
      await act(async () => {
        settleRead(true);
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(container.querySelector('[data-testid="alert"]')).toBeNull();
      expect(buttonWithText(container, 'view')!.disabled).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  // Pins the bound from BELOW: a probe that settles normally must never reach the
  // deadline, and must leave no timer behind.
  it('lets a normal probe settle without arming a lasting timer', async () => {
    jest.useFakeTimers();
    try {
      // A read that is SLOW but well inside the bound. It has to be timer-driven: a
      // mocked promise settles in a microtask, which beats any macrotask deadline, so
      // an instantly-resolving mock would pass even with the bound set to zero.
      mockHasHardwareProtector.mockReturnValue(
        new Promise<boolean>(res => {
          setTimeout(() => res(true), 4000);
        })
      );
      const container = renderNoFlush();
      await act(async () => {
        await Promise.resolve();
      });

      // Strictly INSIDE the bound and strictly BEFORE the read settles. Advancing to the
      // read's own settle time instead would run both timers in one go and every
      // assertion would land post-adoption, which passes for any bound including zero -
      // that is what the previous version of this test did.
      await act(async () => {
        jest.advanceTimersByTime(3999);
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(container.querySelector('[data-testid="alert"]')).toBeNull();

      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(container.querySelector('[data-testid="alert"]')).toBeNull();
      expect(buttonWithText(container, 'view')!.disabled).toBe(false);
      // And nothing is left armed once it settles.
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  // A storage read can HANG rather than reject, and the recovery affordance is gated on
  // the probe settling - so without a bound this is the worst state on the page: no
  // banner (nothing set it), a disabled View (no answer arrived) and only Close. The
  // mount probe is the bad one, because a retry at least leaves the previous banner up.
  it('turns a hanging probe into a retryable error instead of a dead end', async () => {
    jest.useFakeTimers();
    try {
      mockHasHardwareProtector.mockReturnValue(new Promise<boolean>(() => {}));
      const container = renderNoFlush();
      await act(async () => {
        await Promise.resolve();
      });

      // Before the bound: nothing to act on, which is the state being escaped.
      expect(container.querySelector('[data-testid="alert"]')).toBeNull();

      await act(async () => {
        jest.advanceTimersByTime(6000);
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(container.querySelector('[data-testid="alert"]')).not.toBeNull();
      expect(buttonWithText(container, 'retry')!.disabled).toBe(false);
    } finally {
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
    // Button fires the tap buzz itself, and it is not simulated by the mock above,
    // so any count here is a SECOND one from the handler. The Settings overlay this
    // page replaced had the same pair and asserted the same thing.
    expect(mockHapticLight).not.toHaveBeenCalled();
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
    // Same rule as Close above: View must add no buzz of its own.
    expect(mockHapticLight).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Hardware-backed success path -> revealed view.
  // -------------------------------------------------------------------------
  it('reveals the seed phrase via hardware unlock after View and shows the capitalized word grid', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    mockRevealMnemonic.mockResolvedValue('alpha beta gamma delta');
    const container = await renderAndView();

    expect(mockRevealMnemonic).toHaveBeenCalledWith(undefined);
    expect(mockSetSecret).toHaveBeenCalledWith('alpha beta gamma delta');

    // Revealed view: PageHeader + capitalized words + copy/hide buttons.
    expect(container.querySelector('[data-testid="nh-title"]')!.textContent).toBe('recoveryPhrase');
    // PageHeader has no horizontal padding of its own — the page supplies it,
    // or the back button's hit area is clipped by an overflow-hidden ancestor.
    expect(container.querySelector('[data-testid="nav-header"]')).toHaveClass('px-4');
    expect(container.textContent).toContain('Alpha');
    expect(container.textContent).toContain('Delta');
    // Not-yet-copied label + the shared copy glyph.
    expect(container.textContent).toContain('copyToClipboard');
    expect(container.querySelector('[data-copy-icon] [data-name="CopyNew"]')).toBeTruthy();
    expect(buttonWithText(container, 'hideRecoveryPhrase')).toBeTruthy();

    // Copy button click -> haptic + copy().
    const copyBtn = buttonWithText(container, 'copyToClipboard') as HTMLButtonElement;
    await act(async () => {
      copyBtn.click();
    });
    expect(mockHapticLight).toHaveBeenCalled();
    expect(mockCopy).toHaveBeenCalled();
  });

  it('shows the "copied" state (the shared glyph morphed to a check + the label rolled to copied)', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    mockCopied = true;
    const container = await renderAndView();

    expect(container.textContent).toContain('copied');
    expect(container.textContent).not.toContain('copyToClipboard');
    expect(container.querySelector('[data-copy-icon] [data-name="Checkmark"]')).toBeTruthy();
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
    // Hide clears the secret, which also trips the auto-close effect: one pop, not two.
    expect(mockGoBack).toHaveBeenCalledTimes(1);
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
  // Warning -> words is the boundary that needs the key. The password path reaches the
  // words through the `!secret && isSubmitting` null return, which already unmounts and
  // remounts the header on its own, so a test written there would pass with the key
  // deleted. The hardware path never returns null, so only the key remounts it.
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

    expect(container.textContent).toContain('Alpha');
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
    expect(container.textContent).not.toContain('Alpha');
  });

  it('stands on the auth-error view instead of navigating away from it', async () => {
    mockHasHardwareProtector.mockResolvedValue(true);
    mockRevealMnemonic.mockRejectedValue(new Error('biometric failed'));
    const container = await renderAndView();

    expect(mockSetSecret).not.toHaveBeenCalledWith(expect.stringContaining('alpha'));
    expect(container.querySelector('[data-testid="alert"]')!.textContent).toBe('biometric failed');
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

    expect(container.querySelector('[data-testid="alert"]')).toBeNull();
    expect(container.textContent).toContain('Alpha');
    expect(mockGoBack).not.toHaveBeenCalled();

    // The words branch renders ahead of the error branch, so a stale authError is
    // INVISIBLE while a secret exists - asserting here alone would pass either way.
    // It only bites once the 20s auto-hide clears the secret: the auto-close effect
    // is now gated on authError, so an uncleared one makes it refuse to leave and
    // the user lands back on a stale "biometric failed" screen with no way out.
    mockSecret = null;
    await act(async () => {
      testRoot!.render(<RevealSeedPhrase />);
    });
    await act(async () => {
      testRoot!.render(<RevealSeedPhrase />);
    });

    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="alert"]')).toBeNull();
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

    // onOpenChange(false) -> handlePasswordDrawerClose -> goBack, exactly once even
    // though closing the drawer also trips the auto-close effect.
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
