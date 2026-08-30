import React, { FC, FormEvent, useEffect, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { ACCOUNT_NAME_PATTERN } from 'app/defaults';
import { Icon, IconName } from 'app/icons/v2';
import { useMidenContext } from 'lib/miden/front';
import { hapticLight } from 'lib/mobile/haptics';
import { getCardColor, initializeAccountCardColors, setCardColor, useCardColor } from 'lib/settings/card-color';
import { CARD_COLORS, CardColor } from 'lib/settings/constants';
import { useWalletStore } from 'lib/store';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { navigate } from 'lib/woozie';
import { truncateAddress } from 'utils/string';

import { CARD_COLOR_BG } from './BalanceCard';

export interface AccountsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens the add-account type picker (rendered by the host). */
  onAddAccount?: () => void;
}

/**
 * Bottom sheet opened from the BalanceCard account chip / settings button.
 * Lists the wallet's accounts (tap to switch), the balance-card color picker
 * and account-level actions: Settings (navigates to /settings) and Add Account.
 */
export const AccountsDrawer: FC<AccountsDrawerProps> = ({ open, onOpenChange, onAddAccount }) => {
  const { t } = useTranslation();
  const accounts = useWalletStore(s => s.accounts);
  const currentAccount = useWalletStore(s => s.currentAccount);
  const selectedCardColor = useCardColor(currentAccount?.publicKey);
  const { editAccountName, updateCurrentAccount } = useMidenContext();
  const [editingAccountId, setEditingAccountId] = useState<string>();
  const [draftName, setDraftName] = useState('');
  const [nameError, setNameError] = useState('');
  const [isSavingName, setIsSavingName] = useState(false);

  useEffect(() => {
    initializeAccountCardColors(accounts.map(account => account.publicKey));
  }, [accounts]);

  useEffect(() => {
    if (open) return;
    setEditingAccountId(undefined);
    setDraftName('');
    setNameError('');
    setIsSavingName(false);
  }, [open]);

  const handleSettings = () => {
    hapticLight();
    onOpenChange(false);
    navigate('/settings');
  };

  const handleCardColorSelect = (color: CardColor) => {
    if (!currentAccount || color === selectedCardColor) return;
    hapticLight();
    setCardColor(currentAccount.publicKey, color);
  };

  const handleSelectAccount = (accountPublicKey: string) => {
    if (accountPublicKey === currentAccount?.publicKey) {
      onOpenChange(false);
      return;
    }
    hapticLight();
    onOpenChange(false);
    // The store applies the switch optimistically and rolls back on failure,
    // so the drawer can close immediately.
    updateCurrentAccount(accountPublicKey).catch(err => console.error('[AccountsDrawer] switch account failed', err));
  };

  const handleEditAccount = (accountPublicKey: string, accountName: string) => {
    hapticLight();
    setEditingAccountId(accountPublicKey);
    setDraftName(accountName);
    setNameError('');
  };

  const handleCancelEdit = () => {
    hapticLight();
    setEditingAccountId(undefined);
    setDraftName('');
    setNameError('');
  };

  const handleNameSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingAccountId || isSavingName) return;

    const trimmedName = draftName.trim();
    const nameIsTaken = accounts.some(
      account => account.publicKey !== editingAccountId && account.name === trimmedName
    );
    if (!ACCOUNT_NAME_PATTERN.test(trimmedName) || nameIsTaken) {
      setNameError(t('invalidAccountName'));
      return;
    }

    hapticLight();
    setIsSavingName(true);
    setNameError('');
    try {
      await editAccountName(editingAccountId, trimmedName);
      setEditingAccountId(undefined);
      setDraftName('');
    } catch {
      setNameError(t('smthWentWrongWhile', { action: t('editAccountName') }));
    } finally {
      setIsSavingName(false);
    }
  };

  const handleAddAccount = () => {
    hapticLight();
    onOpenChange(false);
    onAddAccount?.();
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('accounts')}</DrawerTitle>
        </DrawerHeader>

        <div className="flex flex-col gap-4 px-4 pb-6">
          {accounts.length > 0 && (
            <div className="flex flex-col gap-1" role="radiogroup" aria-label={t('accounts')}>
              {accounts.map(account => {
                const isActive = account.publicKey === currentAccount?.publicKey;
                const isEditing = account.publicKey === editingAccountId;
                const trimmedDraftName = draftName.trim();
                const canSaveName =
                  isEditing &&
                  ACCOUNT_NAME_PATTERN.test(trimmedDraftName) &&
                  trimmedDraftName !== account.name &&
                  !accounts.some(other => other.publicKey !== account.publicKey && other.name === trimmedDraftName) &&
                  !isSavingName;
                return (
                  <div key={account.publicKey} className="flex flex-col gap-2">
                    <div
                      className={classNames(
                        'flex w-full items-center rounded-2xl transition-colors',
                        isActive ? 'bg-surface-input' : 'hover:bg-surface-input/60'
                      )}
                    >
                      <button
                        type="button"
                        role="radio"
                        aria-checked={isActive}
                        onClick={() => handleSelectAccount(account.publicKey)}
                        data-testid="accounts-drawer-account"
                        className="flex min-w-0 flex-1 items-center gap-3 rounded-l-2xl px-3 py-3 text-left"
                      >
                        <span
                          className={classNames(
                            'h-6.5 w-9 shrink-0 rounded-md',
                            CARD_COLOR_BG[getCardColor(account.publicKey)]
                          )}
                        />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="truncate text-sm font-bold font-heading text-heading-gray">
                            {account.name}
                          </span>
                          <span className="truncate text-xs text-text-tertiary-token">
                            {truncateAddress(account.publicKey, false, 8)}
                          </span>
                        </span>
                        {isActive && (
                          <Icon
                            name={IconName.Checkmark}
                            className="w-4.5! h-4.5! shrink-0 text-status-positive"
                            fill="currentColor"
                          />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleEditAccount(account.publicKey, account.name)}
                        aria-label={`${t('editAccountName')}: ${account.name}`}
                        className="shrink-0 rounded-r-2xl px-3 py-3 text-xs font-semibold text-text-secondary-token"
                      >
                        {t('edit')}
                      </button>
                    </div>

                    {isEditing && (
                      <form onSubmit={handleNameSubmit} className="flex flex-col gap-2 px-3 pb-2">
                        <input
                          autoFocus
                          maxLength={16}
                          value={draftName}
                          onChange={event => {
                            setDraftName(event.target.value);
                            setNameError('');
                          }}
                          onKeyDown={event => {
                            if (event.key === 'Escape') handleCancelEdit();
                          }}
                          aria-label={t('editAccountName')}
                          aria-invalid={nameError ? true : undefined}
                          className="w-full rounded-xl border border-border-light bg-surface-input px-3 py-2 text-sm text-text-primary-token outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
                        />
                        {nameError && (
                          <span role="alert" className="text-xs text-status-negative">
                            {nameError}
                          </span>
                        )}
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={handleCancelEdit}
                            className="rounded-lg px-3 py-2 text-xs font-semibold text-text-secondary-token"
                          >
                            {t('cancel')}
                          </button>
                          <button
                            type="submit"
                            disabled={!canSaveName}
                            aria-busy={isSavingName}
                            className="rounded-lg bg-accent-primary px-3 py-2 text-xs font-semibold text-pure-white disabled:opacity-40"
                          >
                            {t('confirm')}
                          </button>
                        </div>
                      </form>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <span className="text-base font-bold font-heading uppercase  text-grey-400">{t('cardColor')}</span>
            <div className="flex items-center justify-between">
              {CARD_COLORS.map(color => {
                const isSelected = color === selectedCardColor;
                return (
                  <button
                    key={color}
                    type="button"
                    aria-label={color}
                    aria-pressed={isSelected}
                    onClick={() => handleCardColorSelect(color)}
                    className={classNames(
                      'flex h-10 w-10 items-center justify-center rounded-full',
                      'transition-transform active:scale-95',
                      CARD_COLOR_BG[color]
                    )}
                  >
                    {isSelected && (
                      <Icon name={IconName.Checkmark} className="w-5 h-5 text-pure-white" fill="currentColor" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <button
            type="button"
            onClick={handleSettings}
            className={classNames(
              'flex w-full items-center justify-center gap-2 rounded-xl px-4 py-4',
              'bg-surface-input',
              'text-sm font-semibold text-gray-secondary dark:text-pure-white',
              'transition-colors hover:bg-[#ECEAE7] dark:hover:bg-[#3f3f3f] rounded-2xl'
            )}
          >
            <Icon name={IconName.SettingsNew} className="w-4 h-4" fill="currentColor" />
            <span>{t('settings')}</span>
          </button>

          <button
            type="button"
            onClick={handleAddAccount}
            data-testid="accounts-drawer-add-account"
            className={classNames(
              'flex w-full items-center justify-center gap-2 rounded-xl px-4 py-4',
              'border border-dashed border-[#C7C7CC] bg-transparent',
              'text-sm font-medium text-gray-secondary dark:text-pure-white rounded-2xl',
              'transition-colors hover:bg-surface-input/60'
            )}
          >
            <Icon name={IconName.Add} className="w-4 h-4" fill="currentColor" />
            <span>{t('addAccount')}</span>
          </button>
        </div>
      </DrawerContent>
    </Drawer>
  );
};

export default AccountsDrawer;
