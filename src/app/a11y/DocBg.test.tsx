import React from 'react';

import { render } from '@testing-library/react';

import DocBg from './DocBg';

// `DocBg` captures a module-level reference to `document.documentElement` and
// mutates its class list inside a layout effect. jsdom exposes a single stable
// `documentElement`, so this local reference is the same node the component
// mutates.
const doc = document.documentElement;

describe('DocBg', () => {
  beforeEach(() => {
    doc.className = '';
  });

  afterEach(() => {
    doc.className = '';
  });

  it('renders nothing (component returns null)', () => {
    const { container } = render(<DocBg bgClassName="bg-red" />);

    expect(container).toBeEmptyDOMElement();
  });

  it('adds the bgClassName to documentElement on mount', () => {
    render(<DocBg bgClassName="bg-blue" />);

    expect(doc.classList.contains('bg-blue')).toBe(true);
  });

  it('removes pre-existing bg-* classes on mount while preserving non-bg classes', () => {
    // 'foo' / 'another' exercise the false branch of `startsWith('bg-')`;
    // 'bg-old' exercises the true branch.
    doc.className = 'foo bg-old another';

    render(<DocBg bgClassName="bg-new" />);

    expect(doc.classList.contains('bg-old')).toBe(false);
    expect(doc.classList.contains('bg-new')).toBe(true);
    expect(doc.classList.contains('foo')).toBe(true);
    expect(doc.classList.contains('another')).toBe(true);
  });

  it('restores pre-existing bg-* classes and removes bgClassName on unmount', () => {
    doc.className = 'bg-old keep';

    const { unmount } = render(<DocBg bgClassName="bg-new" />);

    expect(doc.classList.contains('bg-old')).toBe(false);
    expect(doc.classList.contains('bg-new')).toBe(true);

    unmount();

    expect(doc.classList.contains('bg-new')).toBe(false);
    expect(doc.classList.contains('bg-old')).toBe(true);
    expect(doc.classList.contains('keep')).toBe(true);
  });

  it('handles the case where no bg-* classes exist (empty collected list)', () => {
    doc.className = 'foo';

    const { unmount } = render(<DocBg bgClassName="bg-solo" />);

    expect(doc.classList.contains('bg-solo')).toBe(true);
    expect(doc.classList.contains('foo')).toBe(true);

    // Cleanup spreads an empty array into remove()/add(); must be a no-op, not throw.
    unmount();

    expect(doc.classList.contains('bg-solo')).toBe(false);
    expect(doc.classList.contains('foo')).toBe(true);
  });

  it('re-runs the effect when bgClassName changes (cleanup then re-apply)', () => {
    doc.className = 'bg-original';

    const { rerender } = render(<DocBg bgClassName="bg-first" />);

    expect(doc.classList.contains('bg-first')).toBe(true);
    expect(doc.classList.contains('bg-original')).toBe(false);

    rerender(<DocBg bgClassName="bg-second" />);

    // The previous effect's cleanup restores 'bg-original', which the new
    // effect then strips again before applying 'bg-second'.
    expect(doc.classList.contains('bg-second')).toBe(true);
    expect(doc.classList.contains('bg-first')).toBe(false);
    expect(doc.classList.contains('bg-original')).toBe(false);
  });
});
