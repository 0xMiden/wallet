import React from 'react';

import { render, screen } from '@testing-library/react';

import { TransactionHeroIcon } from './components';

/**
 * Covers the `size` prop item H added: Processing and the receipt both settle on the spec's
 * 64px status circle, sharing one component rather than two divergent hero sizes.
 */
describe('TransactionHeroIcon size', () => {
  it('defaults to the spec status-circle size (64px, size-16)', () => {
    const { container } = render(<TransactionHeroIcon state="processing" />);

    expect(container.firstElementChild).toHaveClass('size-16');
    expect(container.firstElementChild).not.toHaveClass('size-24');
  });

  it('renders the success glyph scaled to the default size', () => {
    render(<TransactionHeroIcon state="success" />);

    const glyph = document.querySelector('svg')!;
    expect(glyph).toHaveAttribute('width', '30');
    expect(glyph).toHaveAttribute('height', '30');
    // The viewBox stays 44x44 at every size — only width/height change — so the stroke scales
    // uniformly instead of needing a second path per size.
    expect(glyph).toHaveAttribute('viewBox', '0 0 44 44');
  });

  it('accepts an explicit larger size and scales the box and glyph together', () => {
    const { container } = render(<TransactionHeroIcon state="failed" size={96} />);

    expect(container.firstElementChild).toHaveClass('size-24');
    expect(container.firstElementChild).not.toHaveClass('size-16');
    const glyph = document.querySelector('svg')!;
    expect(glyph).toHaveAttribute('width', '44');
    expect(glyph).toHaveAttribute('height', '44');
  });

  it('scales the processing spinner ring with the icon size', () => {
    render(<TransactionHeroIcon state="processing" size={96} />);

    // FlowSpinner derives its stroke from `size`; a 52px ring is the pre-existing large size.
    expect(screen.getByTestId('flow-spinner')).toBeInTheDocument();
  });
});
