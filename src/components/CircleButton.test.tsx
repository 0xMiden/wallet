import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import { CircleButton } from './CircleButton';

// Mock Icon component
jest.mock('app/icons/v2', () => ({
  Icon: ({ name, fill, size, className }: any) => (
    <span data-testid="icon" data-name={name} data-fill={fill} data-size={size} className={className} />
  ),
  IconName: {
    Loader: 'Loader',
    ArrowRight: 'ArrowRight'
  }
}));

// Import the mocked IconName
const { IconName } = jest.requireMock('app/icons/v2');

// Mock haptics
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

// Mock colors
jest.mock('utils/tailwind-colors', () => ({
  grey: {
    300: '#d1d5db'
  }
}));

describe('CircleButton', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders button with icon', () => {
    render(<CircleButton icon={IconName.ArrowRight} />);

    expect(screen.getByRole('button')).toBeInTheDocument();
    expect(screen.getByTestId('icon')).toBeInTheDocument();
  });

  it('displays the correct icon', () => {
    render(<CircleButton icon={IconName.ArrowRight} />);

    expect(screen.getByTestId('icon')).toHaveAttribute('data-name', 'ArrowRight');
  });

  it('triggers haptic feedback on click', () => {
    render(<CircleButton icon={IconName.ArrowRight} />);

    fireEvent.click(screen.getByRole('button'));

    expect(hapticLight).toHaveBeenCalled();
  });

  it('calls onClick handler when clicked', () => {
    const onClick = jest.fn();
    render(<CircleButton icon={IconName.ArrowRight} onClick={onClick} />);

    fireEvent.click(screen.getByRole('button'));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('shows loader icon when isLoading is true', () => {
    render(<CircleButton icon={IconName.ArrowRight} isLoading />);

    expect(screen.getByTestId('icon')).toHaveAttribute('data-name', 'Loader');
    expect(screen.getByTestId('icon')).toHaveClass('animate-spin');
  });

  it('disables pointer events when loading', () => {
    render(<CircleButton icon={IconName.ArrowRight} isLoading />);

    expect(screen.getByRole('button')).toHaveClass('pointer-events-none');
  });

  it('applies disabled styles when disabled', () => {
    render(<CircleButton icon={IconName.ArrowRight} disabled />);

    expect(screen.getByRole('button')).toBeDisabled();
    expect(screen.getByTestId('icon')).toHaveAttribute('data-fill', '#d1d5db');
  });

  it('shows a keyboard focus ring at full brand opacity', () => {
    render(<CircleButton icon={IconName.ArrowRight} />);

    // `focus:outline-none` removes the UA indicator and the only replacement was
    // `focus:bg-gray-100` — a 1.37:1 tint identical to hover. This matters because
    // the routed Settings pages are no longer focus-trapping dialogs with Escape,
    // so this button is their only exit. `focus-visible`, so a mouse click still
    // shows nothing; `primary-600` rather than a translucent `primary-500`, which
    // composited to 1.92:1 and failed the 3:1 that WCAG 1.4.11 asks of a ring.
    const button = screen.getByRole('button');
    expect(button).toHaveClass('focus-visible:ring-2');
    expect(button).toHaveClass('focus-visible:ring-primary-600');
  });

  it('uses custom color when provided', () => {
    render(<CircleButton icon={IconName.ArrowRight} color="blue" />);

    expect(screen.getByTestId('icon')).toHaveAttribute('data-fill', 'blue');
  });

  it('uses black color by default', () => {
    render(<CircleButton icon={IconName.ArrowRight} />);

    expect(screen.getByTestId('icon')).toHaveAttribute('data-fill', 'black');
  });

  it('applies custom size', () => {
    render(<CircleButton icon={IconName.ArrowRight} size="lg" />);

    expect(screen.getByTestId('icon')).toHaveAttribute('data-size', 'lg');
  });

  it('uses md size by default', () => {
    render(<CircleButton icon={IconName.ArrowRight} />);

    expect(screen.getByTestId('icon')).toHaveAttribute('data-size', 'md');
  });

  it('applies custom className', () => {
    render(<CircleButton icon={IconName.ArrowRight} className="custom-class" />);

    expect(screen.getByRole('button')).toHaveClass('custom-class');
  });

  it('has button type by default', () => {
    render(<CircleButton icon={IconName.ArrowRight} />);

    expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
  });
});
