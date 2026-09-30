import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useAppEnv } from 'app/env';
import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import useVerificationBaseFee from 'app/hooks/useVerificationBaseFee';
import { useOnboardingFinishing } from 'app/onboarding-finish';
import { Button } from 'components/Button';
import { RecoverySeedPrompt } from 'components/RecoverySeedPrompt';
import { ErrorDetails } from 'components/ui/ErrorDetails';
import { Spinner } from 'components/ui/Spinner';
import { canHandoffToSidePanel, ONBOARDING_HANDOFF_ROUTES } from 'lib/extension/side-panel-handoff';
import {
  initiateReplaceHotKeyTransaction,
  requestSWTransactionProcessing,
  safeGenerateTransactionsLoop
} from 'lib/miden/activity';
import { isLiveTransaction, ITransactionStatus } from 'lib/miden/db/types';
import { useAllBalances, useAllTokensBaseMetadata, useMidenContext } from 'lib/miden/front';
import { useClaimableNotes } from 'lib/miden/front/claimable-notes';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import * as Repo from 'lib/miden/repo';
import { isVaultShortfallRow } from 'lib/miden/transaction/constants';
import {
  hotKeyRotationLockName,
  isLiveRotationFundingRow,
  isLiveRotationRow,
  isRotationFundingRow,
  isRotationRow,
  selectRotationFundingNotes
} from 'lib/miden/transaction/rotation-funding';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isExtension } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import * as Woozie from 'lib/woozie';
import { TRANSACTION_LOOP_INTERVAL_MS } from 'screens/generating-transaction/constants';
import { useTransactionRow } from 'screens/generating-transaction/useTransactionRow';

import { RotationFundingPanel, useRotationFundingClaim, useRotationGateRows } from './HotKeyRotationFunding';
import {
  describeRotationFailure,
  isBelowBaseFee,
  newestRow,
  resolveRotationGateView,
  rotationFundingMinimum,
  type RotationFailure
} from './HotKeyRotationGate.selectors';

/**
 * Full-app blocking gate for accounts that need a hot-key rotation.
 *
 * Guardian accounts recovered via seed phrase (and legacy accounts migrated on
 * unlock) carry `requiresHotKeyRotation`: they have no usable local hot key
 * and cannot sign, sync, or transact until a `replace_signer` rotation lands.
 * While the CURRENT account carries the flag, this gate auto-initiates the
 * rotation and paints a full-screen overlay that blocks all wallet
 * interaction; the flag clearing (via `Vault.swapHotKey`, accountsUpdated,
 * store sync) is the authoritative "done" signal that dismisses it.
 *
 * The rotation is a transaction and pays its fee from the account's vault, so an
 * account that holds no MIDEN cannot leave (#805). The gate then shows its funding
 * state: the address to send MIDEN to, and a claim of the arriving native notes with
 * the recovery key (`HotKeyRotationFunding.tsx`), never alongside the rotation, which
 * it retries once a claim lands. Nothing else is unlocked while it waits.
 *
 * Only the current account is gated: a flagged non-current account leaves the
 * wallet usable, and switching to it raises the overlay.
 *
 * The onboarding tab stays ungated while it finishes onboarding (the finishing
 * mark, held until the handler navigates on) and on its two side-panel handoff
 * screens: the panel's own gate starts the rotation, or adopts it if one is in
 * flight, so blocking the tab here would only hold the one tap that opens the
 * panel until the rotation lands (#1097).
 */
export const HotKeyRotationGate: FC = () => {
  const currentAccount = useWalletStore(s => s.currentAccount);
  const { fullPage } = useAppEnv();
  const { pathname } = Woozie.useLocation();
  const finishingOnboarding = useOnboardingFinishing();

  if (!currentAccount?.requiresHotKeyRotation) return null;
  if (fullPage && canHandoffToSidePanel() && (finishingOnboarding || ONBOARDING_HANDOFF_ROUTES.has(pathname)))
    return null;

  // Keyed by account so switching between flagged accounts resets all
  // rotation state (txId, errors, in-flight guard) instead of leaking it.
  return <HotKeyRotationOverlay key={currentAccount.publicKey} accountPublicKey={currentAccount.publicKey} />;
};

interface OverlayProps {
  accountPublicKey: string;
}

/**
 * The newest rotation of the account when it failed for want of its fee and no funding
 * claim completed after it (#805). Adopting it on mount shows the funding panel again
 * instead of queueing a rotation that must fail, minting a hot key it never uses.
 */
const adoptableShortfallRow = async (accountPublicKey: string) => {
  const rows = await Repo.transactions
    .filter(r => isRotationRow(r, accountPublicKey) || isRotationFundingRow(r, accountPublicKey))
    .toArray();
  const rotation = newestRow(rows.filter(r => r.type === 'replace-hot-key'));
  if (rotation === undefined || !isVaultShortfallRow(rotation)) return undefined;
  const failedAt = rotation.completedAt ?? rotation.initiatedAt;
  const claimedSince = rows.some(
    r => r.type === 'consume' && r.status === ITransactionStatus.Completed && (r.completedAt ?? 0) > failedAt
  );
  return claimedSince ? undefined : rotation;
};

/**
 * Find (or create) the rotation transaction to track, serialized across every
 * wallet surface via a per-account Web Lock — two concurrently-mounted gate
 * instances (e.g. extension popup + side panel) would otherwise both pass the
 * pending-row lookup before either enqueues, double-rotating the key. Every call
 * adopts a live rotation, so Check again, a funding trigger or a second surface
 * never queues one beside it.
 *
 * On mount (`adoptExisting`), orphaned `GeneratingTransaction` rows, the rotation's and
 * the funding claim's, are requeued first: every driver processes under the
 * `generate-transactions-loop` Web Lock (`safeGenerateTransactionsLoop`, SW included),
 * so if that lock is free the row's generation promise died with its process. The loop
 * refuses to run while an in-progress row exists, so leaving it would hold the gate
 * until `cancelStuckTransactions` expires it (up to 30 minutes off-mobile). The
 * `ifAvailable` request makes the check race-free: we only requeue while provably no
 * loop is running.
 *
 * Resolves `null` when it DEFERRED (#805): the gate's funding claim is live, and a
 * rotation now would run before the vault that claim funds, fail, and mint a hot key it
 * never uses. The claim path takes the same lock and refuses while a rotation is live.
 */
const ensureRotationTx = async (accountPublicKey: string, adoptExisting: boolean): Promise<string | null> => {
  let txId: string | null = null;
  let deferred = false;
  await navigator.locks.request(hotKeyRotationLockName(accountPublicKey), async () => {
    if (adoptExisting) {
      await navigator.locks.request('generate-transactions-loop', { ifAvailable: true }, async lock => {
        if (!lock) return;
        await Repo.transactions
          .filter(
            r =>
              (isLiveRotationRow(r, accountPublicKey) || isLiveRotationFundingRow(r, accountPublicKey)) &&
              r.status === ITransactionStatus.GeneratingTransaction
          )
          .modify(r => {
            r.status = ITransactionStatus.Queued;
            r.processingStartedAt = undefined;
            r.requeueStreak = undefined;
          });
      });
    }
    const existing = await Repo.transactions.filter(r => isLiveRotationRow(r, accountPublicKey)).first();
    if (existing) {
      txId = existing.id;
      return;
    }
    if (await Repo.transactions.filter(r => isLiveRotationFundingRow(r, accountPublicKey)).first()) {
      deferred = true;
      return;
    }
    const failed = adoptExisting ? await adoptableShortfallRow(accountPublicKey) : undefined;
    if (failed) {
      txId = failed.id;
      return;
    }
    txId = await initiateReplaceHotKeyTransaction(accountPublicKey, isDelegateProofEnabled(), zustandProvider);
  });
  if (deferred) return null;
  if (txId === null) {
    throw new Error('Hot-key rotation lock callback did not produce a transaction id');
  }
  return txId;
};

/**
 * The terminal failure. `w-full` on the column and `wrap-anywhere` on the text: in this centred
 * flex column a box otherwise sizes to its widest unbreakable token, and the overlay only scrolls
 * vertically, so a long id in a raw error ran off both sides of the screen (#1250).
 */
const RotationFailedPanel: FC<{ failure: RotationFailure; onRetry: () => void }> = ({ failure, onRetry }) => {
  const { t } = useTranslation();
  return (
    <div data-testid="hot-key-rotation-failed" className="flex w-full flex-col items-center gap-4">
      <h1 className="text-lg font-semibold text-ink">
        {t(failure.unconfirmed ? 'hotKeyRotationUnconfirmedTitle' : 'hotKeyRotationFailedTitle')}
      </h1>
      <p data-testid="hot-key-rotation-failed-message" className="w-full text-sm text-ink wrap-anywhere select-text">
        {failure.message ?? t(failure.unconfirmed ? 'hotKeyRotationUnconfirmedBody' : 'hotKeyRotationFailedGeneric')}
      </p>
      <ErrorDetails details={failure.details} className="w-full items-center" />
      <Button data-testid="hot-key-rotation-retry" onClick={onRetry}>
        {t('hotKeyRotationRetry')}
      </Button>
    </div>
  );
};

const HotKeyRotationOverlay: FC<OverlayProps> = ({ accountPublicKey }) => {
  const { t } = useTranslation();
  const { signTransaction } = useMidenContext();
  const [txId, setTxId] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const inFlightRef = useRef<Promise<string | null> | null>(null);
  const { row } = useTransactionRow(txId ?? '');
  const { rotationRows, fundingRows, loaded: rowsLoaded } = useRotationGateRows(accountPublicKey);
  const feeFaucetId = useMidenFaucetId();
  const baseFee = useVerificationBaseFee();
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: balances, isLoading: balancesLoading } = useAllBalances(accountPublicKey, allTokensBaseMetadata);
  const { data: claimableNotes, isFallback } = useClaimableNotes(accountPublicKey);
  const selection = useMemo(
    () => selectRotationFundingNotes({ data: claimableNotes, isFallback }, feeFaucetId, baseFee),
    [claimableNotes, isFallback, feeFaucetId, baseFee]
  );

  // Swallow hardware/gesture back while the wallet is blocked. Registered by
  // this component (which only mounts while blocking), so it is active exactly
  // when needed and unwinds automatically once the rotation lands.
  useMobileBackHandler(() => true, [], { overlay: true });

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
        if (id !== null) setTxId(id);
        // A deferral too: the claim it waits on, maybe just requeued, runs in the worker's loop.
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
  // mobile/desktop the rotation never routes to the GeneratingTransaction page,
  // and `OrphanedTransactionRecovery` only runs its one-shot sweep at app start,
  // so the overlay kicks the same loop that page uses. The in-flight generate
  // promise survives unmount.
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

  const gate = resolveRotationGateView({
    trackedRow: row,
    initError,
    baseFee,
    belowBaseFee: isBelowBaseFee(balancesLoading, balances, feeFaucetId, baseFee),
    rotationRows,
    fundingRows,
    listedNoteIds: new Set(selection.native.map(note => note.id)),
    tooSmall: selection.tooSmall
  });
  const rotationLive = rotationRows.some(isLiveTransaction);

  const onRetry = useCallback(() => {
    setTxId(null);
    // Failed rows are terminal — retry always enqueues a fresh transaction.
    void beginRotation(false);
  }, [beginRotation]);

  // A funding trigger never queues a second rotation beside a live one.
  const onFunded = useCallback(() => {
    if (!rotationLive) void beginRotation(false);
  }, [beginRotation, rotationLive]);

  const { retryClaim } = useRotationFundingClaim({
    accountPublicKey,
    active: rowsLoaded && gate.view === 'funding' && !rotationLive,
    listLive: !isFallback && claimableNotes !== undefined && feeFaucetId !== null,
    selection,
    feeFaucetId,
    baseFee,
    fundingRows,
    rowsLoaded,
    onFunded
  });

  // A rotation deferred behind a claim has nothing to track, so it runs once nothing is live
  // and the balance asks for no funding, whether the claim completed or failed. Every rows read
  // re-arms it: a deferral on rows newer than the gate's read changes no state to re-run on.
  // Before balances land it adopts a prior shortfall rather than queue a rotation that falls
  // short again. On mount the first call is still in flight and swallows this one.
  const deferredRotationDue =
    gate.view === 'rotating' && txId === null && !rotationLive && !fundingRows.some(isLiveTransaction);
  useEffect(() => {
    if (deferredRotationDue) void beginRotation(balancesLoading);
  }, [beginRotation, deferredRotationDue, balancesLoading, rotationRows, fundingRows]);

  if (gate.view === 'recovery-seed' && row) {
    return <RecoverySeedPrompt transaction={row} onClose={() => Woozie.navigate('/')} />;
  }

  const claimFailure = describeRotationFailure(gate.view === 'funding' ? gate.failedClaim : undefined, null);

  return (
    // A translucent scrim: the wallet stays visible
    // behind the overlay, just dimmed, blurred, and inert. `hot-key-rotation-gate`
    // is a test-only hook (E2E POM): it marks the overlay for as long as it's
    // mounted (spinning OR showing the terminal-failure surface below) — the
    // overlay unmounting IS the "rotation complete" signal.
    <div
      data-testid="hot-key-rotation-gate"
      className="fixed inset-0 z-[9999] flex flex-col items-center overflow-y-auto px-8 pt-[max(2rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))] text-center bg-pure-white/10 dark:bg-pure-black/50 backdrop-blur-xl backdrop-saturate-150"
    >
      {/* `my-auto` centres the content and lets a taller one scroll from its top instead of clipping. */}
      <div className="my-auto flex w-full flex-col items-center gap-4">
        {gate.view === 'funding' ? (
          <RotationFundingPanel
            address={accountPublicKey}
            reason={gate.reason}
            status={gate.status}
            minimum={rotationFundingMinimum(
              baseFee,
              balances.find(balance => balance.tokenId === feeFaucetId)
            )}
            claimMessage={claimFailure.message ?? undefined}
            claimDetails={claimFailure.details}
            claimUnconfirmed={claimFailure.unconfirmed}
            onRetryClaim={() => {
              if (gate.failedClaim) retryClaim(gate.failedClaim);
            }}
            onCheckAgain={onRetry}
          />
        ) : gate.view === 'failed' ? (
          <RotationFailedPanel failure={describeRotationFailure(row, initError)} onRetry={onRetry} />
        ) : (
          <>
            <Spinner />
            <h1 className="text-lg font-semibold text-ink">{t('hotKeyRotationOverlayTitle')}</h1>
            <p className="text-sm text-ink select-text">{t('hotKeyRotationOverlayBody')}</p>
          </>
        )}
      </div>
    </div>
  );
};

export default HotKeyRotationGate;
