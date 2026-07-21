import React, { createRef } from 'react';

import { fireEvent, render } from '@testing-library/react';

import { hapticMedium } from 'lib/mobile/haptics';

import Checkbox from './Checkbox';

// Haptics pull in @capacitor/haptics + platform/settings helpers; mock the
// module so we can assert the feedback fires without touching native code.
jest.mock('lib/mobile/haptics', () => ({
  hapticMedium: jest.fn()
}));

const mockHapticMedium = hapticMedium as jest.Mock;

// The wrapping <div> is the styled "box"; the visually-hidden <input> is the
// real control; the (auto-mocked) checkmark renders as an <svg>.
const getInput = (container: HTMLElement) => container.querySelector('input[type="checkbox"]') as HTMLInputElement;
const getBox = (container: HTMLElement) => container.firstChild as HTMLElement;
const getIcon = (container: HTMLElement) => container.querySelector('svg') as SVGElement;

describe('Checkbox', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders unchecked with default styling (default errored, undefined checked)', () => {
    const { container } = render(<Checkbox />);
    const input = getInput(container);
    const box = getBox(container);
    const icon = getIcon(container);

    expect(input).toBeInTheDocument();
    expect(input).not.toBeChecked();
    expect(box).toHaveClass('bg-black-40');
    expect(box).toHaveClass('border-gray-400');
    expect(box).not.toHaveClass('shadow-outline');
    expect(icon).toHaveClass('hidden');
    expect(icon).not.toHaveClass('block');
  });

  it('renders checked styling when checked prop is true', () => {
    const { container } = render(<Checkbox checked />);
    const box = getBox(container);
    const icon = getIcon(container);

    expect(getInput(container)).toBeChecked();
    expect(box).toHaveClass('bg-primary-orange');
    expect(box).toHaveClass('border-primary-orange-dark');
    expect(box).not.toHaveClass('bg-black-40');
    expect(icon).toHaveClass('block');
    expect(icon).not.toHaveClass('hidden');
  });

  it('applies the errored border when errored and unchecked', () => {
    const { container } = render(<Checkbox errored />);
    expect(getBox(container)).toHaveClass('border-red-400');
  });

  it('lets the checked branch win over errored', () => {
    const { container } = render(<Checkbox checked errored />);
    const box = getBox(container);

    expect(box).toHaveClass('border-primary-orange-dark');
    expect(box).not.toHaveClass('border-red-400');
  });

  it('applies focus styling on focus and clears it on blur', () => {
    const { container } = render(<Checkbox />);
    const input = getInput(container);
    const box = getBox(container);

    fireEvent.focus(input);
    expect(box).toHaveClass('border-primary-orange');
    expect(box).toHaveClass('shadow-outline');

    fireEvent.blur(input);
    expect(box).not.toHaveClass('shadow-outline');
    expect(box).toHaveClass('border-gray-400');
  });

  it('toggles internal state and fires haptic + onChange when clicked', () => {
    const onChange = jest.fn();
    const { container } = render(<Checkbox onChange={onChange} />);
    const input = getInput(container);

    fireEvent.click(input);

    expect(mockHapticMedium).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(input).toBeChecked();
    expect(getIcon(container)).toHaveClass('block');
  });

  it('toggles internal state without an onChange handler', () => {
    const { container } = render(<Checkbox />);
    const input = getInput(container);

    fireEvent.click(input);

    expect(mockHapticMedium).toHaveBeenCalledTimes(1);
    expect(input).toBeChecked();
    expect(getIcon(container)).toHaveClass('block');
  });

  it('invokes provided onFocus and onBlur handlers', () => {
    const onFocus = jest.fn();
    const onBlur = jest.fn();
    const { container } = render(<Checkbox onFocus={onFocus} onBlur={onBlur} />);
    const input = getInput(container);

    fireEvent.focus(input);
    expect(onFocus).toHaveBeenCalledTimes(1);

    fireEvent.blur(input);
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it('syncs local state when the checked prop transitions', () => {
    const { container, rerender } = render(<Checkbox checked={false} />);
    expect(getInput(container)).not.toBeChecked();

    rerender(<Checkbox checked={true} />);
    expect(getInput(container)).toBeChecked();
    expect(getIcon(container)).toHaveClass('block');
  });

  it('keeps local state when the checked prop is undefined (nullish-coalesce branch)', () => {
    const { container, rerender } = render(<Checkbox />);
    const input = getInput(container);

    fireEvent.click(input);
    expect(input).toBeChecked();

    // Re-render without a checked prop: the effect must keep the previous value.
    rerender(<Checkbox containerClassName="changed" />);
    expect(getInput(container)).toBeChecked();
  });

  it('forwards the ref to the underlying input', () => {
    const ref = createRef<HTMLInputElement>();
    const { container } = render(<Checkbox ref={ref} />);

    expect(ref.current).toBe(getInput(container));
    expect(ref.current?.type).toBe('checkbox');
  });

  it('applies containerClassName/className and passes through the rest props', () => {
    const { container } = render(
      <Checkbox containerClassName="my-container" className="my-input" name="agree" disabled data-testid="cb" />
    );
    const input = getInput(container);
    const box = getBox(container);

    expect(box).toHaveClass('my-container');
    expect(input).toHaveClass('sr-only');
    expect(input).toHaveClass('my-input');
    expect(input).toHaveAttribute('name', 'agree');
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute('data-testid', 'cb');
  });
});
