import React, { FC, useCallback, useEffect, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useNetworkFeeEstimate } from 'app/hooks/useNetworkFeeEstimate';
import { Button } from 'components/ui/Button';
import { DetailRow } from 'components/ui/DetailCard';
import { StatusBadge } from 'components/ui/StatusBadge';
import {
  AgglayerDeposit,
  agglayerClaimedFields,
  claimAgglayerDeposit,
  findAgglayerExitDeposit,
  isAgglayerDepositClaimed,
  isAgglayerDepositReady,
  useBridgeTracker
} from 'lib/agglayer';
import { getCurrentMidenBlock, pollEpochIntentFill } from 'lib/epoch';
import {
  initiateConsumeTransactionFromId,
  pinAgglayerDeposit,
  requestSWTransactionProcessing,
  updateBridgeClaimStatus
} from 'lib/miden/activity';
import { IBridgeClaimStatus, ITransactionStatus } from 'lib/miden/db/types';
import { useAccount } from 'lib/miden/front';
import { hapticMedium } from 'lib/mobile/haptics';
import { isExtension } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { DEFAULT_CHAIN_ID, getChain } from 'lib/walletconnect/config';
import { useEvmWalletProvider } from 'lib/walletconnect/useEvmWalletProvider';
import { navigate } from 'lib/woozie';

import HashChip from '../HashChip';
import { DetailSection } from './DetailSection';
import { IHistoryEntry } from './IHistoryEntry';
import { ExternalLinkValue } from './TransactionStatus';
import { bridgeBadgeStatusOf, BridgeStatus } from './transactionUtils';

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
  /**
   * Whether the row came from a restored backup, read straight off the
   * transaction rather than off `entry`.
   *
   * Required, and deliberately not optional: this panel owns four separate
   * affordances that poll or sign, and an earlier revision read the flag off
   * `entry` — whose producer here builds an object literal closed with an
   * `as IHistoryEntry` cast and never set the field. Every guard silently read
   * `undefined` and did nothing. A required prop makes the compiler ask.
   */
  restoredFromBackup: boolean;
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
export const BridgeClaimSection: FC<BridgeClaimSectionProps> = ({ entry, restoredFromBackup }) => {
  const { t } = useTranslation();
  const maxNetworkFee = useNetworkFeeEstimate();
  const { provider: evmProvider, address: evmAddress, isConnected, connect } = useEvmWalletProvider();
  const account = useAccount();

  const isAgglayer = entry.bridgeProvider === 'agglayer';
  const isEpoch = entry.bridgeProvider === 'epoch';
  const isUsdcx = entry.bridgeProvider === 'usdcx';
  const destination = entry.bridgeDestinationAddress ?? '';
  const destinationChain = getChain(entry.bridgeDestinationNetwork ?? DEFAULT_CHAIN_ID);
  const [status, setStatus] = useState<IBridgeClaimStatus>(entry.bridgeClaimStatus ?? 'not-applicable');
  const [claimable, setClaimable] = useState<AgglayerDeposit | null>(null);
  // This panel's own claim, not the row's `claiming`: a page that died mid-claim (the extension popup closes when
  // focus moves to the EVM wallet) leaves the row `claiming` with nothing in flight, and its deposit stays claimable.
  const [claimInFlight, setClaimInFlight] = useState(false);
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
  // The indexer's tx_hash for this row's B2AGG note: the only thing that binds a deposit lookup to THIS row
  // (lib/agglayer/status.ts). A row without one, or one no lookup can find, never looks a deposit up and offers no
  // claim.
  const exitTxHash = entry.bridgeAgglayerExitUnfindable ? undefined : entry.bridgeAgglayerExitTxHash;
  const [pinnedDepositCnt, setPinnedDepositCnt] = useState<number | undefined>(entry.bridgeAgglayerDepositCnt);
  // An unconfirmed failed row may still have landed; its exit hash binds the lookup to its own deposit.
  const mayStillClaim = !transactionFailed || (entry.isUnconfirmed === true && !!exitTxHash);

  // A failed Epoch (Fast) bridge-out offers "Reclaim funds" once the reclaim height
  // passes, and only while its note may exist: the allocator rejected the intent after
  // the note committed, or the outcome is unknown. A definite failure never sent its
  // note, so a reclaim would consume nothing (#1250). The stamped note id stands in for
  // a committed one only when the pipeline claimed its submit, so an unconfirmed or
  // route-failed row demoted before its claim offers nothing. A Completed row whose
  // fill failed is reclaimable too: its note committed and stayed Completed.
  const noteMayExist = entry.isUnconfirmed === true || entry.bridgeEpochStatus === 'failed';
  const reclaimHeight = entry.bridgeReclaimHeight;
  const reclaimNoteId =
    entry.outputNoteIds?.[0] ??
    (entry.bridgeSubmitClaimed === true && (entry.isUnconfirmed === true || entry.bridgeEpochStatus === 'failed')
      ? entry.bridgeReclaimNoteId
      : undefined);
  // On the extension the page submits the intent, not the realm running the note pipeline, so a page closed after the
  // note committed leaves a Completed row whose intent never went out (a recorded intent always sets its status).
  const intentNeverRecorded =
    isEpoch &&
    entry.status === ITransactionStatus.Completed &&
    !entry.bridgeIntentNonce &&
    entry.bridgeEpochStatus === undefined;
  // The fill poll records a failed fill on the Completed row without demoting it; its
  // committed note was not consumed (#1250).
  const fillFailed = isEpoch && entry.status === ITransactionStatus.Completed && entry.bridgeEpochStatus === 'failed';
  // `transactionFailed` is exactly the state import forces every unfinished
  // restored row into, so without the flag check a dump naming any note id gets
  // a "Reclaim funds" button that queues a real consume through the signer.
  const canShowReclaim =
    isEpoch &&
    !restoredFromBackup &&
    reclaimHeight != null &&
    !!reclaimNoteId &&
    ((transactionFailed && noteMayExist) || intentNeverRecorded || fillFailed);
  const reclaimReached =
    canShowReclaim && currentBlock != null && reclaimHeight != null && currentBlock >= reclaimHeight;

  // Poll the bridge indexer for THIS row's own exit deposit. Stateless and
  // indexer-driven, so it surfaces deposits from a previous session too. The
  // lookup is bound to the row's exit hash, so a second bridge-out to the same
  // address can't hand this row its sibling's deposit, which would claim the
  // wrong amount on L1 and mark this row claimed for a claim it never made. It
  // keeps polling past ready: the bridge's auto-claimer claims every exit within
  // minutes, and that claim settles the row too (#1325).
  useBridgeTracker({
    // A restored row polls nothing and claims nothing: `destination` and the
    // deposit it matches come from the dump, and `handleClaim` signs an EVM
    // transaction. Display still shows whatever the backup recorded.
    active: isAgglayer && mayStillClaim && !restoredFromBackup && status !== 'claimed' && !!destination && !!exitTxHash,
    intervalMs: 8000,
    poll: async () => {
      // `active` already requires it; this only narrows the type for the lookup.
      if (!exitTxHash) return true;
      const deposit = await findAgglayerExitDeposit(destination, exitTxHash, pinnedDepositCnt);
      if (!deposit) return false;
      // Every write passes the deposit's own tx_hash, so it can only promote THIS row (#1250).
      if (isAgglayerDepositClaimed(deposit)) {
        setStatus('claimed');
        setClaimable(null);
        if (entry.txId) {
          await updateBridgeClaimStatus(entry.txId, 'claimed', agglayerClaimedFields(deposit), deposit.tx_hash);
        }
        return true;
      }
      if (isAgglayerDepositReady(deposit)) {
        setClaimable(deposit);
        if (status === 'pending' && entry.txId) {
          setStatus('ready');
          setPinnedDepositCnt(deposit.deposit_cnt);
          await updateBridgeClaimStatus(
            entry.txId,
            'ready',
            { depositReady: true, agglayerDepositCnt: deposit.deposit_cnt },
            deposit.tx_hash
          );
          return false;
        }
      }
      // Whatever the claim status: a pin the address page contradicts (a reset indexer) would cost a failed GET and a
      // warning on every tick.
      if (pinnedDepositCnt !== deposit.deposit_cnt) {
        setPinnedDepositCnt(deposit.deposit_cnt);
        if (entry.txId) await pinAgglayerDeposit(entry.txId, deposit.deposit_cnt);
      }
      return false;
    }
  });

  // Epoch fill poll. Runs on mount + every 8s while still pending; persists the
  // receiving tx hash / terminal status for the live transaction-row observer.
  const intentNonce = entry.bridgeIntentNonce;
  const txId = entry.txId;
  useEffect(() => {
    // The fourth affordance in this panel, and the one the earlier
    // marker-settling was silently covering: `epochStatus` comes straight off
    // the row, so a restored `pending` row would poll the allocator against the
    // dump's nonce and destination every 8s for as long as the page is open,
    // and write the result back onto the row.
    if (!isEpoch || restoredFromBackup || epochStatus === 'confirmed' || epochStatus === 'failed') return;
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
    };
    tick();
    const id = setInterval(tick, 8000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isEpoch, restoredFromBackup, epochStatus, intentNonce, destination, txId]);

  const handleClaim = useCallback(async () => {
    if (!claimable || !evmProvider || !entry.txId || !exitTxHash || restoredFromBackup) return;
    hapticMedium();
    setError(null);
    setClaimInFlight(true);
    setStatus('claiming');
    const pin = { agglayerDepositCnt: claimable.deposit_cnt };
    try {
      await updateBridgeClaimStatus(entry.txId, 'claiming', pin, claimable.tx_hash);
      try {
        const tx = await claimAgglayerDeposit({ deposit: claimable, provider: evmProvider });
        await tx.wait();
        setStatus('claimed');
        await updateBridgeClaimStatus(entry.txId, 'claimed', { ...pin, claimTxHash: tx.hash }, claimable.tx_hash);
        setClaimable(null);
      } catch (err) {
        // The bridge's auto-claimer may have claimed the deposit first, and then this claim reverts. The deposit is
        // claimed either way, so the row settles instead of failing. A failed re-check counts as not claimed.
        const settled = await findAgglayerExitDeposit(destination, exitTxHash, claimable.deposit_cnt).catch(() => null);
        if (settled && isAgglayerDepositClaimed(settled)) {
          setStatus('claimed');
          setClaimable(null);
          await updateBridgeClaimStatus(entry.txId, 'claimed', agglayerClaimedFields(settled), settled.tx_hash);
          return;
        }
        console.error('[bridge-claim] claim failed', err);
        setStatus('failed');
        await updateBridgeClaimStatus(entry.txId, 'failed');
        setError(err instanceof Error ? err.message : 'Claim failed');
      }
    } finally {
      setClaimInFlight(false);
    }
  }, [claimable, evmProvider, entry.txId, exitTxHash, destination, restoredFromBackup]);

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
      // `manualRetry` because this only runs on an explicit tap: without it an
      // earlier failed reclaim puts the note behind auto-consume's exponential
      // backoff, so the tap queues nothing and navigates to the old failed receipt.
      const txId = await initiateConsumeTransactionFromId(
        account.publicKey,
        reclaimNoteId,
        isDelegateProofEnabled(),
        true
      );
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
      <DetailSection title={t('bridgeDetails')}>
        <DetailRow label={t('route')}>
          {isUsdcx ? t('usdcxRouteLabel') : isEpoch ? t('fastRouteLabel') : t('slowRouteLabel')}
        </DetailRow>
        {destination && (
          <DetailRow label={t('to')}>
            <ExternalLinkValue
              displayValue={<HashChip hash={destination} trimHash className="ml-2" />}
              href={destinationChain ? `${destinationChain.explorer}/address/${destination}` : undefined}
            />
          </DetailRow>
        )}
        {/* eslint-disable-next-line i18next/no-literal-string -- network's proper name, not translatable copy */}
        <DetailRow label={t('destinationNetwork')}>
          {destinationChain?.name ?? entry.bridgeDestinationNetwork}
        </DetailRow>
        <DetailRow label={isEpoch || isUsdcx ? t('status') : t('claimStatus')}>
          {/* Not confirmed only while the panel has no evidence of its own: once the tracker finds a
              deposit, a claim runs, or the Epoch fill poll reports, that state wins instead (#1250).
              A USDCx burn reads its own phase badge. */}
          {isUsdcx ? (
            <StatusBadge status={bridgeBadgeStatusOf(entry)} live />
          ) : transactionFailed && !entry.isUnconfirmed ? (
            t('bridgeFailed')
          ) : isEpoch ? (
            entry.isUnconfirmed && epochStatus === 'pending' ? (
              t('notConfirmed')
            ) : (
              t(EPOCH_STATUS_LABEL[epochStatus])
            )
          ) : entry.isUnconfirmed && (status === 'pending' || status === 'not-applicable') ? (
            t('notConfirmed')
          ) : (
            t(CLAIM_STATUS_LABEL[status])
          )}
        </DetailRow>
        {isUsdcx && entry.usdcxBurn && (
          <>
            <DetailRow label={t('usdcxBurnNoteId')}>
              <HashChip hash={entry.usdcxBurn.noteId} trimHash />
            </DetailRow>
            <DetailRow label={t('usdcxDestinationDomain')}>{entry.usdcxBurn.destinationDomain}</DetailRow>
            {entry.usdcxBurn.attemptCount !== undefined && (
              <DetailRow label={t('usdcxProcessingAttempts')}>{entry.usdcxBurn.attemptCount}</DetailRow>
            )}
            {entry.usdcxBurn.lastError && (
              <DetailRow label={t('usdcxLastProcessingError')} stacked>
                <span className="break-all text-body-sm text-muted">{entry.usdcxBurn.lastError}</span>
              </DetailRow>
            )}
          </>
        )}
        {isEpoch && fillTxHash && (
          <DetailRow label={t('receivingTx')}>
            <ExternalLinkValue
              displayValue={<HashChip hash={fillTxHash} trimHash className="ml-2" />}
              href={SEPOLIA_TX_URL(fillTxHash)}
            />
          </DetailRow>
        )}
      </DetailSection>
      {isUsdcx && <p className="mt-3 px-4 text-caption text-muted">{t('usdcxBurnTestNotice')}</p>}

      {/* Claim UI is Agglayer-only — Epoch (Fast) auto-settles, so it shows none. */}
      {isAgglayer &&
        mayStillClaim &&
        (status !== 'claimed' ? (
          !!exitTxHash && (
            <div className="mt-3 flex flex-col gap-2">
              {error && (
                <p className="text-red-500 text-xs" role="alert">
                  {error}
                </p>
              )}
              {!isConnected ? (
                <Button size="sm" onClick={connect}>
                  {t('connectEvmWallet')}
                </Button>
              ) : !connectedMatchesDestination ? (
                <p className="text-xs text-ink/60">{t('connectDestinationWalletToClaim')}</p>
              ) : (
                <Button size="sm" onClick={handleClaim} disabled={!claimable || claimInFlight}>
                  {claimInFlight ? t('claiming') : !claimable ? t('claimPending') : t('claimAsset')}
                </Button>
              )}
            </div>
          )
        ) : (
          <div className="mt-3 text-xs text-[#1A9C52]">{t('claimAssetSubmitted')}</div>
        ))}

      {/* Failed Epoch (Fast) bridge, a Completed one whose fill failed, or one whose
          intent never went out: reclaim the recallable P2IDE note once its reclaim
          window opens (funds return to the sender's Miden account). A Failed row or a
          fill-failed Completed row counts down to it - both are definitive. Only a
          Completed row whose intent was never recorded waits for the height with
          nothing shown. */}
      {canShowReclaim && (reclaimReached || transactionFailed || fillFailed) && (
        <div className="mt-3 flex flex-col gap-2">
          {reclaimError && (
            <p className="text-red-500 text-xs" role="alert">
              {reclaimError}
            </p>
          )}
          {reclaimReached ? (
            <>
              {maxNetworkFee && (
                // Reclaiming consumes the recallable note -- a real transaction with a
                // real fee, submitted on this tap with no review step in between.
                <div className="text-center text-xs text-ink">
                  {t('networkFeeMax')} · {maxNetworkFee}
                </div>
              )}
              <Button size="sm" onClick={handleReclaim} disabled={reclaiming}>
                {reclaiming ? t('reclaiming') : t('reclaimFunds')}
              </Button>
            </>
          ) : (
            <p className="text-xs text-ink/60">
              {t('reclaimableAfterBlock')} {reclaimHeight}
            </p>
          )}
        </div>
      )}
    </div>
  );
};
