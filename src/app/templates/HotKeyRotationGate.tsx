import React, { FC, useCallback, useEffect, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import Spinner from 'app/atoms/Spinner/Spinner';
import { Button } from 'components/Button';
import {
  initiateReplaceHotKeyTransaction,
  requestSWTransactionProcessing,
  safeGenerateTransactionsLoop
} from 'lib/miden/activity';
import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { useMidenContext } from 'lib/miden/front';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import * as Repo from 'lib/miden/repo';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isExtension } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { TRANSACTION_LOOP_INTERVAL_MS } from 'screens/generating-transaction/constants';
import { useTransactionRow } from 'screens/generating-transaction/useTransactionRow';

/**
 * Full-app blocking gate for accounts that need a hot-key rotation.
 *
 * Guardian accounts recovered via seed phrase (and legacy accounts migrated on
 * unlock) carry `requiresHotKeyRotation` — they have no usable local hot key
 * and cannot sign, sync, or transact until a `replace_signer` rotation lands.
 * While the CURRENT account carries the flag, this gate auto-initiates the
 * rotation and paints a full-screen overlay that blocks all wallet
 * interaction; the flag clearing (via `Vault.swapHotKey` → accountsUpdated →
 * store sync) is the authoritative "done" signal that dismisses it.
 *
 * Only the current account is gated: a flagged non-current account leaves the
 * wallet usable, and switching to it raises the overlay.
 */
export const HotKeyRotationGate: FC = () => {
  const currentAccount = useWalletStore(s => s.currentAccount);

  if (!currentAccount?.requiresHotKeyRotation) return null;

  // Keyed by account so switching between flagged accounts resets all
  // rotation state (txId, errors, in-flight guard) instead of leaking it.
  return <HotKeyRotationOverlay key={currentAccount.publicKey} accountPublicKey={currentAccount.publicKey} />;
};

interface OverlayProps {
  accountPublicKey: string;
}

const isPendingRotationRow = (r: ITransaction, accountPublicKey: string): boolean =>
  r.type === 'replace-hot-key' &&
  r.accountId === accountPublicKey &&
  (r.status === ITransactionStatus.Queued || r.status === ITransactionStatus.GeneratingTransaction);

/**
 * Find (or create) the rotation transaction to track, serialized across every
 * wallet surface via a per-account Web Lock — two concurrently-mounted gate
 * instances (e.g. extension popup + side panel) would otherwise both pass the
 * pending-row lookup before either enqueues, double-rotating the key.
 *
 * Before adopting, orphaned `GeneratingTransaction` rows are requeued: every
 * driver processes under the `generate-transactions-loop` Web Lock
 * (`safeGenerateTransactionsLoop`, SW included), so if that lock is free the
 * row's generation promise died with its process. The loop refuses to run
 * while an in-progress row exists, so adopting it as-is would leave the
 * overlay spinning until `cancelStuckTransactions` expires it (up to 30
 * minutes off-mobile). The `ifAvailable` request makes the check race-free:
 * we only requeue while provably no loop is running.
 */
const ensureRotationTx = async (accountPublicKey: string, adoptExisting: boolean): Promise<string> => {
  let txId: string | null = null;
  await navigator.locks.request(`hot-key-rotation:${accountPublicKey}`, async () => {
    if (adoptExisting) {
      await navigator.locks.request('generate-transactions-loop', { ifAvailable: true }, async lock => {
        if (!lock) return;
        await Repo.transactions
          .filter(
            r => isPendingRotationRow(r, accountPublicKey) && r.status === ITransactionStatus.GeneratingTransaction
          )
          .modify(r => {
            r.status = ITransactionStatus.Queued;
            r.processingStartedAt = undefined;
          });
      });
      const existing = await Repo.transactions.filter(r => isPendingRotationRow(r, accountPublicKey)).first();
      if (existing) {
        txId = existing.id;
        return;
      }
    }
    txId = await initiateReplaceHotKeyTransaction(accountPublicKey, isDelegateProofEnabled(), zustandProvider);
  });
  if (txId === null) {
    throw new Error('Hot-key rotation lock callback did not produce a transaction id');
  }
  return txId;
};

const HotKeyRotationOverlay: FC<OverlayProps> = ({ accountPublicKey }) => {
  const { t } = useTranslation();
  const { signTransaction } = useMidenContext();
  const [txId, setTxId] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const inFlightRef = useRef<Promise<string> | null>(null);
  const { row } = useTransactionRow(txId ?? '');

  // Swallow hardware/gesture back while the wallet is blocked. Registered by
  // this component (which only mounts while blocking), so it is active exactly
  // when needed and unwinds automatically once the rotation lands.
  useMobileBackHandler(() => true, []);

  const beginRotation = useCallback(
    async (adoptExisting: boolean) => {
      // In-flight guard: strict-mode double-invoke and re-renders share one
      // promise instead of enqueueing duplicate rotation transactions.
      // (Cross-window duplication is handled inside ensureRotationTx.)
      if (inFlightRef.current) return;
      setInitError(null);
      inFlightRef.current = ensureRotationTx(accountPublicKey, adoptExisting);
      try {
        const id = await inFlightRef.current;
        setTxId(id);
        if (isExtension()) requestSWTransactionProcessing();
      } catch (e) {
        setInitError(e instanceof Error ? e.message : String(e));
      } finally {
        inFlightRef.current = null;
      }
    },
    [accountPublicKey]
  );

  useEffect(() => {
    void beginRotation(true);
  }, [beginRotation]);

  // Driver: on extension the service worker owns the FIFO loop; on
  // mobile/desktop nobody else is mounted to drive it (the rotation never
  // routes to the GeneratingTransaction page), so the overlay kicks the same
  // loop that page uses. The in-flight generate promise survives unmount.
  const driveLoop = useCallback(async () => {
    try {
      await safeGenerateTransactionsLoop(signTransaction, false, zustandProvider);
    } catch (e) {
      console.error('[HotKeyRotationGate] Error in transaction loop:', e);
    }
  }, [signTransaction]);

  useEffect(() => {
    if (isExtension()) return;
    void driveLoop();
    const intervalId = setInterval(() => {
      void driveLoop();
    }, TRANSACTION_LOOP_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [driveLoop]);

  const rowFailed = row?.status === ITransactionStatus.Failed;
  const failureMessage = initError ?? (rowFailed ? (row?.error ?? t('hotKeyRotationFailedGeneric')) : null);

  const onRetry = useCallback(() => {
    setTxId(null);
    // Failed rows are terminal — retry always enqueues a fresh transaction.
    void beginRotation(false);
  }, [beginRotation]);

  return (
    // Same translucent scrim recipe as CustomModal: the wallet stays visible
    // behind the overlay, just dimmed, blurred, and inert.
    <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center gap-4 px-8 text-center bg-pure-white/10 dark:bg-pure-black/50 backdrop-blur-xl backdrop-saturate-150">
      {failureMessage === null ? (
        <>
          <Spinner />
          <h1 className="text-lg font-semibold text-black">{t('hotKeyRotationOverlayTitle')}</h1>
          <p className="text-sm text-heading-gray select-text">{t('hotKeyRotationOverlayBody')}</p>
        </>
      ) : (
        <>
          <h1 className="text-lg font-semibold text-black">{t('hotKeyRotationFailedTitle')}</h1>
          <p className="text-sm text-heading-gray break-words select-text">{failureMessage}</p>
          <Button className="px-6 py-2 rounded-lg text-sm font-semibold" onClick={onRetry}>
            {t('hotKeyRotationRetry')}
          </Button>
        </>
      )}
    </div>
  );
};

export default HotKeyRotationGate;
