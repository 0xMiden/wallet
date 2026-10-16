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
export const DappNetworkMismatchNotice: FC<{ claimedNetwork: string | undefined; className?: string }> = ({
  claimedNetwork,
  className
}) => {
  const { t } = useTranslation();
  const walletNetwork = getEffectiveNetworkName();
  if (!claimedNetwork || claimedNetwork === walletNetwork) return null;

  return (
    <Notice
      tone="warning"
      variant="inline"
      icon={<Icon name={IconName.WarningFill} size="xs" fill="currentColor" />}
      className={className}
      data-testid="dapp-network-mismatch"
    >
      {t('dappNetworkMismatch', { dappNetwork: t(claimedNetwork), walletNetwork: t(walletNetwork) })}
    </Notice>
  );
};
