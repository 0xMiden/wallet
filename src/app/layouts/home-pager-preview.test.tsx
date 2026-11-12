import React from 'react';

import { act, render } from '@testing-library/react';

import { setHomePagerPreview, useHomePagerPreview } from './home-pager-preview';

const Probe = () => <span data-testid="preview">{useHomePagerPreview() ?? 'none'}</span>;

describe('home pager preview', () => {
  afterEach(() => setHomePagerPreview(null));

  it('gives null until the pager previews a page', () => {
    const { getByTestId } = render(<Probe />);
    expect(getByTestId('preview').textContent).toBe('none');
  });

  it('re-renders a reader when the preview changes and when it clears', () => {
    const { getByTestId } = render(<Probe />);
    act(() => setHomePagerPreview('send'));
    expect(getByTestId('preview').textContent).toBe('send');
    act(() => setHomePagerPreview(null));
    expect(getByTestId('preview').textContent).toBe('none');
  });
});
