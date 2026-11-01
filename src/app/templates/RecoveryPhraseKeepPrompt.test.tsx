import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { SeedPhraseStatus, WalletAccount } from 'lib/shared/types';

import {
  armRecoveryPhraseKeepPrompt,
  RECOVERY_PHRASE_KEEP_PROMPT_STORAGE_KEY,
  RecoveryPhraseKeepPrompt
} from './RecoveryPhraseKeepPrompt';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// Storage as the hooks see it: one map, and every mounted hook renders again after a write.
const mockStored = new Map<string, string>();
const mockStorageListeners = new Set<() => void>();
const mockPutToStorage = jest.fn(async (key: string, value: string) => {
  mockStored.set(key, value);
  mockStorageListeners.forEach(listener => listener());
});
jest.mock('lib/miden/front/storage', () => {
  const { useEffect, useReducer } = jest.requireActual<typeof React>('react');
  return {
    putToStorage: (key: string, value: string) => mockPutToStorage(key, value),
    useStorage: (key: string, fallback: string) => {
      const [, rerender] = useReducer((n: number) => n + 1, 0);
      useEffect(() => {
        const listener = () => rerender();
        mockStorageListeners.add(listener);
        return () => {
          mockStorageListeners.delete(listener);
        };
      }, []);
      return [mockStored.get(key) ?? fallback, jest.fn()];
    }
  };
});

const mockAlert = jest.fn(async () => {});
jest.mock('lib/ui/dialog', () => ({ useAlert: () => mockAlert }));

const mockRemoveSeedPhrase = jest.fn(async (_password?: string) => {});
type StoreState = { currentAccount: Partial<WalletAccount> | null; seedPhraseStatus?: SeedPhraseStatus };
type SelectableState = StoreState & { removeSeedPhrase: (password?: string) => Promise<void> };
let mockStore: StoreState;
jest.mock('lib/store', () => ({
  useWalletStore: (select: (state: SelectableState) => unknown) =>
    select({ ...mockStore, removeSeedPhrase: mockRemoveSeedPhrase })
}));

jest.mock('components/ui/AlertSheet', () => ({
  AlertSheet: ({
    open,
    title,
    children,
    actionLabel,
    onAction,
    secondaryLabel,
    onSecondary,
    actionTestId,
    secondaryTestId
  }: {
    open: boolean;
    title: React.ReactNode;
    children: React.ReactNode;
    actionLabel: React.ReactNode;
    onAction: () => void;
    secondaryLabel?: React.ReactNode;
    onSecondary?: () => void;
    actionTestId?: string;
    secondaryTestId?: string;
  }) =>
    open ? (
      <div role="alertdialog">
        <h2>{title}</h2>
        <p>{children}</p>
        <button data-testid={actionTestId} onClick={onAction}>
          {actionLabel}
        </button>
        <button data-testid={secondaryTestId} onClick={onSecondary}>
          {secondaryLabel}
        </button>
      </div>
    ) : null
}));

const activatedAccount: Partial<WalletAccount> = { publicKey: 'acc-1', hotPublicKey: 'hot-1' };

describe('RecoveryPhraseKeepPrompt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStored.clear();
    mockStorageListeners.clear();
    mockStore = { currentAccount: activatedAccount, seedPhraseStatus: 'stored' };
  });

  it('arms the prompt for an account through putToStorage', async () => {
    await armRecoveryPhraseKeepPrompt('acc-1');

    expect(mockPutToStorage).toHaveBeenCalledWith(RECOVERY_PHRASE_KEEP_PROMPT_STORAGE_KEY, 'acc-1');
  });

  it('stays hidden when it is not armed, or armed for another account', () => {
    const { rerender } = render(<RecoveryPhraseKeepPrompt />);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    mockStored.set(RECOVERY_PHRASE_KEEP_PROMPT_STORAGE_KEY, 'acc-2');
    rerender(<RecoveryPhraseKeepPrompt />);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it.each<[string, Partial<WalletAccount>]>([
    ['the account has no everyday key yet', { publicKey: 'acc-1' }],
    ['a rotation is still necessary', { ...activatedAccount, requiresHotKeyRotation: true }],
    ['the pending-note scan runs', { ...activatedAccount, guardianNoteRecoveryPending: true }]
  ])('stays hidden while %s', (_case, account) => {
    mockStored.set(RECOVERY_PHRASE_KEEP_PROMPT_STORAGE_KEY, 'acc-1');
    mockStore = { currentAccount: account, seedPhraseStatus: 'stored' };

    render(<RecoveryPhraseKeepPrompt />);

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockPutToStorage).not.toHaveBeenCalled();
  });

  it('shows once the activation lands for the armed account', async () => {
    mockStore = { currentAccount: { publicKey: 'acc-1', requiresHotKeyRotation: true }, seedPhraseStatus: 'stored' };
    const { rerender } = render(<RecoveryPhraseKeepPrompt />);
    await act(async () => {
      await armRecoveryPhraseKeepPrompt('acc-1');
    });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    mockStore = { currentAccount: activatedAccount, seedPhraseStatus: 'stored' };
    rerender(<RecoveryPhraseKeepPrompt />);

    expect(await screen.findByText('keepRecoveryPhraseTitle')).toBeInTheDocument();
    expect(screen.getByText('keepRecoveryPhraseBody')).toBeInTheDocument();
  });

  it('Remove removes the phrase at once, with no verification step, then clears the flag', async () => {
    mockStored.set(RECOVERY_PHRASE_KEEP_PROMPT_STORAGE_KEY, 'acc-1');
    render(<RecoveryPhraseKeepPrompt />);

    fireEvent.click(await screen.findByTestId('recovery-phrase-keep-remove'));

    await waitFor(() => expect(mockRemoveSeedPhrase).toHaveBeenCalledWith(undefined));
    await waitFor(() => expect(mockPutToStorage).toHaveBeenCalledWith(RECOVERY_PHRASE_KEEP_PROMPT_STORAGE_KEY, ''));
    expect(mockRemoveSeedPhrase.mock.invocationCallOrder[0]).toBeLessThan(
      mockPutToStorage.mock.invocationCallOrder[0]!
    );
    expect(mockAlert).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('a failed removal shows its message and keeps the prompt armed', async () => {
    mockStored.set(RECOVERY_PHRASE_KEEP_PROMPT_STORAGE_KEY, 'acc-1');
    mockRemoveSeedPhrase.mockRejectedValueOnce(new Error('Wait for the current transactions to finish'));
    render(<RecoveryPhraseKeepPrompt />);

    fireEvent.click(await screen.findByTestId('recovery-phrase-keep-remove'));

    await waitFor(() =>
      expect(mockAlert).toHaveBeenCalledWith(
        expect.objectContaining({ children: 'Wait for the current transactions to finish' })
      )
    );
    expect(mockPutToStorage).not.toHaveBeenCalledWith(RECOVERY_PHRASE_KEEP_PROMPT_STORAGE_KEY, '');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('a failed removal with no message shows the generic removal error', async () => {
    mockStored.set(RECOVERY_PHRASE_KEEP_PROMPT_STORAGE_KEY, 'acc-1');
    mockRemoveSeedPhrase.mockRejectedValueOnce(new Error(''));
    render(<RecoveryPhraseKeepPrompt />);

    fireEvent.click(await screen.findByTestId('recovery-phrase-keep-remove'));

    await waitFor(() =>
      expect(mockAlert).toHaveBeenCalledWith(expect.objectContaining({ title: 'error', children: 'seedRemovalFailed' }))
    );
  });

  // The first tap holds the answer until its write ends, so a second tap does not remove the phrase two times.
  it('runs the removal once when Remove is tapped twice while it runs', async () => {
    mockStored.set(RECOVERY_PHRASE_KEEP_PROMPT_STORAGE_KEY, 'acc-1');
    let finishRemoval: () => void = () => {};
    mockRemoveSeedPhrase.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishRemoval = resolve;
        })
    );
    render(<RecoveryPhraseKeepPrompt />);

    const remove = await screen.findByTestId('recovery-phrase-keep-remove');
    fireEvent.click(remove);
    fireEvent.click(remove);
    fireEvent.click(screen.getByTestId('recovery-phrase-keep-keep'));
    expect(mockRemoveSeedPhrase).toHaveBeenCalledTimes(1);
    expect(mockPutToStorage).not.toHaveBeenCalled();

    await act(async () => {
      finishRemoval();
    });

    await waitFor(() => expect(mockPutToStorage).toHaveBeenCalledTimes(1));
    expect(mockPutToStorage).toHaveBeenCalledWith(RECOVERY_PHRASE_KEEP_PROMPT_STORAGE_KEY, '');
    expect(mockRemoveSeedPhrase).toHaveBeenCalledTimes(1);
  });

  it('Keep clears the flag and stays on the page', async () => {
    mockStored.set(RECOVERY_PHRASE_KEEP_PROMPT_STORAGE_KEY, 'acc-1');
    render(<RecoveryPhraseKeepPrompt />);

    fireEvent.click(await screen.findByTestId('recovery-phrase-keep-keep'));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(mockPutToStorage).toHaveBeenCalledWith(RECOVERY_PHRASE_KEEP_PROMPT_STORAGE_KEY, '');
    expect(mockRemoveSeedPhrase).not.toHaveBeenCalled();
  });

  it('clears the flag silently when the phrase is not stored', async () => {
    mockStored.set(RECOVERY_PHRASE_KEEP_PROMPT_STORAGE_KEY, 'acc-1');
    mockStore = { currentAccount: activatedAccount, seedPhraseStatus: 'removed' };

    render(<RecoveryPhraseKeepPrompt />);

    await waitFor(() => expect(mockPutToStorage).toHaveBeenCalledWith(RECOVERY_PHRASE_KEEP_PROMPT_STORAGE_KEY, ''));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('keeps the flag while the phrase status is not known yet', async () => {
    mockStored.set(RECOVERY_PHRASE_KEEP_PROMPT_STORAGE_KEY, 'acc-1');
    mockStore = { currentAccount: activatedAccount };

    render(<RecoveryPhraseKeepPrompt />);
    await act(async () => {});

    expect(mockPutToStorage).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
