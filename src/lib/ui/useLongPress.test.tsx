import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { useLongPress } from './useLongPress';

const mockHapticMedium = jest.fn();
jest.mock('lib/mobile/haptics', () => ({
  hapticMedium: () => mockHapticMedium()
}));

// jsdom has no PointerEvent, and without a constructor RTL falls back to a bare
// Event that drops `isPrimary` / `pointerType` / `button` / `clientX`. A MouseEvent
// subclass carries all of those.
class PointerEventPolyfill extends MouseEvent {
  readonly isPrimary: boolean;
  readonly pointerType: string;
  constructor(type: string, init: MouseEventInit & { isPrimary?: boolean; pointerType?: string } = {}) {
    super(type, init);
    this.isPrimary = init.isPrimary ?? true;
    this.pointerType = init.pointerType ?? 'mouse';
  }
}
beforeAll(() => {
  if (!('PointerEvent' in window)) {
    Object.defineProperty(window, 'PointerEvent', { value: PointerEventPolyfill, configurable: true });
  }
});

const Row: React.FC<{ onLongPress: () => void; onClick?: () => void; disabled?: boolean }> = ({
  onLongPress,
  onClick,
  disabled
}) => {
  const { bind } = useLongPress({ onLongPress, disabled });
  return (
    <div data-testid="row" {...bind} onClick={onClick}>
      <button type="button" data-testid="inline-button" data-longpress-ignore="">
        Claim
      </button>
    </div>
  );
};

const press = (el: Element, over: Record<string, unknown> = {}) =>
  fireEvent.pointerDown(el, { isPrimary: true, pointerType: 'touch', button: 0, clientX: 10, clientY: 10, ...over });

beforeEach(() => {
  jest.useFakeTimers();
  mockHapticMedium.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useLongPress', () => {
  it('fires after the hold delay with a medium haptic', () => {
    const onLongPress = jest.fn();
    render(<Row onLongPress={onLongPress} />);
    press(screen.getByTestId('row'));
    jest.advanceTimersByTime(499);
    expect(onLongPress).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(mockHapticMedium).toHaveBeenCalledTimes(1);
  });

  it('does not fire when the pointer lifts before the delay', () => {
    const onLongPress = jest.fn();
    render(<Row onLongPress={onLongPress} />);
    const row = screen.getByTestId('row');
    press(row);
    jest.advanceTimersByTime(200);
    fireEvent.pointerUp(row);
    jest.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('cancels when the pointer travels past the slop (a drag/scroll)', () => {
    const onLongPress = jest.fn();
    render(<Row onLongPress={onLongPress} />);
    const row = screen.getByTestId('row');
    press(row);
    fireEvent.pointerMove(row, { clientX: 10, clientY: 30 });
    jest.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('cancels when the page scrolls during the hold', () => {
    const onLongPress = jest.fn();
    render(<Row onLongPress={onLongPress} />);
    press(screen.getByTestId('row'));
    fireEvent.scroll(window);
    jest.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('never arms for a press that starts on an ignored descendant', () => {
    const onLongPress = jest.fn();
    render(<Row onLongPress={onLongPress} />);
    press(screen.getByTestId('inline-button'));
    jest.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('ignores secondary mouse buttons but fires on contextmenu immediately', () => {
    const onLongPress = jest.fn();
    render(<Row onLongPress={onLongPress} />);
    const row = screen.getByTestId('row');
    press(row, { pointerType: 'mouse', button: 2 });
    jest.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();

    const prevented = !fireEvent.contextMenu(row);
    expect(prevented).toBe(true);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('swallows the one click that follows a fired hold, then lets clicks through again', () => {
    const onLongPress = jest.fn();
    const onClick = jest.fn();
    render(<Row onLongPress={onLongPress} onClick={onClick} />);
    const row = screen.getByTestId('row');
    press(row);
    jest.advanceTimersByTime(500);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    fireEvent.click(row);
    expect(onClick).not.toHaveBeenCalled();
    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not swallow a click after a contextmenu trigger (no synthesized click follows one)', () => {
    const onLongPress = jest.fn();
    const onClick = jest.fn();
    render(<Row onLongPress={onLongPress} onClick={onClick} />);
    const row = screen.getByTestId('row');
    fireEvent.contextMenu(row);
    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not double-fire when the browser raises contextmenu after a hold it already handled', () => {
    const onLongPress = jest.fn();
    render(<Row onLongPress={onLongPress} />);
    const row = screen.getByTestId('row');
    press(row);
    jest.advanceTimersByTime(500);
    fireEvent.contextMenu(row);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('fires on Shift+F10 for keyboard users', () => {
    const onLongPress = jest.fn();
    render(<Row onLongPress={onLongPress} />);
    fireEvent.keyDown(screen.getByTestId('row'), { key: 'F10', shiftKey: true });
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('is inert while disabled', () => {
    const onLongPress = jest.fn();
    render(<Row onLongPress={onLongPress} disabled />);
    const row = screen.getByTestId('row');
    press(row);
    jest.advanceTimersByTime(1000);
    fireEvent.contextMenu(row);
    expect(onLongPress).not.toHaveBeenCalled();
  });
});
