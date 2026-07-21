import React from 'react';

import { render, screen } from '@testing-library/react';

import { PRIVACY_POLICY_URL, TERMS_OF_USE_URL } from 'app/constants';

import About from './About';
import pkg from '../../../package.json';

// `t(key)` is never `init()`-ed in the unit env; echo the key back so labels
// are directly assertable. `versionLabel` is called with an interpolation
// object — surface the `version` value so we can assert `pkg.version` flows
// through the translation call.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { version?: string }) => (opts?.version !== undefined ? `${key}:${opts.version}` : key)
  })
}));

// `Logo` pulls in png / `svg?url` asset imports; stub it to a marker element so
// About's own JSX is what's under test (and the `style` prop it forwards is
// observable).
jest.mock('app/atoms/Logo', () => ({
  __esModule: true,
  default: ({ style }: { style?: React.CSSProperties }) => (
    <div data-testid="logo" data-style={JSON.stringify(style ?? {})} />
  )
}));

// The real `MenuItem` drags in woozie + icon SVGs; replace it with an anchor
// that echoes every prop About sets so each of the four rows is assertable.
jest.mock('./MenuItem', () => ({
  __esModule: true,
  default: ({
    slug,
    titleI18nKey,
    testID,
    linksOutsideOfWallet
  }: {
    slug?: string;
    titleI18nKey: string;
    testID: string;
    linksOutsideOfWallet: boolean;
  }) => (
    <a
      href={slug}
      data-testid={`menu-item-${titleI18nKey}`}
      data-slug={slug}
      data-title-key={titleI18nKey}
      data-test-id-prop={testID}
      data-links-outside={String(linksOutsideOfWallet)}
    >
      {titleI18nKey}
    </a>
  )
}));

describe('About', () => {
  it('renders the Logo with the forwarded height/filter style', () => {
    render(<About />);

    const logo = screen.getByTestId('logo');
    expect(logo).toBeInTheDocument();
    expect(JSON.parse(logo.getAttribute('data-style')!)).toEqual({ height: 60, filter: '' });
  });

  it('renders the app name heading and the interpolated version label', () => {
    render(<About />);

    expect(screen.getByRole('heading', { level: 4 })).toHaveTextContent('appName');
    // `versionLabel` is invoked with `{ version: pkg.version }`.
    expect(screen.getByText(`versionLabel:${pkg.version}`)).toBeInTheDocument();
  });

  it('renders exactly four external MenuItem rows in order with the expected slugs and keys', () => {
    const { container } = render(<About />);

    const items = container.querySelectorAll('a[data-title-key]');
    expect(items).toHaveLength(4);

    const expected = [
      { key: 'website', link: 'https://miden.xyz' },
      { key: 'twitter', link: 'https://x.com/0xMiden' },
      { key: 'privacyPolicy', link: PRIVACY_POLICY_URL },
      { key: 'termsOfUse', link: TERMS_OF_USE_URL }
    ];

    expected.forEach(({ key, link }, index) => {
      const item = items[index] as HTMLElement;
      expect(item.getAttribute('data-title-key')).toBe(key);
      expect(item.getAttribute('data-slug')).toBe(link);
      // Every row is an out-of-wallet link with an empty testID.
      expect(item.getAttribute('data-links-outside')).toBe('true');
      expect(item.getAttribute('data-test-id-prop')).toBe('');
    });
  });
});
