import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { NetworkModeBanner } from './NetworkModeBanner';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${params.network}` : key)
  })
}));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

// `isDevnet` is read on every render, so flipping the mocked module's field
// between tests switches the build network without re-importing React (a
// re-import would give the component a second React copy and break its hooks).
jest.mock('utils/brand-colors', () => ({ isDevnet: false }));
const mockBrand: { isDevnet: boolean } = jest.requireMock('utils/brand-colors');

jest.mock('components/Button', () => ({
  Button: ({ title, onClick }: { title: string; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {title}
    </button>
  )
}));

// Vaul renders through a portal with pointer-event bookkeeping jsdom cannot
// drive; a flat stand-in that renders children only while open is enough to
// assert the open/close wiring.
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DrawerDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>
}));

describe('NetworkModeBanner', () => {
  beforeEach(() => {
    mockBrand.isDevnet = false;
  });

  it('names Testnet on a testnet build', () => {
    render(<NetworkModeBanner />);

    expect(screen.getByTestId('network-mode-banner')).toHaveTextContent('networkModeBanner:testnet');
  });

  it('names Devnet on a devnet build', () => {
    mockBrand.isDevnet = true;

    render(<NetworkModeBanner />);

    expect(screen.getByTestId('network-mode-banner')).toHaveTextContent('networkModeBanner:devnet');
  });

  it('opens the explanation sheet on tap and closes it on "I understand"', () => {
    render(<NetworkModeBanner />);
    expect(screen.queryByTestId('network-mode-sheet')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('network-mode-banner'));
    const sheet = screen.getByTestId('network-mode-sheet');
    expect(sheet).toHaveTextContent('networkNoticeResetTitle');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);

    fireEvent.click(screen.getByText('iUnderstand'));
    expect(screen.queryByTestId('network-mode-sheet')).not.toBeInTheDocument();
  });
});
