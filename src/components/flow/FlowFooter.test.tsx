import React from 'react';

import { render, screen } from '@testing-library/react';

import { FlowFooter } from './FlowFooter';
import { useSlideOnReflow } from './useSlideOnReflow';

jest.mock('components/flow/useSlideOnReflow', () => ({ useSlideOnReflow: jest.fn() }));

describe('FlowFooter', () => {
  it('slides its own footer element when the layout moves it', () => {
    render(
      <FlowFooter>
        <button data-testid="cta" />
      </FlowFooter>
    );

    const footer = screen.getByTestId('cta').parentElement!;
    expect(footer).toHaveAttribute('data-flow-footer');
    expect(useSlideOnReflow).toHaveBeenCalledWith(expect.objectContaining({ current: footer }));
  });

  it('merges a caller className after its own default classes, replacing a class it conflicts with', () => {
    render(
      <FlowFooter className="pt-2">
        <button data-testid="cta" />
      </FlowFooter>
    );

    const footer = screen.getByTestId('cta').parentElement!;
    expect(footer).toHaveClass('pt-2');
    expect(footer).not.toHaveClass('pt-3');
    expect(footer.className).toMatch(/pb-\[max\(1rem,/);
  });
});
