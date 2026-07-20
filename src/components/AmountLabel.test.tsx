import React from 'react';

import { render, screen } from '@testing-library/react';

import { AmountLabel } from './AmountLabel';

describe('AmountLabel', () => {
  it('renders the integer part of the amount', () => {
    render(<AmountLabel amount="123.45" />);

    expect(screen.getByText('123')).toBeInTheDocument();
  });

  it('renders the decimal part when the amount contains a decimal separator', () => {
    render(<AmountLabel amount="123.45" />);

    expect(screen.getByText('.45')).toBeInTheDocument();
  });

  it('defaults the decimal part to ".00" when the amount has no decimal separator', () => {
    render(<AmountLabel amount="500" />);

    expect(screen.getByText('500')).toBeInTheDocument();
    expect(screen.getByText('.00')).toBeInTheDocument();
  });

  it('renders the currency symbol when the currency prop is provided', () => {
    render(<AmountLabel amount="10.00" currency="$" />);

    const currency = screen.getByText('$');
    expect(currency).toBeInTheDocument();
    expect(currency.tagName).toBe('SPAN');
    expect(currency).toHaveClass('text-2xl', 'font-base', 'leading-8');
  });

  it('does not render a currency symbol when the currency prop is omitted', () => {
    const { container } = render(<AmountLabel amount="10.00" />);

    // Only the two <p> elements should exist, no leading <span>.
    expect(container.querySelector('span')).toBeNull();
    expect(container.querySelectorAll('p')).toHaveLength(2);
  });

  it('does not render a currency symbol when the currency prop is an empty string', () => {
    const { container } = render(<AmountLabel amount="10.00" currency="" />);

    expect(container.querySelector('span')).toBeNull();
  });

  it('applies the base layout classes to the wrapper', () => {
    const { container } = render(<AmountLabel amount="1.00" />);
    const wrapper = container.firstChild as HTMLElement;

    expect(wrapper).toHaveClass('flex', 'items-end');
  });

  it('merges a custom className onto the wrapper', () => {
    const { container } = render(<AmountLabel amount="1.00" className="my-custom-class" />);
    const wrapper = container.firstChild as HTMLElement;

    expect(wrapper).toHaveClass('flex', 'items-end', 'my-custom-class');
  });

  it('applies the correct typography classes to the integer and decimal parts', () => {
    render(<AmountLabel amount="7.89" />);

    expect(screen.getByText('7')).toHaveClass('text-4xl', 'font-bold', 'leading-10');
    expect(screen.getByText('.89')).toHaveClass('text-2xl', 'font-bold', 'leading-8');
  });

  it('forwards additional HTML attributes to the wrapper element', () => {
    const { container } = render(
      <AmountLabel amount="1.00" id="amount-id" data-testid="amount-el" title="tooltip" />
    );
    const wrapper = container.firstChild as HTMLElement;

    expect(wrapper).toHaveAttribute('id', 'amount-id');
    expect(wrapper).toHaveAttribute('title', 'tooltip');
    expect(screen.getByTestId('amount-el')).toBe(wrapper);
  });

  it('uses only the first two segments when the amount has multiple separators', () => {
    render(<AmountLabel amount="1.2.3" />);

    expect(screen.getByText('1')).toBeInTheDocument();
    // amountParts[1] is the second segment ("2"); trailing segments are ignored.
    expect(screen.getByText('.2')).toBeInTheDocument();
  });

  it('renders an empty integer part gracefully for an empty amount', () => {
    const { container } = render(<AmountLabel amount="" />);
    const paragraphs = container.querySelectorAll('p');

    // Integer part is empty, decimal defaults to ".00".
    expect(paragraphs[0]).toHaveTextContent('');
    expect(paragraphs[1]).toHaveTextContent('.00');
  });
});
