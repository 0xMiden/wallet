import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { Link } from './Link';

describe('Link', () => {
  it('renders as an anchor element', () => {
    const { container } = render(<Link>Click me</Link>);
    const anchor = container.querySelector('a');

    expect(anchor).toBeInTheDocument();
  });

  it('renders string children', () => {
    render(<Link>Hello World</Link>);

    expect(screen.getByText('Hello World')).toBeInTheDocument();
  });

  it('renders ReactNode children', () => {
    render(
      <Link>
        <span data-testid="node-child">Node child</span>
      </Link>
    );

    expect(screen.getByTestId('node-child')).toBeInTheDocument();
    expect(screen.getByTestId('node-child')).toHaveTextContent('Node child');
  });

  it('renders without children', () => {
    const { container } = render(<Link />);
    const anchor = container.querySelector('a')!;

    expect(anchor).toBeInTheDocument();
    expect(anchor).toBeEmptyDOMElement();
  });

  it('applies the base classes', () => {
    const { container } = render(<Link>Styled</Link>);
    const anchor = container.querySelector('a')!;

    expect(anchor).toHaveClass(
      'text-blue-600',
      'hover:underline',
      'underline-offset-2',
      'decoration-blue-600',
      'cursor-pointer'
    );
  });

  it('applies a custom className in addition to the base classes', () => {
    const { container } = render(<Link className="my-custom-class">Custom</Link>);
    const anchor = container.querySelector('a')!;

    expect(anchor).toHaveClass('my-custom-class');
    // Base classes are still present.
    expect(anchor).toHaveClass('text-blue-600', 'cursor-pointer');
  });

  it('applies only the base classes when className is omitted', () => {
    const { container } = render(<Link>No custom</Link>);
    const anchor = container.querySelector('a')!;

    expect(anchor).toHaveClass('text-blue-600', 'cursor-pointer');
    expect(anchor.className).not.toContain('undefined');
  });

  it('forwards the href attribute', () => {
    const { container } = render(<Link href="https://example.com">Example</Link>);
    const anchor = container.querySelector('a')!;

    expect(anchor).toHaveAttribute('href', 'https://example.com');
  });

  it('forwards arbitrary anchor props', () => {
    const { container } = render(
      <Link href="https://miden.xyz" target="_blank" rel="noopener noreferrer" id="link-id" data-testid="link-el">
        Miden
      </Link>
    );
    const anchor = container.querySelector('a')!;

    expect(anchor).toHaveAttribute('target', '_blank');
    expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
    expect(anchor).toHaveAttribute('id', 'link-id');
    expect(screen.getByTestId('link-el')).toBe(anchor);
  });

  it('calls the onClick handler when clicked', () => {
    const onClick = jest.fn();
    render(<Link onClick={onClick}>Clickable</Link>);

    fireEvent.click(screen.getByText('Clickable'));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not throw when clicked without an onClick handler', () => {
    render(<Link>NoHandler</Link>);

    expect(() => fireEvent.click(screen.getByText('NoHandler'))).not.toThrow();
  });
});
