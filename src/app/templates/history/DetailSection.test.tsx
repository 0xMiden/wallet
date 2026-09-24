import React from 'react';

import { render, screen } from '@testing-library/react';

import { DetailSection } from './DetailSection';

describe('DetailSection', () => {
  it('renders only the card when no title is given', () => {
    const { container } = render(
      <DetailSection>
        <span data-testid="body">row</span>
      </DetailSection>
    );

    expect(screen.getByTestId('body')).toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(container.querySelector('section')!.children).toHaveLength(1);
  });

  it('titles the card with the design-system SectionHeader, not a local pill', () => {
    const { container } = render(
      <DetailSection title="Transfer Details">
        <span>row</span>
      </DetailSection>
    );

    const heading = screen.getByRole('heading', { level: 2, name: 'Transfer Details' });
    expect(heading).toHaveClass('text-label', 'text-muted');
    expect(heading).not.toHaveClass('rounded-full', 'bg-fill');

    const section = container.querySelector('section')!;
    expect(section).not.toHaveClass('font-heading');
    // Header first, card second; SectionHeader's own 8px bottom padding spaces them.
    expect(section.children).toHaveLength(2);
    expect(section.children[0]).toContainElement(heading);
    expect(section.children[1]).toHaveClass('divide-y');
    expect(section.children[1]).not.toHaveClass('mt-2');
  });

  it('forwards a caller className to the card', () => {
    const { container } = render(<DetailSection className="mt-6">row</DetailSection>);
    const card = container.querySelector('section > div')!;
    expect(card).toHaveClass('mt-6');
  });
});
