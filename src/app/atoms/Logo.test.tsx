import React from 'react';

import { render } from '@testing-library/react';

import Logo from './Logo';

// Mock react-i18next so `t('appName')` deterministically returns the key,
// matching the pattern used by sibling atom tests (e.g. Alert.test.tsx).
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}));

// The title logo is a PNG. The jest `\.(png|...)$` moduleNameMapper resolves it
// to the shared file stub ('test-file-stub'), so no explicit mock is needed —
// but we assert against that value below.
//
// The plain logo is imported as `app/misc/logo.svg?url`. The `?url` query
// suffix means it does NOT match the `\.svg$` asset mapper (which anchors on a
// trailing `.svg`), and the `^app/` path mapper would point at a non-existent
// `logo.svg?url` file. A virtual mock short-circuits resolution and gives the
// import a distinct, assertable value so we can tell the two branches apart.
jest.mock('app/misc/logo.svg?url', () => 'plain-logo-url-stub', { virtual: true });

const getImg = (container: HTMLElement) => container.querySelector('img') as HTMLImageElement;

describe('Logo', () => {
  it('renders the plain logo by default (no hasTitle, no white, no style)', () => {
    const { container } = render(<Logo />);

    const img = getImg(container);
    expect(img).toBeInTheDocument();
    // hasTitle falsy → PlainLogo (the virtual svg?url stub).
    expect(img).toHaveAttribute('src', 'plain-logo-url-stub');
    // t('appName') → 'appName' via the mocked translator.
    expect(img).toHaveAttribute('title', 'appName');
    expect(img).toHaveAttribute('alt', 'appName');
  });

  it('applies the fixed base styles and no white filter by default', () => {
    const { container } = render(<Logo />);
    const img = getImg(container);

    expect(img).toHaveStyle({
      height: '40px',
      width: 'auto',
      marginTop: '6px',
      marginBottom: '6px'
    });
    // white falsy → filter branch resolves to '' (empty), i.e. not applied.
    expect(img.style.filter).toBe('');
  });

  it('renders the title logo when hasTitle is true', () => {
    const { container } = render(<Logo hasTitle />);
    const img = getImg(container);

    // hasTitle truthy → LogoTitle (the PNG file stub).
    expect(img).toHaveAttribute('src', 'test-file-stub');
  });

  it('applies the white brightness/invert filter when white is true', () => {
    const { container } = render(<Logo white />);
    const img = getImg(container);

    expect(img.style.filter).toBe('brightness(0) invert(1)');
  });

  it('merges a custom style prop over the base styles', () => {
    const { container } = render(<Logo style={{ height: 80, opacity: 0.5 }} />);
    const img = getImg(container);

    // The provided style overrides the default height and adds new properties,
    // while untouched base styles remain.
    expect(img).toHaveStyle({
      height: '80px',
      opacity: '0.5',
      marginTop: '6px',
      marginBottom: '6px'
    });
  });

  it('spreads additional HTML attributes onto the img via {...rest}', () => {
    const { container } = render(<Logo data-testid="brand-logo" className="extra-class" id="the-logo" />);
    const img = getImg(container);

    expect(img).toHaveAttribute('data-testid', 'brand-logo');
    expect(img).toHaveClass('extra-class');
    expect(img).toHaveAttribute('id', 'the-logo');
  });

  it('combines hasTitle and white together (both truthy branches at once)', () => {
    const { container } = render(<Logo hasTitle white style={{ marginTop: 12 }} />);
    const img = getImg(container);

    expect(img).toHaveAttribute('src', 'test-file-stub');
    expect(img.style.filter).toBe('brightness(0) invert(1)');
    expect(img).toHaveStyle({ marginTop: '12px' });
  });
});
