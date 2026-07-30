/**
 * @jest-environment jsdom
 */
import { Keyboard } from '@capacitor/keyboard';

import { isMobile } from 'lib/platform';

import { initKeyboardInset } from './keyboard-inset';

jest.mock('@capacitor/keyboard', () => ({
  Keyboard: {
    addListener: jest.fn()
  }
}));

jest.mock('lib/platform', () => ({
  isMobile: jest.fn()
}));

const isMobileMock = isMobile as jest.Mock;
const addListenerMock = Keyboard.addListener as jest.Mock;

/** Keyboard listeners captured per event name by the addListener mock. */
let listeners: Record<string, (info?: { keyboardHeight?: number }) => void>;

describe('keyboard-inset', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    listeners = {};
    addListenerMock.mockImplementation((event: string, cb: (info?: { keyboardHeight?: number }) => void) => {
      listeners[event] = cb;
      return Promise.resolve({ remove: jest.fn() });
    });
    document.documentElement.style.removeProperty('--keyboard-height');
  });

  afterEach(() => {
    jest.useRealTimers();
    document.body.innerHTML = '';
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
    document.body.appendChild(input);

    input.focus();
    jest.advanceTimersByTime(300);

    expect(input.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
  });

  it('does not scroll if the input lost focus before the delay elapsed', async () => {
    isMobileMock.mockReturnValue(true);

    await initKeyboardInset();

    const input = document.createElement('input');
    input.scrollIntoView = jest.fn();
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
});
