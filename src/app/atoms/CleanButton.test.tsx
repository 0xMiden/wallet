import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';
import useTippy from 'lib/ui/useTippy';

import CleanButton from './CleanButton';

// i18n is stubbed so `t(key)` returns the key verbatim, letting us assert the
// tooltip content without loading translation resources.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// Haptics pull in @capacitor/haptics; mock so we can assert the feedback fires
// without touching native code.
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

// useTippy returns a callback ref; the default mock returns a spy ref so we can
// assert the button node is wired into it.
jest.mock('lib/ui/useTippy', () => ({
  __esModule: true,
  default: jest.fn(() => jest.fn())
}));

const mockHapticLight = hapticLight as jest.Mock;
const mockUseTippy = useTippy as jest.Mock;

// The (auto-mocked) close icon renders as a plain <svg>.
const getIcon = (container: HTMLElement) => container.querySelector('svg') as SVGElement;

describe('CleanButton', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseTippy.mockImplementation(() => jest.fn());
  });

  it('renders default button styling, icon, and tippy config', () => {
    const { container } = render(<CleanButton />);
    const button = screen.getByRole('button');

    // Static button attributes / classes.
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('tabindex', '-1');
    expect(button).toHaveClass('absolute');
    expect(button).toHaveClass('bg-surface-solid');

    // Default inline style (bottomOffset default = 0.4rem).
    expect(button.style.right).toBe('0.4rem');
    expect(button.style.bottom).toBe('0.4rem');
    expect(button.style.padding).toBe('2px');

    // Icon rendered with its stroke/fill styling; default iconStyle = {} → no
    // inline styles applied.
    const icon = getIcon(container);
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveClass('stroke-white');
    expect(icon).toHaveAttribute('fill', 'white');
    expect(icon.getAttribute('style')).toBeFalsy();

    // Tippy configured with the translated "clean" tooltip.
    expect(mockUseTippy).toHaveBeenCalledTimes(1);
    const tippyProps = mockUseTippy.mock.calls[0][0];
    expect(tippyProps).toEqual({
      trigger: 'mouseenter',
      hideOnClick: false,
      content: 'clean',
      animation: 'shift-away-subtle'
    });
  });

  it('fires haptic feedback and forwards the click event to onClick', () => {
    const onClick = jest.fn();
    render(<CleanButton onClick={onClick} />);

    fireEvent.click(screen.getByRole('button'));

    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
    // The handler receives the synthetic mouse event.
    expect(onClick.mock.calls[0][0]).toHaveProperty('type', 'click');
  });

  it('still fires haptics and does not throw when no onClick is provided', () => {
    render(<CleanButton />);

    expect(() => fireEvent.click(screen.getByRole('button'))).not.toThrow();
    expect(mockHapticLight).toHaveBeenCalledTimes(1);
  });

  it('applies custom bottomOffset, className, style, and iconStyle', () => {
    const { container } = render(
      <CleanButton
        bottomOffset="2rem"
        className="my-clean"
        style={{ right: '1rem', color: 'blue' }}
        iconStyle={{ color: 'red' }}
      />
    );
    const button = screen.getByRole('button');

    // className is merged in by clsx.
    expect(button).toHaveClass('my-clean');
    expect(button).toHaveClass('absolute');

    // bottomOffset overrides the default bottom; the custom style object
    // overrides `right` and adds `color`, while padding stays.
    expect(button.style.bottom).toBe('2rem');
    expect(button.style.right).toBe('1rem');
    expect(button.style.color).toBe('blue');
    expect(button.style.padding).toBe('2px');

    // iconStyle is spread onto the icon.
    expect(getIcon(container).style.color).toBe('red');
  });

  it('passes through the rest props to the underlying button', () => {
    render(<CleanButton data-testid="clean-btn" aria-label="clear field" disabled />);
    const button = screen.getByRole('button');

    expect(button).toHaveAttribute('data-testid', 'clean-btn');
    expect(button).toHaveAttribute('aria-label', 'clear field');
    expect(button).toBeDisabled();
  });

  it('wires the tippy callback ref to the button element', () => {
    const refSpy = jest.fn();
    mockUseTippy.mockReturnValue(refSpy);

    render(<CleanButton />);

    expect(refSpy).toHaveBeenCalledTimes(1);
    expect(refSpy.mock.calls[0][0]).toBe(screen.getByRole('button'));
  });
});
