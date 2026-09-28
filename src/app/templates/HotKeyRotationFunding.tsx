import React, { FC, useEffect, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { CopyButton } from 'components/ui/CopyButton';
import { subscribeToLiveQuery } from 'lib/dexie-live-query';
import { requestSWTransactionProcessing } from 'lib/miden/activity';
import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import {
  enqueueRotationFundingClaim,
  isRotationFundingRow,
  isRotationRow,
  RotationFundingSelection
} from 'lib/miden/transaction/rotation-funding';
import { ConsumableNote } from 'lib/miden/types';
import { isExtension } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';

import { claimNoteIds, GateRow, RotationFundingReason, RotationFundingStatus } from './HotKeyRotationGate.selectors';

/** The driver's cadence, the one `NativeNoteAutoConsumeManager` uses. */
const FUNDING_CLAIM_INTERVAL_MS = 3_000;

export interface RotationGateRows {
  rotationRows: ITransaction[];
  fundingRows: ITransaction[];
  /** The first read has landed. */
  loaded: boolean;
}

/** The account's rotation rows and the gate's funding claims, pushed by Dexie `liveQuery`. */
export function useRotationGateRows(accountPublicKey: string): RotationGateRows {
  const [rows, setRows] = useState<RotationGateRows>({ rotationRows: [], fundingRows: [], loaded: false });
  useEffect(
    () =>
      subscribeToLiveQuery(
        () =>
          Repo.transactions
            .filter(r => isRotationRow(r, accountPublicKey) || isRotationFundingRow(r, accountPublicKey))
            .toArray(),
        {
          next: all =>
            setRows({
              rotationRows: all.filter(r => r.type === 'replace-hot-key'),
              fundingRows: all.filter(r => r.type === 'consume'),
              loaded: true
            }),
          error: error => console.error('[HotKeyRotationGate] Failed to read the rotation rows:', error)
        }
      ),
    [accountPublicKey]
  );
  return rows;
}

const isLive = (row: GateRow): boolean =>
  row.status === ITransactionStatus.Queued || row.status === ITransactionStatus.GeneratingTransaction;

interface FundingClaimOptions {
  accountPublicKey: string;
  /** Funding is needed and no rotation row is live. */
  active: boolean;
  /** The latest read was a live list, not the cache. */
  listLive: boolean;
  selection: RotationFundingSelection<ConsumableNote>;
  baseFee: number | null;
  fundingRows: readonly GateRow[];
  /** `fundingRows` is a read, not the initial empty list. */
  rowsLoaded: boolean;
  /** Retry the rotation. The caller refuses while a rotation row is live. */
  onFunded: () => void;
}

/**
 * The gate's funding driver (#805). While `active`, it claims the native notes the live
 * list offers, as the gate's own flagged claim, every 3 s; dedup and the funding-scoped
 * backoff live in the initiator, so a tick that finds a claim live or backed off writes
 * nothing. It does not read the auto-consume setting: the claim is the gate's disclosed
 * action and the only way out of it.
 *
 * It retries the rotation once per funding claim that completes, and once when a native
 * note it saw leaves the live list while no claim carrying it is live or completed: the
 * old device claimed it, or its sender recalled it. Completions already on record when
 * the gate mounts are not retries; the mount itself is (see `ensureRotationTx`).
 */
export function useRotationFundingClaim({
  accountPublicKey,
  active,
  listLive,
  selection,
  baseFee,
  fundingRows,
  rowsLoaded,
  onFunded
}: FundingClaimOptions): { retryClaim: (failedClaim: GateRow) => void } {
  const latest = useRef({ active, selection, baseFee, fundingRows, onFunded });
  latest.current = { active, selection, baseFee, fundingRows, onFunded };

  useEffect(() => {
    if (!active) return;
    let running = false;
    const tick = async () => {
      const { selection: current, baseFee: fee, fundingRows: rows } = latest.current;
      if (running || !latest.current.active || current.batch.length === 0 || rows.some(isLive)) return;
      running = true;
      try {
        await enqueueRotationFundingClaim(accountPublicKey, [...current.batch], {
          delegate: isDelegateProofEnabled(),
          verificationBaseFee: fee
        });
        if (isExtension()) requestSWTransactionProcessing();
      } catch (e) {
        console.warn('[HotKeyRotationGate] funding claim enqueue failed:', e);
      } finally {
        running = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), FUNDING_CLAIM_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [accountPublicKey, active]);

  const handledClaims = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!rowsLoaded) return;
    const completed = fundingRows.filter(r => r.status === ITransactionStatus.Completed).map(r => r.id);
    if (handledClaims.current === null) {
      handledClaims.current = new Set(completed);
      return;
    }
    const fresh = completed.filter(id => !handledClaims.current?.has(id));
    fresh.forEach(id => handledClaims.current?.add(id));
    if (fresh.length > 0) latest.current.onFunded();
  }, [fundingRows, rowsLoaded]);

  const seenNotes = useRef(new Set<string>());
  useEffect(() => {
    if (!active || !listLive) return;
    const listed = new Set(selection.native.map(note => note.id));
    const carried = new Set(
      latest.current.fundingRows.filter(r => r.status !== ITransactionStatus.Failed).flatMap(claimNoteIds)
    );
    const vanished = [...seenNotes.current].filter(id => !listed.has(id) && !carried.has(id));
    vanished.forEach(id => seenNotes.current.delete(id));
    listed.forEach(id => seenNotes.current.add(id));
    if (vanished.length > 0) latest.current.onFunded();
  }, [active, listLive, selection]);

  const retryClaim = (failedClaim: GateRow) => {
    const ids = new Set(claimNoteIds(failedClaim));
    const notes = selection.native.filter(note => ids.has(note.id) && !note.isBeingClaimed);
    if (notes.length === 0) return;
    void enqueueRotationFundingClaim(accountPublicKey, notes, {
      delegate: isDelegateProofEnabled(),
      manualRetry: true,
      verificationBaseFee: baseFee
    })
      .then(() => {
        if (isExtension()) requestSWTransactionProcessing();
      })
      .catch(e => console.warn('[HotKeyRotationGate] funding claim retry failed:', e));
  };

  return { retryClaim };
}

const STATUS_KEYS: Record<RotationFundingStatus, string> = {
  waiting: 'hotKeyRotationFundingWaiting',
  'too-small': 'hotKeyRotationFundingTooSmall',
  claiming: 'hotKeyRotationFundingClaiming',
  activating: 'hotKeyRotationFundingActivating',
  'claim-failed': 'hotKeyRotationFundingClaimFailed'
};

interface PanelProps {
  address: string;
  reason: RotationFundingReason;
  status: RotationFundingStatus;
  /** The suggested amount in MIDEN, or `null` to leave the line out. */
  minimum: string | null;
  /** The failed claim's message, shown with `claim-failed`. */
  claimError?: string;
  onRetryClaim: () => void;
  onCheckAgain: () => void;
}

/**
 * The gate's funding state (#805): why the key cannot be activated yet, the address to
 * send MIDEN to, and where the claim stands. Check again is always offered, because the
 * local balance cannot prove the account unfunded when another holder funded it.
 */
export const RotationFundingPanel: FC<PanelProps> = ({
  address,
  reason,
  status,
  minimum,
  claimError,
  onRetryClaim,
  onCheckAgain
}) => {
  const { t } = useTranslation();
  return (
    <div
      data-testid="hot-key-rotation-funding"
      data-funding-reason={reason}
      className="flex w-full max-w-sm flex-col items-center gap-4"
    >
      <h1 className="text-lg font-semibold text-ink">{t('hotKeyRotationFundingTitle')}</h1>
      <p className="text-sm text-ink select-text">{t('hotKeyRotationFundingBody')}</p>
      {minimum !== null && <p className="text-sm text-ink">{t('hotKeyRotationFundingMinimum', { amount: minimum })}</p>}
      <div className="flex w-full flex-col items-center gap-2">
        <span className="text-sm text-muted">{t('hotKeyRotationFundingAddressLabel')}</span>
        <p data-testid="hot-key-rotation-funding-address" className="w-full text-sm text-ink break-all select-text">
          {address}
        </p>
        <CopyButton text={address} icon="leading" data-testid="hot-key-rotation-funding-copy" />
      </div>
      <p
        role="status"
        data-testid="hot-key-rotation-funding-status"
        data-state={status}
        className="text-sm text-ink select-text"
      >
        {t(STATUS_KEYS[status])}
      </p>
      {status === 'claim-failed' && (
        <>
          {claimError && <p className="text-sm text-ink break-words select-text">{claimError}</p>}
          <Button data-testid="hot-key-rotation-funding-claim-retry" onClick={onRetryClaim}>
            {t('hotKeyRotationFundingClaimRetry')}
          </Button>
        </>
      )}
      <Button data-testid="hot-key-rotation-retry" variant={ButtonVariant.Secondary} onClick={onCheckAgain}>
        {t('hotKeyRotationFundingCheckAgain')}
      </Button>
    </div>
  );
};
