import React, { useMemo } from 'react';

import { useTranslation } from 'react-i18next';
import { formatUnits } from 'viem';

import { Loader } from 'components/Loader';
import { midenAddrToEvmAddr, useIncomingBridge } from 'lib/agglayer';
import { useAccount } from 'lib/miden/front';

// Pinned banner shown above the Activity list while an Agglayer bridge is still
// settling. Polls the bridge indexer for the current account's destination
// address and clears itself once the deposit is claimable on the Miden side.
export const AgglayerBridgeBanner: React.FC = () => {
  const { t } = useTranslation();
  const account = useAccount();

  const destAddr = useMemo(() => {
    try {
      return midenAddrToEvmAddr(account.publicKey);
    } catch {
      return null;
    }
  }, [account.publicKey]);

  const pending = useIncomingBridge(destAddr);

  if (!pending) return null;

  // Native ETH only for now, so 18 decimals; show amount only when meaningful.
  const eth = formatUnits(BigInt(pending.amount), 18);
  const amountLabel = pending.amount !== '0' ? `${eth} ETH` : '';

  return (
    <div className="mb-3 flex items-center gap-3 rounded-10 border border-rule-strong bg-white px-3 py-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-primary/10">
        <Loader size="sm" color="var(--accent-primary)" />
      </div>
      <div className="flex flex-col">
        <span className="text-sm font-semibold text-heading-gray dark:text-pure-white">
          {t('agglayerBridgeInProgressTitle')}
        </span>
        <span className="text-xs text-grey-500">
          {amountLabel
            ? t('agglayerBridgeInProgressSubtitle', { amount: amountLabel })
            : t('agglayerBridgeInProgressSubtitleNoAmount')}
        </span>
      </div>
    </div>
  );
};
