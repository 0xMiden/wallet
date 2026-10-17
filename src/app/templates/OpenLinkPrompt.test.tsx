/* eslint-disable import/first */
import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { host?: string }) => (params?.host ? `${key}:${params.host}` : key)
  })
}));

const mockAddListener = jest.fn();
jest.mock('@capacitor/app', () => ({
  App: {
    addListener: (...args: unknown[]) => mockAddListener(...args),
    getLaunchUrl: () => Promise.resolve(undefined)
  }
}));

const mockOpen = jest.fn();
const mockHideForegroundDapp = jest.fn();
jest.mock('app/providers/DappBrowserProvider', () => ({
  useDappBrowser: () => ({ open: mockOpen }),
  useHideForegroundDappWhileOpen: (open: boolean) => mockHideForegroundDapp(open)
}));

jest.mock('lib/dapp-browser', () => ({
  createDappSession: (url: string) => ({ id: `session:${url}`, url }),
  parseOrigin: (url: string) => new URL(url).origin
}));

const mockRecordOpenedDapp = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
jest.mock('app/pages/Browser/record-opened-dapp', () => ({
  recordOpenedDapp: (url: string) => mockRecordOpenedDapp(url)
}));

let mockWallet = { locked: false, ready: true, hydrated: true };
jest.mock('lib/miden/front', () => ({ useMidenContext: () => mockWallet }));

let mockFinishingOnboarding = false;
jest.mock('app/onboarding-finish', () => ({ useOnboardingFinishing: () => mockFinishingOnboarding }));

let mockStore: { currentAccount: { requiresHotKeyRotation: boolean } | null } = {
  currentAccount: { requiresHotKeyRotation: false }
};
jest.mock('lib/store', () => ({
  useWalletStore: (select: (state: typeof mockStore) => unknown) => select(mockStore)
}));

let mockCatalog: ExploreCatalog | null | undefined;
const mockUseExploreCatalog = jest.fn();
jest.mock('lib/explore-config/use-explore-catalog', () => ({
  useExploreCatalog: (load?: boolean) => {
    mockUseExploreCatalog(load);
    return mockCatalog;
  }
}));

const mockNavigate = jest.fn();
let mockPathname = '/';
jest.mock('lib/woozie', () => ({
  navigate: (to: string) => mockNavigate(to),
  useLocation: () => ({ pathname: mockPathname })
}));

jest.mock('components/ui/AlertSheet', () => ({
  AlertSheet: ({
    open,
    title,
    children,
    actionLabel,
    onAction,
    onCancel,
    cancelLabel
  }: {
    open: boolean;
    title: React.ReactNode;
    children: React.ReactNode;
    actionLabel: React.ReactNode;
    onAction: () => void;
    onCancel: () => void;
    cancelLabel: React.ReactNode;
  }) =>
    open ? (
      <div role="alertdialog">
        <h2>{title}</h2>
        <p>{children}</p>
        <button onClick={onAction}>{actionLabel}</button>
        <button onClick={onCancel}>{cancelLabel}</button>
      </div>
    ) : null
}));

import {
  __resetOpenLinksForTest,
  acceptOpenLink,
  getPendingOpenLink,
  OPEN_LINK_HOST
} from 'lib/dapp-browser/open-link';
import type { ExploreCatalog } from 'lib/explore-config/schema';

import { OpenLinkPrompt } from './OpenLinkPrompt';

const LISTED_PAGE = 'https://swap.example/trade?pair=MIDEN-USDC';
const UNLISTED_PAGE = 'https://unknown.example/claim';

const catalog: ExploreCatalog = {
  network: 'testnet',
  version: 1,
  items: [{ url: 'https://swap.example/' } as ExploreCatalog['items'][number]],
  sections: []
};

function deliver(page: string): void {
  act(() => acceptOpenLink(`https://${OPEN_LINK_HOST}/open?url=${encodeURIComponent(page)}`));
}

beforeEach(() => {
  __resetOpenLinksForTest();
  jest.clearAllMocks();
  mockAddListener.mockResolvedValue({ remove: jest.fn() });
  mockWallet = { locked: false, ready: true, hydrated: true };
  mockFinishingOnboarding = false;
  mockStore = { currentAccount: { requiresHotKeyRotation: false } };
  mockCatalog = catalog;
  mockPathname = '/';
});

it('listens for links from mount', () => {
  render(<OpenLinkPrompt />);

  expect(mockAddListener).toHaveBeenCalledWith('appUrlOpen', expect.any(Function));
});

it('opens a page on a listed origin in the dApp browser straight away', () => {
  render(<OpenLinkPrompt />);
  deliver(LISTED_PAGE);

  expect(mockOpen).toHaveBeenCalledWith({ id: `session:${LISTED_PAGE}`, url: LISTED_PAGE });
  expect(mockRecordOpenedDapp).toHaveBeenCalledWith(LISTED_PAGE);
  expect(mockNavigate).toHaveBeenCalledWith('/browser');
  expect(getPendingOpenLink()).toBeNull();
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});

it('stays on the Browser tab when it is already there', () => {
  mockPathname = '/browser';
  render(<OpenLinkPrompt />);
  deliver(LISTED_PAGE);

  expect(mockOpen).toHaveBeenCalledTimes(1);
  expect(mockNavigate).not.toHaveBeenCalled();
});

it('asks before opening a page on any other origin, naming its host', () => {
  render(<OpenLinkPrompt />);
  deliver(UNLISTED_PAGE);

  expect(screen.getByRole('heading')).toHaveTextContent('openLinkTitle:unknown.example');
  expect(mockOpen).not.toHaveBeenCalled();
  expect(mockHideForegroundDapp).toHaveBeenLastCalledWith(true);

  fireEvent.click(screen.getByText('openLinkAction'));

  expect(mockOpen).toHaveBeenCalledWith({ id: `session:${UNLISTED_PAGE}`, url: UNLISTED_PAGE });
  expect(mockNavigate).toHaveBeenCalledWith('/browser');
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(mockHideForegroundDapp).toHaveBeenLastCalledWith(false);
});

it('drops the page when the user cancels', () => {
  render(<OpenLinkPrompt />);
  deliver(UNLISTED_PAGE);

  fireEvent.click(screen.getByText('cancel'));

  expect(mockOpen).not.toHaveBeenCalled();
  expect(mockNavigate).not.toHaveBeenCalled();
  expect(getPendingOpenLink()).toBeNull();
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});

it('asks when the network has no Explore catalog', () => {
  mockCatalog = null;
  render(<OpenLinkPrompt />);
  deliver(LISTED_PAGE);

  expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  expect(mockOpen).not.toHaveBeenCalled();
});

it('waits for the Explore catalog before deciding, and loads it only for a link', () => {
  mockCatalog = undefined;
  const { rerender } = render(<OpenLinkPrompt />);
  expect(mockUseExploreCatalog).toHaveBeenLastCalledWith(false);

  deliver(LISTED_PAGE);
  expect(mockUseExploreCatalog).toHaveBeenLastCalledWith(true);
  expect(mockOpen).not.toHaveBeenCalled();
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

  mockCatalog = catalog;
  rerender(<OpenLinkPrompt />);
  expect(mockOpen).toHaveBeenCalledTimes(1);
});

it.each([
  [
    'the wallet is locked',
    () => {
      mockWallet = { ...mockWallet, locked: true };
    }
  ],
  [
    'onboarding is finishing',
    () => {
      mockFinishingOnboarding = true;
    }
  ],
  [
    'the hot-key rotation gate is up',
    () => {
      mockStore = { currentAccount: { requiresHotKeyRotation: true } };
    }
  ]
])('holds the link while %s, then opens it', (_case, block) => {
  block();
  const { rerender } = render(<OpenLinkPrompt />);
  deliver(LISTED_PAGE);

  expect(mockUseExploreCatalog).toHaveBeenLastCalledWith(false);
  expect(mockOpen).not.toHaveBeenCalled();
  expect(getPendingOpenLink()).toBe(LISTED_PAGE);

  mockWallet = { locked: false, ready: true, hydrated: true };
  mockFinishingOnboarding = false;
  mockStore = { currentAccount: { requiresHotKeyRotation: false } };
  rerender(<OpenLinkPrompt />);

  expect(mockOpen).toHaveBeenCalledWith({ id: `session:${LISTED_PAGE}`, url: LISTED_PAGE });
});

it('opens a link that arrived before the prompt mounted, once even when its effects run twice', () => {
  acceptOpenLink(`https://${OPEN_LINK_HOST}/open?url=${encodeURIComponent(LISTED_PAGE)}`);

  render(
    <React.StrictMode>
      <OpenLinkPrompt />
    </React.StrictMode>
  );

  expect(mockOpen).toHaveBeenCalledTimes(1);
  expect(mockAddListener).toHaveBeenCalledTimes(1);
});

it('opens a page while no account is selected yet', () => {
  mockStore = { currentAccount: null };
  render(<OpenLinkPrompt />);
  deliver(LISTED_PAGE);

  expect(mockOpen).toHaveBeenCalledTimes(1);
});
