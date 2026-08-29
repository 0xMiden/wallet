import React, { FC, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Loader } from 'components/Loader';
import { useMidenContext } from 'lib/miden/front';
import { hapticLight } from 'lib/mobile/haptics';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { useWalletStore } from 'lib/store';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { navigate } from 'lib/woozie';
import { WalletType } from 'screens/onboarding/types';

export interface AddAccountDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type DrawerStep = 'type' | 'privateRecovery';

interface DrawerOption {
  id: string;
  icon: IconName;
  titleKey: string;
  descriptionKey: string;
}

const TYPE_OPTIONS: DrawerOption[] = [
  {
    id: 'public',
    icon: IconName.Globe,
    titleKey: 'accountTypePublic',
    descriptionKey: 'accountTypePublicDescription'
  },
  {
    id: 'private',
    icon: IconName.EyeOff,
    titleKey: 'accountTypePrivate',
    descriptionKey: 'accountTypePrivateDescription'
  }
];

const RECOVERY_OPTIONS: DrawerOption[] = [
  {
    id: 'guardian',
    icon: IconName.Users,
    titleKey: 'guardianRecovery',
    descriptionKey: 'guardianRecoveryDescription'
  },
  {
    id: 'local',
    icon: IconName.Lock,
    titleKey: 'fullyPrivateRecovery',
    descriptionKey: 'fullyPrivateRecoveryDescription'
  }
];

/**
 * Bottom sheet opened from the BalanceCard "+" button. Step 1 picks the new
 * account's visibility: public (on-chain) accounts are created right here with
 * the default "Account N" name; private swaps the sheet to step 2, which picks
 * how the account should be recoverable — Guardian-backed routes to
 * /add-account/guardian (operator picker), fully local routes to
 * /add-account/private (the risk acknowledgment flow).
 */
export const AddAccountDrawer: FC<AddAccountDrawerProps> = ({ open, onOpenChange }) => {
  const { t } = useTranslation();
  const { createAccount, updateCurrentAccount } = useMidenContext();
  const [step, setStep] = useState<DrawerStep>('type');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hardware/swipe back pops step 2 back to step 1 before the host's handler
  // (registered earlier, so consulted after this one) closes the drawer.
  useMobileBackHandler(() => {
    if (open && step === 'privateRecovery') {
      setStep('type');
      return true;
    }
    return false;
  }, [open, step]);

  const createPublicAccount = async () => {
    setError(null);
    setIsCreating(true);
    const prevKeys = new Set(useWalletStore.getState().accounts.map(a => a.publicKey));
    try {
      // No name: the vault auto-names it "Account N".
      await createAccount(WalletType.OnChain);
      const created = useWalletStore.getState().accounts.find(a => !prevKeys.has(a.publicKey));
      if (created) {
        await updateCurrentAccount(created.publicKey);
      }
      onOpenChange(false);
    } catch (err) {
      console.error('[AddAccountDrawer] create account failed', err);
      setError(err instanceof Error ? err.message : t('smthWentWrong'));
    } finally {
      setIsCreating(false);
    }
  };

  const handleTypeSelect = (optionId: string) => {
    if (isCreating) return;
    hapticLight();
    switch (optionId) {
      case 'public':
        createPublicAccount();
        return;
      case 'private':
        setError(null);
        setStep('privateRecovery');
        return;
    }
  };

  const handleRecoverySelect = (optionId: string) => {
    hapticLight();
    // Reset here rather than relying on handleOpenChange: this close goes
    // through the raw prop, and the next open should start on step 1 again.
    setStep('type');
    onOpenChange(false);
    switch (optionId) {
      case 'guardian':
        navigate('/add-account/guardian');
        return;
      case 'local':
        navigate('/add-account/private');
        return;
    }
  };

  const handleBackToType = () => {
    hapticLight();
    setStep('type');
  };

  const handleOpenChange = (next: boolean) => {
    // Account creation does seconds of WASM work; keep the sheet up so the
    // spinner stays visible and the flow isn't double-triggered.
    if (!next && isCreating) return;
    if (!next) {
      setError(null);
      setStep('type');
    }
    onOpenChange(next);
  };

  const isRecoveryStep = step === 'privateRecovery';
  const options = isRecoveryStep ? RECOVERY_OPTIONS : TYPE_OPTIONS;
  const onSelect = isRecoveryStep ? handleRecoverySelect : handleTypeSelect;

  return (
    <Drawer open={open} onOpenChange={handleOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <div className="relative flex items-center justify-center">
            {isRecoveryStep && (
              <button
                type="button"
                onClick={handleBackToType}
                aria-label={t('back')}
                data-testid="add-account-back"
                className="absolute left-0 flex h-8 w-8 items-center justify-center rounded-full"
              >
                <Icon name={IconName.ChevronLeft} className="w-4.5! h-4.5! text-heading-gray" fill="currentColor" />
              </button>
            )}
            <DrawerTitle>{isRecoveryStep ? t('chooseRecoveryMethod') : t('addAccount')}</DrawerTitle>
          </div>
        </DrawerHeader>

        <div className="flex flex-col gap-2 px-4 pb-6">
          {options.map(option => {
            const isCreatingThis = isCreating && option.id === 'public';
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => onSelect(option.id)}
                disabled={isCreating}
                aria-busy={isCreatingThis}
                data-testid={`add-account-option-${option.id}`}
                className={classNames(
                  'flex w-full items-center gap-3 rounded-2xl bg-surface-input px-4 py-4 text-left transition-colors',
                  isCreating ? 'opacity-70' : 'hover:bg-button-secondary-hover'
                )}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-pure-white dark:bg-grey-800">
                  <Icon name={option.icon} className="w-4.5! h-4.5! text-heading-gray" fill="currentColor" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-bold font-heading text-heading-gray">{t(option.titleKey)}</span>
                  <span className="text-xs text-text-tertiary-token">{t(option.descriptionKey)}</span>
                </span>
                {isCreatingThis ? (
                  <Loader size="sm" aria-label={t('loading')} />
                ) : (
                  <Icon
                    name={IconName.ChevronRight}
                    className="w-4! h-4! shrink-0 text-text-tertiary-token"
                    fill="currentColor"
                  />
                )}
              </button>
            );
          })}

          {error && (
            <p className="text-red-500 text-xs text-center select-text break-words" role="alert">
              {error}
            </p>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
};

export default AddAccountDrawer;
