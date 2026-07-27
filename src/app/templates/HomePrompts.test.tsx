import React from 'react';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import type { TokenBalanceData } from 'lib/miden/front';
import type { WalletAccount } from 'lib/shared/types';
import type { PendingNoteValue } from 'lib/wallet-prompts';
import { WalletPromptStatus, WalletPromptType } from 'lib/wallet-prompts';

import { HomePrompts } from './HomePrompts';

const mockFaucet = jest.fn();
const mockFetchActiveBridgePrompts = jest.fn();
const mockPollActiveBridgePrompts = jest.fn();
const mockUseWalletPromptStorage = jest.fn();

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { amount?: string }) => (values?.amount === undefined ? key : `${key}:${values.amount}`)
  })
}));

jest.mock('components/ui', () => ({
  PromptCarousel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PromptCard: ({
    title,
    body,
    onClick,
    actionLabel,
    onAction,
    actionDisabled,
    status,
    onDismiss
  }: {
    title: string;
    body?: string;
    onClick?: () => void;
    actionLabel?: string;
    onAction?: () => void;
    actionDisabled?: boolean;
    status?: string;
    onDismiss?: () => void;
  }) => (
    <section data-testid="prompt-card" data-title={title} data-status={status}>
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

jest.mock('lib/wallet-prompts', () => {
  const actual = jest.requireActual('lib/wallet-prompts');
  return {
    ...actual,
    faucet: (address: string) => mockFaucet(address),
    fetchActiveBridgePrompts: (address: string) => mockFetchActiveBridgePrompts(address),
    pollActiveBridgePrompts: (transactions: unknown[]) => mockPollActiveBridgePrompts(transactions),
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
    mockFetchActiveBridgePrompts.mockResolvedValue([]);
    mockPollActiveBridgePrompts.mockResolvedValue(undefined);
  });

  it('polls and dismisses a pending bridge through the wallet prompt type', async () => {
    const dismissPrompt = jest.fn();
    const bridgeTransaction = { id: 'bridge-1', type: 'bridged-send' };
    mockFetchActiveBridgePrompts.mockResolvedValue([bridgeTransaction]);
    mockUseWalletPromptStorage.mockReturnValue(
      makePromptState({
        dismissPrompt,
        storage: {
          version: 1,
          prompts: { [WalletPromptType.Bridge]: WalletPromptStatus.Pending },
          pendingNotesDismissedIds: []
        },
        isPromptPending: (type: WalletPromptType) => type === WalletPromptType.Bridge
      })
    );

    render(
      <HomePrompts
        account={account}
        balances={fundedBalance}
        balancesLoading={false}
        claimableNotes={[]}
        tokenPrices={{}}
      />
    );

    const bridgeCard = await screen.findByText('bridgePromptTitle');
    await waitFor(() => expect(mockPollActiveBridgePrompts).toHaveBeenCalledWith([bridgeTransaction]));
    fireEvent.click(bridgeCard);
    expect(jest.requireMock('lib/woozie').navigate).toHaveBeenCalledWith('/history-details/bridge-1');

    fireEvent.click(screen.getByRole('button', { name: 'dismiss-bridgePromptTitle' }));
    expect(dismissPrompt).toHaveBeenCalledWith(WalletPromptType.Bridge);
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
    const promptState = makePromptState();
    mockUseWalletPromptStorage.mockReturnValue(promptState);

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
    expect(jest.requireMock('lib/woozie').navigate).toHaveBeenCalledWith('/pending-notes');
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
        claimableNotes={[]}
        tokenPrices={{}}
      />
    );

    expect(screen.queryByText('pendingNotesPromptTitle')).not.toBeInTheDocument();
    expect(setPromptStatus).not.toHaveBeenCalled();
  });
});
