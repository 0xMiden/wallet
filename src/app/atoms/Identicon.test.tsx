import React from 'react';

import { render } from '@testing-library/react';

import Identicon from './Identicon';

// The real @dicebear/avatars stack (jdenticon / bottts / initials sprites) is
// deterministic and runs fine under jsdom (see
// src/lib/avatars-initials-sprites/index.test.ts), so we exercise it directly
// rather than mocking — that keeps the component + its estimateOptimalFontSize
// helper fully covered.

/** Read the inline background-image url off the rendered root div. */
const bgImage = (el: HTMLElement) => el.style.backgroundImage;

describe('Identicon', () => {
  it('renders a jdenticon avatar with the default size/style and passes rest props', () => {
    const { container } = render(
      <Identicon type="jdenticon" publicKey="alice" data-testid="ident" title="hello" />
    );
    const root = container.firstChild as HTMLElement;

    // rest props flow through
    expect(root).toHaveAttribute('data-testid', 'ident');
    expect(root).toHaveAttribute('title', 'hello');

    // non-initials → gray background + base layout classes
    expect(root).toHaveClass('inline-block', 'bg-gray-100', 'bg-no-repeat', 'bg-center', 'overflow-hidden');
    expect(root).not.toHaveClass('bg-transparent');

    // default size = 100 → 100px box, borderRadius round(100/10)=10px
    expect(root).toHaveStyle({
      width: '100px',
      height: '100px',
      maxWidth: '100px',
      borderRadius: '10px'
    });

    // a base64 svg data-uri background image was generated
    expect(bgImage(root)).toContain('url(');
    expect(bgImage(root)).toContain('data:image');
  });

  it('renders a bottts avatar (non-initials branch)', () => {
    const { container } = render(<Identicon type="bottts" publicKey="bob" />);
    const root = container.firstChild as HTMLElement;

    expect(root).toHaveClass('bg-gray-100');
    expect(root).not.toHaveClass('bg-transparent');
    expect(bgImage(root)).toContain('data:image');
  });

  it('renders an initials avatar with a transparent background (multi-char font-size branch)', () => {
    // publicKey.slice(0,5).length = 5 (> 2) → estimateOptimalFontSize multiplier path
    const { container } = render(<Identicon type="initials" publicKey="ABCDE" />);
    const root = container.firstChild as HTMLElement;

    expect(root).toHaveClass('bg-transparent');
    expect(root).not.toHaveClass('bg-gray-100');
    expect(bgImage(root)).toContain('data:image');
  });

  it('renders an initials avatar with a short key (default font-size branch, length <= 2)', () => {
    // publicKey.slice(0,5).length = 2 (<= 2) → estimateOptimalFontSize returns DEFAULT_FONT_SIZE
    const { container } = render(<Identicon type="initials" publicKey="AB" />);
    const root = container.firstChild as HTMLElement;

    expect(root).toHaveClass('bg-transparent');
    expect(bgImage(root)).toContain('data:image');
  });

  it('honours a custom size for box dimensions and border radius', () => {
    const { container } = render(<Identicon type="jdenticon" publicKey="carol" size={40} />);
    const root = container.firstChild as HTMLElement;

    // borderRadius = round(40/10) = 4px
    expect(root).toHaveStyle({
      width: '40px',
      height: '40px',
      maxWidth: '40px',
      borderRadius: '4px'
    });
  });

  it('merges a custom className and inline style overrides', () => {
    const { container } = render(
      <Identicon
        type="jdenticon"
        publicKey="dave"
        className="my-custom-class"
        style={{ opacity: '0.5' }}
      />
    );
    const root = container.firstChild as HTMLElement;

    expect(root).toHaveClass('my-custom-class');
    expect(root).toHaveStyle({ opacity: '0.5' });
    // size default still applied alongside the custom style
    expect(root).toHaveStyle({ width: '100px' });
  });

  it('falls back to the default type (jdenticon) when type is undefined', () => {
    const { container } = render(
      <Identicon type={undefined as unknown as 'jdenticon'} publicKey="erin" />
    );
    const root = container.firstChild as HTMLElement;

    // default type is not initials → gray background
    expect(root).toHaveClass('bg-gray-100');
    expect(bgImage(root)).toContain('data:image');
  });

  it('reuses the module-level cache for identical type/publicKey/size (cache hit branch)', () => {
    // First render populates the cache (cache.has === false path).
    const first = render(<Identicon type="bottts" publicKey="cache-me" size={64} />);
    const firstBg = bgImage(first.container.firstChild as HTMLElement);
    first.unmount();

    // Second render with the same key hits the cache (cache.has === true path)
    // and must yield the identical background-image string.
    const second = render(<Identicon type="bottts" publicKey="cache-me" size={64} />);
    const secondBg = bgImage(second.container.firstChild as HTMLElement);

    expect(firstBg).toBe(secondBg);
    expect(secondBg).toContain('data:image');
  });
});
