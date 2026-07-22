import React from 'react';

import { render } from '@testing-library/react';

import { ReviewRow } from './ReviewRow';

describe('ReviewRow note', () => {
  // The info note sits on the dark app background in dark mode, so its colour
  // must come from a theme token that flips — never a hardcoded light hex.
  it('colours the note with a theme token, not a hardcoded light hex', () => {
    const { getByText } = render(<ReviewRow label="Amount" value="10" note="heads up" />);

    const noteWrapper = getByText('heads up').parentElement as HTMLElement;

    expect(noteWrapper.className).toContain('text-text-muted');
    expect(noteWrapper.className).not.toContain('text-[#6B6862]');
  });
});
