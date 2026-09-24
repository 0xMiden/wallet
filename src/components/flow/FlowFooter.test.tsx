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
});
