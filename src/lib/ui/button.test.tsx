import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { Button, buttonVariants } from './button';

describe('Button', () => {
  it('renders a native button with default data attributes and base classes', () => {
    const { container } = render(<Button>Click me</Button>);

    const el = screen.getByRole('button', { name: 'Click me' });
    expect(el).toBeInTheDocument();
    expect(el.tagName).toBe('BUTTON');
    expect(el).toBe(container.firstChild);
    expect(el).toHaveAttribute('data-slot', 'button');
    // Falls back to the defaultVariants when nothing is supplied.
    expect(el).toHaveAttribute('data-variant', 'default');
    expect(el).toHaveAttribute('data-size', 'default');
    // A representative slice of the base + default-variant + default-size classes.
    expect(el).toHaveClass('inline-flex', 'items-center', 'bg-primary-500', 'text-pure-white', 'h-8');
  });

  it('reflects an explicit variant on the data-variant attribute and class list', () => {
    render(
      <Button variant="destructive" data-testid="btn">
        Delete
      </Button>
    );

    const el = screen.getByTestId('btn');
    expect(el).toHaveAttribute('data-variant', 'destructive');
    expect(el).toHaveClass('bg-red-500/10', 'text-red-500');
    // Default variant classes should NOT be present when another variant is picked.
    expect(el).not.toHaveClass('bg-primary-500');
  });

  it.each([
    ['default', 'bg-primary-500'],
    ['outline', 'border-border-light'],
    ['secondary', 'bg-gray-50'],
    ['ghost', 'hover:bg-gray-100'],
    ['destructive', 'bg-red-500/10'],
    ['link', 'text-primary-500']
  ] as const)('renders the %s variant with its signature class', (variant, signatureClass) => {
    render(
      <Button variant={variant} data-testid="btn">
        {variant}
      </Button>
    );

    const el = screen.getByTestId('btn');
    expect(el).toHaveAttribute('data-variant', variant);
    expect(el).toHaveClass(signatureClass);
  });

  it.each([
    ['default', 'h-8'],
    ['xs', 'h-6'],
    ['sm', 'h-7'],
    ['lg', 'h-9'],
    ['icon', 'size-8'],
    ['icon-xs', 'size-6'],
    ['icon-sm', 'size-7'],
    ['icon-lg', 'size-9']
  ] as const)('renders the %s size with its signature class', (size, signatureClass) => {
    render(
      <Button size={size} data-testid="btn">
        {size}
      </Button>
    );

    const el = screen.getByTestId('btn');
    expect(el).toHaveAttribute('data-size', size);
    expect(el).toHaveClass(signatureClass);
  });

  it('merges a caller-supplied className with the generated variant classes', () => {
    render(
      <Button className="w-full extra-thing" data-testid="btn">
        Wide
      </Button>
    );

    const el = screen.getByTestId('btn');
    // Base + default variant classes survive alongside the caller extras.
    expect(el).toHaveClass('inline-flex', 'bg-primary-500', 'w-full', 'extra-thing');
  });

  it('lets a caller-supplied className win a tailwind-merge conflict', () => {
    // `cn` runs through tailwind-merge; a conflicting utility from the caller
    // (rounded-full vs the base rounded-lg) should replace the base one.
    render(
      <Button className="rounded-full" data-testid="btn">
        Round
      </Button>
    );

    const el = screen.getByTestId('btn');
    expect(el).toHaveClass('rounded-full');
    expect(el).not.toHaveClass('rounded-lg');
  });

  it('spreads arbitrary button props onto the rendered element', () => {
    render(
      <Button data-testid="btn" id="submit-btn" type="submit" name="action" title="please submit" aria-label="submit">
        Submit
      </Button>
    );

    const el = screen.getByTestId('btn');
    expect(el).toHaveAttribute('id', 'submit-btn');
    expect(el).toHaveAttribute('type', 'submit');
    expect(el).toHaveAttribute('name', 'action');
    expect(el).toHaveAttribute('title', 'please submit');
    expect(el).toHaveAttribute('aria-label', 'submit');
  });

  it('forwards click handlers and honours the disabled attribute', () => {
    const onClick = jest.fn();

    const { rerender } = render(
      <Button onClick={onClick} data-testid="btn">
        Go
      </Button>
    );

    fireEvent.click(screen.getByTestId('btn'));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Button onClick={onClick} disabled data-testid="btn">
        Go
      </Button>
    );

    const el = screen.getByTestId('btn');
    expect(el).toBeDisabled();
    // The base class list includes disabled:pointer-events-none.
    expect(el).toHaveClass('disabled:pointer-events-none', 'disabled:opacity-50');
    fireEvent.click(el);
    // A disabled button does not fire additional click handlers.
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders explicitly as a native button when asChild is false', () => {
    render(
      <Button asChild={false} data-testid="btn">
        Native
      </Button>
    );

    const el = screen.getByTestId('btn');
    expect(el.tagName).toBe('BUTTON');
    expect(el).toHaveAttribute('data-slot', 'button');
  });

  it('renders as its child element (Slot) when asChild is true, forwarding attributes and classes', () => {
    render(
      <Button asChild variant="link" size="sm">
        <a href="/dashboard" data-testid="link-btn">
          Go to dashboard
        </a>
      </Button>
    );

    const el = screen.getByTestId('link-btn');
    // Slot renders the child element itself rather than a <button>.
    expect(el.tagName).toBe('A');
    expect(el).toHaveAttribute('href', '/dashboard');
    // Button's own props are merged onto the child element.
    expect(el).toHaveAttribute('data-slot', 'button');
    expect(el).toHaveAttribute('data-variant', 'link');
    expect(el).toHaveAttribute('data-size', 'sm');
    expect(el).toHaveClass('text-primary-500', 'h-7');
    // No stray native button gets rendered.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('buttonVariants', () => {
  it('returns the default variant + size classes when called with no arguments', () => {
    const classes = buttonVariants();

    expect(typeof classes).toBe('string');
    // Default variant (default) and default size classes are present.
    expect(classes).toContain('bg-primary-500');
    expect(classes).toContain('h-8');
    // Shared base classes are always included.
    expect(classes).toContain('inline-flex');
  });

  it('honours explicit variant and size arguments', () => {
    const classes = buttonVariants({ variant: 'outline', size: 'lg' });

    expect(classes).toContain('border-border-light');
    expect(classes).toContain('h-9');
    expect(classes).not.toContain('bg-primary-500');
  });

  it('folds an extra className into its output', () => {
    const classes = buttonVariants({ variant: 'ghost', className: 'my-custom-class' });

    expect(classes).toContain('my-custom-class');
    expect(classes).toContain('hover:bg-gray-100');
  });
});
