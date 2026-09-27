import React from 'react';

import { render } from '@testing-library/react';

import { copyMotion } from 'lib/animation/copy';

import { SwapSlot } from './copy-swap';

describe('SwapSlot', () => {
  it('forwards its ref to its root span, which popLayout measures', () => {
    const ref = React.createRef<HTMLSpanElement>();
    const { container } = render(
      <SwapSlot ref={ref} swap={copyMotion.icon} data-copy-state="idle">
        glyph
      </SwapSlot>
    );

    expect(ref.current).toBe(container.firstElementChild);
    expect(ref.current).toHaveTextContent('glyph');
  });
});
