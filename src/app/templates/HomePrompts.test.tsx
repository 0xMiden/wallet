import React from 'react';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import type { TokenBalanceData } from 'lib/miden/front';
import type { WalletAccount } from 'lib/shared/types';
import type { PendingNoteValue } from 'lib/wallet-prompts';
import { WalletPromptStatus, WalletPromptType } from 'lib/wallet-prompts';

import { HomePrompts } from './HomePrompts';

const mockFaucet = jest.fn();
const mockUseWalletPromptStorage = jest.fn();
const mockFetchHotKeyHardwareError = jest.fn();

// `t` is never `init()`-ed in the unit env; echo the key back (with the
// interpolated amount appended) so the rendered copy is directly assertable.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { amount?: string }) => (values?.amount === undefined ? key : `${key}:${values.amount}`)
  })
}));

// The real banner lazy-requires native Capacitor haptics + the miden front
// barrel. Stub it to a marker so we can assert it renders (or not) based on
// `account.requiresHotKeyRotation`.
jest.mock('app/templates/ActivateHotKeyBanner', () => ({
  ActivateHotKeyBanner: () => <div data-testid="hotkey-banner">hotkey-banner</div>
}));

// The real PromptCard/PromptCarousel drag in framer-motion, haptics and SVG
// icons. Substitute thin stubs that faithfully forward the props HomePrompts
// relies on so the test stays hermetic while still exercising every handler.
jest.mock('components/ui', () => ({
  PromptCarousel: ({ children }: { children: React.ReactNode }) => <div data-testid="prompt-carousel">{children}</div>,
  PromptCard: ({
    title,
    body,
    variant,
    onClick,
    actionLabel,
    onAction,
    actionDisabled,
    status,
    onDismiss
  }: {
    title: string;
    body?: string;
    variant?: string;
    onClick?: () => void;
    actionLabel?: string;
    onAction?: () => void;
    actionDisabled?: boolean;
    status?: string;
    onDismiss?: () => void;
  }) => (
    <section data-testid="prompt-card" data-title={title} data-status={status} data-variant={variant ?? ''}>
      <button type="button" onClick={onClick}>
        {title}
      </button>
      {body && <p>{body}</p>}
      {actionLabel && (
        <button type="button" onClick={onAction} disabled={actionDisabled}>
          {actionLabel}
        </button>
      )}
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label={`dismiss-${title}`}>
          dismiss
        </button>
      )}
    </section>
  )
}));

// Keep the real enums/helpers (HomePrompts keys its definition map off
// `WalletPromptType` at module-eval time) and only replace the hook plus the
// network-touching faucet call.
jest.mock('lib/wallet-prompts', () => {
  const actual = jest.requireActual('lib/wallet-prompts');
  return {
    ...actual,
    faucet: (address: string) => mockFaucet(address),
    fetchHotKeyHardwareError: () => mockFetchHotKeyHardwareError(),
    useWalletPromptStorage: () => mockUseWalletPromptStorage()
  };
});

jest.mock('lib/woozie', () => ({ navigate: jest.fn() }));

const account = {
  publicKey: 'accountA',
  name: 'Account A',
  isPublic: false,
  hdIndex: 0
} as WalletAccount;

const accountNeedingRotation = { ...account, requiresHotKeyRotation: true } as WalletAccount;

const zeroBalance = [{ tokenId: 'token', balance: 0 }] as TokenBalanceData[];
const fundedBalance = [{ tokenId: 'token', balance: 1 }] as TokenBalanceData[];
const pendingNotes: PendingNoteValue[] = [
  { id: 'note-1', amount: '1250000', metadata: { decimals: 6, symbol: 'MIDEN' } },
  { id: 'note-2', amount: '2000000', metadata: { decimals: 6, symbol: 'USDC' } }
];
const tokenPrices = {
  MIDEN: { price: 2, change24h: 0, percentageChange24h: 0 },
  USDC: { price: 1, change24h: 0, percentageChange24h: 0 }
};

const makePromptState = (overrides: Record<string, unknown> = {}) => ({
  storage: { version: 1, prompts: {}, pendingNotesDismissedIds: [] },
  isLoaded: true,
  setPromptStatus: jest.fn(),
  dismissPrompt: jest.fn(),
  completePrompt: jest.fn(),
  isPromptPending: (type: WalletPromptType) => type === WalletPromptType.VerifySeedPhrase,
  ...overrides
});

describe('HomePrompts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFaucet.mockResolvedValue(undefined);
    mockFetchHotKeyHardwareError.mockResolvedValue(null);
  });

  it('renders the pending VerifySeedPhrase prompt inside the carousel', () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[]}
        tokenPrices={{}}
      />
    );

    expect(screen.getByTestId('prompt-carousel')).toBeInTheDocument();
    const card = screen.getByTestId('prompt-card');
    expect(card).toHaveAttribute('data-title', 'verifySeedPhrasePromptTitle');
    expect(card).toHaveAttribute('data-variant', 'warning');
    expect(screen.getByText('verifySeedPhrasePromptBody')).toBeInTheDocument();
  });

  it('navigates to the prompt route when a route-backed card is clicked', () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[]}
        tokenPrices={{}}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'verifySeedPhrasePromptTitle' }));

    expect(jest.requireMock('lib/woozie').navigate).toHaveBeenCalledWith('/settings/verify-seed-phrase');
  });

  it('dismisses a route-backed prompt without navigating', () => {
    const dismissPrompt = jest.fn();
    mockUseWalletPromptStorage.mockReturnValue(makePromptState({ dismissPrompt }));

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[]}
        tokenPrices={{}}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'dismiss-verifySeedPhrasePromptTitle' }));

    expect(dismissPrompt).toHaveBeenCalledWith(WalletPromptType.VerifySeedPhrase);
    expect(jest.requireMock('lib/woozie').navigate).not.toHaveBeenCalled();
  });

  it('renders no prompt cards while prompt storage has not loaded', () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState({ isLoaded: false }));

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[]}
        tokenPrices={{}}
      />
    );

    expect(screen.getByTestId('prompt-carousel')).toBeInTheDocument();
    expect(screen.queryByTestId('prompt-card')).not.toBeInTheDocument();
  });

  it('renders no prompt cards when nothing is pending', () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState({ isPromptPending: () => false }));

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[]}
        tokenPrices={{}}
      />
    );

    expect(screen.queryByTestId('prompt-card')).not.toBeInTheDocument();
  });

  it('renders the ActivateHotKeyBanner only when the account requires hot-key rotation', () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState({ isPromptPending: () => false }));

    const { rerender } = render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[]}
        tokenPrices={{}}
      />
    );
    expect(screen.queryByTestId('hotkey-banner')).not.toBeInTheDocument();

    rerender(
      <HomePrompts
        account={accountNeedingRotation}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[]}
        tokenPrices={{}}
      />
    );
    expect(screen.getByTestId('hotkey-banner')).toBeInTheDocument();
  });

  it('shows the faucet prompt before seed verification for a loaded empty account', () => {
    const promptState = makePromptState();
    mockUseWalletPromptStorage.mockReturnValue(promptState);

    render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        tokenPrices={{}}
      />
    );

    expect(screen.getAllByTestId('prompt-card').map(card => card.dataset.title)).toEqual([
      'faucetPromptTitle',
      'verifySeedPhrasePromptTitle'
    ]);
    expect(promptState.setPromptStatus).toHaveBeenCalledWith(WalletPromptType.Faucet, WalletPromptStatus.Pending);
  });

  it('does not show the faucet while balances load or when the account has funds', () => {
    const completePrompt = jest.fn();
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        completePrompt,
        storage: {
          version: 1,
          prompts: { [WalletPromptType.Faucet]: WalletPromptStatus.Pending },
          pendingNotesDismissedIds: []
        }
      })
    );

    const { rerender } = render(
      <HomePrompts account={account} balances={zeroBalance} balancesLoading claimableNotes={[]} tokenPrices={{}} />
    );
    expect(screen.queryByText('faucetPromptTitle')).not.toBeInTheDocument();

    rerender(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[]}
        tokenPrices={{}}
      />
    );
    expect(screen.queryByText('faucetPromptTitle')).not.toBeInTheDocument();
    expect(completePrompt).toHaveBeenCalledWith(WalletPromptType.Faucet);
  });

  it('keeps the faucet prompt hidden once it was dismissed', () => {
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        storage: {
          version: 1,
          prompts: { [WalletPromptType.Faucet]: WalletPromptStatus.Dismissed },
          pendingNotesDismissedIds: []
        }
      })
    );

    render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        tokenPrices={{}}
      />
    );

    expect(screen.queryByText('faucetPromptTitle')).not.toBeInTheDocument();
  });

  it('funds and completes from the faucet button', async () => {
    const completePrompt = jest.fn();
    mockUseWalletPromptStorage.mockReturnValue(makePromptState({ completePrompt }));

    render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        tokenPrices={{}}
      />
    );
    const faucetCard = screen.getAllByTestId('prompt-card')[0]!;
    fireEvent.click(within(faucetCard).getByRole('button', { name: 'faucetPromptAction' }));

    await waitFor(() => expect(mockFaucet).toHaveBeenCalledWith('accountA'));
    expect(mockFaucet).toHaveBeenCalledTimes(1);
    expect(completePrompt).toHaveBeenCalledWith(WalletPromptType.Faucet);
    expect(faucetCard).toHaveAttribute('data-status', 'success');
  });

  it('shows a failure state and allows the faucet request to be retried', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockFaucet.mockRejectedValueOnce(new Error('rate limited')).mockResolvedValueOnce(undefined);
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());

    render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        tokenPrices={{}}
      />
    );
    const faucetCard = screen.getAllByTestId('prompt-card')[0]!;
    const action = within(faucetCard).getByRole('button', { name: 'faucetPromptAction' });

    fireEvent.click(action);
    await waitFor(() => expect(faucetCard).toHaveAttribute('data-status', 'failure'));
    fireEvent.click(action);

    await waitFor(() => expect(mockFaucet).toHaveBeenCalledTimes(2));
  });

  it('does not fund when the faucet card content is clicked', () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());

    render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        tokenPrices={{}}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'faucetPromptTitle' }));

    expect(mockFaucet).not.toHaveBeenCalled();
  });

  it('dismisses the faucet prompt without calling the faucet', () => {
    const dismissPrompt = jest.fn();
    mockUseWalletPromptStorage.mockReturnValue(makePromptState({ dismissPrompt }));

    render(
      <HomePrompts
        account={account}
        balances={zeroBalance}
        balancesLoading={false}
        claimableNotes={[]}
        tokenPrices={{}}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'dismiss-faucetPromptTitle' }));

    expect(dismissPrompt).toHaveBeenCalledWith(WalletPromptType.Faucet);
    expect(mockFaucet).not.toHaveBeenCalled();
  });

  it('shows pending notes first with their USD value and action-only navigation', () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={pendingNotes}
        tokenPrices={tokenPrices}
      />
    );

    expect(screen.getAllByTestId('prompt-card').map(card => card.dataset.title)).toEqual([
      'pendingNotesPromptTitle',
      'verifySeedPhrasePromptTitle'
    ]);
    expect(screen.getByText('pendingNotesPromptBody:$4.50')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'pendingNotesPromptTitle' }));
    expect(jest.requireMock('lib/woozie').navigate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'pendingNotesPromptAction' }));
    expect(jest.requireMock('lib/woozie').navigate).toHaveBeenCalledWith('/pending');
  });

  it('dismisses the current pending-note batch by note id', () => {
    const setPromptStatus = jest.fn();
    mockUseWalletPromptStorage.mockReturnValue(makePromptState({ setPromptStatus }));

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={pendingNotes}
        tokenPrices={tokenPrices}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'dismiss-pendingNotesPromptTitle' }));

    expect(setPromptStatus).toHaveBeenCalledWith(WalletPromptType.PendingNotes, WalletPromptStatus.Dismissed, [
      'note-1',
      'note-2'
    ]);
  });

  it('keeps a dismissed batch hidden while one of its notes remains', () => {
    const setPromptStatus = jest.fn();
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        setPromptStatus,
        storage: {
          version: 1,
          prompts: { [WalletPromptType.PendingNotes]: WalletPromptStatus.Dismissed },
          pendingNotesDismissedIds: ['note-1', 'note-2']
        },
        isPromptPending: () => false
      })
    );

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[pendingNotes[0]!, { ...pendingNotes[1]!, id: 'note-3' }]}
        tokenPrices={tokenPrices}
      />
    );

    expect(screen.queryByText('pendingNotesPromptTitle')).not.toBeInTheDocument();
    expect(setPromptStatus).not.toHaveBeenCalled();
  });

  it('resurfaces for a later batch disjoint from the dismissed note ids', () => {
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        storage: {
          version: 1,
          prompts: { [WalletPromptType.PendingNotes]: WalletPromptStatus.Dismissed },
          pendingNotesDismissedIds: ['old-note']
        },
        isPromptPending: () => false
      })
    );

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={pendingNotes}
        tokenPrices={tokenPrices}
      />
    );

    expect(screen.getByText('pendingNotesPromptTitle')).toBeInTheDocument();
  });

  it('shows no pending-note prompt and writes no status when no notes remain', () => {
    const setPromptStatus = jest.fn();
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        setPromptStatus,
        storage: {
          version: 1,
          prompts: { [WalletPromptType.PendingNotes]: WalletPromptStatus.Dismissed },
          pendingNotesDismissedIds: ['note-1']
        },
        isPromptPending: () => false
      })
    );

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={undefined}
        tokenPrices={{}}
      />
    );

    expect(screen.queryByText('pendingNotesPromptTitle')).not.toBeInTheDocument();
    expect(setPromptStatus).not.toHaveBeenCalled();
  });

  const hotKeyPromptState = () =>
    makePromptState({
      storage: {
        version: 1,
        prompts: { [WalletPromptType.HotKeyHardwareUnavailable]: WalletPromptStatus.Pending },
        pendingNotesDismissedIds: []
      },
      isPromptPending: (type: WalletPromptType) => type === WalletPromptType.HotKeyHardwareUnavailable
    });

  it('shows the stored hot-key hardware error and copies it on the report action', async () => {
    mockFetchHotKeyHardwareError.mockResolvedValue({ message: 'TEE unavailable (code 7)' });
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mockUseWalletPromptStorage.mockReturnValue(hotKeyPromptState());

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[]}
        tokenPrices={{}}
      />
    );

    const card = screen.getByTestId('prompt-card');
    expect(card).toHaveAttribute('data-title', 'hotKeyHardwareErrorPromptTitle');
    expect(card).toHaveAttribute('data-variant', 'critical');
    await waitFor(() => expect(mockFetchHotKeyHardwareError).toHaveBeenCalled());
    // Flush the microtask that lands the fetched error in component state.
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'hotKeyHardwareErrorPromptAction' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('TEE unavailable (code 7)'));
    await waitFor(() => expect(screen.getByTestId('prompt-card')).toHaveAttribute('data-status', 'success'));
  });

  it('copies a generic message when no native error was recorded', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mockUseWalletPromptStorage.mockReturnValue(hotKeyPromptState());

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[]}
        tokenPrices={{}}
      />
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'hotKeyHardwareErrorPromptAction' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Hot-key secure hardware unavailable'));
  });

  it('warns without rendering an error when the stored hot-key error cannot be read', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockFetchHotKeyHardwareError.mockRejectedValue(new Error('storage down'));
    mockUseWalletPromptStorage.mockReturnValue(hotKeyPromptState());

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[]}
        tokenPrices={{}}
      />
    );

    await waitFor(() =>
      expect(warnSpy).toHaveBeenCalledWith('[wallet-prompts] failed to load hot-key hardware error:', expect.any(Error))
    );
    warnSpy.mockRestore();
  });

  it('marks the copy action failed when the clipboard rejects', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const writeText = jest.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mockUseWalletPromptStorage.mockReturnValue(hotKeyPromptState());

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[]}
        tokenPrices={{}}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'hotKeyHardwareErrorPromptAction' }));

    await waitFor(() => expect(screen.getByTestId('prompt-card')).toHaveAttribute('data-status', 'failure'));
    errorSpy.mockRestore();
  });
});
