import React from 'react';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import type { TokenBalanceData } from 'lib/miden/front';
import type { WalletAccount } from 'lib/shared/types';
import { WalletPromptStatus, WalletPromptType } from 'lib/wallet-prompts';

import { HomePrompts } from './HomePrompts';

const mockFaucet = jest.fn();
const mockUseWalletPromptStorage = jest.fn();

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('components/ui', () => ({
  PromptCarousel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PromptCard: ({
    title,
    onClick,
    actionLabel,
    onAction,
    actionDisabled,
    onDismiss
  }: {
    title: string;
    onClick?: () => void;
    actionLabel?: string;
    onAction?: () => void;
    actionDisabled?: boolean;
    onDismiss?: () => void;
  }) => (
    <section data-testid="prompt-card" data-title={title}>
      <button type="button" onClick={onClick}>
        {title}
      </button>
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

jest.mock('app/templates/ActivateHotKeyBanner', () => ({
  ActivateHotKeyBanner: () => <div>activate-hot-key</div>
}));

jest.mock('lib/wallet-prompts', () => {
  const actual = jest.requireActual('lib/wallet-prompts');
  return {
    ...actual,
    faucet: (address: string) => mockFaucet(address),
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

const makePromptState = (overrides: Record<string, unknown> = {}) => ({
  storage: { version: 1, prompts: {} },
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
  });

  it('shows the faucet prompt before seed verification for a loaded empty account', () => {
    const promptState = makePromptState();
    mockUseWalletPromptStorage.mockReturnValue(promptState);

    render(<HomePrompts account={account} balances={zeroBalance} balancesLoading={false} />);

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
        storage: { version: 1, prompts: { [WalletPromptType.Faucet]: WalletPromptStatus.Pending } }
      })
    );

    const { rerender } = render(<HomePrompts account={account} balances={zeroBalance} balancesLoading />);
    expect(screen.queryByText('faucetPromptTitle')).not.toBeInTheDocument();

    rerender(<HomePrompts account={account} balances={fundedBalance} balancesLoading={false} />);
    expect(screen.queryByText('faucetPromptTitle')).not.toBeInTheDocument();
    expect(completePrompt).toHaveBeenCalledWith(WalletPromptType.Faucet);
  });

  it('funds and completes from the faucet button', async () => {
    const completePrompt = jest.fn();
    mockUseWalletPromptStorage.mockReturnValue(makePromptState({ completePrompt }));

    render(<HomePrompts account={account} balances={zeroBalance} balancesLoading={false} />);
    const faucetCard = screen.getAllByTestId('prompt-card')[0]!;
    fireEvent.click(within(faucetCard).getByRole('button', { name: 'faucetPromptAction' }));

    await waitFor(() => expect(mockFaucet).toHaveBeenCalledWith('accountA'));
    expect(mockFaucet).toHaveBeenCalledTimes(1);
    expect(completePrompt).toHaveBeenCalledWith(WalletPromptType.Faucet);
  });

  it('does not fund when the faucet card content is clicked', () => {
    mockUseWalletPromptStorage.mockReturnValue(makePromptState());

    render(<HomePrompts account={account} balances={zeroBalance} balancesLoading={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'faucetPromptTitle' }));

    expect(mockFaucet).not.toHaveBeenCalled();
  });

  it('dismisses the faucet prompt without calling the faucet', () => {
    const dismissPrompt = jest.fn();
    mockUseWalletPromptStorage.mockReturnValue(makePromptState({ dismissPrompt }));

    render(<HomePrompts account={account} balances={zeroBalance} balancesLoading={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'dismiss-faucetPromptTitle' }));

    expect(dismissPrompt).toHaveBeenCalledWith(WalletPromptType.Faucet);
    expect(mockFaucet).not.toHaveBeenCalled();
  });
});
