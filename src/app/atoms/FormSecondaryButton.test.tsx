import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import FormSecondaryButton from './FormSecondaryButton';

// Passthrough mock of the design-system Button. It forwards every prop the
// component computes (className, style, type, disabled, onClick and any rest
// props) onto a real <button> so we can assert the class/style ternaries and
// event wiring without dragging in framer-motion / haptics. Follows the
// existing `jest.mock('components/Button', ...)` pattern used across the repo.
jest.mock('components/Button', () => {
  const ReactMock = require('react');
  return {
    __esModule: true,
    ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' },
    Button: ({ variant, children, className, style, disabled, onClick, type, ...rest }: any) =>
      ReactMock.createElement(
        'button',
        { className, style, disabled, onClick, type, 'data-variant': variant, ...rest },
        children
      )
  };
});

// Simple marker for the spinner so we can detect the loading branch.
jest.mock('app/atoms/Spinner/Spinner', () => ({
  __esModule: true,
  default: () => {
    const ReactMock = require('react');
    return ReactMock.createElement('div', { 'data-testid': 'spinner' });
  }
}));

const getButton = () => screen.getByRole('button');

describe('FormSecondaryButton', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders children with the Ghost variant and the default button type', () => {
    render(<FormSecondaryButton>Click me</FormSecondaryButton>);

    const button = getButton();
    expect(button).toHaveTextContent('Click me');
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('data-variant', 'ghost');
  });

  it('does not throw on click when no onClick is provided', () => {
    render(<FormSecondaryButton>Click me</FormSecondaryButton>);

    expect(() => fireEvent.click(getButton())).not.toThrow();
  });

  it('forwards the click to onClick and does not leak testID/testIDProperties onto the DOM button', () => {
    const onClick = jest.fn();
    render(
      <FormSecondaryButton testID="secondary-cta" testIDProperties={{ surface: 'send' }} onClick={onClick}>
        Submit
      </FormSecondaryButton>
    );

    const button = getButton();
    fireEvent.click(button);

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick.mock.calls[0][0]).toMatchObject({ type: 'click' });
    expect(button).not.toHaveAttribute('testID');
    expect(button).not.toHaveAttribute('testIDProperties');
  });

  it('applies the loading branch: renders the spinner and loading-only classes/padding', () => {
    render(
      <FormSecondaryButton loading small>
        Loading
      </FormSecondaryButton>
    );

    const button = getButton();
    expect(screen.getByTestId('spinner')).toBeInTheDocument();

    // small === true classes
    expect(button.className).toContain('px-6');
    expect(button.className).toContain('text-sm');
    // loading === true classes
    expect(button.className).toContain('text-transparent');
    expect(button.className).toContain('opacity-75');
    expect(button.className).toContain('shadow-inner');
    expect(button.className).toContain('pointer-events-none');

    // small === true padding
    expect(button.style.paddingTop).toBe('0.5rem');
    expect(button.style.paddingBottom).toBe('0.5rem');
  });

  it('applies the disabled (non-loading, non-small) branch: no spinner, disabled classes/padding', () => {
    render(<FormSecondaryButton disabled>Disabled</FormSecondaryButton>);

    const button = getButton();
    expect(screen.queryByTestId('spinner')).not.toBeInTheDocument();
    expect(button).toBeDisabled();

    // small === false classes
    expect(button.className).toContain('px-8');
    expect(button.className).toContain('text-black');
    expect(button.className).toContain('text-primary-orange');
    // disabled === true (loading === false) classes
    expect(button.className).toContain('opacity-75');
    expect(button.className).toContain('shadow-inner');
    expect(button.className).toContain('pointer-events-none');

    // small === false padding
    expect(button.style.paddingTop).toBe('0.625rem');
    expect(button.style.paddingBottom).toBe('0.625rem');
  });

  it('applies the interactive (non-loading, non-disabled) branch classes', () => {
    render(<FormSecondaryButton>Idle</FormSecondaryButton>);

    const button = getButton();
    expect(screen.queryByTestId('spinner')).not.toBeInTheDocument();
    expect(button.className).toContain('opacity-90');
    expect(button.className).toContain('hover:opacity-100');
    expect(button.className).toContain('shadow-sm');
    expect(button.className).toContain('hover:shadow');
    expect(button.className).toContain('focus:shadow');
  });

  it('honours an explicit type, merges custom className/style, and forwards rest props', () => {
    render(
      <FormSecondaryButton
        type="submit"
        className="custom-class"
        style={{ color: 'red' }}
        aria-label="my-secondary"
        data-testid="forwarded"
      >
        Extra
      </FormSecondaryButton>
    );

    const button = getButton();
    expect(button).toHaveAttribute('type', 'submit');
    // custom className appended after the computed classes
    expect(button.className).toContain('custom-class');
    // custom style merged with the computed padding via the spread
    expect(button.style.color).toBe('red');
    expect(button.style.paddingTop).toBe('0.625rem');
    // arbitrary rest props forwarded to the underlying element
    expect(button).toHaveAttribute('aria-label', 'my-secondary');
    expect(button).toHaveAttribute('data-testid', 'forwarded');
  });
});
