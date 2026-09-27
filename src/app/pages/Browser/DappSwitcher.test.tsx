import React from 'react';

import { render, screen } from '@testing-library/react';

import { DappSwitcher } from './DappSwitcher';

const mockSessionStates = [
  {
    session: {
      id: 'session-1',
      url: 'https://app.example/',
      origin: 'https://app.example',
      title: 'Example',
      favicon: null,
      status: 'active',
      openedAt: 0
    },
    instance: null,
    status: 'active',
    origin: 'https://app.example',
    originConfirmed: true,
    isLoading: false,
    isCold: false,
    error: null
  }
];

jest.mock('app/providers/DappBrowserProvider', () => ({
  useDappBrowser: () => ({ sessionStates: mockSessionStates, restore: jest.fn(), close: jest.fn() })
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/dapp-browser/snapshot-store', () => ({ getSnapshot: () => undefined }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticMedium: jest.fn() }));

describe('DappSwitcher', () => {
  // A card is scaled by its `layout` animation when the grid's width changes (a rotation, split
  // view). Framer counter-scales a radius or shadow only when it reads them from style, not from a class.
  it("keeps the card's radius and shadow where the layout animation can correct them", () => {
    render(<DappSwitcher open onClose={jest.fn()} />);

    const card = screen.getByRole('listitem');
    expect(card).toHaveStyle({ borderRadius: '16px', boxShadow: '0 16px 48px rgba(0,0,0,0.4)' });
    expect(card.className).not.toMatch(/rounded-2xl|shadow-\[/);
  });
});
