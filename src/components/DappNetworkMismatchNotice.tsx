import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Notice } from 'components/ui/Notice';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';

/**
 * Warns on a connect request whose dApp claimed another Miden network than the one the wallet is on, naming both.
 * Every request the dApp makes runs on the wallet's own network, and the adapter's defaults claim testnet whatever
 * the wallet is on. Renders nothing when the dApp claimed no network or the wallet's own.
 */
export const DappNetworkMismatchNotice: FC<{
  claimedNetwork: string | undefined;
  /**
   * `inline` (default): the caption line under a sheet's details. `fact`: the titled card the extension's
   * connect window draws beside its list of facts.
   */
  variant?: 'inline' | 'fact';
  className?: string;
}> = ({ claimedNetwork, variant = 'inline', className }) => {
  const { t } = useTranslation();
  const walletNetwork = getEffectiveNetworkName();
  if (!claimedNetwork || claimedNetwork === walletNetwork) return null;

  const fact = variant === 'fact';
  return (
    <Notice
      tone="warning"
      variant={variant}
      title={fact ? t('dappNetworkMismatchTitle') : undefined}
      icon={<Icon name={fact ? IconName.FactAlert : IconName.WarningFill} size="xs" fill="currentColor" />}
      className={className}
      data-testid="dapp-network-mismatch"
    >
      {t('dappNetworkMismatch', { dappNetwork: t(claimedNetwork), walletNetwork: t(walletNetwork) })}
    </Notice>
  );
};
