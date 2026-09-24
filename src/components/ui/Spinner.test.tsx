import React from 'react';

import { render, screen } from '@testing-library/react';

import { Spinner } from './Spinner';

describe('Spinner', () => {
  it('renders a presentational, ARIA-hidden root at the default md size', () => {
    render(<Spinner data-testid="spinner" />);

    const root = screen.getByTestId('spinner');
    expect(root).toHaveAttribute('role', 'presentation');
    expect(root).toHaveAttribute('aria-hidden', 'true');
    expect(root).toHaveStyle({ width: '24px', height: '24px' });
  });

  it('sizes the root per the `size` prop', () => {
    const { rerender } = render(<Spinner data-testid="spinner" size="sm" />);
    expect(screen.getByTestId('spinner')).toHaveStyle({ width: '16px', height: '16px' });

    rerender(<Spinner data-testid="spinner" size="lg" />);
    expect(screen.getByTestId('spinner')).toHaveStyle({ width: '32px', height: '32px' });
  });

  it('carries the 0.9s spin animation, slowed (not stopped) under reduced motion', () => {
    render(<Spinner data-testid="spinner" />);

    const root = screen.getByTestId('spinner');
    expect(root).toHaveClass('animate-[spin_0.9s_linear_infinite]');
    expect(root).toHaveClass('motion-reduce:animate-[spin_1.8s_linear_infinite]');
  });

  it('is `accent` colored so the ring reads on a `fill` surface', () => {
    render(<Spinner data-testid="spinner" />);
    expect(screen.getByTestId('spinner')).toHaveClass('text-accent-primary');
  });

  it('merges a caller-supplied className', () => {
    render(<Spinner data-testid="spinner" className="mx-auto" />);
    expect(screen.getByTestId('spinner')).toHaveClass('mx-auto');
  });

  it('renders two concentric circles: a faint full track and a partial accent arc', () => {
    const { container } = render(<Spinner />);
    const circles = container.querySelectorAll('circle');
    expect(circles).toHaveLength(2);
    expect(circles[0]).toHaveAttribute('stroke-opacity', '0.18');
    expect(circles[1]).toHaveAttribute('stroke-linecap', 'round');
  });
});
