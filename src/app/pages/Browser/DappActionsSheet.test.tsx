import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { DappActionsSheet } from './DappActionsSheet';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/ui/drawer', () => ({
  Drawer: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>
}));

jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
  IconName: { Copy: 'Copy', AddCircle: 'AddCircle', CheckboxCircleFill: 'CheckboxCircleFill', Refresh: 'Refresh' }
}));

const mockHapticLight = jest.fn();
jest.mock('lib/mobile/haptics', () => ({ hapticLight: (...args: unknown[]) => mockHapticLight(...args) }));

const mockClipboardWrite = jest.fn();
jest.mock('@capacitor/clipboard', () => ({
  Clipboard: { write: (...args: unknown[]) => mockClipboardWrite(...args) }
}));

const mockGetRecentDapps = jest.fn();
const mockForgetRecentDapp = jest.fn();
const mockRecordRecentDapp = jest.fn();
jest.mock('lib/dapp-browser', () => ({
  getDappDisplayName: (session: { origin: string }) => session.origin,
  getRecentDapps: (...args: unknown[]) => mockGetRecentDapps(...args),
  forgetRecentDapp: (...args: unknown[]) => mockForgetRecentDapp(...args),
  recordRecentDapp: (...args: unknown[]) => mockRecordRecentDapp(...args)
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only stand-in for the mocked module's DappSession
const SESSION: any = { url: 'https://example.dapp/app', origin: 'https://example.dapp' };

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecentDapps.mockResolvedValue([]);
  mockClipboardWrite.mockResolvedValue(undefined);
  mockForgetRecentDapp.mockResolvedValue(undefined);
  mockRecordRecentDapp.mockResolvedValue(undefined);
});

describe('DappActionsSheet', () => {
  it('copies the session url to the clipboard, fires the tap haptic, and closes', async () => {
    const onOpenChange = jest.fn();

    await act(async () => {
      render(<DappActionsSheet session={SESSION} open onOpenChange={onOpenChange} onReopen={jest.fn()} />);
    });

    await act(async () => {
      fireEvent.click(screen.getByText('dappActionCopyLink'));
    });

    expect(mockClipboardWrite).toHaveBeenCalledWith({ string: SESSION.url });
    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes even when the clipboard write rejects, so the sheet is never left stranded', async () => {
    mockClipboardWrite.mockRejectedValue(new Error('denied'));
    const onOpenChange = jest.fn();

    await act(async () => {
      render(<DappActionsSheet session={SESSION} open onOpenChange={onOpenChange} onReopen={jest.fn()} />);
    });

    await act(async () => {
      fireEvent.click(screen.getByText('dappActionCopyLink'));
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('adds the open dApp to My dApps', async () => {
    await act(async () => {
      render(<DappActionsSheet session={SESSION} open onOpenChange={jest.fn()} onReopen={jest.fn()} />);
    });

    await act(async () => {
      fireEvent.click(screen.getByText('dappActionAddToMyDapps'));
    });

    expect(mockRecordRecentDapp).toHaveBeenCalledWith(expect.objectContaining({ url: SESSION.url }));
  });

  // My dApps is a list of dApps. A web search the launcher produced is a page, not one - and this is
  // the SECOND writer of that store, so the rule has to hold here as well as in BrowserScreen.
  it('never adds a web search to My dApps', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only stand-in, as above
    const search: any = { url: 'https://duckduckgo.com/?q=nft%20games', origin: 'https://duckduckgo.com' };
    await act(async () => {
      render(<DappActionsSheet session={search} open onOpenChange={jest.fn()} onReopen={jest.fn()} />);
    });

    await act(async () => {
      fireEvent.click(screen.getByText('dappActionAddToMyDapps'));
    });

    expect(mockRecordRecentDapp).not.toHaveBeenCalled();
  });

  it('does nothing when tapped with no active session', async () => {
    const onOpenChange = jest.fn();

    await act(async () => {
      render(<DappActionsSheet session={null} open onOpenChange={onOpenChange} onReopen={jest.fn()} />);
    });

    fireEvent.click(screen.getByText('dappActionCopyLink'));

    expect(mockClipboardWrite).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('renders nothing when closed', async () => {
    await act(async () => {
      render(<DappActionsSheet session={SESSION} open={false} onOpenChange={jest.fn()} onReopen={jest.fn()} />);
    });

    expect(screen.queryByText('dappActionCopyLink')).not.toBeInTheDocument();
  });
});
