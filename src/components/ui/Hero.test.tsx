import React, { useEffect, useRef } from 'react';

import { render, screen } from '@testing-library/react';

import { Hero } from './Hero';

describe('Hero', () => {
  it('centers the visual', () => {
    const { container } = render(<Hero visual={<span data-testid="avatar" />} />);

    expect(screen.getByTestId('avatar')).toBeInTheDocument();
    expect(container.firstChild).toHaveClass('flex', 'flex-col', 'items-center');
  });

  it('renders the hero value at 32px/900', () => {
    render(<Hero visual={<span />} value="5 MDN" />);

    const value = screen.getByText('5 MDN');
    expect(value.tagName).toBe('DIV');
    expect(value).toHaveClass('text-[32px]', 'font-black', 'text-ink');
  });

  it('renders the hero name as an h2 at 24px/900', () => {
    render(<Hero visual={<span />} name="Transaction Complete!" />);

    const name = screen.getByRole('heading', { level: 2, name: 'Transaction Complete!' });
    expect(name).toHaveClass('text-2xl', 'font-black', 'text-ink');
  });

  it('renders neither value nor name when both are omitted', () => {
    render(<Hero visual={<span data-testid="avatar-only" />} />);

    expect(screen.getByTestId('avatar-only')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
  });

  it('renders a muted subtitle under the value', () => {
    render(<Hero visual={<span />} value="5 MDN" subtitle="≈ $10.00" />);

    expect(screen.getByText('≈ $10.00')).toHaveClass('text-muted', 'text-sm');
  });

  it('omits the subtitle when not provided', () => {
    render(<Hero visual={<span />} value="5 MDN" />);
    // Only the value node and the visual should be present — no stray empty paragraph.
    expect(document.querySelectorAll('p').length).toBe(0);
  });

  it('forwards a nameRef and nameProps to the name heading, for focus management', () => {
    const Wrapper: React.FC = () => {
      const ref = useRef<HTMLHeadingElement>(null);
      useEffect(() => {
        ref.current?.focus();
      }, []);
      return <Hero visual={<span />} name="Success!" nameRef={ref} nameProps={{ tabIndex: -1 }} />;
    };
    render(<Wrapper />);

    const heading = screen.getByRole('heading', { level: 2, name: 'Success!' });
    expect(heading).toHaveFocus();
    expect(heading).toHaveAttribute('tabindex', '-1');
  });

  it('forwards data-testid to the root', () => {
    render(<Hero visual={<span />} data-testid="review-hero" />);
    expect(screen.getByTestId('review-hero')).toBeInTheDocument();
  });

  it('forwards className to the root for layout margins', () => {
    const { container } = render(<Hero visual={<span />} className="mt-3" />);
    expect(container.firstChild).toHaveClass('mt-3');
  });
});
