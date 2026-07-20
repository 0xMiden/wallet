import React from 'react';

import { render } from '@testing-library/react';

// ColorIdenticon renders the real `Avatar` (components/Avatar), whose only
// impure dependency is `useTranslation` from react-i18next. Mirroring sibling
// atom tests (Alert/Logo/CopyButton), we stub the translator so `t('avatar')`
// deterministically returns its key. Everything else is exercised for real:
//   - `randomcolor` is a pure, seeded, deterministic JS dep (same as
//     AnimalIdenticon.test.tsx / Identicon.test.tsx) — mocking it would only
//     hide the one meaningful behaviour (seed → stable colour).
//   - the `image="/misc/avatars/miden-logo.svg"` prop is a plain string literal
//     (NOT an import), so it flows straight through to the <img src> attribute
//     and needs no asset mock.
//
// ColorIdenticon has a single default export, no exported helpers, and no
// rest-prop forwarding, so full coverage only needs: the seeded colour line,
// the default `size`/`className` params, and their explicitly-supplied variants.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}));

import ColorIdenticon from './ColorIdenticon';

const getRoot = (container: HTMLElement) => container.firstChild as HTMLElement;
const getImg = (container: HTMLElement) => container.querySelector('img') as HTMLImageElement;

describe('ColorIdenticon', () => {
  it('renders the Avatar with default size (md) and default className (m-auto)', () => {
    const { container } = render(<ColorIdenticon publicKey="alice" />);
    const root = getRoot(container);

    // Avatar root div: base classes + size(md → w-6 h-6) + default className.
    expect(root).toBeInTheDocument();
    expect(root.tagName.toLowerCase()).toBe('div');
    expect(root).toHaveClass('rounded-[3.21px]', 'overflow-hidden', 'w-6', 'h-6', 'm-auto');

    // seeded background colour is applied inline (jsdom normalises to rgb()).
    expect(root.style.backgroundColor).toBeTruthy();

    // image prop → <img> with the miden logo src and the mocked t('avatar') alt.
    const img = getImg(container);
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', '/misc/avatars/miden-logo.svg');
    expect(img).toHaveAttribute('alt', 'avatar');
  });

  it('applies an explicitly-provided className instead of the m-auto default', () => {
    const { container } = render(<ColorIdenticon publicKey="bob" className="my-extra-class" />);
    const root = getRoot(container);

    expect(root).toHaveClass('my-extra-class');
    // the default is a fallback for a *missing* prop, so it must not appear here.
    expect(root).not.toHaveClass('m-auto');
    // base + default-md size classes still present.
    expect(root).toHaveClass('rounded-[3.21px]', 'overflow-hidden', 'w-6', 'h-6');
  });

  it('maps each supported size token to the Avatar size class', () => {
    const cases: Array<['xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl', string, string]> = [
      ['xs', 'w-4', 'h-4'],
      ['sm', 'w-5', 'h-5'],
      ['md', 'w-6', 'h-6'],
      ['lg', 'w-9', 'h-9'],
      ['xl', 'w-12', 'h-12'],
      ['xxl', 'w-16', 'h-16']
    ];

    for (const [size, wClass, hClass] of cases) {
      const { container, unmount } = render(<ColorIdenticon publicKey="carol" size={size} />);
      expect(getRoot(container)).toHaveClass(wClass, hClass);
      unmount();
    }
  });

  it('is deterministic: the same publicKey yields the same seeded colour', () => {
    const first = render(<ColorIdenticon publicKey="stable-key" />);
    const firstColor = getRoot(first.container).style.backgroundColor;
    expect(firstColor).toBeTruthy();
    first.unmount();

    const second = render(<ColorIdenticon publicKey="stable-key" />);
    expect(getRoot(second.container).style.backgroundColor).toBe(firstColor);
  });

  it('maps different publicKeys to (generally) distinct colours', () => {
    const keys = ['k0', 'k1', 'k2', 'k3', 'k4', 'account-0xabc', 'zzz', 'the-quick-brown-fox'];

    const seen = new Set<string>();
    for (const key of keys) {
      const { container, unmount } = render(<ColorIdenticon publicKey={key} />);
      const color = getRoot(container).style.backgroundColor;
      expect(color).toBeTruthy();
      seen.add(color);
      unmount();
    }

    // guards against an accidental constant colour (seed being ignored).
    expect(seen.size).toBeGreaterThan(1);
  });
});
