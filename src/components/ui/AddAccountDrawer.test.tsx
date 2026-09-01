import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';
import { navigate } from 'lib/woozie';

import AddAccountDrawerDefault, { AddAccountDrawer } from './AddAccountDrawer';

// ---------------------------------------------------------------------------
// AddAccountDrawer is the BalanceCard "+" bottom sheet. Everything it renders
// (Drawer chrome, icons, Loader) is stubbed to a minimal double so the tests
// exercise only the sheet's own logic: the three-step flow, the public-account
// creation pipeline, the restore/rescan form and its validation bounds, and the
// hardware-back / close guards.
//
// `mock*`-prefixed module vars are required for jest.mock factory hoisting.
// ---------------------------------------------------------------------------

interface MockAccount {
  publicKey: string;
}

interface MockWalletState {
  accounts: MockAccount[];
  ownMnemonic: boolean;
}

const mockWalletState: MockWalletState = { accounts: [{ publicKey: 'key-1' }], ownMnemonic: true };

const mockCreateAccount = jest.fn<Promise<void>, [string, string?, string?]>();
const mockUpdateCurrentAccount = jest.fn<Promise<void>, [string]>();
const mockScanForAccounts = jest.fn<Promise<MockAccount[]>, [number]>();

// Captures the sheet's hardware-back handler so tests can drive Android back.
let mockBackHandler: (() => boolean | void) | undefined;

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid="icon" data-name={name} />,
  IconName: new Proxy({}, { get: (_target, prop) => String(prop) })
}));

jest.mock('components/Loader', () => ({
  Loader: ({ size, 'aria-label': ariaLabel }: { size?: string; 'aria-label'?: string }) => (
    <span data-testid="loader" data-size={size} aria-label={ariaLabel} />
  )
}));

jest.mock('lib/miden/front', () => ({
  useMidenContext: () => ({
    createAccount: mockCreateAccount,
    updateCurrentAccount: mockUpdateCurrentAccount,
    scanForAccounts: mockScanForAccounts
  })
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: (handler: () => boolean | void) => {
    mockBackHandler = handler;
  }
}));

// Both shapes are used by the component: the hook-with-selector for
// `ownMnemonic`, and `getState()` for the before/after account-key diff.
jest.mock('lib/store', () => ({
  useWalletStore: Object.assign(<Selected,>(selector: (state: MockWalletState) => Selected): Selected =>
    selector(mockWalletState),
  {
    getState: () => mockWalletState
  })
}));

jest.mock('lib/ui/drawer', () => ({
  Drawer: ({
    open,
    onOpenChange,
    children
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: React.ReactNode;
  }) => (
    <div data-testid="drawer" data-open={String(open)}>
      <button data-testid="drawer-close" onClick={() => onOpenChange(false)} />
      <button data-testid="drawer-open" onClick={() => onOpenChange(true)} />
      {children}
    </div>
  ),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-content">{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-header">{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-title">{children}</div>
}));

jest.mock('lib/woozie', () => ({
  navigate: jest.fn()
}));

jest.mock('screens/onboarding/types', () => ({
  WalletType: { OffChain: 'off-chain', Guardian: 'guardian', OnChain: 'on-chain' }
}));

const renderDrawer = (props: Partial<React.ComponentProps<typeof AddAccountDrawer>> = {}) => {
  const onOpenChange = props.onOpenChange ?? jest.fn();
  const result = render(<AddAccountDrawer open onOpenChange={onOpenChange} {...props} />);
  return { ...result, onOpenChange };
};

/** Deferred promise so a test can hold `createAccount` / `scanForAccounts` open. */
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('AddAccountDrawer', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockWalletState.accounts = [{ publicKey: 'key-1' }];
    mockWalletState.ownMnemonic = true;
    mockBackHandler = undefined;
    mockCreateAccount.mockImplementation(() => {
      mockWalletState.accounts = [...mockWalletState.accounts, { publicKey: 'key-new' }];
      return Promise.resolve();
    });
    mockUpdateCurrentAccount.mockResolvedValue(undefined);
    mockScanForAccounts.mockResolvedValue([]);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('exports the same component as default and named', () => {
    expect(AddAccountDrawerDefault).toBe(AddAccountDrawer);
  });

  describe('type step', () => {
    it('forwards the open flag and renders the three type options under the add-account title', () => {
      renderDrawer();

      expect(screen.getByTestId('drawer')).toHaveAttribute('data-open', 'true');
      expect(screen.getByTestId('drawer-title')).toHaveTextContent('addAccount');
      expect(screen.getByTestId('add-account-option-public')).toBeInTheDocument();
      expect(screen.getByTestId('add-account-option-private')).toBeInTheDocument();
      expect(screen.getByTestId('add-account-option-restore')).toBeInTheDocument();
      // Step 1 is the root: no back chevron.
      expect(screen.queryByTestId('add-account-back')).toBeNull();
      expect(screen.getByText('accountTypePublicDescription')).toBeInTheDocument();
    });

    it('hides the restore option for a wallet with no mnemonic to re-derive', () => {
      mockWalletState.ownMnemonic = false;
      renderDrawer();

      expect(screen.queryByTestId('add-account-option-restore')).toBeNull();
      expect(screen.getByTestId('add-account-option-public')).toBeInTheDocument();
    });

    it('renders the sheet closed when open is false', () => {
      renderDrawer({ open: false });

      expect(screen.getByTestId('drawer')).toHaveAttribute('data-open', 'false');
    });
  });

  describe('public account creation', () => {
    it('creates the account, switches to the new key and closes the sheet', async () => {
      const { onOpenChange } = renderDrawer();

      await act(async () => {
        fireEvent.click(screen.getByTestId('add-account-option-public'));
      });

      expect(hapticLight).toHaveBeenCalledTimes(1);
      expect(mockCreateAccount).toHaveBeenCalledWith('on-chain');
      expect(mockUpdateCurrentAccount).toHaveBeenCalledWith('key-new');
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('closes without switching when no new account turned up', async () => {
      mockCreateAccount.mockResolvedValue(undefined);
      const { onOpenChange } = renderDrawer();

      await act(async () => {
        fireEvent.click(screen.getByTestId('add-account-option-public'));
      });

      expect(mockCreateAccount).toHaveBeenCalledTimes(1);
      expect(mockUpdateCurrentAccount).not.toHaveBeenCalled();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('shows a spinner on the public row while the creation is in flight', async () => {
      const pending = deferred<void>();
      mockCreateAccount.mockReturnValue(pending.promise);
      renderDrawer();

      await act(async () => {
        fireEvent.click(screen.getByTestId('add-account-option-public'));
      });

      const publicRow = screen.getByTestId('add-account-option-public');
      expect(publicRow).toHaveAttribute('aria-busy', 'true');
      expect(publicRow).toBeDisabled();
      expect(publicRow.className).toContain('opacity-70');
      expect(screen.getByTestId('loader')).toBeInTheDocument();
      // Only the tapped row is busy.
      expect(screen.getByTestId('add-account-option-private')).toHaveAttribute('aria-busy', 'false');

      await act(async () => {
        pending.resolve();
        await pending.promise;
      });
    });

    it('ignores a second tap while the first creation is still running', async () => {
      const pending = deferred<void>();
      mockCreateAccount.mockReturnValue(pending.promise);
      renderDrawer();

      await act(async () => {
        fireEvent.click(screen.getByTestId('add-account-option-public'));
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('add-account-option-private'));
      });

      expect(mockCreateAccount).toHaveBeenCalledTimes(1);
      expect(hapticLight).toHaveBeenCalledTimes(1);
      // Every row is disabled while a creation is in flight, so the second tap
      // does not advance to the recovery step either.
      expect(screen.getByTestId('drawer-title')).toHaveTextContent('addAccount');

      await act(async () => {
        pending.resolve();
        await pending.promise;
      });
    });

    it('refuses to close the sheet while the creation is in flight', async () => {
      const pending = deferred<void>();
      mockCreateAccount.mockReturnValue(pending.promise);
      const { onOpenChange } = renderDrawer();

      await act(async () => {
        fireEvent.click(screen.getByTestId('add-account-option-public'));
      });
      fireEvent.click(screen.getByTestId('drawer-close'));

      expect(onOpenChange).not.toHaveBeenCalled();

      await act(async () => {
        pending.resolve();
        await pending.promise;
      });
    });

    it('surfaces the Error message when creation fails', async () => {
      mockCreateAccount.mockRejectedValue(new Error('vault is locked'));
      const { onOpenChange } = renderDrawer();

      await act(async () => {
        fireEvent.click(screen.getByTestId('add-account-option-public'));
      });

      expect(screen.getByRole('alert')).toHaveTextContent('vault is locked');
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('falls back to the generic message for a non-Error rejection', async () => {
      mockCreateAccount.mockRejectedValue('boom');
      renderDrawer();

      await act(async () => {
        fireEvent.click(screen.getByTestId('add-account-option-public'));
      });

      expect(screen.getByRole('alert')).toHaveTextContent('smthWentWrong');
    });
  });

  describe('private recovery step', () => {
    const openRecoveryStep = () => {
      const rendered = renderDrawer();
      fireEvent.click(screen.getByTestId('add-account-option-private'));
      return rendered;
    };

    it('swaps the sheet to the recovery options with a back chevron', () => {
      openRecoveryStep();

      expect(screen.getByTestId('drawer-title')).toHaveTextContent('chooseRecoveryMethod');
      expect(screen.getByTestId('add-account-option-guardian')).toBeInTheDocument();
      expect(screen.getByTestId('add-account-option-local')).toBeInTheDocument();
      expect(screen.queryByTestId('add-account-option-public')).toBeNull();
      expect(screen.getByTestId('add-account-back')).toHaveAttribute('aria-label', 'back');
    });

    it('routes the guardian option to the operator picker and closes the sheet', () => {
      const { onOpenChange } = openRecoveryStep();

      fireEvent.click(screen.getByTestId('add-account-option-guardian'));

      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(navigate).toHaveBeenCalledWith('/add-account/guardian');
      // Reset back to step 1 for the next open.
      expect(screen.getByTestId('drawer-title')).toHaveTextContent('addAccount');
    });

    it('routes the fully-local option to the risk flow', () => {
      const { onOpenChange } = openRecoveryStep();

      fireEvent.click(screen.getByTestId('add-account-option-local'));

      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(navigate).toHaveBeenCalledWith('/add-account/private');
    });

    it('returns to the type step via the back chevron', () => {
      openRecoveryStep();

      fireEvent.click(screen.getByTestId('add-account-back'));

      expect(hapticLight).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('drawer-title')).toHaveTextContent('addAccount');
      expect(screen.getByTestId('add-account-option-public')).toBeInTheDocument();
    });
  });

  describe('restore step', () => {
    const openRestoreStep = () => {
      const rendered = renderDrawer();
      fireEvent.click(screen.getByTestId('add-account-option-restore'));
      return rendered;
    };

    it('renders the scan form pre-filled with the default window', () => {
      openRestoreStep();

      expect(screen.getByTestId('drawer-title')).toHaveTextContent('restoreExistingAccount');
      expect(screen.getByTestId('add-account-scan-count')).toHaveValue('5');
      expect(screen.getByTestId('add-account-scan-submit')).toBeEnabled();
      expect(screen.getByText('howManyMoreAccounts')).toBeInTheDocument();
      expect(screen.getByText('searchForAccounts')).toBeInTheDocument();
      expect(screen.queryByTestId('add-account-scan-result')).toBeNull();
    });

    it.each([
      ['0', 'below the minimum'],
      ['21', 'above the maximum'],
      ['', 'empty'],
      ['abc', 'not a number']
    ])('disables the scan button for %s (%s)', (value: string) => {
      openRestoreStep();

      fireEvent.change(screen.getByTestId('add-account-scan-count'), { target: { value } });

      expect(screen.getByTestId('add-account-scan-submit')).toBeDisabled();
      expect(screen.getByTestId('add-account-scan-submit').className).toContain('opacity-70');
    });

    it.each(['1', '20'])('keeps the scan button enabled at the bound %s', (value: string) => {
      openRestoreStep();

      fireEvent.change(screen.getByTestId('add-account-scan-count'), { target: { value } });

      expect(screen.getByTestId('add-account-scan-submit')).toBeEnabled();
    });

    it('scans the truncated integer for a decimal input (parseInt semantics)', async () => {
      openRestoreStep();

      fireEvent.change(screen.getByTestId('add-account-scan-count'), { target: { value: '1.5' } });
      expect(screen.getByTestId('add-account-scan-submit')).toBeEnabled();

      await act(async () => {
        fireEvent.click(screen.getByTestId('add-account-scan-submit'));
      });

      expect(mockScanForAccounts).toHaveBeenCalledWith(1);
    });

    it('ignores a scan attempt while the count is out of bounds', async () => {
      openRestoreStep();

      fireEvent.change(screen.getByTestId('add-account-scan-count'), { target: { value: '0' } });
      await act(async () => {
        fireEvent.click(screen.getByTestId('add-account-scan-submit'));
      });

      expect(mockScanForAccounts).not.toHaveBeenCalled();
    });

    it('reports that nothing new was found', async () => {
      mockScanForAccounts.mockResolvedValue([]);
      openRestoreStep();

      await act(async () => {
        fireEvent.click(screen.getByTestId('add-account-scan-submit'));
      });

      expect(mockScanForAccounts).toHaveBeenCalledWith(5);
      expect(screen.getByTestId('add-account-scan-result')).toHaveTextContent('noAdditionalAccountsFound');
    });

    it('reports the number of recovered accounts', async () => {
      mockScanForAccounts.mockResolvedValue([{ publicKey: 'a' }, { publicKey: 'b' }]);
      openRestoreStep();

      fireEvent.change(screen.getByTestId('add-account-scan-count'), { target: { value: '7' } });
      await act(async () => {
        fireEvent.click(screen.getByTestId('add-account-scan-submit'));
      });

      expect(mockScanForAccounts).toHaveBeenCalledWith(7);
      expect(screen.getByTestId('add-account-scan-result')).toHaveTextContent('foundAdditionalAccounts');
    });

    it('shows the scanning state, blocks re-entry and blocks closing', async () => {
      const pending = deferred<MockAccount[]>();
      mockScanForAccounts.mockReturnValue(pending.promise);
      const { onOpenChange } = openRestoreStep();

      await act(async () => {
        fireEvent.click(screen.getByTestId('add-account-scan-submit'));
      });

      const submit = screen.getByTestId('add-account-scan-submit');
      expect(submit).toHaveAttribute('aria-busy', 'true');
      expect(submit).toBeDisabled();
      expect(screen.getByText('scanningForAccounts')).toBeInTheDocument();
      expect(screen.getByTestId('add-account-scan-count')).toBeDisabled();

      // A second submit while the scan is running is a no-op.
      await act(async () => {
        fireEvent.click(submit);
      });
      expect(mockScanForAccounts).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByTestId('drawer-close'));
      expect(onOpenChange).not.toHaveBeenCalled();

      await act(async () => {
        pending.resolve([]);
        await pending.promise;
      });
      await waitFor(() => expect(screen.getByTestId('add-account-scan-result')).toBeInTheDocument());
    });

    it('surfaces the Error message when the scan fails', async () => {
      mockScanForAccounts.mockRejectedValue(new Error('endpoint unreachable'));
      openRestoreStep();

      await act(async () => {
        fireEvent.click(screen.getByTestId('add-account-scan-submit'));
      });

      expect(screen.getByRole('alert')).toHaveTextContent('endpoint unreachable');
      expect(screen.queryByTestId('add-account-scan-result')).toBeNull();
    });

    it('falls back to the generic message for a non-Error scan rejection', async () => {
      mockScanForAccounts.mockRejectedValue('nope');
      openRestoreStep();

      await act(async () => {
        fireEvent.click(screen.getByTestId('add-account-scan-submit'));
      });

      expect(screen.getByRole('alert')).toHaveTextContent('smthWentWrong');
    });

    it('returns to the type step via the back chevron', () => {
      openRestoreStep();

      fireEvent.click(screen.getByTestId('add-account-back'));

      expect(screen.getByTestId('drawer-title')).toHaveTextContent('addAccount');
    });
  });

  describe('open-change handling', () => {
    it('forwards an open request untouched', () => {
      const { onOpenChange } = renderDrawer();

      fireEvent.click(screen.getByTestId('drawer-open'));

      expect(onOpenChange).toHaveBeenCalledWith(true);
    });

    it('resets the step and any error on close', async () => {
      mockCreateAccount.mockRejectedValue(new Error('vault is locked'));
      const { onOpenChange } = renderDrawer();

      // Leave the sheet on step 2 with an error showing.
      await act(async () => {
        fireEvent.click(screen.getByTestId('add-account-option-public'));
      });
      fireEvent.click(screen.getByTestId('add-account-option-private'));
      expect(screen.getByTestId('drawer-title')).toHaveTextContent('chooseRecoveryMethod');

      fireEvent.click(screen.getByTestId('drawer-close'));

      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(screen.getByTestId('drawer-title')).toHaveTextContent('addAccount');
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  describe('hardware back', () => {
    it('pops the recovery step back to the type step', () => {
      renderDrawer();
      fireEvent.click(screen.getByTestId('add-account-option-private'));

      let handled: boolean | void = false;
      act(() => {
        handled = mockBackHandler?.();
      });

      expect(handled).toBe(true);
      expect(screen.getByTestId('drawer-title')).toHaveTextContent('addAccount');
    });

    it('pops the restore step back to the type step', () => {
      renderDrawer();
      fireEvent.click(screen.getByTestId('add-account-option-restore'));

      let handled: boolean | void = false;
      act(() => {
        handled = mockBackHandler?.();
      });

      expect(handled).toBe(true);
      expect(screen.getByTestId('drawer-title')).toHaveTextContent('addAccount');
    });

    it('passes through on the type step so the host closes the sheet', () => {
      renderDrawer();

      let handled: boolean | void = true;
      act(() => {
        handled = mockBackHandler?.();
      });

      expect(handled).toBe(false);
    });

    it('passes through when the sheet is closed', () => {
      renderDrawer({ open: false });

      let handled: boolean | void = true;
      act(() => {
        handled = mockBackHandler?.();
      });

      expect(handled).toBe(false);
    });
  });
});
