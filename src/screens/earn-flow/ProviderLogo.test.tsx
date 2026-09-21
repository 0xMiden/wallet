import React from 'react';

import { render } from '@testing-library/react';

import { ProviderLogo } from './ProviderLogo';

// `ProviderLogo.tsx` imports the Aave logo as `...aave.svg?url`. The `?url` query suffix means it
// does NOT match the `\.svg$` asset mapper (which anchors on a trailing `.svg`), and the `^app/`
// path mapper would point at a non-existent `aave.svg?url` file. A virtual mock short-circuits
// resolution and gives the import a distinct, assertable value (mirrors `Logo.test.tsx`).
jest.mock('app/icons/earn-provider-logos/aave.svg?url', () => 'aave-logo-url-stub', { virtual: true });

describe('ProviderLogo', () => {
  it('renders the Aave image branch with the stubbed logo url and empty alt', () => {
    const { container } = render(<ProviderLogo protocol="Aave" className="logo-class" />);

    const img = container.querySelector('img') as HTMLImageElement;
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', 'aave-logo-url-stub');
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
