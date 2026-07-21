import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { AnalyticsEventCategory, useAnalytics } from 'lib/analytics';

import FormSecondaryButton from './FormSecondaryButton';

// Mock analytics so we can assert tracking behaviour without pulling in the
// real hook + its providers. Mirrors the sibling CopyButton.test.tsx.
jest.mock('lib/analytics', () => ({
  AnalyticsEventCategory: { ButtonPress: 'ButtonPress' },
  useAnalytics: jest.fn()
}));

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

const mockUseAnalytics = useAnalytics as jest.Mock;

const getButton = () => screen.getByRole('button');

describe('FormSecondaryButton', () => {
  const trackEvent = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAnalytics.mockReturnValue({ trackEvent });
  });

  it('renders children with the Ghost variant and the default button type', () => {
    render(<FormSecondaryButton>Click me</FormSecondaryButton>);

    const button = getButton();
    expect(button).toHaveTextContent('Click me');
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('data-variant', 'ghost');
  });

  it('does not track or throw on click when neither testID nor onClick are provided', () => {
    render(<FormSecondaryButton>Click me</FormSecondaryButton>);

    // No testID (skips trackEvent branch) and no onClick (exercises the
    // optional-chaining short-circuit) — clicking must be a harmless no-op.
    expect(() => fireEvent.click(getButton())).not.toThrow();
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('tracks the button press and forwards the click when a testID is provided', () => {
    const onClick = jest.fn();
    render(
      <FormSecondaryButton testID="secondary-cta" testIDProperties={{ surface: 'send' }} onClick={onClick}>
        Submit
      </FormSecondaryButton>
    );

    fireEvent.click(getButton());

    expect(trackEvent).toHaveBeenCalledWith('secondary-cta', AnalyticsEventCategory.ButtonPress, {
      surface: 'send'
    });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick.mock.calls[0][0]).toMatchObject({ type: 'click' });
  });

  it('calls onClick without tracking when onClick is set but testID is absent', () => {
    const onClick = jest.fn();
    render(<FormSecondaryButton onClick={onClick}>Go</FormSecondaryButton>);

    fireEvent.click(getButton());

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(trackEvent).not.toHaveBeenCalled();
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
