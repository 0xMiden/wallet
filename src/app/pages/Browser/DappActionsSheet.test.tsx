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
  // A web search cannot become a recent dApp, so the add action is not offered rather than offered
  // and silently refused: tapping it fired the confirmation haptic and closed the sheet while saving
  // nothing. Remove stays offered, because it can still act.
  it('offers no add action for a web search, and still offers copy and reopen', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only stand-in, as above
    const search: any = { url: 'https://duckduckgo.com/?q=nft%20games', origin: 'https://duckduckgo.com' };
    await act(async () => {
      render(<DappActionsSheet session={search} open onOpenChange={jest.fn()} onReopen={jest.fn()} />);
    });

    expect(screen.queryByText('dappActionAddToMyDapps')).toBeNull();
    expect(screen.queryByText('dappActionRemoveFromMyDapps')).toBeNull();
    expect(screen.getByText('dappActionCopyLink')).not.toBeNull();
    expect(screen.getByText('dappActionReopen')).not.toBeNull();
    expect(mockHapticLight).not.toHaveBeenCalled();
    expect(mockRecordRecentDapp).not.toHaveBeenCalled();
  });

  // This sheet is the only caller of `forgetRecentDapp`, so a search URL persisted by a build from
  // before that rule existed would be unremovable if the whole control were hidden.
  it('still offers remove for a web search that is already in My dApps', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only stand-in, as above
    const search: any = { url: 'https://duckduckgo.com/?q=nft%20games', origin: 'https://duckduckgo.com' };
    mockGetRecentDapps.mockResolvedValueOnce([{ url: search.url, name: 'nft games', origin: search.origin }]);
    await act(async () => {
      render(<DappActionsSheet session={search} open onOpenChange={jest.fn()} onReopen={jest.fn()} />);
    });

    await act(async () => {
      fireEvent.click(screen.getByText('dappActionRemoveFromMyDapps'));
    });

    expect(mockForgetRecentDapp).toHaveBeenCalledWith(search.url);
    expect(mockRecordRecentDapp).not.toHaveBeenCalled();
  });

  // G8p-08: the fifth combination had no visibility assertion of its own.
  it('offers remove for a plain dApp already in My dApps', async () => {
    mockGetRecentDapps.mockResolvedValueOnce([{ url: SESSION.url, name: 'Example', origin: SESSION.origin }]);
    await act(async () => {
      render(<DappActionsSheet session={SESSION} open onOpenChange={jest.fn()} onReopen={jest.fn()} />);
    });

    expect(screen.getByText('dappActionRemoveFromMyDapps')).not.toBeNull();
    expect(screen.queryByText('dappActionAddToMyDapps')).toBeNull();
  });

  // The membership answer belongs to the session it was read for. Before it was keyed, a resolved
  // `true` from one session was still on screen for the next one, so a web search inherited
  // "Remove" - and a tap there fired the haptic, closed the sheet and deleted nothing.
  it("does not carry one session's My-dApps answer over to the next", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only stand-in, as above
    const searchA: any = { url: 'https://duckduckgo.com/?q=alpha', origin: 'https://duckduckgo.com' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only stand-in, as above
    const searchB: any = { url: 'https://duckduckgo.com/?q=beta', origin: 'https://duckduckgo.com' };

    mockGetRecentDapps.mockResolvedValueOnce([{ url: searchA.url, name: 'alpha', origin: searchA.origin }]);
    const { rerender } = render(
      <DappActionsSheet session={searchA} open onOpenChange={jest.fn()} onReopen={jest.fn()} />
    );
    await act(async () => {});
    expect(screen.getByText('dappActionRemoveFromMyDapps')).not.toBeNull();

    // The read for B never settles, so only the keying can answer "unknown" rather than "in store".
    mockGetRecentDapps.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => {
      rerender(<DappActionsSheet session={searchB} open onOpenChange={jest.fn()} onReopen={jest.fn()} />);
    });

    expect(screen.queryByText('dappActionRemoveFromMyDapps')).toBeNull();
    expect(screen.queryByText('dappActionAddToMyDapps')).toBeNull();
  });

  it('does nothing when tapped with no active session', async () => {
    const onOpenChange = jest.fn();

    await act(async () => {
      render(<DappActionsSheet session={null} open onOpenChange={onOpenChange} onReopen={jest.fn()} />);
    });

    // The row is unchanged without a session: all three actions render and each no-ops on tap.
    expect(screen.getByText('dappActionAddToMyDapps')).not.toBeNull();
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
