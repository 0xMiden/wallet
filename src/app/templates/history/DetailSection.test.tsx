import React from 'react';

import { render, screen } from '@testing-library/react';

import { DetailSection } from './DetailSection';

describe('DetailSection', () => {
  it('renders only the card when no title is given', () => {
    render(
      <DetailSection>
        <span data-testid="body">row</span>
      </DetailSection>
    );

    expect(screen.getByTestId('body')).toBeInTheDocument();
    expect(screen.queryByText(/./, { selector: '.rounded-full' })).not.toBeInTheDocument();
  });

  it('renders a compact pill label above the card when a title is given', () => {
    const { container } = render(
      <DetailSection title="Transfer Details">
        <span>row</span>
      </DetailSection>
    );

    const label = screen.getByText('Transfer Details');
    expect(label).toHaveClass('rounded-full', 'bg-gray-50');

    // The card sits after the label and picks up the label's bottom margin.
    const card = container.querySelector('section > div:last-child')!;
    expect(card).toHaveClass('mt-2');
  });

  it('forwards a caller className to the card', () => {
    const { container } = render(<DetailSection className="mt-6">row</DetailSection>);
    const card = container.querySelector('section > div')!;
    expect(card).toHaveClass('mt-6');
  });
});
