import React, { FC, useCallback, useEffect, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { AgglayerDeposit, claimAgglayerDeposit, findClaimableMidenToEvmDeposit, useBridgeTracker } from 'lib/agglayer';
import { getCurrentMidenBlock, pollEpochIntentFill } from 'lib/epoch';
import {
  initiateConsumeTransactionFromId,
  requestSWTransactionProcessing,
  updateBridgeClaimStatus
} from 'lib/miden/activity';
import { IBridgeClaimStatus, ITransactionStatus } from 'lib/miden/db/types';
import { useAccount } from 'lib/miden/front';
import { hapticMedium } from 'lib/mobile/haptics';
import { isExtension } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { Button } from 'lib/ui/button';
import { useEvmWalletProvider } from 'lib/walletconnect/useEvmWalletProvider';
import { navigate } from 'lib/woozie';

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
  const account = useAccount();

  const isAgglayer = entry.bridgeProvider === 'agglayer';
  const isEpoch = entry.bridgeProvider === 'epoch';
  const destination = entry.bridgeDestinationAddress ?? '';
  const [status, setStatus] = useState<IBridgeClaimStatus>(entry.bridgeClaimStatus ?? 'not-applicable');
  const [claimable, setClaimable] = useState<AgglayerDeposit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentBlock, setCurrentBlock] = useState<number | null>(null);
  const [reclaiming, setReclaiming] = useState(false);
  const [reclaimError, setReclaimError] = useState<string | null>(null);

  // Epoch (Fast) auto-settles on the destination chain — poll the allocator for
  // the receiving-chain fill (status + tx hash) only while the detail is open.
  const [epochStatus, setEpochStatus] = useState<BridgeStatus>(entry.bridgeEpochStatus ?? 'pending');
  const [fillTxHash, setFillTxHash] = useState<string | undefined>(entry.bridgeFillTxHash);

  const connectedMatchesDestination = !!evmAddress && evmAddress.toLowerCase() === destination.toLowerCase();
  const transactionFailed = entry.status === ITransactionStatus.Failed;

  // Failed Epoch (Fast) bridge-out: the funds sit in a recallable P2IDE note that
  // the sender can reclaim once the reclaim height passes. Gate a "Reclaim funds"
  // button on that block height.
  const reclaimHeight = entry.bridgeReclaimHeight;
  const reclaimNoteId = entry.outputNoteIds?.[0];
  // `transactionFailed` is exactly the state import forces every unfinished
  // restored row into, so without the flag check a dump naming any note id gets
  // a "Reclaim funds" button that queues a real consume through the signer.
  const canShowReclaim =
    isEpoch && transactionFailed && !entry.restoredFromBackup && reclaimHeight != null && !!reclaimNoteId;
  const reclaimReached =
    canShowReclaim && currentBlock != null && reclaimHeight != null && currentBlock >= reclaimHeight;

  // Poll the bridge indexer for a claimable deposit to the destination. Stateless
  // / indexer-driven, so it surfaces deposits from a previous session too.
  useBridgeTracker({
    // A restored row polls nothing and claims nothing: `destination` and the
    // deposit it matches come from the dump, and `handleClaim` signs an EVM
    // transaction. Display still shows whatever the backup recorded.
    active: isAgglayer && !transactionFailed && !entry.restoredFromBackup && status !== 'claimed' && !!destination,
    intervalMs: 8000,
    poll: async () => {
      const deposit = await findClaimableMidenToEvmDeposit(destination);
      if (!deposit) return false;
      setClaimable(deposit);
      if (status === 'pending' && entry.txId) {
        setStatus('ready');
        await updateBridgeClaimStatus(entry.txId, 'ready', { depositReady: true });
        onUpdated();
      }
      return true;
    }
  });

  // Epoch fill poll. Runs on mount + every 8s while still pending; persists the
  // receiving tx hash / terminal status and reloads the row once it settles so
  // the hero pill flips to Confirmed.
  const intentNonce = entry.bridgeIntentNonce;
  const txId = entry.txId;
  useEffect(() => {
    if (!isEpoch || epochStatus === 'confirmed' || epochStatus === 'failed') return;
    if (!intentNonce || !destination || !txId) return;

    let cancelled = false;
    const tick = async () => {
      const fill = await pollEpochIntentFill({ destinationAddress: destination, intentNonce });
      if (cancelled || !fill) return;
      if (fill.fillTxHash) setFillTxHash(fill.fillTxHash);
      setEpochStatus(fill.status);
      if (fill.fillTxHash || fill.status !== 'pending') {
        await updateBridgeClaimStatus(txId, 'not-applicable', {
          epochStatus: fill.status,
          fillTxHash: fill.fillTxHash,
          fillChainId: fill.fillChainId
        });
      }
      if (fill.status === 'confirmed' || fill.status === 'failed') onUpdated();
    };
    tick();
    const id = setInterval(tick, 8000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isEpoch, epochStatus, intentNonce, destination, txId, onUpdated]);

  const handleClaim = useCallback(async () => {
    if (!claimable || !evmProvider || !entry.txId || entry.restoredFromBackup) return;
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
  }, [claimable, evmProvider, entry.txId, entry.restoredFromBackup, onUpdated]);

  // Read the current Miden block once, to know whether the reclaim window has opened.
  useEffect(() => {
    if (!canShowReclaim) return;
    let cancelled = false;
    getCurrentMidenBlock()
      .then(block => {
        if (!cancelled) setCurrentBlock(block);
      })
      .catch(err => console.warn('[bridge-claim] getCurrentMidenBlock failed', err));
    return () => {
      cancelled = true;
    };
  }, [canShowReclaim]);

  const handleReclaim = useCallback(async () => {
    if (!reclaimNoteId) return;
    hapticMedium();
    setReclaimError(null);
    setReclaiming(true);
    try {
      // Reclaim = the sender consuming their own recallable P2IDE note by id.
      const txId = await initiateConsumeTransactionFromId(account.publicKey, reclaimNoteId, isDelegateProofEnabled());
      if (isExtension()) requestSWTransactionProcessing();
      navigate(`/generating-transaction-full/${encodeURIComponent(txId)}`);
    } catch (err) {
      console.error('[bridge-claim] reclaim failed', err);
      setReclaimError(err instanceof Error ? err.message : 'Reclaim failed');
      setReclaiming(false);
    }
  }, [reclaimNoteId, account.publicKey]);

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

      {/* Failed Epoch (Fast) bridge: reclaim the recallable P2IDE note once its
          reclaim window opens (funds return to the sender's Miden account). */}
      {canShowReclaim && (
        <div className="mt-3 flex flex-col gap-2">
          {reclaimError && (
            <p className="text-red-500 text-xs" role="alert">
              {reclaimError}
            </p>
          )}
          {reclaimReached ? (
            <Button variant="default" size="lg" onClick={handleReclaim} disabled={reclaiming}>
              {reclaiming ? t('reclaiming') : t('reclaimFunds')}
            </Button>
          ) : (
            <p className="text-xs text-heading-gray/60">
              {t('reclaimableAfterBlock')} {reclaimHeight}
            </p>
          )}
        </div>
      )}
    </div>
  );
};
