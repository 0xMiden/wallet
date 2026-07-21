import React from 'react';

import { render } from '@testing-library/react';

import { ActivitySpinner } from './ActivitySpinner';

// ActivitySpinner is a self-contained presentational atom: a single wrapper
// <div> with fixed layout classes and an inline `height` (defaulting to
// '21px'), containing the real <Spinner /> (→ CircularProgress). None of those
// have external dependencies beyond the `PRIMARY_HEX` colour constant, so we
// exercise the whole tree end-to-end under jsdom and cover both sides of the
// `height = '21px'` default parameter (omitted vs. provided).

const getWrapper = (container: HTMLElement) => container.firstChild as HTMLDivElement;

describe('ActivitySpinner', () => {
  it('renders a single wrapper <div> with the fixed layout classes', () => {
    const { container } = render(<ActivitySpinner />);
    const wrapper = getWrapper(container);

    expect(wrapper).toBeInTheDocument();
    expect(wrapper.tagName).toBe('DIV');
    expect(wrapper).toHaveClass('w-full', 'pt-8', 'flex', 'items-center', 'justify-center');
  });

  it('applies the default height of 21px when no height prop is given', () => {
    const { container } = render(<ActivitySpinner />);
    const wrapper = getWrapper(container);

    expect(wrapper).toHaveStyle({ height: '21px' });
  });

  it('treats an explicitly undefined height the same as the default', () => {
    const { container } = render(<ActivitySpinner height={undefined} />);
    const wrapper = getWrapper(container);

    // The default parameter kicks in for `undefined`, so it falls back to 21px.
    expect(wrapper).toHaveStyle({ height: '21px' });
  });

  it('applies a custom height when the height prop is provided', () => {
    const { container } = render(<ActivitySpinner height="120px" />);
    const wrapper = getWrapper(container);

    expect(wrapper).toHaveStyle({ height: '120px' });
  });

  it('supports non-pixel height units passed straight through', () => {
    const { container } = render(<ActivitySpinner height="50%" />);
    const wrapper = getWrapper(container);

    expect(wrapper).toHaveStyle({ height: '50%' });
  });

  it('renders the spinning CircularProgress inside the wrapper', () => {
    const { container } = render(<ActivitySpinner />);
    const wrapper = getWrapper(container);

    // Exactly one child: the <Spinner /> tree.
    expect(wrapper.childNodes).toHaveLength(1);

    // Spinner → CircularProgress renders a spinning circle carrying the
    // progress marker; confirm the real inner component actually mounted.
    const spinner = wrapper.querySelector('[data-progress]') as HTMLElement;
    expect(spinner).toBeInTheDocument();
    expect(spinner).toHaveClass('animate-spin');
    expect(spinner).toHaveAttribute('data-progress', '40');
  });
});
