import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { Skeleton } from './Skeleton';

describe('Skeleton', () => {
  it('renders a div carrying the skeleton data-slot and the base classes', () => {
    const { container } = render(<Skeleton data-testid="skeleton" />);

    const el = screen.getByTestId('skeleton');
    expect(el).toBeInTheDocument();
    expect(el.tagName).toBe('DIV');
    expect(el).toBe(container.firstChild);
    expect(el).toHaveAttribute('data-slot', 'skeleton');
    expect(el).toHaveClass('animate-pulse', 'rounded-md', 'motion-reduce:animate-none', 'bg-fill');
  });

  it('defaults to the `fill` tone', () => {
    render(<Skeleton data-testid="skeleton" />);
    expect(screen.getByTestId('skeleton')).toHaveClass('bg-fill');
  });

  it('renders the `inverse` tone for a skeleton on a colored surface', () => {
    render(<Skeleton data-testid="skeleton" tone="inverse" />);
    const el = screen.getByTestId('skeleton');
    // `white` is the theme surface token and turns dark in dark mode, where a 15% wash of it
    // vanished on the dark balance card (#1123); the fixed palette's white does not flip.
    expect(el).toHaveClass('bg-pure-white/15');
    expect(el).not.toHaveClass('bg-white/15');
    expect(el).not.toHaveClass('bg-fill');
  });

  it('merges a caller-supplied className with the base classes', () => {
    render(<Skeleton data-testid="skeleton" className="h-4 w-24" />);

    const el = screen.getByTestId('skeleton');
    expect(el).toHaveClass('animate-pulse', 'bg-fill', 'h-4', 'w-24');
  });

  it('lets a caller-supplied className win a tailwind-merge conflict', () => {
    render(<Skeleton data-testid="skeleton" className="rounded-full" />);

    const el = screen.getByTestId('skeleton');
    expect(el).toHaveClass('rounded-full', 'bg-fill', 'animate-pulse');
    expect(el).not.toHaveClass('rounded-md');
  });

  it('spreads arbitrary div props onto the rendered element', () => {
    render(
      <Skeleton data-testid="skeleton" id="loading-block" role="status" aria-label="loading" title="please wait">
        <span>child content</span>
      </Skeleton>
    );

    const el = screen.getByTestId('skeleton');
    expect(el).toHaveAttribute('id', 'loading-block');
    expect(el).toHaveAttribute('role', 'status');
    expect(el).toHaveAttribute('aria-label', 'loading');
    expect(el).toHaveAttribute('title', 'please wait');
    expect(screen.getByText('child content')).toBeInTheDocument();
  });

  it('forwards event handlers passed through props', () => {
    const onClick = jest.fn();
    render(<Skeleton data-testid="skeleton" onClick={onClick} />);

    fireEvent.click(screen.getByTestId('skeleton'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
