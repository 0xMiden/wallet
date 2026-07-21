import React, { FC, useCallback, useEffect, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { AgglayerDeposit, claimAgglayerDeposit, findClaimableMidenToEvmDeposit } from 'lib/agglayer';
import { updateBridgeClaimStatus } from 'lib/miden/activity';
import { IBridgeClaimStatus, ITransactionStatus } from 'lib/miden/db/types';
import { hapticMedium } from 'lib/mobile/haptics';
import { Button } from 'lib/ui/button';
import { useEvmWalletProvider } from 'lib/walletconnect/useEvmWalletProvider';

import HashChip from '../HashChip';
import { DetailCard, DetailRow, ExternalLinkValue } from './DetailCard';
import { IHistoryEntry } from './IHistoryEntry';
import { BridgeStatus } from './transactionUtils';

const SEPOLIA_ADDRESS_URL = (addr: string) => `https://sepolia.etherscan.io/address/${addr}`;
const SEPOLIA_TX_URL = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;

const EPOCH_STATUS_LABEL: Record<BridgeStatus, string> = {
  pending: 'bridgeInProgress',
  confirmed: 'confirmed',
  failed: 'bridgeFailed'
};

const CLAIM_STATUS_LABEL: Record<IBridgeClaimStatus, string> = {
  'not-applicable': 'noManualClaimRequired',
  pending: 'claimPending',
  ready: 'claimable',
  claiming: 'claiming',
  claimed: 'claimed',
  failed: 'claimFailedStatus'
};

interface BridgeClaimSectionProps {
  entry: IHistoryEntry;
  /** Re-load the transaction so persisted claim-status changes are reflected. */
  onUpdated: () => void;
}

/**
 * Activity-detail panel for a `bridged-send`: shows route + EVM destination +
 * claim status, and — for the Agglayer (Slow) route — a "Claim Asset" button
 * that pulls the L1 claimable deposit and submits `claimAsset` from the
 * connected EVM wallet. Works on web AND native via `useEvmWalletProvider`. The
 * claim must be made from the destination wallet, so the button is gated on the
 * connected address matching the bridge destination. Epoch (Fast) auto-settles,
 * so it shows "no manual claim required" instead.
 */
export const BridgeClaimSection: FC<BridgeClaimSectionProps> = ({ entry, onUpdated }) => {
  const { t } = useTranslation();
  const { provider: evmProvider, address: evmAddress, isConnected, connect } = useEvmWalletProvider();

  const isAgglayer = entry.bridgeProvider === 'agglayer';
  const isEpoch = entry.bridgeProvider === 'epoch';
  const destination = entry.bridgeDestinationAddress ?? '';
  const [status, setStatus] = useState<IBridgeClaimStatus>(entry.bridgeClaimStatus ?? 'not-applicable');
  const [claimable, setClaimable] = useState<AgglayerDeposit | null>(null);
  const [error, setError] = useState<string | null>(null);

  const epochStatus: BridgeStatus = entry.bridgeEpochStatus ?? 'pending';
  const fillTxHash = entry.bridgeFillTxHash;

  const connectedMatchesDestination = !!evmAddress && evmAddress.toLowerCase() === destination.toLowerCase();
  const transactionFailed = entry.status === ITransactionStatus.Failed;

  // Settlement polling lives in the home PromptCard. Once it marks an Agglayer
  // bridge ready, fetch the deposit payload once so this screen can submit the claim.
  useEffect(() => {
    if (!isAgglayer || transactionFailed || status !== 'ready' || !destination || claimable) return;

    let cancelled = false;
    findClaimableMidenToEvmDeposit(destination)
      .then(deposit => {
        if (!cancelled) setClaimable(deposit);
      })
      .catch(err => console.warn('[bridge-claim] failed to load claimable deposit', err));
    return () => {
      cancelled = true;
    };
  }, [claimable, destination, isAgglayer, status, transactionFailed]);

  const handleClaim = useCallback(async () => {
    if (!claimable || !evmProvider || !entry.txId) return;
    hapticMedium();
    setError(null);
    setStatus('claiming');
    await updateBridgeClaimStatus(entry.txId, 'claiming');
    try {
      const tx = await claimAgglayerDeposit({ deposit: claimable, provider: evmProvider, network: 'sepolia' });
      await tx.wait();
      setStatus('claimed');
      await updateBridgeClaimStatus(entry.txId, 'claimed', { claimTxHash: tx.hash });
      setClaimable(null);
      onUpdated();
    } catch (err) {
      console.error('[bridge-claim] claim failed', err);
      setStatus('failed');
      await updateBridgeClaimStatus(entry.txId, 'failed');
      setError(err instanceof Error ? err.message : 'Claim failed');
    }
  }, [claimable, evmProvider, entry.txId, onUpdated]);

  return (
    <div className="mt-6 mb-4">
      <DetailCard title={t('bridgeDetails')}>
        <DetailRow label={t('route')}>
          <span className="text-sm text-heading-gray font-medium">
            {entry.bridgeProvider === 'epoch' ? t('fastRouteLabel') : t('slowRouteLabel')}
          </span>
        </DetailRow>
        {destination && (
          <DetailRow label={t('to')}>
            <ExternalLinkValue
              displayValue={<HashChip hash={destination} trimHash fill="#9E9E9E" className="ml-2" copyIcon={false} />}
              href={SEPOLIA_ADDRESS_URL(destination)}
            />
          </DetailRow>
        )}
        <DetailRow label={t('destinationNetwork')} value="Sepolia" />
        <DetailRow label={isEpoch ? t('status') : t('claimStatus')} isLast={!(isEpoch && fillTxHash)}>
          <span className="text-sm text-heading-gray font-medium">
            {transactionFailed
              ? t('bridgeFailed')
              : isEpoch
                ? t(EPOCH_STATUS_LABEL[epochStatus])
                : t(CLAIM_STATUS_LABEL[status])}
          </span>
        </DetailRow>
        {isEpoch && fillTxHash && (
          <DetailRow label={t('receivingTx')} isLast>
            <ExternalLinkValue
              displayValue={<HashChip hash={fillTxHash} trimHash fill="#9E9E9E" className="ml-2" copyIcon={false} />}
              href={SEPOLIA_TX_URL(fillTxHash)}
            />
          </DetailRow>
        )}
      </DetailCard>

      {/* Claim UI is Agglayer-only — Epoch (Fast) auto-settles, so it shows none. */}
      {isAgglayer &&
        !transactionFailed &&
        (status !== 'claimed' ? (
          <div className="mt-3 flex flex-col gap-2">
            {error && (
              <p className="text-red-500 text-xs" role="alert">
                {error}
              </p>
            )}
            {!isConnected ? (
              <Button variant="default" size="lg" onClick={connect}>
                {t('connectEvmWallet')}
              </Button>
            ) : !connectedMatchesDestination ? (
              <p className="text-xs text-heading-gray/60">{t('connectDestinationWalletToClaim')}</p>
            ) : (
              <Button variant="default" size="lg" onClick={handleClaim} disabled={!claimable || status === 'claiming'}>
                {status === 'claiming' ? t('claiming') : !claimable ? t('claimPending') : t('claimAsset')}
              </Button>
            )}
          </div>
        ) : (
          <div className="mt-3 text-xs text-[#1A9C52]">{t('claimAssetSubmitted')}</div>
        ))}
    </div>
  );
};
