/**
 * @jest-environment jsdom
 */
import { Keyboard } from '@capacitor/keyboard';

import { isIOS, isMobile } from 'lib/platform';

import { initKeyboardInset } from './keyboard-inset';

jest.mock('@capacitor/keyboard', () => ({
  Keyboard: {
    addListener: jest.fn(),
    setAccessoryBarVisible: jest.fn()
  }
}));

jest.mock('lib/platform', () => ({
  isMobile: jest.fn(),
  isIOS: jest.fn()
}));

const isMobileMock = isMobile as jest.Mock;
const isIOSMock = isIOS as jest.Mock;
const addListenerMock = Keyboard.addListener as jest.Mock;
const setAccessoryBarVisibleMock = Keyboard.setAccessoryBarVisible as jest.Mock;

/** Keyboard listeners captured per event name by the addListener mock. */
let listeners: Record<string, (info?: { keyboardHeight?: number }) => void>;

// jsdom reports a zero rect for every element, which reads as "on screen".
// Put the field below the fold so the nudge has something to do.
function placeBelowFold(element: HTMLElement) {
  element.getBoundingClientRect = () => new DOMRect(0, window.innerHeight + 200, 300, 36);
}

describe('keyboard-inset', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    // Default to iOS, where the --keyboard-height compensation is active. The
    // Android path (native adjustResize; no compensation) is covered explicitly.
    isIOSMock.mockReturnValue(true);
    listeners = {};
    addListenerMock.mockImplementation((event: string, cb: (info?: { keyboardHeight?: number }) => void) => {
      listeners[event] = cb;
      return Promise.resolve({ remove: jest.fn() });
    });
    document.documentElement.style.removeProperty('--keyboard-height');
  });

  afterEach(() => {
    // Release any navbar hold a test left: the hold counter is shared, module-level state.
    listeners['keyboardWillHide']?.();
    jest.useRealTimers();
    document.body.innerHTML = '';
    document.body.removeAttribute('data-hide-navbar');
  });

  it('does nothing off mobile', async () => {
    isMobileMock.mockReturnValue(false);

    await initKeyboardInset();

    expect(addListenerMock).not.toHaveBeenCalled();
  });

  it('mirrors the keyboard height into --keyboard-height and resets on hide', async () => {
    isMobileMock.mockReturnValue(true);

    await initKeyboardInset();

    listeners['keyboardWillShow']!({ keyboardHeight: 336 });
    expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('336px');

    listeners['keyboardWillHide']!();
    expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('0px');
  });

  it('hides the navbar in the same callback that writes the inset, and shows it again in the same one', async () => {
    isMobileMock.mockReturnValue(true);

    await initKeyboardInset();

    // One task: the inset, the cushion and the bar change together, so the CTA moves once.
    listeners['keyboardWillShow']!({ keyboardHeight: 336 });
    expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('336px');
    expect(document.body).toHaveAttribute('data-hide-navbar');

    listeners['keyboardWillHide']!();
    expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('0px');
    expect(document.body).not.toHaveAttribute('data-hide-navbar');
  });

  it('takes one hold however many times the keyboard reports it is showing', async () => {
    isMobileMock.mockReturnValue(true);

    await initKeyboardInset();

    listeners['keyboardWillShow']!({ keyboardHeight: 300 });
    listeners['keyboardWillShow']!({ keyboardHeight: 336 });
    listeners['keyboardWillHide']!();
    expect(document.body).not.toHaveAttribute('data-hide-navbar');
  });

  it('on Android holds the navbar flag but leaves --keyboard-height alone (native adjustResize lifts the page)', async () => {
    isMobileMock.mockReturnValue(true);
    isIOSMock.mockReturnValue(false);

    await initKeyboardInset();

    // Setting --keyboard-height on Android would double-count the native resize, collapsing the
    // layout with a void above the keyboard.
    listeners['keyboardWillShow']!({ keyboardHeight: 336 });
    expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('');
    expect(document.body).toHaveAttribute('data-hide-navbar');

    listeners['keyboardWillHide']!();
    expect(document.body).not.toHaveAttribute('data-hide-navbar');
  });

  it('still nudges the focused input into view on Android', async () => {
    isMobileMock.mockReturnValue(true);
    isIOSMock.mockReturnValue(false);

    await initKeyboardInset();

    const input = document.createElement('input');
    input.scrollIntoView = jest.fn();
    placeBelowFold(input);
    document.body.appendChild(input);

    input.focus();
    jest.advanceTimersByTime(300);

    expect(input.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
  });

  it('treats a missing keyboardHeight as 0', async () => {
    isMobileMock.mockReturnValue(true);

    await initKeyboardInset();

    listeners['keyboardWillShow']!({});
    expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('0px');
  });

  it('scrolls the still-focused input into view after the keyboard animation', async () => {
    isMobileMock.mockReturnValue(true);

    await initKeyboardInset();

    const input = document.createElement('input');
    input.scrollIntoView = jest.fn();
    placeBelowFold(input);
    document.body.appendChild(input);

    input.focus();
    jest.advanceTimersByTime(300);

    expect(input.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
  });

  it('leaves a field that is already on screen where it is', async () => {
    isMobileMock.mockReturnValue(true);

    await initKeyboardInset();

    const input = document.createElement('input');
    input.scrollIntoView = jest.fn();
    input.getBoundingClientRect = () => new DOMRect(0, 40, 300, 36);
    document.body.appendChild(input);

    input.focus();
    jest.advanceTimersByTime(300);

    expect(input.scrollIntoView).not.toHaveBeenCalled();
  });

  it('measures against the visual viewport that the keyboard shrinks, not the layout viewport', async () => {
    isMobileMock.mockReturnValue(true);
    // A WebView reports the area left above the keyboard as the visual viewport; jsdom has none.
    const top = 100;
    const bottom = window.innerHeight - 300;
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: { offsetTop: top, height: bottom - top }
    });
    try {
      await initKeyboardInset();

      const field = (rectTop: number) => {
        const input = document.createElement('input');
        input.scrollIntoView = jest.fn();
        input.getBoundingClientRect = () => new DOMRect(0, rectTop, 300, 36);
        document.body.appendChild(input);
        input.focus();
        jest.advanceTimersByTime(300);
        return input;
      };
      const above = field(top - 40);
      const inside = field(bottom - 40);
      const covered = field(bottom + 50);

      expect(above.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
      expect(inside.scrollIntoView).not.toHaveBeenCalled();
      expect(covered.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
    } finally {
      Reflect.deleteProperty(window, 'visualViewport');
    }
  });

  it('does not scroll if the input lost focus before the delay elapsed', async () => {
    isMobileMock.mockReturnValue(true);

    await initKeyboardInset();

    const input = document.createElement('input');
    input.scrollIntoView = jest.fn();
    placeBelowFold(input);
    document.body.appendChild(input);

    input.focus();
    input.blur();
    jest.advanceTimersByTime(300);

    expect(input.scrollIntoView).not.toHaveBeenCalled();
  });

  it('ignores focus on non-text elements', async () => {
    isMobileMock.mockReturnValue(true);

    await initKeyboardInset();

    const button = document.createElement('button');
    button.scrollIntoView = jest.fn();
    document.body.appendChild(button);

    button.focus();
    jest.advanceTimersByTime(300);

    expect(button.scrollIntoView).not.toHaveBeenCalled();
  });

  it('survives a Keyboard plugin without a native implementation', async () => {
    isMobileMock.mockReturnValue(true);
    addListenerMock.mockRejectedValue(new Error('"Keyboard" plugin is not implemented on web'));

    await expect(initKeyboardInset()).resolves.toBeUndefined();
  });

  it('enables the iOS keyboard accessory bar (Done key) on mobile', async () => {
    isMobileMock.mockReturnValue(true);

    await initKeyboardInset();

    // The accessory bar is set at runtime — there is no `accessoryBarVisible`
    // Keyboard config key (this is the fix for the number pad having no way to
    // dismiss on iOS).
    expect(setAccessoryBarVisibleMock).toHaveBeenCalledWith({ isVisible: true });
  });

  it('does not touch the accessory bar off mobile', async () => {
    isMobileMock.mockReturnValue(false);

    await initKeyboardInset();

    expect(setAccessoryBarVisibleMock).not.toHaveBeenCalled();
  });

  it('still registers the focusin scroll fallback when addListener rejects', async () => {
    isMobileMock.mockReturnValue(true);
    addListenerMock.mockRejectedValue(new Error('"Keyboard" plugin is not implemented on web'));

    await initKeyboardInset();

    // The fallback is registered after the listener try/catch, so a plugin
    // without a native impl must not disable it.
    const input = document.createElement('input');
    input.scrollIntoView = jest.fn();
    placeBelowFold(input);
    document.body.appendChild(input);
    input.focus();
    jest.advanceTimersByTime(300);

    expect(input.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
  });

  it('tolerates the accessory bar being unavailable and still wires the inset', async () => {
    isMobileMock.mockReturnValue(true);
    setAccessoryBarVisibleMock.mockRejectedValue(new Error('accessory bar unavailable (non-iPhone)'));

    // The accessory-bar call is best-effort; a rejection must not abort init.
    await expect(initKeyboardInset()).resolves.toBeUndefined();
    expect(addListenerMock).toHaveBeenCalledWith('keyboardWillShow', expect.any(Function));
  });
});
