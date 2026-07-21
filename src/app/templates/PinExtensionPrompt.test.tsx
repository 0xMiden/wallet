import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { isExtension } from 'lib/platform';

import { PinExtensionPrompt } from './PinExtensionPrompt';

// `isExtension()` gates the whole effect; mock `lib/platform` so we can flip
// between the extension / non-extension code paths without touching the real
// Capacitor-aware detection (which the platform module lazy-requires).
jest.mock('lib/platform', () => ({
  isExtension: jest.fn(() => true)
}));

// `t` is never `init()`-ed in the unit env; echo the key back so the rendered
// copy is directly assertable by translation key.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// The real `Button` pulls in framer-motion + native Capacitor haptics. The
// prompt only relies on the button forwarding `onClick` and rendering its
// children, so a plain <button> keeps the test hermetic while still exercising
// the `dismiss` handler on click.
jest.mock('components/Button', () => ({
  Button: ({
    onClick,
    children,
    className
  }: {
    onClick?: () => void;
    children?: React.ReactNode;
    className?: string;
  }) => (
    <button type="button" data-testid="got-it-button" className={className} onClick={onClick}>
      {children}
    </button>
  )
}));

const mockIsExtension = isExtension as jest.MockedFunction<typeof isExtension>;

// `chrome.storage.local` comes from `@serh11p/jest-webextension-mock`; we swap
// `get`/`remove` for controllable spies so each test can drive the callback
// with a specific `fresh_install` value and assert the cleanup call.
let getSpy: jest.Mock;
let removeSpy: jest.Mock;

beforeEach(() => {
  mockIsExtension.mockReturnValue(true);

  getSpy = jest.fn();
  removeSpy = jest.fn();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  g.chrome = g.chrome ?? {};
  g.chrome.storage = g.chrome.storage ?? {};
  g.chrome.storage.local = g.chrome.storage.local ?? {};
  g.chrome.storage.local.get = getSpy;
  g.chrome.storage.local.remove = removeSpy;
});

describe('PinExtensionPrompt', () => {
  it('renders nothing and skips storage when not running as an extension', () => {
    mockIsExtension.mockReturnValue(false);

    const { container } = render(<PinExtensionPrompt />);

    // `!isExtension()` early-returns from the effect → storage untouched.
    expect(getSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();

    // `visible` stays false → component returns null.
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing (and does not clear the flag) when there is no fresh install', () => {
    // Extension context, but the stored flag is falsy → the inner `if` is false.
    getSpy.mockImplementation((_key: string, cb: (result: { fresh_install?: boolean }) => void) =>
      cb({ fresh_install: false })
    );

    const { container } = render(<PinExtensionPrompt />);

    expect(getSpy).toHaveBeenCalledWith('fresh_install', expect.any(Function));
    // Flag was falsy → prompt stays hidden and the flag is left untouched.
    expect(removeSpy).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the pin prompt and clears the flag on a fresh install', () => {
    getSpy.mockImplementation((_key: string, cb: (result: { fresh_install?: boolean }) => void) =>
      cb({ fresh_install: true })
    );

    const { container } = render(<PinExtensionPrompt />);

    // Fresh install → the flag is consumed exactly once so the prompt is one-shot.
    expect(getSpy).toHaveBeenCalledWith('fresh_install', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith('fresh_install');

    // Tooltip body: title, description and the dismiss button copy (echoed keys).
    expect(screen.getByText('pinExtensionTitle')).toBeInTheDocument();
    expect(screen.getByText('pinExtensionDescription')).toBeInTheDocument();
    expect(screen.getByTestId('got-it-button')).toHaveTextContent('gotIt');

    // The PuzzleIcon renders inside the visible prompt (the arrow is a div, so
    // the icon is the only svg).
    expect(container.querySelectorAll('svg')).toHaveLength(1);
  });

  it('dismisses the prompt when the "got it" button is clicked', () => {
    getSpy.mockImplementation((_key: string, cb: (result: { fresh_install?: boolean }) => void) =>
      cb({ fresh_install: true })
    );

    const { container } = render(<PinExtensionPrompt />);

    // Sanity: the prompt is visible before dismissal.
    expect(screen.getByText('pinExtensionTitle')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('got-it-button'));

    // `dismiss` → setVisible(false) → `!visible` returns null.
    expect(screen.queryByText('pinExtensionTitle')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });
});
