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

  it("takes a caller's tint in place of the fill", () => {
    render(<IconCircle className="bg-positive-tint text-positive-tint-ink">*</IconCircle>);

    const circle = screen.getByText('*');
    expect(circle).toHaveClass('bg-positive-tint', 'text-positive-tint-ink');
    expect(circle).not.toHaveClass('bg-fill');
  });
});
