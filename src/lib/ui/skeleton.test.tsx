import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { Skeleton } from './skeleton';

describe('Skeleton', () => {
  it('renders a div carrying the skeleton data-slot and the base classes', () => {
    const { container } = render(<Skeleton data-testid="skeleton" />);

    const el = screen.getByTestId('skeleton');
    expect(el).toBeInTheDocument();
    expect(el.tagName).toBe('DIV');
    expect(el).toBe(container.firstChild);
    expect(el).toHaveAttribute('data-slot', 'skeleton');
    expect(el).toHaveClass('bg-muted', 'rounded-md', 'animate-pulse');
  });

  it('merges a caller-supplied className with the base classes', () => {
    render(<Skeleton data-testid="skeleton" className="h-4 w-24" />);

    const el = screen.getByTestId('skeleton');
    // Base classes survive alongside the extras.
    expect(el).toHaveClass('bg-muted', 'rounded-md', 'animate-pulse', 'h-4', 'w-24');
  });

  it('lets a caller-supplied className win a tailwind-merge conflict', () => {
    // `cn` runs through tailwind-merge, so a conflicting utility from the
    // caller (rounded-full vs the base rounded-md) should replace the base.
    render(<Skeleton data-testid="skeleton" className="rounded-full" />);

    const el = screen.getByTestId('skeleton');
    expect(el).toHaveClass('rounded-full', 'bg-muted', 'animate-pulse');
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

  it('renders with only the base classes when no className is provided', () => {
    render(<Skeleton data-testid="skeleton" />);

    const el = screen.getByTestId('skeleton');
    expect(el.className).toBe('bg-muted rounded-md animate-pulse');
  });
});
