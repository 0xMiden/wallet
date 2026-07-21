import React from 'react';

import { render, screen } from '@testing-library/react';

import { Checkbox } from './Checkbox';

// Mock Icon component
jest.mock('app/icons/v2', () => ({
  Icon: ({ name, fill, size, className }: any) => (
    <span data-testid="icon" data-name={name} data-fill={fill} data-size={size} className={className} />
  ),
  IconName: {
    Checkmark: 'Checkmark'
  }
}));

describe('Checkbox', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders a checkbox input', () => {
    render(<Checkbox value={false} />);

    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).toHaveAttribute('type', 'checkbox');
  });

  describe('unchecked state (value = false)', () => {
    it('does not render the checkmark icon', () => {
      render(<Checkbox value={false} />);

      expect(screen.queryByTestId('icon')).not.toBeInTheDocument();
    });

    it('applies the default background color to the container', () => {
      const { container } = render(<Checkbox value={false} />);

      const box = container.firstChild as HTMLElement;
      expect(box).toHaveClass('bg-white');
    });

    it('applies the default border to the container', () => {
      const { container } = render(<Checkbox value={false} />);

      const box = container.firstChild as HTMLElement;
      expect(box).toHaveClass('border-2');
      expect(box).toHaveClass('border-border-light');
    });
  });

  describe('checked state (value = true)', () => {
    it('renders the checkmark icon', () => {
      render(<Checkbox value={true} />);

      expect(screen.getByTestId('icon')).toBeInTheDocument();
    });

    it('renders the checkmark icon with the correct props', () => {
      render(<Checkbox value={true} />);

      const icon = screen.getByTestId('icon');
      expect(icon).toHaveAttribute('data-name', 'Checkmark');
      expect(icon).toHaveAttribute('data-fill', 'white');
      expect(icon).toHaveAttribute('data-size', 'xs');
    });

    it('applies the checked background color to the container', () => {
      const { container } = render(<Checkbox value={true} />);

      const box = container.firstChild as HTMLElement;
      expect(box).toHaveClass('bg-primary-500');
      expect(box).toHaveClass('hover:bg-primary-600');
    });

    it('applies the checked (zero-width) border to the container', () => {
      const { container } = render(<Checkbox value={true} />);

      const box = container.firstChild as HTMLElement;
      expect(box).toHaveClass('border-0');
    });
  });

  describe('shared container styles', () => {
    it('always applies the base layout classes regardless of value', () => {
      const { container } = render(<Checkbox value={false} />);

      const box = container.firstChild as HTMLElement;
      expect(box).toHaveClass('w-5');
      expect(box).toHaveClass('h-5');
      expect(box).toHaveClass('rounded-xs');
      expect(box).toHaveClass('transition-colors');
    });
  });

  describe('input props passthrough', () => {
    it('forwards arbitrary input attributes such as disabled', () => {
      render(<Checkbox value={false} disabled />);

      expect(screen.getByRole('checkbox')).toBeDisabled();
    });

    it('forwards the id attribute', () => {
      render(<Checkbox value={false} id="terms" />);

      expect(screen.getByRole('checkbox')).toHaveAttribute('id', 'terms');
    });

    it('forwards data attributes', () => {
      render(<Checkbox value={true} data-testid="my-checkbox" />);

      expect(screen.getByTestId('my-checkbox')).toBeInTheDocument();
    });

    it('applies the appearance-none input styling', () => {
      render(<Checkbox value={false} />);

      expect(screen.getByRole('checkbox')).toHaveClass('appearance-none');
      expect(screen.getByRole('checkbox')).toHaveClass('cursor-pointer');
    });
  });

  describe('onChange prop', () => {
    it('accepts an onChange prop without forwarding it to the input (currently disabled)', () => {
      const onChange = jest.fn();

      // onChange is destructured out of the spread props on purpose; the
      // native change handler is commented out in the source, so this simply
      // verifies the component renders when an onChange is supplied.
      expect(() => render(<Checkbox value={false} onChange={onChange} />)).not.toThrow();
      expect(screen.getByRole('checkbox')).toBeInTheDocument();
      expect(onChange).not.toHaveBeenCalled();
    });
  });
});
