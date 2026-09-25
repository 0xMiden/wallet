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
    expect(img).toHaveAttribute('src', 'test-file-stub');
    expect(img).toHaveAttribute('alt', '');

    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper).toHaveClass('logo-class');
    expect(wrapper).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders the first character fallback for a non-Aave protocol', () => {
    const { container } = render(<ProviderLogo protocol="Compound" />);

    expect(container.querySelector('img')).toBeNull();
    // protocol.charAt(0) → 'C'
    expect(container.firstChild).toHaveTextContent('C');
  });
});
