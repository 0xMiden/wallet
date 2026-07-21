import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { Badge, badgeVariants } from './badge';

// Base classes shared by every variant (from the cva base string).
const BASE_CLASSES = ['inline-flex', 'w-fit', 'shrink-0', 'items-center', 'rounded-10', 'text-xs', 'font-medium'];

describe('Badge', () => {
  it('renders a <span> by default carrying the badge data-slot and default variant', () => {
    const { container } = render(<Badge data-testid="badge">hello</Badge>);

    const el = screen.getByTestId('badge');
    expect(el).toBeInTheDocument();
    expect(el.tagName).toBe('SPAN');
    expect(el).toBe(container.firstChild);
    expect(el).toHaveAttribute('data-slot', 'badge');
    // variant defaults to 'default' when the prop is omitted.
    expect(el).toHaveAttribute('data-variant', 'default');
    expect(el).toHaveTextContent('hello');
    expect(el).toHaveClass(...BASE_CLASSES);
    // Default variant styling.
    expect(el).toHaveClass('bg-primary', 'text-primary-foreground');
  });

  it.each([
    ['default', ['bg-primary', 'text-primary-foreground']],
    ['secondary', ['bg-secondary', 'text-secondary-foreground']],
    ['destructive', ['bg-destructive', 'text-white']],
    ['outline', ['border-border', 'text-foreground']],
    ['ghost', []],
    ['link', ['text-primary', 'underline-offset-4']]
  ] as const)('applies the %s variant classes and reflects it on data-variant', (variant, expectedClasses) => {
    render(
      <Badge data-testid="badge" variant={variant}>
        badge
      </Badge>
    );

    const el = screen.getByTestId('badge');
    expect(el).toHaveAttribute('data-variant', variant);
    // The base classes are always present regardless of variant.
    expect(el).toHaveClass(...BASE_CLASSES);
    // Each variant-specific class must be present (ghost contributes none).
    for (const expectedClass of expectedClasses) {
      expect(el).toHaveClass(expectedClass);
    }
  });

  it('merges a caller-supplied className with the variant classes', () => {
    render(
      <Badge data-testid="badge" className="mt-2 px-4">
        badge
      </Badge>
    );

    const el = screen.getByTestId('badge');
    expect(el).toHaveClass('mt-2');
    // px-4 wins the tailwind-merge conflict against the base px-2.
    expect(el).toHaveClass('px-4');
    expect(el).not.toHaveClass('px-2');
    // Non-conflicting base classes survive.
    expect(el).toHaveClass('inline-flex', 'rounded-10');
  });

  it('lets a caller-supplied className win a tailwind-merge conflict against a variant class', () => {
    // `cn` runs through tailwind-merge, so a conflicting bg utility from the
    // caller should replace the default variant's bg-primary.
    render(
      <Badge data-testid="badge" variant="default" className="bg-red-500">
        badge
      </Badge>
    );

    const el = screen.getByTestId('badge');
    expect(el).toHaveClass('bg-red-500');
    expect(el).not.toHaveClass('bg-primary');
  });

  it('spreads arbitrary span props onto the rendered element', () => {
    render(
      <Badge data-testid="badge" id="status-badge" role="status" aria-label="online" title="user is online">
        <span>child content</span>
      </Badge>
    );

    const el = screen.getByTestId('badge');
    expect(el).toHaveAttribute('id', 'status-badge');
    expect(el).toHaveAttribute('role', 'status');
    expect(el).toHaveAttribute('aria-label', 'online');
    expect(el).toHaveAttribute('title', 'user is online');
    expect(screen.getByText('child content')).toBeInTheDocument();
  });

  it('forwards event handlers passed through props', () => {
    const onClick = jest.fn();
    render(
      <Badge data-testid="badge" onClick={onClick}>
        clickable
      </Badge>
    );

    fireEvent.click(screen.getByTestId('badge'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders as its child element (via Slot) when asChild is true', () => {
    const { container } = render(
      <Badge asChild variant="link" data-testid="badge">
        <a href="https://miden.xyz">link badge</a>
      </Badge>
    );

    // Slot merges the badge props onto the child <a> rather than wrapping it
    // in a <span>.
    const anchor = container.querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor).toHaveAttribute('href', 'https://miden.xyz');
    expect(anchor).toHaveAttribute('data-slot', 'badge');
    expect(anchor).toHaveAttribute('data-variant', 'link');
    expect(anchor).toHaveClass(...BASE_CLASSES);
    expect(anchor).toHaveTextContent('link badge');
    // No wrapper <span> is produced when asChild is used.
    expect(container.querySelector('span')).toBeNull();
  });

  it('explicitly renders a <span> when asChild is false', () => {
    render(
      <Badge asChild={false} data-testid="badge">
        badge
      </Badge>
    );

    const el = screen.getByTestId('badge');
    expect(el.tagName).toBe('SPAN');
    expect(el).toHaveAttribute('data-slot', 'badge');
  });

  it('reflects an explicitly-passed default variant on data-variant', () => {
    render(
      <Badge data-testid="badge" variant="default">
        badge
      </Badge>
    );

    expect(screen.getByTestId('badge')).toHaveAttribute('data-variant', 'default');
  });
});

describe('badgeVariants', () => {
  it('returns the base classes with the default variant when called with no args', () => {
    const classes = badgeVariants();
    for (const base of BASE_CLASSES) {
      expect(classes).toContain(base);
    }
    // Falls back to the default variant styling.
    expect(classes).toContain('bg-primary');
    expect(classes).toContain('text-primary-foreground');
  });

  it('returns the base classes plus the default variant when variant is omitted from the options object', () => {
    const classes = badgeVariants({});
    expect(classes).toContain('inline-flex');
    expect(classes).toContain('bg-primary');
  });

  it.each([
    ['default', 'bg-primary'],
    ['secondary', 'bg-secondary'],
    ['destructive', 'bg-destructive'],
    ['outline', 'border-border'],
    ['link', 'text-primary']
  ] as const)('includes the %s variant class when requested', (variant, expectedClass) => {
    const classes = badgeVariants({ variant });
    expect(classes).toContain('inline-flex');
    expect(classes).toContain(expectedClass);
  });

  it('produces a string usable as a className', () => {
    expect(typeof badgeVariants({ variant: 'secondary' })).toBe('string');
  });
});
