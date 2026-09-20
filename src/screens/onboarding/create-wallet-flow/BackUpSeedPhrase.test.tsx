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
// members, so expose stable marker strings for the four it references.
jest.mock('app/icons/v2', () => ({
  IconName: {
    Eye: 'ICON_EYE',
    EyeOff: 'ICON_EYE_OFF',
    FileCopy: 'ICON_FILE_COPY',
    CheckboxCircleFill: 'ICON_CHECK'
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
    className
  }: {
    title?: string;
    iconLeft?: unknown;
    onClick?: () => void;
    className?: string;
  }) => (
    <button data-testid={`btn-${title}`} data-icon={String(iconLeft)} data-classname={className} onClick={onClick}>
      {title}
    </button>
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

// The seed copy goes through `@capacitor/clipboard`, which has its own web implementation, so the
// same call is correct on desktop, the extension and every mobile webview.
const mockWriteText = jest.fn();
jest.mock('@capacitor/clipboard', () => ({
  Clipboard: { write: ({ string }: { string: string }) => mockWriteText(string) }
}));

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
  mockWriteText.mockResolvedValue(undefined);
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

    it('merges a custom className and spreads arbitrary div props onto the root', () => {
      renderComponent({ className: 'my-custom-class', 'data-testid': 'backup-root' } as never);
      const root = screen.getByTestId('backup-root');
      expect(root).toHaveClass('my-custom-class');
      // Base classes from the component are preserved alongside the override.
      expect(root).toHaveClass('flex', 'flex-col', 'bg-app-bg');
    });

    it('renders the three control buttons (show, copy, continue)', () => {
      renderComponent();
      expect(screen.getByTestId('btn-show')).toBeInTheDocument();
      expect(screen.getByTestId('btn-copyToClipboard')).toBeInTheDocument();
      expect(screen.getByTestId('btn-continue')).toBeInTheDocument();
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
    it('writes the space-joined seed phrase and flips the button to the "copied" state', async () => {
      renderComponent();

      const copyBtn = screen.getByTestId('btn-copyToClipboard');
      expect(copyBtn).toHaveAttribute('data-icon', 'ICON_FILE_COPY');

      await act(async () => {
        fireEvent.click(copyBtn);
      });

      expect(mockWriteText).toHaveBeenCalledTimes(1);
      expect(mockWriteText).toHaveBeenCalledWith(SEED.join(' '));

      const copied = screen.getByTestId('btn-copied');
      expect(copied).toHaveAttribute('data-icon', 'ICON_CHECK');
    });

    it('reverts to the default copy state after the 2s timeout', async () => {
      jest.useFakeTimers();
      renderComponent();

      await act(async () => {
        fireEvent.click(screen.getByTestId('btn-copyToClipboard'));
      });
      expect(screen.getByTestId('btn-copied')).toBeInTheDocument();

      act(() => {
        jest.advanceTimersByTime(2000);
      });

      expect(screen.getByTestId('btn-copyToClipboard')).toBeInTheDocument();
      expect(screen.queryByTestId('btn-copied')).not.toBeInTheDocument();
      expect(screen.getByTestId('btn-copyToClipboard')).toHaveAttribute('data-icon', 'ICON_FILE_COPY');
    });

    it('stays in the copied state before the timeout elapses', async () => {
      jest.useFakeTimers();
      renderComponent();

      await act(async () => {
        fireEvent.click(screen.getByTestId('btn-copyToClipboard'));
      });

      act(() => {
        jest.advanceTimersByTime(1999);
      });

      expect(screen.getByTestId('btn-copied')).toBeInTheDocument();
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

    it('removes the SAME copy listener it added, so the handler cannot outlive the screen', () => {
      // `expect.any(Function)` used to sit in this slot, which is exactly the thing the bug changed:
      // the old cleanup passed a freshly allocated `() => {}`, so removeEventListener was still
      // called with a Function and the assertion passed while the real handler stayed on document
      // for the life of the realm, rewriting every later copy.
      const addSpy = jest.spyOn(document, 'addEventListener');
      const removeSpy = jest.spyOn(document, 'removeEventListener');
      const { unmount } = renderComponent();

      const added = addSpy.mock.calls.find(([type]) => type === 'copy')?.[1];
      expect(added).toBeInstanceOf(Function);

      unmount();
      expect(removeSpy).toHaveBeenCalledWith('copy', added);

      addSpy.mockRestore();
      removeSpy.mockRestore();
    });

    it('stops rewriting the clipboard once unmounted', () => {
      const { unmount } = renderComponent();
      unmount();

      const setData = jest.fn();
      const { preventDefaultSpy } = dispatchCopy({
        selection: { toString: () => 'Send 123 MIDEN to mtst1abc' },
        clipboardData: { setData }
      });

      // Behavioural mirror of the identity check: a leaked handler would strip the digits and
      // preventDefault() on a copy that has nothing to do with this screen.
      expect(setData).not.toHaveBeenCalled();
      expect(preventDefaultSpy).not.toHaveBeenCalled();
    });
  });
});
