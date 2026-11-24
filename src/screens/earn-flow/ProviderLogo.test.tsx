import React from 'react';

import { fireEvent, render } from '@testing-library/react';

import { ProviderLogo } from './ProviderLogo';

// The `?url` asset import resolves through jest's `\.svg\?url$` mapper to the shared file stub, so the
// suite loads the real module and the image carries that stub as its src.

/** The one image the mark draws. */
function imageOf(container: HTMLElement): HTMLImageElement {
  const img = container.querySelector('img');
  if (!img) throw new Error('the mark draws no image');
  return img;
}

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

  it('draws the document logo first, as a lazy CORS image with no referrer', () => {
    const { container } = render(<ProviderLogo protocol="Aave V3" logoUrl="https://config.test/icons/aave.svg" />);

    const images = container.querySelectorAll('img');
    expect(images).toHaveLength(1);
    const [img] = images;
    expect(img).toHaveAttribute('src', 'https://config.test/icons/aave.svg');
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
    // The extension's require-corp embedder policy admits a cross-origin image on its CORS header only.
    expect(img).toHaveAttribute('crossorigin', 'anonymous');
    // An image context, never inline SVG markup.
    expect(container.querySelector('svg')).toBeNull();
  });

  it('falls back to the bundled mark when the document logo fails, and tries a new logo again', () => {
    const { container, rerender } = render(
      <ProviderLogo protocol="Aave V3" logoUrl="https://config.test/icons/aave.svg" />
    );
    fireEvent.error(imageOf(container));
    expect(container.querySelector('img')).toHaveAttribute('src', 'svg-url-stub');

    rerender(<ProviderLogo protocol="Aave V3" logoUrl="https://config.test/icons/aave-v3.png" />);
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://config.test/icons/aave-v3.png');
  });

  it('falls back to the initial when the document logo fails and the app ships no mark', () => {
    const { container } = render(<ProviderLogo protocol="Morpho" logoUrl="https://config.test/icons/morpho.svg" />);
    fireEvent.error(imageOf(container));

    expect(container.querySelector('img')).toBeNull();
    expect(container.firstChild).toHaveTextContent('M');
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
