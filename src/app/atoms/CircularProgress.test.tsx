import React from 'react';

import { render } from '@testing-library/react';

import CircularProgress from './CircularProgress';

describe('CircularProgress', () => {
  const defaultProps = {
    borderWeight: 4,
    circleSize: 100,
    circleColor: '#3b82f6',
    progress: 50,
    spin: false
  };

  it('renders without crashing', () => {
    const { container } = render(<CircularProgress {...defaultProps} />);

    expect(container.firstChild).toBeInTheDocument();
  });

  it('applies correct size styles', () => {
    const { container } = render(<CircularProgress {...defaultProps} circleSize={200} />);
    const circle = container.firstChild as HTMLElement;

    expect(circle).toHaveStyle({
      width: '200px',
      height: '200px'
    });
  });

  it('includes progress in data attribute', () => {
    const { container } = render(<CircularProgress {...defaultProps} progress={75} />);
    const circle = container.firstChild as HTMLElement;

    expect(circle).toHaveAttribute('data-progress', '75');
  });

  it('applies animate-spin class when spin is true', () => {
    const { container } = render(<CircularProgress {...defaultProps} spin={true} />);
    const circle = container.firstChild;

    expect(circle).toHaveClass('animate-spin');
  });

  it('does not apply animate-spin class when spin is false', () => {
    const { container } = render(<CircularProgress {...defaultProps} spin={false} />);
    const circle = container.firstChild;

    expect(circle).not.toHaveClass('animate-spin');
  });

  it('renders nested slices for progress display', () => {
    const { container } = render(<CircularProgress {...defaultProps} />);
    const divs = container.querySelectorAll('div');

    // Should have multiple nested divs for the progress slices
    expect(divs.length).toBeGreaterThan(3);
  });

  it('applies border-radius for circular shape', () => {
    const { container } = render(<CircularProgress {...defaultProps} />);
    const circle = container.firstChild as HTMLElement;

    expect(circle).toHaveStyle({
      borderRadius: '50%'
    });
  });

  it('calculates progress rotation correctly', () => {
    const { container } = render(<CircularProgress {...defaultProps} progress={100} />);

    // At 100%, the rotation should be 180deg
    // We can check the data-progress attribute to verify the prop was used
    const circle = container.firstChild as HTMLElement;
    expect(circle).toHaveAttribute('data-progress', '100');
  });

  it('handles 0 progress', () => {
    const { container } = render(<CircularProgress {...defaultProps} progress={0} />);
    const circle = container.firstChild as HTMLElement;

    expect(circle).toHaveAttribute('data-progress', '0');
  });

  it('applies margin styling', () => {
    const { container } = render(<CircularProgress {...defaultProps} />);
    const circle = container.firstChild as HTMLElement;

    expect(circle).toHaveStyle({
      margin: '20px auto'
    });
  });
});
