import React from 'react';

import { fireEvent, render } from '@testing-library/react';

import Flag from './Flag';

// Flag is a self-contained presentational atom: given a `src` it renders an
// <img> that swaps to an inline "broken flag" <svg> stub on load error, and
// with no `src` it renders the stub directly. Its only dependency is `clsx`,
// which runs fine under jsdom, so we exercise the real component end-to-end.

const getImg = (container: HTMLElement) => container.querySelector('img') as HTMLImageElement | null;
const getStub = (container: HTMLElement) => container.querySelector('svg') as SVGElement | null;
const getRoot = (container: HTMLElement) => container.firstChild as HTMLElement;

describe('Flag', () => {
  it('renders the standalone stub svg when no src is provided', () => {
    const { container } = render(<Flag alt="no-flag" />);

    // The `!src` early-return path: the stub svg is the root, no wrapper div,
    // no <img>.
    const stub = getStub(container);
    expect(stub).toBeInTheDocument();
    expect(stub).toBe(getRoot(container));
    expect(stub).toHaveClass('w-6', 'h-auto');
    expect(stub).toHaveAttribute('role', 'img');
    expect(getImg(container)).toBeNull();

    // The stub draws the X-cross path.
    expect(container.querySelector('path')).toHaveAttribute(
      'd',
      'M6.34314575 6.34314575L17.6568542 17.6568542M6.34314575 17.6568542L17.6568542 6.34314575'
    );
  });

  it('treats an empty-string src as "no src" and renders the standalone stub', () => {
    // '' is falsy → same early-return branch as omitting the prop entirely.
    const { container } = render(<Flag alt="empty" src="" />);

    expect(getStub(container)).toBe(getRoot(container));
    expect(getImg(container)).toBeNull();
  });

  it('renders the flag image (no error) with the wrapper div and merged className', () => {
    const { container } = render(
      <Flag alt="United States" src="https://flags.example/us.svg" className="extra-class" />
    );

    // The `src` branch: wrapper div carries base layout classes, the merged
    // custom class, and the fixed inline height.
    const root = getRoot(container);
    expect(root.tagName).toBe('DIV');
    expect(root).toHaveClass('w-6', 'flex', 'justify-center', 'items-center', 'extra-class');
    expect(root).toHaveStyle({ height: '1.3125rem' });

    // The image is visible (not hidden) and reflects alt/src; no stub yet.
    const img = getImg(container);
    expect(img).toBeInTheDocument();
    expect(img).not.toHaveClass('hidden');
    expect(img).toHaveAttribute('alt', 'United States');
    expect(img).toHaveAttribute('src', 'https://flags.example/us.svg');
    expect(getStub(container)).toBeNull();
  });

  it('renders the wrapper without a custom className when none is given', () => {
    // Exercises the clsx branch where the optional className is undefined.
    const { container } = render(<Flag alt="Poland" src="pl.svg" />);

    const root = getRoot(container);
    expect(root).toHaveClass('w-6', 'flex', 'justify-center', 'items-center');
    expect(getImg(container)).toBeInTheDocument();
    expect(getStub(container)).toBeNull();
  });

  it('hides the image and shows the stub svg after an image load error', () => {
    const { container } = render(<Flag alt="Broken" src="broken.svg" />);

    const img = getImg(container);
    expect(img).not.toHaveClass('hidden');
    expect(getStub(container)).toBeNull();

    // Fire the <img> onError → handleError sets error state.
    fireEvent.error(img as HTMLImageElement);

    // Image is kept in the tree but hidden; the fallback stub appears alongside.
    const imgAfter = getImg(container);
    expect(imgAfter).toBeInTheDocument();
    expect(imgAfter).toHaveClass('hidden');

    const stub = getStub(container);
    expect(stub).toBeInTheDocument();
    expect(stub).toHaveClass('w-6', 'h-auto');
    expect(stub).toHaveAttribute('role', 'img');

    // The wrapper div is still the root (not replaced by the stub).
    expect(getRoot(container).tagName).toBe('DIV');
  });
});
