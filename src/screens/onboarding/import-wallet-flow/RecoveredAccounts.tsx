import React, { useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { hapticLight } from 'lib/mobile/haptics';
import { WalletAccount } from 'lib/shared/types';
import { Badge } from 'lib/ui/badge';
import { truncateAddress } from 'utils/string';

import { WalletType } from '../types';

/** Bounds for the "search N more" extension window (mirrors the vault guard). */
const MIN_SCAN_MORE_COUNT = 1;
const MAX_SCAN_MORE_COUNT = 20;
const DEFAULT_SCAN_MORE_COUNT = 5;

export interface RecoveredAccountsScreenProps {
  accounts: WalletAccount[];
  isScanning?: boolean;
  scanError?: string | null;
  /** Set after an extension scan that appended nothing, so the screen can say so. */
  lastScanFoundNone?: boolean;
  onScanMore: (count: number) => void;
  onContinue: () => void;
}

function accountTypeBadgeKey(account: WalletAccount): string {
  switch (account.type) {
    case WalletType.Guardian:
      return 'accountBadgeGuardian';
    case WalletType.OnChain:
      return 'accountBadgePublic';
    default:
      return 'accountBadgePrivate';
  }
}

/**
 * Post-restore overview: every account the seed-recovery scan found, plus the
 * "I have more accounts" extension (asks how many more HD indices to search).
 * Pure presentational — the host (Welcome / ForgotPassword) owns the scan
 * call and the live accounts list.
 */
export const RecoveredAccountsScreen: React.FC<RecoveredAccountsScreenProps> = ({
  accounts,
  isScanning,
  scanError,
  lastScanFoundNone,
  onScanMore,
  onContinue
}) => {
  const { t } = useTranslation();
  const [showScanMore, setShowScanMore] = useState(false);
  const [countInput, setCountInput] = useState(String(DEFAULT_SCAN_MORE_COUNT));

  const parsedCount = Number.parseInt(countInput, 10);
  const countValid =
    Number.isInteger(parsedCount) && parsedCount >= MIN_SCAN_MORE_COUNT && parsedCount <= MAX_SCAN_MORE_COUNT;

  const handleToggleScanMore = () => {
    hapticLight();
    setShowScanMore(prev => !prev);
  };

  const handleScanMore = () => {
    if (!countValid || isScanning) return;
    hapticLight();
    onScanMore(parsedCount);
  };

  const handleContinue = () => {
    hapticLight();
    onContinue();
  };

  return (
    <div
      className="flex-1 flex flex-col items-center bg-transparent pt-6 h-full px-4 text-heading-gray gap-6"
      data-testid="recovered-accounts"
    >
      <div className="flex flex-col items-center gap-2">
        <h1 className="font-semibold text-2xl lh-title">{t('recoveredAccountsTitle')}</h1>
        <p className="text-xs text-center lh-title px-4">
          {t('recoveredAccountsSubtitle', { count: accounts.length })}
        </p>
      </div>

      <div className="flex w-full flex-1 flex-col gap-1 overflow-y-auto">
        {accounts.map(account => (
          <div
            key={account.publicKey}
            data-testid="recovered-account-row"
            className="flex w-full items-center gap-3 rounded-2xl bg-white px-3 py-3"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
              <span className="truncate text-sm font-bold font-heading text-heading-gray">{account.name}</span>
              <span className="truncate text-xs text-text-tertiary-token">
                {truncateAddress(account.publicKey, false, 8)}
              </span>
            </span>
            <Badge variant="default" className="shrink-0">
              {t(accountTypeBadgeKey(account))}
            </Badge>
          </div>
        ))}
      </div>

      <div className="flex w-full flex-col gap-2">
        {isScanning && (
          <div className="flex items-center gap-2 self-center" data-testid="recovered-accounts-scanning">
            <span className="w-4 h-4 rounded-full border-2 border-grey-200 border-t-primary-500 animate-spin" />
            <span className="text-sm text-grey-600">{t('scanningForAccounts')}</span>
          </div>
        )}
        {!isScanning && lastScanFoundNone && (
          <p className="text-xs text-center text-grey-600">{t('noAdditionalAccountsFound')}</p>
        )}
        {!isScanning && scanError && <p className="text-xs text-center text-red-500">{scanError}</p>}

        {showScanMore && !isScanning && (
          <div className="flex w-full items-center gap-2">
            <div className="flex flex-1 flex-col gap-1">
              <label htmlFor="scan-more-count" className="text-xs text-grey-600">
                {t('howManyMoreAccounts')}
              </label>
              <input
                id="scan-more-count"
                data-testid="scan-more-count"
                inputMode="numeric"
                pattern="[0-9]*"
                value={countInput}
                onChange={event => setCountInput(event.target.value)}
                className="w-full rounded-xl border border-border-light bg-surface-input px-3 py-2 text-sm text-text-primary-token outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
              />
            </div>
            <Button
              data-testid="scan-more-submit"
              title={t('searchForAccounts')}
              onClick={handleScanMore}
              disabled={!countValid}
              className="text-base self-end"
            />
          </div>
        )}

        {!showScanMore && (
          <Button
            data-testid="recovered-accounts-scan-more"
            title={t('iHaveMoreAccounts')}
            variant={ButtonVariant.Secondary}
            onClick={handleToggleScanMore}
            disabled={Boolean(isScanning)}
            className="text-base"
          />
        )}
        <Button
          data-testid="recovered-accounts-continue"
          title={t('continue')}
          onClick={handleContinue}
          disabled={Boolean(isScanning)}
          className="text-base"
        />
      </div>
    </div>
  );
};
