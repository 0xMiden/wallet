import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import useTippy from 'lib/ui/useTippy';

import FormSubmitButton from './FormSubmitButton';

// `useTippy` wires up tippy.js against a real DOM node on mount; stub it so we
// can both hand back a ref and assert the props the component computes.
jest.mock('lib/ui/useTippy', () => ({
  __esModule: true,
  default: jest.fn(() => ({ current: null }))
}));

// Mock the design-system Button so we can inspect the exact props/className
// FormSubmitButton computes, without pulling in framer-motion / haptics.
jest.mock('components/Button', () => ({
  __esModule: true,
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' },
  Button: ({ children, variant, ...rest }: any) => (
    <button data-testid="ds-button" data-variant={variant} {...rest}>
      {children}
    </button>
  )
}));

// Mock the Spinner so its presence (loading branch) is trivially assertable.
jest.mock('app/atoms/Spinner/Spinner', () => ({
  __esModule: true,
  default: ({ color }: { color?: string }) => <div data-testid="spinner" data-color={color} />
}));

const mockUseTippy = useTippy as jest.Mock;

const getButton = () => screen.getByTestId('ds-button');

describe('FormSubmitButton', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseTippy.mockReturnValue({ current: null });
  });

  it('renders a submit-typed primary button with default styling (not loading, not small)', () => {
    render(<FormSubmitButton>Confirm</FormSubmitButton>);

    const button = getButton();
    expect(button).toHaveTextContent('Confirm');
    expect(button).toHaveAttribute('type', 'submit');
    expect(button).toHaveAttribute('data-variant', 'primary');

    // Default (small falsy) → px-8; not loading → visible text; enabled → hover styles.
    expect(button).toHaveClass('px-8');
    expect(button).toHaveClass('text-pure-white');
    expect(button).not.toHaveClass('text-transparent');
    expect(button).not.toHaveClass('opacity-60');
    expect(button).toHaveClass('hover:opacity-90', 'focus:opacity-90');
    expect(button).not.toHaveClass('pointer-events-none');
    expect(button).toHaveClass('hover:bg-linear-to-r');

    // Not loading → no spinner, and no tooltip → button is the root (no wrapping span).
    expect(screen.queryByTestId('spinner')).not.toBeInTheDocument();
    expect(button.parentElement).toBe(document.body.querySelector('div'));
  });

  it('applies the `small` (px-6) styling branch', () => {
    render(<FormSubmitButton small>Small</FormSubmitButton>);

    const button = getButton();
    expect(button).toHaveClass('px-6');
    expect(button).not.toHaveClass('px-8');
  });

  it('renders the loading branch (transparent text, opacity, pointer-events, spinner)', () => {
    render(<FormSubmitButton loading>Loading</FormSubmitButton>);

    const button = getButton();
    expect(button).toHaveClass('text-transparent');
    expect(button).not.toHaveClass('text-pure-white');
    expect(button).toHaveClass('opacity-60');
    expect(button).toHaveClass('pointer-events-none');
    expect(button).not.toHaveClass('hover:opacity-90');
    expect(button).not.toHaveClass('hover:bg-linear-to-r');

    const spinner = screen.getByTestId('spinner');
    expect(spinner).toBeInTheDocument();
    expect(spinner).toHaveAttribute('data-color', '#ffffff');
  });

  it('applies the disabled branch (opacity + pointer-events) without the loading text/spinner', () => {
    render(<FormSubmitButton disabled>Disabled</FormSubmitButton>);

    const button = getButton();
    expect(button).toBeDisabled();
    // disabled drives opacity/pointer-events, but not the loading-only text/spinner.
    expect(button).toHaveClass('opacity-60');
    expect(button).toHaveClass('pointer-events-none');
    expect(button).toHaveClass('text-pure-white');
    expect(screen.queryByTestId('spinner')).not.toBeInTheDocument();
  });

  it('honours an explicit `type`, forwards `className`, `style` and remaining props', () => {
    render(
      <FormSubmitButton type="button" className="custom-class" style={{ marginTop: 4 }} id="my-btn" name="submitter">
        Go
      </FormSubmitButton>
    );

    const button = getButton();
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveClass('custom-class');
    expect(button).toHaveStyle({ marginTop: '4px' });
    expect(button).toHaveAttribute('id', 'my-btn');
    expect(button).toHaveAttribute('name', 'submitter');
  });

  it('calls `onClick` when provided alongside a testID, and does not forward testID/testIDProperties to the DOM button', () => {
    const onClick = jest.fn();
    const testIDProperties = { surface: 'send' };
    render(
      <FormSubmitButton type="button" testID="confirm-send" testIDProperties={testIDProperties} onClick={onClick}>
        Send
      </FormSubmitButton>
    );

    const button = getButton();
    fireEvent.click(button);

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button).not.toHaveAttribute('testID');
    expect(button).not.toHaveAttribute('testIDProperties');
  });

  it('does not throw without an onClick handler', () => {
    render(<FormSubmitButton type="button">No Click</FormSubmitButton>);

    expect(() => fireEvent.click(getButton())).not.toThrow();
  });

  it('passes tooltip content to useTippy and wraps the button in a ref span when a tooltip is set', () => {
    const { container } = render(<FormSubmitButton tooltip="Helpful hint">Hover me</FormSubmitButton>);

    // Tippy receives the merged mock props plus the tooltip content.
    expect(mockUseTippy).toHaveBeenCalledWith({
      trigger: 'mouseenter',
      hideOnClick: false,
      animation: 'shift-away-subtle',
      content: 'Helpful hint'
    });

    // Tooltip branch → the button is nested inside a wrapping <span>.
    const wrapperSpan = container.querySelector('span');
    expect(wrapperSpan).toBeInTheDocument();
    expect(wrapperSpan).toContainElement(getButton());
  });

  it('passes `content: undefined` to useTippy and renders the button without a span when no tooltip', () => {
    const { container } = render(<FormSubmitButton>No tooltip</FormSubmitButton>);

    expect(mockUseTippy).toHaveBeenCalledWith({
      trigger: 'mouseenter',
      hideOnClick: false,
      animation: 'shift-away-subtle',
      content: undefined
    });

    // No tooltip branch → button is not wrapped in a span.
    expect(container.querySelector('span')).not.toBeInTheDocument();
  });
});
