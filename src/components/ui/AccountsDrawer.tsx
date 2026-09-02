import React, { FC, FormEvent, useEffect, useState } from 'react';

import classNames from 'clsx';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { ACCOUNT_NAME_PATTERN } from 'app/defaults';
import { Icon, IconName } from 'app/icons/v2';
import { springs, useMotion } from 'lib/animation';
import { toLocalFormat } from 'lib/i18n/numbers';
import { useMidenContext } from 'lib/miden/front';
import type { TokenBalanceData } from 'lib/miden/front';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { hapticLight } from 'lib/mobile/haptics';
import { getTokenPrice } from 'lib/prices';
import type { TokenPrices } from 'lib/prices';
import { getCardColor, initializeAccountCardColors, setCardColor, useCardColor } from 'lib/settings/card-color';
import { CARD_COLORS, CardColor } from 'lib/settings/constants';
import { useWalletStore } from 'lib/store';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { navigate } from 'lib/woozie';
import { truncateAddress } from 'utils/string';

import { CARD_COLOR_BG } from './BalanceCard';

function formatAccountBalance(accountBalances: TokenBalanceData[] | undefined, tokenPrices: TokenPrices): string {
  if (!accountBalances || Object.keys(tokenPrices).length === 0) return '$—';

  const totalFiat = accountBalances.reduce((sum, token) => {
    if (!hasKnownScale(token.metadata)) return sum;
    return sum + token.balance * getTokenPrice(tokenPrices, token.metadata.symbol).price;
  }, 0);

  return `$${toLocalFormat(totalFiat, { decimalPlaces: 2 })}`;
}

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
  const balances = useWalletStore(s => s.balances);
  const tokenPrices = useWalletStore(s => s.tokenPrices);
  const selectedCardColor = useCardColor(currentAccount?.publicKey);
  const { editAccountName, updateCurrentAccount } = useMidenContext();
  const [editingAccountId, setEditingAccountId] = useState<string>();
  const [draftName, setDraftName] = useState('');
  const [nameError, setNameError] = useState('');
  const [isSavingName, setIsSavingName] = useState(false);
  const cardHoverTransition = useMotion(springs.snappy);

  const orderedAccounts = currentAccount
    ? accounts
        .filter(account => account.publicKey === currentAccount.publicKey)
        .concat(accounts.filter(account => account.publicKey !== currentAccount.publicKey))
    : accounts;
  const editingAccount = accounts.find(account => account.publicKey === editingAccountId);
  const trimmedDraftName = draftName.trim();
  const canSaveName = Boolean(
    editingAccount &&
    ACCOUNT_NAME_PATTERN.test(trimmedDraftName) &&
    trimmedDraftName !== editingAccount.name &&
    !accounts.some(account => account.publicKey !== editingAccount.publicKey && account.name === trimmedDraftName) &&
    !isSavingName
  );

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

        <div className="flex flex-col gap-4 overflow-y-auto overscroll-contain px-4 pb-6">
          {accounts.length > 0 && (
            <div
              className="isolate flex w-[390px] max-w-full flex-col-reverse self-center"
              role="radiogroup"
              aria-label={t('accounts')}
            >
              {orderedAccounts.map((account, index) => {
                const isActive = account.publicKey === currentAccount?.publicKey;
                const formattedBalance = formatAccountBalance(balances[account.publicKey], tokenPrices);
                return (
                  <div
                    key={account.publicKey}
                    style={{ zIndex: orderedAccounts.length - index }}
                    className={classNames('relative shrink-0', index === 0 ? 'h-42.5' : 'h-10')}
                  >
                    <motion.div
                      data-testid="accounts-drawer-card"
                      whileHover={isActive ? undefined : { y: -8 }}
                      transition={cardHoverTransition}
                      className={classNames(
                        'absolute inset-x-0 top-0 h-[170px] overflow-hidden rounded-2xl shadow-md',
                        'text-surface-balance-fg',
                        CARD_COLOR_BG[getCardColor(account.publicKey)]
                      )}
                    >
                      <button
                        type="button"
                        role="radio"
                        aria-checked={isActive}
                        onClick={() => handleSelectAccount(account.publicKey)}
                        data-testid="accounts-drawer-account"
                        aria-label={account.name}
                        className={classNames(
                          'flex h-full w-full flex-col justify-between p-4 text-left',
                          'outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-inset'
                        )}
                      >
                        <span className="flex min-w-0 items-center">
                          <span className="shrink-0 rounded-lg bg-surface-balance-rule px-3 py-1.5 font-heading text-xs font-semibold uppercase leading-none">
                            {t(account.isPublic ? 'accountTypePublic' : 'accountTypePrivate')}
                          </span>
                        </span>

                        <span className="flex min-w-0 flex-col gap-1">
                          <span className="text-4xl font-extrabold leading-none">{formattedBalance}</span>
                          <span className="text-xs text-pure-white">
                            {truncateAddress(account.publicKey, false, 8)}
                          </span>
                        </span>
                      </button>

                      <span className="pointer-events-none absolute right-4 top-4 z-10 flex max-w-[60%] items-center">
                        <span
                          data-testid="accounts-drawer-account-name"
                          className="min-w-0 truncate text-sm font-semibold text-pure-white"
                        >
                          {account.name}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleEditAccount(account.publicKey, account.name)}
                          aria-label={`${t('editAccountName')}: ${account.name}`}
                          className={classNames(
                            'pointer-events-auto flex h-4 w-4 shrink-0 items-center justify-center text-pure-white outline-none',
                            'focus-visible:ring-2 focus-visible:ring-primary-500'
                          )}
                        >
                          <Icon name={IconName.Edit} className="w-3.5! h-3.5!" fill="none" />
                        </button>
                      </span>
                    </motion.div>
                  </div>
                );
              })}
            </div>
          )}

          {editingAccount && (
            <form onSubmit={handleNameSubmit} className="flex flex-col gap-2 rounded-2xl bg-surface-input p-3">
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
                className="w-full rounded-xl border border-border-light bg-surface-solid px-3 py-2 text-sm text-text-primary-token outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
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
