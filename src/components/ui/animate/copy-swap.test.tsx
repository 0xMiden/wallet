import React from 'react';

import { render, screen } from '@testing-library/react';

import { copyMotion } from 'lib/animation/copy';

import { SwapSlot } from './copy-swap';

describe('SwapSlot', () => {
  // AnimatePresence mode="popLayout" measures the leaving slot through the ref it hands its direct child; without it
  // the outgoing glyph stays in layout and pushes its neighbour aside on every copy.
  it('forwards its ref to the span it renders, which popLayout measures', () => {
    const ref = React.createRef<HTMLSpanElement>();
    render(
      <SwapSlot ref={ref} swap={copyMotion.icon} data-copy-state="idle">
        glyph
      </SwapSlot>
    );

    expect(ref.current).toBe(screen.getByText('glyph'));
  });
});
