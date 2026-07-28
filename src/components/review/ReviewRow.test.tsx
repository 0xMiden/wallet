import React from 'react';

import { render } from '@testing-library/react';

import { ReviewRow } from './ReviewRow';

describe('ReviewRow note', () => {
  // The note must stay legible in BOTH themes: on the white light background it
  // needs to clear WCAG AA (>= 4.5:1), and on the dark app background it must
  // flip so it isn't a dark-grey blob. `text-heading-gray` (--color-text-secondary)
  // is #484848 in light (9.15:1) and #ffffff in dark — both pass. A hardcoded
  // light hex or `text-text-muted` (#ababab, only 2.30:1 on white) does not.
  it('colours the note with a theme token that passes contrast in both themes', () => {
    const { getByText } = render(<ReviewRow label="Amount" value="10" note="heads up" />);

    const noteWrapper = getByText('heads up').parentElement as HTMLElement;

    expect(noteWrapper.className).toContain('text-heading-gray');
    expect(noteWrapper.className).not.toContain('text-text-muted');
    expect(noteWrapper.className).not.toContain('text-[#6B6862]');
  });
});
