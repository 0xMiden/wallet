import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import type { FeaturedDapp } from 'lib/dapp-browser';
import { hapticLight } from 'lib/mobile/haptics';

import { AppsGrid } from './AppsGrid';

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

const mockDapps: FeaturedDapp[] = [
  {
    id: 'with-icon',
    name: 'Faucet',
    url: 'https://faucet.example',
    icon: 'faucet.png',
    shortDescription: 'Mint test tokens',
    genre: 'Tools',
    brandColor: '#123456',
    category: 'tools'
  },
  {
    id: 'no-icon',
    name: 'Lender',
    url: 'https://lender.example',
    icon: '',
    shortDescription: 'Borrow and lend',
    brandColor: '#654321',
    category: 'defi'
  }
];

jest.mock('lib/dapp-browser', () => ({ getExploreGridDapps: () => mockDapps }));

const hasBorderClass = (el: HTMLElement) => el.className.split(/\s+/).some(c => /^border(-|$)/.test(c));

beforeEach(() => {
  jest.clearAllMocks();
});

it('renders each app on the shared fill card, with no border', () => {
  render(<AppsGrid onOpen={jest.fn()} />);

  const cards = screen.getAllByTestId('dapp-grid-card');
  expect(cards).toHaveLength(2);
  cards.forEach(card => {
    expect(card.tagName).toBe('BUTTON');
    expect(card).toHaveClass('bg-fill', 'rounded-2xl', 'p-4', 'active:bg-fill-pressed');
    expect(card).not.toHaveClass('bg-white');
    expect(hasBorderClass(card)).toBe(false);
  });
  expect(cards.map(card => card.getAttribute('data-dapp-url'))).toEqual([
    'https://faucet.example',
    'https://lender.example'
  ]);
});

it('puts an app icon on page so it stays visible on the card fill, and a fallback on the brand color', () => {
  render(<AppsGrid onOpen={jest.fn()} />);

  const [withIcon, noIcon] = screen.getAllByTestId('dapp-grid-card');
  const iconTile = withIcon?.querySelector('[aria-hidden="true"]');
  expect(iconTile).toHaveClass('bg-page');
  expect(iconTile).not.toHaveAttribute('style');

  const fallbackTile = noIcon?.querySelector('[aria-hidden="true"]');
  expect(fallbackTile).not.toHaveClass('bg-page');
  expect(fallbackTile).toHaveStyle({ background: '#654321' });
});

it('opens the app with one tap haptic', () => {
  const onOpen = jest.fn();
  render(<AppsGrid onOpen={onOpen} />);

  fireEvent.click(screen.getByRole('button', { name: 'Faucet' }));
  expect(hapticLight).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledWith('https://faucet.example');
});
