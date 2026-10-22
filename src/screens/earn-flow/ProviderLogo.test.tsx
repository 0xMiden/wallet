import React from 'react';

import { render } from '@testing-library/react';

import { ProviderLogo } from './ProviderLogo';

// The `?url` asset import resolves through jest's `\.svg\?url$` mapper to the shared file stub, so the
// suite loads the real module and the image carries that stub as its src.

describe('ProviderLogo', () => {
  it('renders the Aave image branch with the mapped logo url and empty alt', () => {
    const { container } = render(<ProviderLogo protocol="Aave" className="logo-class" />);

    const img = container.querySelector('img') as HTMLImageElement;
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', 'svg-url-stub');
    expect(img).toHaveAttribute('alt', '');

    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper).toHaveClass('logo-class');
    expect(wrapper).toHaveAttribute('aria-hidden', 'true');
  });

  it('draws the Aave logo for a versioned Aave name, and not for a name that only starts with the letters', () => {
    const { container, unmount } = render(<ProviderLogo protocol="Aave V3" />);
    expect(container.querySelector('img')).toHaveAttribute('src', 'svg-url-stub');
    unmount();

    const other = render(<ProviderLogo protocol="Aavex" />);
    expect(other.container.querySelector('img')).toBeNull();
    expect(other.container.firstChild).toHaveTextContent('A');
  });

  it('renders the first character fallback for a non-Aave protocol', () => {
    const { container } = render(<ProviderLogo protocol="Compound" />);

    expect(container.querySelector('img')).toBeNull();
    // protocol.charAt(0) → 'C'
    expect(container.firstChild).toHaveTextContent('C');
    // In ink, not inherited: inside a CardButton the initial would take the button's UA text colour,
    // black on the dark theme's card.
    expect(container.firstChild).toHaveClass('text-ink');
  });
});
