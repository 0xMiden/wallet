import React from 'react';

import { render, screen } from '@testing-library/react';

import { Loader } from './Loader';

// Mock the Icon component
jest.mock('app/icons/v2', () => ({
  Icon: ({ name, fill, size, className, ...props }: any) => (
    <span data-testid="icon" data-name={name} data-fill={fill} data-size={size} className={className} {...props} />
  ),
  IconName: {
    Loader: 'Loader'
  }
}));

describe('Loader', () => {
  it('renders Icon component', () => {
    render(<Loader />);

    expect(screen.getByTestId('icon')).toBeInTheDocument();
  });

  it('uses Loader icon name', () => {
    render(<Loader />);

    expect(screen.getByTestId('icon')).toHaveAttribute('data-name', 'Loader');
  });

  it('uses default color currentColor', () => {
    render(<Loader />);

    expect(screen.getByTestId('icon')).toHaveAttribute('data-fill', 'currentColor');
  });

  it('uses custom color when provided', () => {
    render(<Loader color="white" />);

    expect(screen.getByTestId('icon')).toHaveAttribute('data-fill', 'white');
  });

  it('uses default size md', () => {
    render(<Loader />);

    expect(screen.getByTestId('icon')).toHaveAttribute('data-size', 'md');
  });

  it('uses custom size when provided', () => {
    render(<Loader size="lg" />);

    expect(screen.getByTestId('icon')).toHaveAttribute('data-size', 'lg');
  });

  it('has animate-spin class', () => {
    render(<Loader />);

    expect(screen.getByTestId('icon')).toHaveClass('animate-spin');
  });

  it('applies custom className', () => {
    render(<Loader className="custom-class" />);

    expect(screen.getByTestId('icon')).toHaveClass('custom-class');
    expect(screen.getByTestId('icon')).toHaveClass('animate-spin');
  });

  it('passes additional props to Icon', () => {
    render(<Loader data-custom="value" />);

    expect(screen.getByTestId('icon')).toHaveAttribute('data-custom', 'value');
  });
});
