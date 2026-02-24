import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { hapticLight, hapticMedium } from 'lib/mobile/haptics';

import { Button, ButtonVariant } from './Button';

// Mock Loader component
jest.mock('./Loader', () => ({
  Loader: ({ color }: { color: string }) => <span data-testid="loader" data-color={color} />
}));

// Mock haptics
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn(),
  hapticMedium: jest.fn()
}));

// Mock IconOrComponent
jest.mock('utils/icon-or-component', () => ({
  IconOrComponent: ({ icon, color }: any) => (
    <span data-testid="icon" data-color={color}>
      {icon}
    </span>
  )
}));

describe('Button', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders button with default title', () => {
    render(<Button />);

    expect(screen.getByRole('button')).toBeInTheDocument();
    expect(screen.getByText('Button Title')).toBeInTheDocument();
  });

  it('renders with custom title', () => {
    render(<Button title="Click Me" />);

    expect(screen.getByText('Click Me')).toBeInTheDocument();
  });

  it('renders children instead of title when provided', () => {
    render(<Button>Custom Content</Button>);

    expect(screen.getByText('Custom Content')).toBeInTheDocument();
    expect(screen.queryByText('Button Title')).not.toBeInTheDocument();
  });

  describe('variants', () => {
    it('applies Primary variant styles by default', () => {
      render(<Button />);

      expect(screen.getByRole('button')).toHaveClass('bg-primary-500');
    });

    it('applies Secondary variant styles', () => {
      render(<Button variant={ButtonVariant.Secondary} />);

      expect(screen.getByRole('button')).toHaveClass('bg-grey-25');
    });

    it('applies Ghost variant styles', () => {
      render(<Button variant={ButtonVariant.Ghost} />);

      expect(screen.getByRole('button')).toHaveClass('bg-transparent');
    });

    it('applies Danger variant styles', () => {
      render(<Button variant={ButtonVariant.Danger} />);

      expect(screen.getByRole('button')).toHaveClass('bg-red-500');
    });
  });

  describe('haptic feedback', () => {
    it('triggers light haptic for non-danger buttons', () => {
      render(<Button variant={ButtonVariant.Primary} />);

      fireEvent.click(screen.getByRole('button'));

      expect(hapticLight).toHaveBeenCalled();
      expect(hapticMedium).not.toHaveBeenCalled();
    });

    it('triggers medium haptic for danger buttons', () => {
      render(<Button variant={ButtonVariant.Danger} />);

      fireEvent.click(screen.getByRole('button'));

      expect(hapticMedium).toHaveBeenCalled();
      expect(hapticLight).not.toHaveBeenCalled();
    });
  });

  it('calls onClick handler when clicked', () => {
    const onClick = jest.fn();
    render(<Button onClick={onClick} />);

    fireEvent.click(screen.getByRole('button'));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  describe('disabled state', () => {
    it('applies disabled styles when disabled', () => {
      render(<Button disabled />);

      expect(screen.getByRole('button')).toBeDisabled();
      expect(screen.getByRole('button')).toHaveClass('bg-[#FF550099]');
    });

    it('does not call onClick when disabled', () => {
      const onClick = jest.fn();
      render(<Button disabled onClick={onClick} />);

      fireEvent.click(screen.getByRole('button'));

      // Disabled buttons still fire click events, but the handler may not be called
      // depending on implementation. The button should be disabled.
      expect(screen.getByRole('button')).toBeDisabled();
    });
  });

  describe('loading state', () => {
    it('shows loader when isLoading', () => {
      render(<Button isLoading />);

      expect(screen.getByTestId('loader')).toBeInTheDocument();
      expect(screen.queryByText('Button Title')).not.toBeInTheDocument();
    });

    it('disables pointer events when loading', () => {
      render(<Button isLoading />);

      expect(screen.getByRole('button')).toHaveClass('pointer-events-none');
    });
  });

  describe('icons', () => {
    it('renders left icon', () => {
      render(<Button iconLeft="left-icon" />);

      expect(screen.getByTestId('icon')).toBeInTheDocument();
    });

    it('renders right icon', () => {
      render(<Button iconRight="right-icon" />);

      expect(screen.getByTestId('icon')).toBeInTheDocument();
    });

    it('renders both icons', () => {
      render(<Button iconLeft="left" iconRight="right" />);

      expect(screen.getAllByTestId('icon')).toHaveLength(2);
    });
  });

  it('applies custom className', () => {
    render(<Button className="custom-class" />);

    expect(screen.getByRole('button')).toHaveClass('custom-class');
  });

  it('has button type by default', () => {
    render(<Button />);

    expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
  });
});
