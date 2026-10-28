import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useAppEnv } from 'app/env';
import useNativeFeeFaucetId from 'app/hooks/useNativeFeeFaucetId';
import useVerificationBaseFee from 'app/hooks/useVerificationBaseFee';
import { useOnboardingFinishing } from 'app/onboarding-finish';
import { Button, ButtonVariant } from 'components/Button';
import { RecoverySeedPrompt } from 'components/RecoverySeedPrompt';
import { ErrorDetails } from 'components/ui/ErrorDetails';
import { Notice } from 'components/ui/Notice';
import { Spinner } from 'components/ui/Spinner';
import { canHandoffToSidePanel, ONBOARDING_HANDOFF_ROUTES } from 'lib/extension/side-panel-handoff';
import {
  initiateReplaceHotKeyTransaction,
  requestSWTransactionProcessing,
  safeGenerateTransactionsLoop
} from 'lib/miden/activity';
import { type HotKeyActivationMode, isLiveTransaction, ITransactionStatus } from 'lib/miden/db/types';
import { useAllBalances, useAllTokensBaseMetadata, useMidenContext } from 'lib/miden/front';
import { useClaimableNotes } from 'lib/miden/front/claimable-notes';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { useOnChainSignerCount } from 'lib/miden/front/useOnChainSignerCount';
import * as Repo from 'lib/miden/repo';
import { resetWalletAndReload } from 'lib/miden/reset-and-reload';
import {
  findAdoptableShortfallRow,
  hotKeyRotationLockName,
  isLiveRotationFundingRow,
  isLiveRotationRow,
  isRotationRow,
  newestRow,
  selectRotationFundingNotes
} from 'lib/miden/transaction/rotation-funding';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isExtension } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';
import type { UserErrorId } from 'lib/telemetry/user-visible-error';
import { useAlert, useConfirm } from 'lib/ui/dialog';
import { guardianNoteScanText, useGuardianNoteRecoveryProgress } from 'lib/wallet-prompts';
import * as Woozie from 'lib/woozie';
import { TRANSACTION_LOOP_INTERVAL_MS } from 'screens/generating-transaction/constants';
import { useTransactionRow } from 'screens/generating-transaction/useTransactionRow';
import { ChooseDeviceRole } from 'screens/onboarding/import-wallet-flow/ChooseDeviceRole';
import { ImportHotKeyScreen } from 'screens/onboarding/import-wallet-flow/ImportHotKey';

import {
  RotationFundingPanel,
  useRotationFundingClaim,
  useRotationGateRows,
  useWatchedTransactionFailure
} from './HotKeyRotationFunding';
import {
  activationModeOf,
  describeRotationFailure,
  isBelowBaseFee,
  resolveRotationGateView,
  resumableActivationMode,
  rotationFundingMinimum,
  type RotationFailure
} from './HotKeyRotationGate.selectors';
import { armRecoveryPhraseKeepPrompt } from './RecoveryPhraseKeepPrompt';

/**
 * Full-app blocking gate for accounts that need a hot-key rotation.
 *
 * Guardian accounts recovered via seed phrase carry `requiresHotKeyRotation`:
 * they have no usable local hot key and cannot sign, sync, or transact until a
 * `replace_signer` rotation lands.
 * While the CURRENT account carries the flag, this gate paints a full-screen
 * overlay that blocks all wallet interaction. Its first screen asks the device
 * role: add this device (the other devices keep working) or make it the main
 * one (every other device is removed). Continue starts the rotation in that
 * mode. A rotation that already exists (a reload during a rotation) is adopted
 * on mount, and the gate does not ask again. The flag clearing (via
 * `Vault.swapHotKey`, accountsUpdated, store sync) is the authoritative "done"
 * signal that dismisses it.
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
 * Resolves `deferred` when it DEFERRED (#805): the gate's funding claim is live, and a
 * rotation now would run before the vault that claim funds, fail, and mint a hot key it
 * never uses. The claim path takes the same lock and refuses while a rotation is live.
 *
 * A NEW rotation needs a device role: the `mode` the user chose in this overlay, else the mode of
 * the account's last rotation that did not complete (`resumableActivationMode`), so a reload or a
 * second surface continues with the role the user chose before. Without either, the call adopts
 * what exists and resolves `none` when there is nothing, so the gate asks the user first.
 */
type RotationLookup = { status: 'tracking'; txId: string } | { status: 'deferred' } | { status: 'none' };

const ensureRotationTx = async (
  accountPublicKey: string,
  adoptExisting: boolean,
  mode: HotKeyActivationMode | null
): Promise<RotationLookup> => {
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
            r.attemptId = undefined;
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
    const failed = adoptExisting ? await findAdoptableShortfallRow(accountPublicKey) : undefined;
    if (failed) {
      txId = failed.id;
      return;
    }
    const activationMode =
      mode ??
      resumableActivationMode(await Repo.transactions.filter(r => isRotationRow(r, accountPublicKey)).toArray());
    if (activationMode === null) return;
    txId = await initiateReplaceHotKeyTransaction(
      accountPublicKey,
      isDelegateProofEnabled(),
      zustandProvider,
      activationMode
    );
  });
  if (deferred) return { status: 'deferred' };
  if (txId !== null) return { status: 'tracking', txId };
  if (mode === null) return { status: 'none' };
  throw new Error('Hot-key rotation lock callback did not produce a transaction id');
};

/**
 * The terminal failure. `w-full` on the column and `wrap-anywhere` on the text: in this centred
 * flex column a box otherwise sizes to its widest unbreakable token, and the overlay only scrolls
 * vertically, so a long id in a raw error ran off both sides of the screen (#1250).
 */
const RotationFailedPanel: FC<{
  failure: RotationFailure;
  errorId: UserErrorId | null;
  onRetry: () => void;
  onStartOver: () => void;
  onUseKeyPair: () => void;
}> = ({ failure, errorId, onRetry, onStartOver, onUseKeyPair }) => {
  const { t } = useTranslation();
  useUserVisibleError(errorId, 'status_screen');
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
      {/* The exit (#1648): the wallet behind this gate holds a recovered account whose rotation keeps failing, most
          often because it was recovered from a Guardian the account had left. Nothing local is worth keeping (no hot
          key ever landed), so the way out is a wipe back to onboarding, where recovery starts again with the right
          Guardian. Without it the only exit was to reinstall. */}
      {/* The other way out when the Guardian cannot be reached: the everyday key from a saved key pair needs no
          operator, because the account state it signs against is already on this device. */}
      {!failure.unconfirmed && (
        <Button variant={ButtonVariant.Secondary} data-testid="hot-key-rotation-use-key-pair" onClick={onUseKeyPair}>
          {t('hotKeyRotationUseKeyPair')}
        </Button>
      )}
      <Button variant={ButtonVariant.Secondary} data-testid="hot-key-rotation-start-over" onClick={onStartOver}>
        {t('hotKeyRotationStartOver')}
      </Button>
    </div>
  );
};

/**
 * The device-role screen. It reads the on-chain device count only while it shows, so the gate makes no WASM
 * read for a rotation it adopts.
 */
const ChooseDeviceRoleStep: FC<{ accountPublicKey: string; onSubmit: (mode: HotKeyActivationMode) => void }> = ({
  accountPublicKey,
  onSubmit
}) => {
  const deviceCount = useOnChainSignerCount(accountPublicKey);
  return <ChooseDeviceRole deviceCount={deviceCount} onSubmit={onSubmit} />;
};

const HotKeyRotationOverlay: FC<OverlayProps> = ({ accountPublicKey }) => {
  const { t } = useTranslation();
  const { signTransaction } = useMidenContext();
  const importHotKeyPair = useWalletStore(s => s.importHotKeyPair);
  const [importing, setImporting] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [txId, setTxId] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  // The device role the user chose in this overlay. `null` until a choice: no new rotation starts without one.
  const [mode, setMode] = useState<HotKeyActivationMode | null>(null);
  // The first lookup (adopt only) is done, so the gate knows whether a rotation exists before it asks.
  const [adoptChecked, setAdoptChecked] = useState(false);
  const inFlightRef = useRef<Promise<RotationLookup> | null>(null);
  const { row: rowById, loaded: rowLoaded } = useTransactionRow(txId ?? '');
  // Without an id the overlay tracks no row.
  const row = txId === null ? undefined : rowById;
  const { rotationRows, fundingRows, loaded: rowsLoaded } = useRotationGateRows(accountPublicKey);
  const feeFaucetId = useNativeFeeFaucetId();
  const baseFee = useVerificationBaseFee();
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: balances, isLoading: balancesLoading } = useAllBalances(accountPublicKey, allTokensBaseMetadata);
  const { data: claimableNotes, isFallback } = useClaimableNotes(accountPublicKey);
  const selection = useMemo(
    () => selectRotationFundingNotes({ data: claimableNotes, isFallback }, feeFaucetId, baseFee),
    [claimableNotes, isFallback, feeFaucetId, baseFee]
  );
  // While the rotation waits for funds, the pending-note scan is what finds transfers sent before the recovery.
  // The gate mounts only for the current account.
  const noteRecoveryPending = useWalletStore(
    s => s.currentAccount?.publicKey === accountPublicKey && s.currentAccount.guardianNoteRecoveryPending === true
  );
  const noteScan = guardianNoteScanText(useGuardianNoteRecoveryProgress(accountPublicKey, noteRecoveryPending), t);

  // Swallow hardware/gesture back while the wallet is blocked. Registered by
  // this component (which only mounts while blocking), so it is active exactly
  // when needed and unwinds automatically once the rotation lands.
  useMobileBackHandler(() => true, [], { overlay: true });

  const beginRotation = useCallback(
    async (adoptExisting: boolean, chosenMode: HotKeyActivationMode | null) => {
      // In-flight guard: strict-mode double-invoke and re-renders share one
      // promise instead of enqueueing duplicate rotation transactions.
      // (Cross-window duplication is handled inside ensureRotationTx.)
      if (inFlightRef.current) return;
      setInitError(null);
      inFlightRef.current = ensureRotationTx(accountPublicKey, adoptExisting, chosenMode);
      try {
        const lookup = await inFlightRef.current;
        switch (lookup.status) {
          case 'tracking':
            setTxId(lookup.txId);
            break;
          case 'none':
            // No rotation exists and no role is chosen: the gate asks for the role.
            setTxId(null);
            break;
          case 'deferred':
            break;
        }
        // A deferral too: the claim it waits on, maybe just requeued, runs in the worker's loop.
        if (isExtension()) requestSWTransactionProcessing();
      } catch (e) {
        setInitError(e instanceof Error ? e.message : String(e));
      } finally {
        inFlightRef.current = null;
        setAdoptChecked(true);
      }
    },
    [accountPublicKey]
  );

  // Mount adopts a rotation that exists, or continues with the role of the last rotation that did not complete
  // (a reload during a rotation). Without a role it starts no rotation: the user chooses one on the first screen.
  useEffect(() => {
    beginRotation(true, null);
  }, [beginRotation]);

  const onChooseRole = useCallback(
    (chosenMode: HotKeyActivationMode) => {
      setMode(chosenMode);
      armRecoveryPhraseKeepPrompt(accountPublicKey).catch(error =>
        console.warn('[HotKeyRotationGate] could not arm the recovery phrase prompt:', error)
      );
      beginRotation(false, chosenMode);
    },
    [accountPublicKey, beginRotation]
  );

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
    // Not before the rows load, nor while a found row loads: a rotation that exists must not flash the screen.
    roleChoicePending:
      adoptChecked && rowsLoaded && txId === null && mode === null && resumableActivationMode(rotationRows) === null,
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
    // Failed rows are terminal — retry always enqueues a fresh transaction, with the role chosen here, else
    // with the role of the failed rotation (a rotation adopted on mount).
    beginRotation(false, mode);
  }, [beginRotation, mode]);

  const confirm = useConfirm();
  const alert = useAlert();
  // The exit from a rotation that keeps failing: a confirmed wipe back to onboarding (#1648). The confirmation
  // names what the user needs, since nothing of this wallet survives the reset. The reset's failure contract is
  // the mainnet switch's: a rejected wipe and a reload that cannot start are both reported, nothing else is.
  const onStartOver = useCallback(async () => {
    const accepted = await confirm({
      title: t('hotKeyRotationStartOverTitle'),
      variant: 'explanation',
      children: t('hotKeyRotationStartOverBody'),
      confirmLabel: t('hotKeyRotationStartOver'),
      destructive: true
    });
    if (!accepted) return;
    try {
      await resetWalletAndReload(async () => {
        await alert({ errorId: 'resetDidNotFinish', title: t('error'), children: t('resetDidNotFinish') });
      });
    } catch {
      await alert({ errorId: 'resetDidNotFinish', title: t('error'), children: t('resetDidNotFinish') });
    }
  }, [alert, confirm, t]);

  const onImportKeyPair = useCallback(
    async (keyPairPayload: string) => {
      setImportBusy(true);
      setImportError(null);
      try {
        // Under the rotation lock, so no rotation queues beside the import and none already live lands after it.
        await navigator.locks.request(hotKeyRotationLockName(accountPublicKey), async () => {
          const live = await Repo.transactions
            .filter(r => isLiveRotationRow(r, accountPublicKey) || isLiveRotationFundingRow(r, accountPublicKey))
            .first();
          if (live) throw new Error(t('hotKeyRotationImportBusy'));
          await importHotKeyPair(accountPublicKey, keyPairPayload);
        });
      } catch (e) {
        console.error('[HotKeyRotationGate] key pair import failed:', e);
        setImportError(e instanceof Error && e.message ? e.message : t('importHotKeyError'));
        setImportBusy(false);
      }
    },
    [accountPublicKey, importHotKeyPair, t]
  );

  // A funding trigger never queues a second rotation beside a live one.
  const onFunded = useCallback(() => {
    if (!rotationLive && !importing) beginRotation(false, mode);
  }, [beginRotation, rotationLive, importing, mode]);

  const { retryClaim } = useRotationFundingClaim({
    accountPublicKey,
    active: rowsLoaded && gate.view === 'funding' && !rotationLive && !importing,
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
    gate.view === 'rotating' && txId === null && !rotationLive && !importing && !fundingRows.some(isLiveTransaction);
  useEffect(() => {
    if (deferredRotationDue) beginRotation(balancesLoading, mode);
  }, [beginRotation, deferredRotationDue, balancesLoading, mode, rotationRows, fundingRows]);

  const watchedRotationFailure = useWatchedTransactionFailure(row, rowLoaded, accountPublicKey, gate.view === 'failed');
  const watchedFundingRow = newestRow(fundingRows);
  const watchedFundingFailure = useWatchedTransactionFailure(
    watchedFundingRow,
    rowsLoaded,
    accountPublicKey,
    gate.view === 'funding' && gate.status === 'claim-failed'
  );
  const rotationFailure = describeRotationFailure(row, initError);
  const rotationErrorId: UserErrorId | null =
    gate.view === 'failed' && (initError !== null || watchedRotationFailure)
      ? rotationFailure.unconfirmed
        ? 'hotKeyRotationUnconfirmedBody'
        : rotationFailure.message
          ? 'raw_hot_key_rotation_failed'
          : 'hotKeyRotationFailedGeneric'
      : null;
  if (gate.view === 'recovery-seed' && row) {
    return <RecoverySeedPrompt transaction={row} onClose={() => Woozie.navigate('/')} />;
  }

  const claimFailure = describeRotationFailure(gate.view === 'funding' ? gate.failedClaim : undefined, null);
  const claimErrorId: UserErrorId | null = watchedFundingFailure
    ? claimFailure.unconfirmed
      ? 'hotKeyRotationFundingClaimUnconfirmed'
      : claimFailure.message
        ? 'raw_hot_key_rotation_funding_claim_failed'
        : 'hotKeyRotationFundingClaimFailed'
    : null;

  // The progress copy follows the activation mode: the one chosen here, else the one of the row the gate adopted.
  const progressMode: HotKeyActivationMode = mode ?? (row ? activationModeOf(row) : 'replace');

  if (!importing && gate.view === 'choose-role') {
    // The device-role step is a full page in the onboarding frame, not a card on the scrim: the user reads and
    // chooses here, so it gets the page background, the left-aligned title and the pinned CTA every step has.
    return (
      <div
        data-testid="hot-key-rotation-gate"
        className="fixed inset-0 z-[9999] flex flex-col bg-app-bg pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
      >
        <ChooseDeviceRoleStep accountPublicKey={accountPublicKey} onSubmit={onChooseRole} />
      </div>
    );
  }

  return (
    // A translucent scrim: the wallet stays visible
    // behind the overlay, just dimmed, blurred, and inert. `hot-key-rotation-gate`
    // is a test-only hook (E2E POM): it marks the overlay for as long as it's
    // mounted (spinning OR showing the terminal-failure surface below) — the
    // overlay unmounting IS the "rotation complete" signal.
    <div
      data-testid="hot-key-rotation-gate"
      className="fixed inset-0 z-[9999] flex flex-col items-center overflow-y-auto px-8 pt-[max(2rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))] text-center bg-pure-white/10 dark:bg-pure-black/50 [backdrop-filter:blur(24px)_saturate(1.5)] [-webkit-backdrop-filter:blur(24px)_saturate(1.5)]"
    >
      {/* `my-auto` centres the content and lets a taller one scroll from its top instead of clipping. */}
      <div className="my-auto flex w-full flex-col items-center gap-4">
        {importing ? (
          <div data-testid="hot-key-rotation-import" className="flex w-full flex-col items-center gap-4">
            <ImportHotKeyScreen submitting={importBusy} onSubmit={onImportKeyPair} />
            {importError && (
              <Notice
                errorId="importHotKeyError"
                tone="negative"
                role="alert"
                data-testid="hot-key-rotation-import-error"
              >
                {importError}
              </Notice>
            )}
            <Button variant={ButtonVariant.Secondary} disabled={importBusy} onClick={() => setImporting(false)}>
              {t('back')}
            </Button>
          </div>
        ) : gate.view === 'funding' ? (
          <RotationFundingPanel
            errorId={claimErrorId}
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
            noteScan={noteScan}
            onRetryClaim={() => {
              if (gate.failedClaim) retryClaim(gate.failedClaim);
            }}
            onCheckAgain={onRetry}
            onUseKeyPair={() => setImporting(true)}
          />
        ) : gate.view === 'failed' ? (
          <RotationFailedPanel
            failure={rotationFailure}
            errorId={rotationErrorId}
            onRetry={onRetry}
            onStartOver={onStartOver}
            onUseKeyPair={() => setImporting(true)}
          />
        ) : (
          <>
            <Spinner />
            <h1 className="text-lg font-semibold text-ink">
              {t(progressMode === 'add' ? 'hotKeyAddOverlayTitle' : 'hotKeyRotationOverlayTitle')}
            </h1>
            <p className="text-sm text-ink select-text">
              {t(progressMode === 'add' ? 'hotKeyAddOverlayBody' : 'hotKeyRotationOverlayBody')}
            </p>
          </>
        )}
      </div>
    </div>
  );
};

export default HotKeyRotationGate;
