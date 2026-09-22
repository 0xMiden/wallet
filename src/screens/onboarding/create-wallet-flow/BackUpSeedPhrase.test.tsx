import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { BackUpSeedPhraseScreen } from './BackUpSeedPhrase';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// `react-i18next` drags in the full i18n runtime; echo the key back so every
// rendered label is its raw translation key and can be asserted directly.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `app/icons/v2` is a heavy SVG barrel; the component only reads `IconName`
// members, so expose stable marker strings for the two it references.
jest.mock('app/icons/v2', () => ({
  IconName: {
    Eye: 'ICON_EYE',
    EyeOff: 'ICON_EYE_OFF'
  }
}));

// `components/Button` pulls in framer-motion / haptics / the icon switch. Stub
// it to a plain <button> that records `title`, `iconLeft` and `onClick` so the
// title/icon toggles and click wiring are assertable. A `btn-<title>` test id
// makes each button addressable, and titles change as state flips.
jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' },
  Button: ({
    title,
    iconLeft,
    onClick,
    className,
    size,
    children
  }: {
    children?: React.ReactNode;
    title?: string;
    iconLeft?: unknown;
    onClick?: () => void;
    className?: string;
    size?: string;
  }) => (
    <button
      data-testid={`btn-${title}`}
      data-icon={String(iconLeft)}
      data-classname={className}
      data-size={size}
      onClick={onClick}
    >
      {children ?? title}
    </button>
  )
}));

// The shared copy confirmation (glyph morph + label roll) has its own suite; stub it to markers
// that surface the `copied` state this screen feeds it.
jest.mock('components/ui/CopyFeedback', () => ({
  AnimatedCopyIcon: ({ copied }: { copied: boolean }) => <span data-testid="copy-glyph" data-copied={String(copied)} />,
  CopyLabel: ({ copied, copiedLabel, children }: { copied: boolean; copiedLabel: string; children: string }) => (
    <span data-testid="copy-label">{copied ? copiedLabel : children}</span>
  )
}));

// `components/ui/Pill` renders the seed-word content; stub it to a div that
// simply forwards `children` and `data-testid` so the inner blur-toggle <span>
// is present in the DOM for class assertions.
jest.mock('components/ui/Pill', () => ({
  Pill: ({
    children,
    className,
    'data-testid': dataTestId
  }: {
    children: React.ReactNode;
    className?: string;
    'data-testid'?: string;
  }) => (
    <div data-testid={dataTestId} data-classname={className}>
      {children}
    </div>
  )
}));

// ---------------------------------------------------------------------------
// Environment stubs
// ---------------------------------------------------------------------------

// The copy goes through @capacitor/clipboard (its own web implementation makes the same call right
// on every surface), so that is the boundary to assert. `navigator.clipboard` is still stubbed
// because jsdom exposes none and unrelated code may reach for it.
const mockWriteText = jest.fn();
const mockClipboardWrite = jest.fn();
jest.mock('@capacitor/clipboard', () => ({
  Clipboard: { write: (...args: unknown[]) => mockClipboardWrite(...args) }
}));
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: mockWriteText },
  configurable: true
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SEED = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];

const renderComponent = (props: Partial<React.ComponentProps<typeof BackUpSeedPhraseScreen>> = {}) =>
  render(<BackUpSeedPhraseScreen seedPhrase={SEED} {...props} />);

/**
 * Fire a synthetic `copy` event on `document`, temporarily swapping
 * `window.getSelection` for the given selection value. Returns the event and a
 * spy on `preventDefault` so the handler side-effects can be asserted.
 */
const dispatchCopy = ({
  selection,
  clipboardData
}: {
  selection: { toString: () => string } | null;
  clipboardData?: { setData: jest.Mock };
}) => {
  const event = new Event('copy', { cancelable: true, bubbles: true });
  if (clipboardData !== undefined) {
    Object.defineProperty(event, 'clipboardData', { value: clipboardData, configurable: true });
  }
  const preventDefaultSpy = jest.spyOn(event, 'preventDefault');

  const originalGetSelection = window.getSelection;
  (window as unknown as { getSelection: () => unknown }).getSelection = jest.fn(() => selection);
  document.dispatchEvent(event);
  (window as unknown as { getSelection: () => unknown }).getSelection = originalGetSelection;

  return { event, preventDefaultSpy };
};

beforeEach(() => {
  mockWriteText.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BackUpSeedPhraseScreen', () => {
  describe('rendering', () => {
    it('renders the translated heading and instruction copy', () => {
      renderComponent();
      expect(screen.getByText('backUpYourWallet')).toBeInTheDocument();
      expect(screen.getByText('backUpWalletInstructions')).toBeInTheDocument();
      expect(screen.getByText('doNotShareWithAnywone')).toBeInTheDocument();
      expect(screen.getByText('seedPhraseRecoveryCaption')).toBeInTheDocument();
    });

    it('renders one chip per seed word with its 1-based index and word', () => {
      renderComponent();
      const chips = screen.getAllByTestId(/^seed-word-\d+$/);
      expect(chips).toHaveLength(SEED.length);
      expect(chips[0]).toHaveTextContent('1.');
      expect(chips[0]).toHaveTextContent('alpha');
      expect(chips[SEED.length - 1]).toHaveTextContent(`${SEED.length}.`);
      expect(chips[SEED.length - 1]).toHaveTextContent('foxtrot');
    });

    it('renders an empty grid (no chips) when given an empty seed phrase', () => {
      renderComponent({ seedPhrase: [] });
      expect(screen.queryAllByTestId(/^seed-word-\d+$/)).toHaveLength(0);
      // The continue CTA is still present.
      expect(screen.getByTestId('btn-continue')).toBeInTheDocument();
    });

    it('renders on the step layout: a 28px title, the words in the body and Continue pinned', () => {
      renderComponent({ 'data-testid': 'backup-root' });
      const root = screen.getByTestId('backup-root');
      expect(root).toHaveClass('flex', 'flex-col', 'bg-app-bg');
      expect(screen.getByRole('heading', { level: 1, name: 'backUpYourWallet' })).toBeInTheDocument();
      expect(screen.getByTestId('btn-continue').closest('[data-slot="footer"]')).not.toBeNull();
      expect(screen.getByText('backUpWalletInstructions').closest('[data-slot="step-heading"]')).not.toBeNull();
    });

    it('renders the three control buttons (show, copy, continue)', () => {
      renderComponent();
      expect(screen.getByTestId('btn-show')).toBeInTheDocument();
      expect(screen.getByTestId('btn-copyToClipboard')).toBeInTheDocument();
      expect(screen.getByTestId('btn-continue')).toBeInTheDocument();
    });

    it('gives the show/copy row buttons the canonical `sm` size instead of a manual height override', () => {
      renderComponent();
      const show = screen.getByTestId('btn-show');
      const copy = screen.getByTestId('btn-copyToClipboard');
      expect(show).toHaveAttribute('data-size', 'sm');
      expect(copy).toHaveAttribute('data-size', 'sm');
      expect(show.getAttribute('data-classname')).not.toMatch(/\bh-8\b|\btext-xs\b/);
      expect(copy.getAttribute('data-classname')).not.toMatch(/\bh-8\b|\btext-xs\b/);
      // Continue keeps the plain lg CTA anatomy, only spanning the pinned footer.
      expect(screen.getByTestId('btn-continue').getAttribute('data-classname')).toBe('max-w-none');
    });

    it("gives the show/copy row buttons equal flex-1 shares instead of a fixed w-1/2 (so a longer ru/uk label doesn't overflow at 320px), 10px apart", () => {
      renderComponent();
      const show = screen.getByTestId('btn-show');
      const copy = screen.getByTestId('btn-copyToClipboard');
      expect(show).toHaveAttribute('data-classname', 'flex-1');
      expect(copy).toHaveAttribute('data-classname', 'flex-1');
      expect(show.getAttribute('data-classname')).not.toMatch(/w-1\/2/);
      expect(copy.getAttribute('data-classname')).not.toMatch(/w-1\/2/);

      // The row wrapper holding both buttons sets the 10px gap between them.
      expect(show.parentElement).toBe(copy.parentElement);
      expect(show.parentElement).toHaveClass('gap-2.5');
    });
  });

  describe('words visibility toggle', () => {
    it('starts hidden: words are blurred and the toggle shows the "show" affordance', () => {
      renderComponent();
      const firstChip = screen.getAllByTestId(/^seed-word-\d+$/)[0]!;
      expect(firstChip.querySelector('.blur-sm, .blur-none')).toHaveClass('blur-sm');

      const toggle = screen.getByTestId('btn-show');
      expect(toggle).toHaveAttribute('data-icon', 'ICON_EYE');
    });

    it('respects reduced motion on the blur transition', () => {
      renderComponent();
      const firstChip = screen.getAllByTestId(/^seed-word-\d+$/)[0]!;
      expect(firstChip.querySelector('.blur-sm, .blur-none')).toHaveClass('motion-reduce:transition-none');
    });

    it('reveals the words and flips the toggle label/icon when clicked', () => {
      renderComponent();

      fireEvent.click(screen.getByTestId('btn-show'));

      const firstChip = screen.getAllByTestId(/^seed-word-\d+$/)[0]!;
      expect(firstChip.querySelector('.blur-sm, .blur-none')).toHaveClass('blur-none');

      const toggle = screen.getByTestId('btn-hide');
      expect(toggle).toHaveAttribute('data-icon', 'ICON_EYE_OFF');
    });

    it('toggles back to hidden on a second click', () => {
      renderComponent();

      fireEvent.click(screen.getByTestId('btn-show'));
      fireEvent.click(screen.getByTestId('btn-hide'));

      const firstChip = screen.getAllByTestId(/^seed-word-\d+$/)[0]!;
      expect(firstChip.querySelector('.blur-sm, .blur-none')).toHaveClass('blur-sm');
      expect(screen.getByTestId('btn-show')).toBeInTheDocument();
    });
  });

  describe('copy to clipboard', () => {
    it('writes the space-joined seed phrase and hands the shared copy confirmation the copied state', async () => {
      renderComponent();

      const copyBtn = screen.getByTestId('btn-copyToClipboard');
      expect(screen.getByTestId('copy-glyph')).toHaveAttribute('data-copied', 'false');
      expect(screen.getByTestId('copy-label')).toHaveTextContent('copyToClipboard');

      await act(async () => {
        fireEvent.click(copyBtn);
      });

      expect(mockClipboardWrite).toHaveBeenCalledTimes(1);
      expect(mockClipboardWrite).toHaveBeenCalledWith({ string: SEED.join(' ') });
      expect(screen.getByTestId('copy-glyph')).toHaveAttribute('data-copied', 'true');
      expect(screen.getByTestId('copy-label')).toHaveTextContent('copied');
    });

    // The whole point of the shared implementation: the confirmation follows the WRITE. The screen
    // used to report success without awaiting it, on the one value where that costs the most.
    it('says nothing was copied when the write fails', async () => {
      mockClipboardWrite.mockRejectedValueOnce(new Error('denied'));
      renderComponent();

      await act(async () => {
        fireEvent.click(screen.getByTestId('btn-copyToClipboard'));
      });

      expect(screen.getByTestId('copy-glyph')).toHaveAttribute('data-copied', 'false');
      expect(screen.getByTestId('copy-label')).toHaveTextContent('copyToClipboard');
    });

    // The local version armed a timeout it never cleared, so a Continue inside the window left it
    // firing into a detached tree. React 18 reports nothing for that, so the timer is the evidence.
    it('leaves no timer behind when the step is left inside the feedback window', async () => {
      jest.useFakeTimers();
      const { unmount } = renderComponent();

      await act(async () => {
        fireEvent.click(screen.getByTestId('btn-copyToClipboard'));
      });
      expect(jest.getTimerCount()).toBeGreaterThan(0);

      unmount();

      expect(jest.getTimerCount()).toBe(0);
    });

    it('reverts to the default copy state after the shared 1.5s feedback window', async () => {
      jest.useFakeTimers();
      renderComponent();

      await act(async () => {
        fireEvent.click(screen.getByTestId('btn-copyToClipboard'));
      });
      expect(screen.getByTestId('copy-glyph')).toHaveAttribute('data-copied', 'true');

      act(() => {
        jest.advanceTimersByTime(1500);
      });

      expect(screen.getByTestId('copy-glyph')).toHaveAttribute('data-copied', 'false');
      expect(screen.getByTestId('copy-label')).toHaveTextContent('copyToClipboard');
    });

    it('stays in the copied state before the timeout elapses', async () => {
      jest.useFakeTimers();
      renderComponent();

      await act(async () => {
        fireEvent.click(screen.getByTestId('btn-copyToClipboard'));
      });

      act(() => {
        jest.advanceTimersByTime(1499);
      });

      expect(screen.getByTestId('copy-glyph')).toHaveAttribute('data-copied', 'true');
    });
  });

  describe('continue button', () => {
    it('invokes onSubmit when clicked', () => {
      const onSubmit = jest.fn();
      renderComponent({ onSubmit });

      fireEvent.click(screen.getByTestId('btn-continue'));
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('does not throw when clicked without an onSubmit handler', () => {
      renderComponent();
      expect(() => fireEvent.click(screen.getByTestId('btn-continue'))).not.toThrow();
    });
  });

  describe('document copy interception (useEffect)', () => {
    it('sanitizes the selection to letters/spaces and writes it to the clipboard event', () => {
      renderComponent();

      const setData = jest.fn();
      const { preventDefaultSpy } = dispatchCopy({
        selection: { toString: () => 'Hello 123 World!!' },
        clipboardData: { setData }
      });

      expect(setData).toHaveBeenCalledWith('text/plain', 'Hello World');
      expect(preventDefaultSpy).toHaveBeenCalled();
    });

    it('writes an empty string when there is no active selection', () => {
      renderComponent();

      const setData = jest.fn();
      const { preventDefaultSpy } = dispatchCopy({
        selection: null,
        clipboardData: { setData }
      });

      expect(setData).toHaveBeenCalledWith('text/plain', '');
      expect(preventDefaultSpy).toHaveBeenCalled();
    });

    it('does not throw and still prevents default when the event has no clipboardData', () => {
      renderComponent();

      let result: ReturnType<typeof dispatchCopy>;
      expect(() => {
        result = dispatchCopy({ selection: { toString: () => 'anything' } });
      }).not.toThrow();

      expect(result!.preventDefaultSpy).toHaveBeenCalled();
    });

    it('removes its copy listener on unmount without throwing', () => {
      const removeSpy = jest.spyOn(document, 'removeEventListener');
      const { unmount } = renderComponent();

      expect(() => unmount()).not.toThrow();
      expect(removeSpy).toHaveBeenCalledWith('copy', expect.any(Function));

      removeSpy.mockRestore();
    });
  });
});
