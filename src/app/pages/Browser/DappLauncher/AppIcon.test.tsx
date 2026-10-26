import React from 'react';

import { fireEvent, render } from '@testing-library/react';

import { tintForAddress } from 'components/contacts/ContactAvatar';

import { AppIcon, appInitial, appTint } from './AppIcon';

const slot = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-slot="app-icon"]');

describe('appTint', () => {
  it('is stable per host, whatever the path or trailing slash', () => {
    expect(appTint('https://faucet.testnet.miden.io/')).toBe(appTint('https://faucet.testnet.miden.io'));
    expect(appTint('https://www.faucet.testnet.miden.io/mint')).toBe(appTint('https://faucet.testnet.miden.io'));
    expect(appTint('https://faucet.testnet.miden.io/')).toBe(tintForAddress('faucet.testnet.miden.io'));
  });

  it('gives the two faucets different tints from the contact avatar palette', () => {
    expect(appTint('https://faucet.testnet.miden.io/')).toBe('#D9885A');
    expect(appTint('https://faucets.forkchoice.xyz/')).toBe('#7E7E96');
  });

  it('hashes a string that is not a URL as given', () => {
    expect(appTint('not a url')).toBe(tintForAddress('not a url'));
  });
});

describe('appInitial', () => {
  it('uses the name, or the host when there is none', () => {
    expect(appInitial('faucet', 'https://x.example')).toBe('F');
    expect(appInitial('  ', 'https://www.zoro.example')).toBe('Z');
  });
});

describe('AppIcon', () => {
  it('draws the initial on the url tint without an icon, the same color on every render', () => {
    const first = render(<AppIcon url="https://faucets.forkchoice.xyz/" name="Forkchoice" />);
    const second = render(<AppIcon url="https://faucets.forkchoice.xyz/" name="Forkchoice" />);
    const [a, b] = [slot(first.container), slot(second.container)];
    expect(a).toHaveAttribute('data-letter', 'true');
    expect(a).toHaveTextContent('F');
    expect(a).toHaveStyle({ backgroundColor: '#7E7E96' });
    expect(b?.style.backgroundColor).toBe(a?.style.backgroundColor);
  });

  it('puts an image on the surface opposite to the one it sits on', () => {
    const onFill = render(<AppIcon url="https://a.example" name="A" icon="a.png" surface="fill" />);
    expect(slot(onFill.container)).toHaveClass('bg-page', 'rounded-xl');
    const onPage = render(<AppIcon url="https://a.example" name="A" icon="a.png" surface="page" />);
    expect(slot(onPage.container)).toHaveClass('bg-fill');
  });

  it('falls back to the initial when the image fails to load', () => {
    const { container } = render(<AppIcon url="https://a.example" name="Apple" icon="broken.png" />);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    if (img) fireEvent.error(img);
    expect(slot(container)).toHaveAttribute('data-letter', 'true');
    expect(slot(container)).toHaveTextContent('A');
  });
});
