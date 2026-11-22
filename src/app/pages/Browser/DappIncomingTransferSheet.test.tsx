import React from 'react';

import { render, screen } from '@testing-library/react';

import { DappIncomingTransferSheet } from './DappIncomingTransferSheet';

const mockUseActivityClaimList = jest.fn();
const mockHideForeground = jest.fn();
jest.mock('app/templates/history/useActivityClaimList', () => ({
  useActivityClaimList: (...args: unknown[]) => mockUseActivityClaimList(...args)
}));
jest.mock('app/providers/DappBrowserProvider', () => ({
  useHideForegroundDappWhileOpen: (open: boolean) => mockHideForeground(open)
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockUseActivityClaimList.mockReturnValue({ representedItems: [], renderPendingItem: jest.fn() });
});

describe('DappIncomingTransferSheet', () => {
  it('uses pending review claims and holds the foreground dApp until dismissed', () => {
    render(<DappIncomingTransferSheet onClose={jest.fn()} />);

    expect(mockUseActivityClaimList).toHaveBeenCalledWith('', 'pending');
    expect(mockHideForeground).toHaveBeenCalledWith(true);
    expect(screen.getByRole('heading', { name: 'noteReceivedTitle' })).toBeInTheDocument();
    expect(screen.getByText('noOperationsFound')).toBeInTheDocument();
  });
});
