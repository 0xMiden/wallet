import React from 'react';

import { render } from '@testing-library/react';

import AccountTypeBadge from './AccountTypeBadge';

// AccountTypeBadge is a self-contained, memoized presentational atom. Its render
// function ignores its (optional) `darkTheme` prop entirely and always returns
// `null`, so it never contributes any DOM. It has no external dependencies, so we
// exercise the real component end-to-end under jsdom and assert that it renders
// nothing across every prop permutation, covering the memo render callback and
// both states of the single optional prop.

describe('AccountTypeBadge', () => {
  it('renders nothing when no props are given', () => {
    const { container } = render(<AccountTypeBadge />);

    // The render callback returns null → no DOM is produced.
    expect(container).toBeEmptyDOMElement();
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when darkTheme is true', () => {
    const { container } = render(<AccountTypeBadge darkTheme />);

    expect(container).toBeEmptyDOMElement();
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when darkTheme is false', () => {
    const { container } = render(<AccountTypeBadge darkTheme={false} />);

    expect(container).toBeEmptyDOMElement();
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when darkTheme is explicitly undefined', () => {
    const { container } = render(<AccountTypeBadge darkTheme={undefined} />);

    expect(container).toBeEmptyDOMElement();
    expect(container.firstChild).toBeNull();
  });

  it('is a memoized component that stays empty across re-renders with new props', () => {
    const { container, rerender } = render(<AccountTypeBadge darkTheme={false} />);

    expect(container).toBeEmptyDOMElement();

    // Re-render with a changed prop to exercise the memo comparison path.
    rerender(<AccountTypeBadge darkTheme />);

    expect(container).toBeEmptyDOMElement();
    expect(container.firstChild).toBeNull();
  });
});
