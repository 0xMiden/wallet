import React from 'react';

import { fireEvent, render, renderHook } from '@testing-library/react';

import usePasswordToggle from './usePasswordToggle.hook';

// The two eye SVGs are auto-mocked (jest.config `\\.svg$` -> svgMock.js) to the
// intrinsic `svg` element, so both branches of the visible/hidden ternary render
// as a plain <svg>. We therefore drive the visibility branch through the
// observable `inputType` return value ('password' <-> 'text') rather than trying
// to distinguish the two icon components by tag.
const getButton = (container: HTMLElement) => container.querySelector('button') as HTMLButtonElement;
const getIcon = (container: HTMLElement) => container.querySelector('svg') as SVGElement;

// Small host that wires the hook's tuple into a real input + the returned Icon,
// so a click on the Icon re-runs the hook and flips the input's `type`.
const Harness = () => {
  const [inputType, Icon] = usePasswordToggle();
  return (
    <div>
      <input data-testid="pwd" type={inputType} readOnly />
      {Icon}
    </div>
  );
};

const getInput = (container: HTMLElement) => container.querySelector('input[data-testid="pwd"]') as HTMLInputElement;

describe('usePasswordToggle', () => {
  describe('returned tuple (via renderHook)', () => {
    it('returns a [inputType, Icon] tuple defaulting to the hidden/password state', () => {
      const { result } = renderHook(() => usePasswordToggle());

      const [inputType, Icon] = result.current;
      expect(inputType).toBe('password');
      expect(React.isValidElement(Icon)).toBe(true);
    });
  });

  describe('Icon element', () => {
    it('renders a non-submitting button with the expected attributes and classes', () => {
      const { container } = render(<Harness />);
      const button = getButton(container);

      expect(button).toBeInTheDocument();
      expect(button).toHaveAttribute('type', 'button');
      expect(button).toHaveAttribute('tabindex', '1');
      expect(button).toHaveClass('absolute', 'inset-y-0', 'right-3', 'text-heading-gray');
    });

    it('renders the 24x24 eye icon (open eye while hidden)', () => {
      const { container } = render(<Harness />);
      const icon = getIcon(container);

      expect(icon).toBeInTheDocument();
      expect(icon.style.height).toBe('24px');
      expect(icon.style.width).toBe('24px');
    });
  });

  describe('visibility toggling', () => {
    it('starts hidden so the field renders as a password input', () => {
      const { container } = render(<Harness />);
      expect(getInput(container)).toHaveAttribute('type', 'password');
    });

    it('reveals the value (password -> text) when the icon is clicked', () => {
      const { container } = render(<Harness />);

      fireEvent.click(getButton(container));

      expect(getInput(container)).toHaveAttribute('type', 'text');
      // Icon still renders (now the closed-eye branch of the ternary).
      expect(getIcon(container)).toBeInTheDocument();
    });

    it('toggles back to hidden (text -> password) on a second click', () => {
      const { container } = render(<Harness />);
      const button = getButton(container);

      fireEvent.click(button);
      expect(getInput(container)).toHaveAttribute('type', 'text');

      fireEvent.click(button);
      expect(getInput(container)).toHaveAttribute('type', 'password');
    });
  });
});
