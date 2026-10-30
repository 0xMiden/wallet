import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { NoCodeSheet } from './NoCodeSheet';

const mockOpenExternalUrl = jest.fn().mockResolvedValue(undefined);

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

jest.mock('lib/mobile/external-browser', () => ({
  openExternalUrl: (...args: unknown[]) => mockOpenExternalUrl(...args)
}));

jest.mock('app/constants', () => ({ MAINNET_EARLY_ACCESS_URL: 'https://miden.xyz/bread' }));

// Vaul renders through a portal that jsdom cannot drive. A flat stand-in that renders its children
// only while open is sufficient for the open and close wiring.
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DrawerDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DrawerFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}));

describe('NoCodeSheet', () => {
  it('says Bread is invite-only, and closes on Got it', () => {
    const onOpenChange = jest.fn();
    render(<NoCodeSheet open onOpenChange={onOpenChange} />);

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('noCodeTitle');
    expect(screen.getByText('noCodeBody')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('no-code-sheet-close'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps account recovery on the welcome page', () => {
    render(<NoCodeSheet open onOpenChange={jest.fn()} />);
    expect(screen.queryByTestId('no-code-sheet-recover')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('opens the early-access list without closing the sheet', () => {
    const onOpenChange = jest.fn();
    render(<NoCodeSheet open onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'mainnetCountdownLink' }));

    expect(mockOpenExternalUrl).toHaveBeenCalledWith({
      url: 'https://miden.xyz/bread',
      title: 'mainnetCountdownLink'
    });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('renders nothing while closed', () => {
    const { container } = render(<NoCodeSheet open={false} onOpenChange={jest.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
