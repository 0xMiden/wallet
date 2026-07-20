import React from 'react';

import { render } from '@testing-library/react';

import HashShortView from './HashShortView';

// HashShortView is a self-contained presentational atom with no external
// dependencies: given a `hash` string it renders either the full string, a
// provided `displayName`, or a trimmed "first…last" form depending on its
// flags. We exercise every branch end-to-end under jsdom.

describe('HashShortView', () => {
  it('returns null when hash is an empty string', () => {
    // The `!hash` early-return branch: nothing is rendered.
    const { container } = render(<HashShortView hash="" />);

    expect(container).toBeEmptyDOMElement();
  });

  it('returns null when hash is falsy (undefined)', () => {
    // Same early-return branch via an undefined hash value.
    const { container } = render(<HashShortView hash={undefined as unknown as string} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders displayName verbatim when provided, ignoring the hash', () => {
    // The `displayName` branch short-circuits all trimming logic.
    const longHash = '0x' + 'a'.repeat(40);
    const { container } = render(<HashShortView hash={longHash} displayName="My Wallet" />);

    expect(container).toHaveTextContent('My Wallet');
    // The raw hash must not leak through, and no ellipsis span is rendered.
    expect(container).not.toHaveTextContent(longHash);
    expect(container.querySelector('span.opacity-75')).toBeNull();
  });

  it('renders displayName even when trimHash is false', () => {
    // displayName takes precedence over the `!trimHash` branch too.
    const { container } = render(
      <HashShortView hash="0xdeadbeefdeadbeefdeadbeef" trimHash={false} displayName="Named" />
    );

    expect(container).toHaveTextContent('Named');
    expect(container).not.toHaveTextContent('0xdeadbeef');
  });

  it('renders the full hash untrimmed when trimHash is false', () => {
    // The `!trimHash` branch returns the raw hash even when it is long.
    const longHash = '0x' + 'b'.repeat(60);
    const { container } = render(<HashShortView hash={longHash} trimHash={false} />);

    expect(container).toHaveTextContent(longHash);
    expect(container.querySelector('span.opacity-75')).toBeNull();
  });

  it('renders the full hash when its length is not greater than trimAfter (default 20)', () => {
    // The `ln > trimAfter` condition is false → the hash is returned as-is.
    // Exactly 20 chars is the boundary (20 > 20 is false).
    const hash = '01234567890123456789'; // length 20
    expect(hash).toHaveLength(20);

    const { container } = render(<HashShortView hash={hash} />);

    expect(container).toHaveTextContent(hash);
    expect(container.querySelector('span.opacity-75')).toBeNull();
  });

  it('trims a hash longer than trimAfter using the default first/last char counts', () => {
    // The `ln > trimAfter` branch: keep first 7 chars, an opacity-75 "..." span,
    // and the last 4 chars.
    const hash = 'abcdefghijklmnopqrstuvwxyz012345'; // length 32 > 20
    const { container } = render(<HashShortView hash={hash} />);

    const first = hash.slice(0, 7); // 'abcdefg'
    const last = hash.slice(hash.length - 4); // '2345'

    const ellipsis = container.querySelector('span.opacity-75');
    expect(ellipsis).toBeInTheDocument();
    expect(ellipsis).toHaveTextContent('...');

    expect(container).toHaveTextContent(`${first}...${last}`);
    // The middle of the hash is dropped.
    expect(container).not.toHaveTextContent('hijklmnopqrstuvwxyz');
  });

  it('respects a custom trimAfter threshold that forces trimming', () => {
    // A short-ish hash (length 12) is longer than a custom trimAfter of 5,
    // so it gets trimmed even though the default (20) would not have.
    const hash = 'hello-world!'; // length 12
    const { container } = render(<HashShortView hash={hash} trimAfter={5} />);

    expect(container.querySelector('span.opacity-75')).toBeInTheDocument();
    expect(container).toHaveTextContent(`${hash.slice(0, 7)}...${hash.slice(hash.length - 4)}`);
  });

  it('respects a custom trimAfter threshold that suppresses trimming', () => {
    // Raising trimAfter above the hash length keeps the full string.
    const hash = 'abcdefghijklmnopqrstuvwxyz'; // length 26
    const { container } = render(<HashShortView hash={hash} trimAfter={100} />);

    expect(container).toHaveTextContent(hash);
    expect(container.querySelector('span.opacity-75')).toBeNull();
  });

  it('honors custom firstCharsCount and lastCharsCount', () => {
    // Overriding both counts changes how many chars survive on each side.
    const hash = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'; // length 36 > 20
    const { container } = render(<HashShortView hash={hash} firstCharsCount={3} lastCharsCount={2} />);

    const first = hash.slice(0, 3); // '012'
    const last = hash.slice(hash.length - 2); // 'YZ'

    expect(container).toHaveTextContent(`${first}...${last}`);
    // The default 7/4 slices should NOT be what is shown.
    expect(container).not.toHaveTextContent(`${hash.slice(0, 7)}...${hash.slice(hash.length - 4)}`);
  });

  it('memoizes: re-rendering with identical props preserves the output', () => {
    // React.memo wraps the component; a re-render with the same props yields
    // the same visible text (exercises the memo() default export path).
    const hash = 'ffeeddccbbaa99887766554433221100'; // length 32
    const { container, rerender } = render(<HashShortView hash={hash} />);

    const firstText = container.textContent;
    rerender(<HashShortView hash={hash} />);

    expect(container.textContent).toBe(firstText);
    expect(container.querySelector('span.opacity-75')).toBeInTheDocument();
  });
});
