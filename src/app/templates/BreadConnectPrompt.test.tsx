/* eslint-disable import/first */
import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { host?: string }) => (params?.host ? `${key}:${params.host}` : key)
  })
}));

jest.mock('@capacitor/app', () => ({
  App: {
    addListener: () => Promise.resolve({ remove: jest.fn() }),
    getLaunchUrl: () => Promise.resolve(undefined)
  }
}));

const mockPark = jest.fn<Promise<void>, []>(() => Promise.resolve());
let mockForeground: { id: string } | null = null;
const mockHideForegroundDapp = jest.fn();
jest.mock('app/providers/DappBrowserProvider', () => ({
  useDappBrowser: () => ({ park: mockPark, session: mockForeground }),
  useHideForegroundDappWhileOpen: (open: boolean) => mockHideForegroundDapp(open)
}));

const mockAnswer = jest.fn();
jest.mock('lib/bread-connect/answer', () => ({
  answerRequestLink: (...args: unknown[]) => mockAnswer(...args)
}));

const mockOpenCallback = jest.fn<Promise<boolean>, [string]>();
jest.mock('lib/bread-connect/opener', () => ({
  openCallback: (link: string) => mockOpenCallback(link)
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

let mockPathname = '/';
jest.mock('lib/woozie', () => ({ useLocation: () => ({ pathname: mockPathname }) }));

jest.mock('components/ui/AlertSheet', () => ({
  AlertSheet: ({
    open,
    title,
    children,
    actionLabel,
    onAction
  }: {
    open: boolean;
    title: React.ReactNode;
    children: React.ReactNode;
    actionLabel: React.ReactNode;
    onAction: () => void;
  }) =>
    open ? (
      <div role="alertdialog">
        <h2>{title}</h2>
        <p>{children}</p>
        <button onClick={onAction}>{actionLabel}</button>
      </div>
    ) : null
}));

import { startConnect } from '@miden-sdk/bread-connect';
import { __resetRequestLinksForTest, acceptRequestLink, nextRequestLink } from 'lib/bread-connect/capture';

import { BreadConnectPrompt } from './BreadConnectPrompt';

const CALLBACK = 'https://game.example/bread';

function requestLink(): string {
  return startConnect(CALLBACK, { type: 'PERMISSION_REQUEST', appMeta: { name: 'Game' } }).link;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => (resolve = done));
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  sessionStorage.clear();
  __resetRequestLinksForTest();
  mockPark.mockClear();
  mockForeground = null;
  mockHideForegroundDapp.mockClear();
  mockAnswer.mockReset();
  mockOpenCallback.mockReset().mockResolvedValue(true);
  mockWallet = { locked: false, ready: true, hydrated: true };
  mockFinishingOnboarding = false;
  mockStore = { currentAccount: { requiresHotKeyRotation: false } };
  mockPathname = '/';
});

it('answers a held link once the wallet is open, keeps what it asks, then opens the callback with the answer', async () => {
  const keep = jest.fn(() => Promise.resolve());
  const drop = jest.fn(() => Promise.resolve());
  mockAnswer.mockResolvedValue({ link: `${CALLBACK}#answer`, callback: CALLBACK, keep, drop });
  mockWallet = { locked: true, ready: true, hydrated: true };
  const link = requestLink();
  act(() => acceptRequestLink(link));
  const { rerender } = render(<BreadConnectPrompt />);
  await settle();
  expect(mockAnswer).not.toHaveBeenCalled();

  mockWallet = { locked: false, ready: true, hydrated: true };
  rerender(<BreadConnectPrompt />);
  await settle();

  expect(mockAnswer).toHaveBeenCalledWith(link, { onTransactionSent: expect.any(Function) });
  expect(mockOpenCallback).toHaveBeenCalledWith(`${CALLBACK}#answer`);
  expect(keep).toHaveBeenCalled();
  expect(keep.mock.invocationCallOrder[0]).toBeLessThan(mockOpenCallback.mock.invocationCallOrder[0]!);
  expect(drop).not.toHaveBeenCalled();
  expect(nextRequestLink()).toBeNull();
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});

it.each([
  ['onboarding finishes', () => (mockFinishingOnboarding = true)],
  ['the hot-key rotation gate is up', () => (mockStore = { currentAccount: { requiresHotKeyRotation: true } })],
  ['a screen outside the wallet shell shows', () => (mockPathname = '/reset-required')]
])('waits while %s', async (_name, arrange) => {
  arrange();
  act(() => acceptRequestLink(requestLink()));

  render(<BreadConnectPrompt />);
  await settle();

  expect(mockAnswer).not.toHaveBeenCalled();
});

it('parks a foreground dApp first, so the confirmation sheet shows', async () => {
  mockForeground = { id: 'dapp-1' };
  mockAnswer.mockResolvedValue(null);
  act(() => acceptRequestLink(requestLink()));

  render(<BreadConnectPrompt />);
  await settle();

  expect(mockPark).toHaveBeenCalledTimes(1);
  expect(mockPark.mock.invocationCallOrder[0]).toBeLessThan(mockAnswer.mock.invocationCallOrder[0]!);
});

it('shows that Bread is finishing an approved transaction until it answers', async () => {
  const answered = deferred<unknown>();
  mockAnswer.mockImplementation((_link: string, { onTransactionSent }: { onTransactionSent: (c: string) => void }) => {
    onTransactionSent(CALLBACK);
    return answered.promise;
  });
  act(() => acceptRequestLink(requestLink()));

  render(<BreadConnectPrompt />);
  await settle();

  expect(screen.getByRole('heading')).toHaveTextContent('breadConnectWaitingTitle:game.example');
  expect(screen.getByRole('alertdialog')).toHaveTextContent('breadConnectWaitingDescription:game.example');
  expect(mockHideForegroundDapp).toHaveBeenLastCalledWith(true);

  answered.resolve({ link: `${CALLBACK}#answer`, callback: CALLBACK, sentTransaction: true });
  await settle();

  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(mockHideForegroundDapp).toHaveBeenLastCalledWith(false);
});

it.each([
  ['an answer', {}, 'breadConnectUnreturnedDescription'],
  ['a transaction it sent', { sentTransaction: true }, 'breadConnectUnreturnedTransactionDescription']
])('says so when no app takes %s, and drops what it kept', async (_name, extra, description) => {
  const keep = jest.fn(() => Promise.resolve());
  const drop = jest.fn(() => Promise.resolve());
  mockAnswer.mockResolvedValue({ link: `${CALLBACK}#answer`, callback: CALLBACK, keep, drop, ...extra });
  mockOpenCallback.mockResolvedValue(false);
  act(() => acceptRequestLink(requestLink()));

  render(<BreadConnectPrompt />);
  await settle();

  expect(keep.mock.invocationCallOrder[0]).toBeLessThan(mockOpenCallback.mock.invocationCallOrder[0]!);
  expect(drop.mock.invocationCallOrder[0]).toBeGreaterThan(mockOpenCallback.mock.invocationCallOrder[0]!);
  expect(screen.getByRole('heading')).toHaveTextContent('breadConnectUnreturnedTitle:game.example');
  expect(screen.getByRole('alertdialog')).toHaveTextContent(`${description}:game.example`);

  fireEvent.click(screen.getByText('ok'));
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});

it('answers one link at a time, in order', async () => {
  const first = deferred<unknown>();
  mockAnswer.mockReturnValueOnce(first.promise).mockResolvedValueOnce(null);
  const links = [requestLink(), requestLink()];
  act(() => links.forEach(acceptRequestLink));

  render(<BreadConnectPrompt />);
  await settle();
  expect(mockAnswer).toHaveBeenCalledTimes(1);
  expect(mockAnswer.mock.calls[0]![0]).toBe(links[0]);

  first.resolve(null);
  await settle();

  expect(mockAnswer).toHaveBeenCalledTimes(2);
  expect(mockAnswer.mock.calls[1]![0]).toBe(links[1]);
});

it('moves on after a link it cannot answer', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    mockAnswer.mockRejectedValueOnce(new Error('storage gone')).mockResolvedValueOnce(null);
    act(() => [requestLink(), requestLink()].forEach(acceptRequestLink));

    render(<BreadConnectPrompt />);
    await settle();

    expect(warn).toHaveBeenCalledWith('[bread-connect] answering a request failed:', expect.any(Error));
    expect(mockAnswer).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  } finally {
    warn.mockRestore();
  }
});
