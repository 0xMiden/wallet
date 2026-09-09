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

type DrawerStep = 'type' | 'privateRecovery' | 'restore';

/** Bounds for the restore scan window (mirrors the vault guard). */
const MIN_SCAN_COUNT = 1;
const MAX_SCAN_COUNT = 20;
const DEFAULT_SCAN_COUNT = 5;

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
  },
  {
    id: 'restore',
    icon: IconName.Refresh,
    titleKey: 'restoreExistingAccount',
    descriptionKey: 'restoreExistingAccountDescription'
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
  const { createAccount, updateCurrentAccount, scanForAccounts } = useMidenContext();
  // Only an own-mnemonic wallet has anything to re-derive and rescan for.
  const ownMnemonic = useWalletStore(s => s.ownMnemonic);
  const [step, setStep] = useState<DrawerStep>('type');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanCountInput, setScanCountInput] = useState(String(DEFAULT_SCAN_COUNT));
  const [isScanning, setIsScanning] = useState(false);
  const [scanResult, setScanResult] = useState<number | null>(null);

  // Hardware/swipe back pops step 2 back to step 1 before the host's handler
  // (registered earlier, so consulted after this one) closes the drawer.
  useMobileBackHandler(() => {
    if (open && step !== 'type') {
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
      case 'restore':
        setError(null);
        setScanResult(null);
        setStep('restore');
        return;
    }
  };

  const parsedScanCount = Number.parseInt(scanCountInput, 10);
  const scanCountValid =
    Number.isInteger(parsedScanCount) && parsedScanCount >= MIN_SCAN_COUNT && parsedScanCount <= MAX_SCAN_COUNT;

  const handleScan = async () => {
    if (!scanCountValid || isScanning) return;
    hapticLight();
    setError(null);
    setScanResult(null);
    setIsScanning(true);
    try {
      // Guardian endpoint is sourced from a sibling account inside the vault;
      // no picker needed here.
      const found = await scanForAccounts(parsedScanCount);
      setScanResult(found.length);
    } catch (err) {
      console.error('[AddAccountDrawer] account scan failed', err);
      setError(err instanceof Error ? err.message : t('smthWentWrong'));
    } finally {
      setIsScanning(false);
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
    // Account creation / scanning does seconds of WASM work; keep the sheet up
    // so the spinner stays visible and the flow isn't double-triggered.
    if (!next && (isCreating || isScanning)) return;
    if (!next) {
      setError(null);
      setScanResult(null);
      setStep('type');
    }
    onOpenChange(next);
  };

  const isRecoveryStep = step === 'privateRecovery';
  const isRestoreStep = step === 'restore';
  // A wallet restored from an encrypted file has no mnemonic to re-derive —
  // hide the rescan entry entirely.
  const typeOptions = ownMnemonic ? TYPE_OPTIONS : TYPE_OPTIONS.filter(option => option.id !== 'restore');
  const options = isRecoveryStep ? RECOVERY_OPTIONS : typeOptions;
  const onSelect = isRecoveryStep ? handleRecoverySelect : handleTypeSelect;

  const headerTitle = (() => {
    switch (step) {
      case 'privateRecovery':
        return t('chooseRecoveryMethod');
      case 'restore':
        return t('restoreExistingAccount');
      default:
        return t('addAccount');
    }
  })();

  return (
    <Drawer open={open} onOpenChange={handleOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <div className="relative flex items-center justify-center">
            {step !== 'type' && (
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
            <DrawerTitle>{headerTitle}</DrawerTitle>
          </div>
        </DrawerHeader>

        {isRestoreStep ? (
          <div className="flex flex-col gap-3 px-4 pb-6">
            <div className="flex flex-col gap-1">
              <label htmlFor="add-account-scan-count" className="text-xs text-text-tertiary-token">
                {t('howManyMoreAccounts')}
              </label>
              <input
                id="add-account-scan-count"
                data-testid="add-account-scan-count"
                inputMode="numeric"
                pattern="[0-9]*"
                value={scanCountInput}
                disabled={isScanning}
                onChange={event => setScanCountInput(event.target.value)}
                className="w-full rounded-xl border border-border-light bg-surface-input px-3 py-2 text-sm text-text-primary-token outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
              />
            </div>
            <button
              type="button"
              onClick={handleScan}
              disabled={!scanCountValid || isScanning}
              aria-busy={isScanning}
              data-testid="add-account-scan-submit"
              className={classNames(
                'flex w-full items-center justify-center gap-2 rounded-2xl bg-surface-input px-4 py-4',
                'text-sm font-bold font-heading text-heading-gray transition-colors',
                isScanning || !scanCountValid ? 'opacity-70' : 'hover:bg-button-secondary-hover'
              )}
            >
              {isScanning ? (
                <>
                  <Loader size="sm" aria-label={t('loading')} />
                  <span>{t('scanningForAccounts')}</span>
                </>
              ) : (
                <span>{t('searchForAccounts')}</span>
              )}
            </button>
            {scanResult !== null && (
              <p className="text-xs text-center text-text-tertiary-token" data-testid="add-account-scan-result">
                {scanResult === 0
                  ? t('noAdditionalAccountsFound')
                  : t('foundAdditionalAccounts', { count: scanResult })}
              </p>
            )}
            {error && (
              <p className="text-red-500 text-xs text-center select-text break-words" role="alert">
                {error}
              </p>
            )}
          </div>
        ) : (
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
        )}
      </DrawerContent>
    </Drawer>
  );
};

export default AddAccountDrawer;
