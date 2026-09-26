import React from 'react';

import { render, screen } from '@testing-library/react';

import { FactRow, IconCircle } from './FactRow';

const renderFacts = () =>
  render(
    <ul>
      {['one', 'two'].map(id => (
        <FactRow
          key={id}
          as="li"
          data-testid={id}
          leading={<IconCircle>*</IconCircle>}
          title={`${id} title`}
          description={`${id} description that wraps`}
        />
      ))}
    </ul>
  );

describe('FactRow', () => {
  it('starts the hairline after the icon circle (32px + the 12px gap) and hides it on the first row', () => {
    renderFacts();

    const row = screen.getByTestId('two');
    expect(row.tagName).toBe('LI');
    expect(row).toHaveAttribute('data-slot', 'fact-row');
    expect(row.className).toContain('before:left-11');
    expect(row.className).toContain('before:right-0');
    expect(row.className).toContain('before:bg-hairline');
    expect(row.className).toContain('first:before:hidden');
  });

  it('lets the description wrap, where a ListRow subtitle truncates', () => {
    renderFacts();

    const description = screen.getByText('one description that wraps');
    expect(description).toHaveClass('break-words', 'text-caption-heading', 'text-muted');
    expect(description).not.toHaveClass('truncate');
  });

  it('declares its own inset, so an inset plain ListGroup keeps it: 44px for a fact, 30px for an item', () => {
    render(
      <>
        <FactRow data-testid="fact" leading={null} title="Fact" description="Body" />
        <FactRow data-testid="item" variant="item" leading={null} title="Item" />
      </>
    );

    expect(screen.getByTestId('fact')).toHaveClass('[--row-flush-inset:44px]');
    expect(screen.getByTestId('item')).toHaveClass('[--row-flush-inset:30px]');
  });

  it('draws an item as one centred line after a small circle, with no description', () => {
    render(
      <FactRow
        data-testid="item"
        variant="item"
        leading={<IconCircle size="sm">*</IconCircle>}
        title="Cannot move your funds"
      />
    );

    const row = screen.getByTestId('item');
    expect(row).toHaveClass('items-center', 'gap-2.5', 'py-2.5', 'before:left-7.5');
    expect(row).not.toHaveClass('before:left-11');
    expect(screen.getByText('Cannot move your funds')).toHaveClass('text-value', 'text-ink');
    expect(row.querySelector('p')).toBeNull();
  });

  it('renders the title as a heading when asked', () => {
    render(<FactRow titleAs="h3" leading={null} title="Heading" description="Body" />);

    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Heading');
  });
});

describe('IconCircle', () => {
  it('is the decorative 32px fill disc with a 16px glyph', () => {
    render(<IconCircle>*</IconCircle>);

    const circle = screen.getByText('*');
    expect(circle).toHaveAttribute('aria-hidden', 'true');
    expect(circle).toHaveAttribute('data-slot', 'icon');
    expect(circle).toHaveClass('h-8', 'w-8', 'rounded-full', 'bg-fill', '[&>svg]:h-4', '[&>svg]:w-4');
  });

  it('draws the small size as a 20px disc that leaves the glyph its own size', () => {
    render(<IconCircle size="sm">*</IconCircle>);

    const circle = screen.getByText('*');
    expect(circle).toHaveClass('size-5', 'rounded-full');
    expect(circle).not.toHaveClass('h-8');
    expect(circle.className).not.toContain('[&>svg]:h-4');
  });

  it("takes a caller's tint in place of the fill", () => {
    render(<IconCircle className="bg-positive-tint text-positive-tint-ink">*</IconCircle>);

    const circle = screen.getByText('*');
    expect(circle).toHaveClass('bg-positive-tint', 'text-positive-tint-ink');
    expect(circle).not.toHaveClass('bg-fill');
  });
});
