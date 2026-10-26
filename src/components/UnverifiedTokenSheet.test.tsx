import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { UnverifiedTokenSheet } from './UnverifiedTokenSheet';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

const mockHideForegroundDapp = jest.fn();
jest.mock('app/providers/DappBrowserProvider', () => ({
  useHideForegroundDappWhileOpen: (open: boolean) => mockHideForegroundDapp(open)
}));

// Vaul renders through a portal jsdom cannot drive; a flat stand-in that renders children only while
// open is enough for the open/close wiring.
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DrawerDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DrawerFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}));

describe('UnverifiedTokenSheet', () => {
  beforeEach(() => mockHideForegroundDapp.mockClear());

  it('renders nothing while closed', () => {
    render(<UnverifiedTokenSheet open={false} onOpenChange={jest.fn()} />);

    expect(screen.queryByTestId('unverified-token-sheet')).not.toBeInTheDocument();
    expect(mockHideForegroundDapp).toHaveBeenCalledWith(false);
  });

  it('says why the token is unverified and closes on I understand', () => {
    const onOpenChange = jest.fn();
    render(<UnverifiedTokenSheet open onOpenChange={onOpenChange} />);

    expect(screen.getByRole('heading')).toHaveTextContent('unverifiedTokenTitle');
    expect(screen.getByText('unverifiedTokenDescription')).toBeInTheDocument();
    expect(mockHideForegroundDapp).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByTestId('unverified-token-sheet-cta'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
