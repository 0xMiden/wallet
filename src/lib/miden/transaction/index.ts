import { NoteType, TransactionProver, WasmWebClient } from '@miden-sdk/miden-sdk/lazy';
import { type Proposal } from '@openzeppelin/miden-multisig-client';

import {
  getOrCreateMultisigService,
  isGuardianAccount,
  type GuardianAccountProvider
} from 'lib/miden/front/guardian-manager';
import { MultisigService } from 'lib/miden/guardian';
import {
  isGuardianPendingConflict,
  withGuardianAccountLock,
  withGuardianConflictRetry
} from 'lib/miden/guardian/serialize';
import { assertGuardianInSync } from 'lib/miden/guardian/sync-guard';
import * as Repo from 'lib/miden/repo';
import { DEFAULT_NETWORK, MIDEN_NETWORK_ENDPOINTS } from 'lib/miden-chain/constants';
import { isMobile } from 'lib/platform';
import { logger } from 'shared/logger';

import { cancelStaleQueuedTransactions, cancelStuckTransactions, cancelTransaction } from './cancel';
import {
  completeBridgedSendTransaction,
  completeConsumeTransaction,
  completeCustomTransaction,
  completeEarnDepositTransaction,
  completeReplaceHotKeyTransaction,
  completeSendTransaction,
  completeSwapTransaction,
  completeSwitchGuardianTransaction,
  completeUpdateProcedureThresholdTransaction
} from './complete';
import { getAllUncompletedTransactions, getTransactionsInProgress } from './get';
import {
  buildSignCallbackError,
  isGuardianCanonicalizationError,
  isLockedError,
  readLastAuthReason,
  setTransactionStage,
  updateTransactionStatus
} from './helper';
import { importAllNotes } from '../activity/notes';
import {
  BridgedSendTransaction,
  ConsumeTransaction,
  EarnDepositTransaction,
  ITransaction,
  ITransactionStatus,
  ITransactionType,
  ReplaceHotKeyTransaction,
  SendTransaction,
  SwapTransaction,
  SwitchGuardianTransaction,
  Transaction,
  UpdateProcedureThresholdTransaction
} from '../db/types';
import { accountIdStringToSdk, canonicalWalletAccountId, sameWalletAccountId } from '../sdk/helpers';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';
import { MidenClientCreateOptions } from '../sdk/miden-client-interface';
import { buildNativeProverCallback } from '../sdk/native-prover-mobile';
import { NoteTypeEnum } from '../types';

export * from './cancel';
export * from './complete';
export * from './constants';
export * from './get';
export * from './helper';
export * from './initiate';
export * from './retry';

// Transaction types whose proposal creator is side-effect-free and idempotent on
// a pending-delta 409, so returning the tx to the queue for a later cycle is safe.
// Structural ops are deliberately EXCLUDED: `replace-hot-key` mints a hardware hot
// key inside createReplaceHotKeyProposal BEFORE its proposal POST, so a requeue
// re-mints and orphans another key every cycle; `switch-guardian` /
// `update-procedure-threshold` create a proposal (and switch-guardian cold
// co-signs) whose re-run can register a duplicate delta and push the commitment
// past the guardian's expected single delta. Those fall through to cancelTransaction.
const REQUEUEABLE_ON_PENDING_CONFLICT: ReadonlySet<ITransactionType> = new Set<ITransactionType>([
  'send',
  'consume',
  'swap',
  'earn-deposit',
  'execute'
]);

// Cooldown (seconds) applied to a tx requeued after a transient guardian
// pending-delta 409. A persistently-conflicting tx is always the OLDEST Queued
// row by initiatedAt, so without a backoff it is re-picked every cycle — burning
// the ~60s inline retry budget and starving another account's freshly-queued tx
// until it ages out at MAX_QUEUED_AGE. Setting `nextEligibleAt = now + this` makes
// the loop skip it for at least one cycle so other accounts drain first. Kept
// comfortably above the processing loop's ~5s poll interval so the skip is not a
// race; MAX_QUEUED_AGE stays the terminal cap.
const PENDING_CONFLICT_REQUEUE_COOLDOWN_SEC = 15;

/**
 * Run the structural side effects a structural Guardian op needs after its
 * submit landed on chain but the LOCAL apply failed (`ApplyTransactionAfterSubmitFailed`).
 * Without this the generic apply-failure handler would mark the tx Completed and
 * skip reconciliation, stranding the account.
 *
 * replace-hot-key → swap the vault hot pointer (idempotent).
 * switch-guardian → rebuild a service to drive `finalizeGuardianSwitch` (which
 *   re-syncs the post-switch account state itself) + persist the per-account
 *   endpoint. Both completion handlers tolerate a missing TransactionResult.
 */
async function reconcileStructuralApplyFailure(
  tx: ITransaction,
  guardianProvider: GuardianAccountProvider
): Promise<void> {
  if (tx.type === 'replace-hot-key') {
    await completeReplaceHotKeyTransaction(tx as ReplaceHotKeyTransaction, undefined, guardianProvider);
    return;
  }
  const service = await getOrCreateMultisigService(tx.accountId, guardianProvider);
  await completeSwitchGuardianTransaction(tx as SwitchGuardianTransaction, undefined, service, guardianProvider);
}

export const generateTransaction = async (
  transaction: Transaction,
  signCallback: (publicKey: string, signingInputs: string) => Promise<Uint8Array>,
  _useWorker: boolean = true,
  guardianProvider: GuardianAccountProvider
) => {
  // Sync state first to ensure we have latest account state
  // Separate lock acquisition to avoid holding lock during network call
  // If sync fails (e.g. network down), the error propagates to generateTransactionsLoop's
  // catch block which cancels the transaction — this is intentional fail-fast behavior,
  // since the transaction can't be submitted without network anyway
  await setTransactionStage(transaction.id, 'syncing');
  await withWasmClientLock(async () => {
    const midenClient = await getMidenClient();
    await midenClient.syncState();
  });

  // Mark transaction as in progress
  await updateTransactionStatus(transaction.id, ITransactionStatus.GeneratingTransaction, {
    processingStartedAt: Math.floor(Date.now() / 1000), // seconds
    stage: 'sending'
  });

  // Route Guardian accounts through Guardian service
  if (await isGuardianAccount(transaction.accountId, guardianProvider)) {
    try {
      // Serialize guardian transactions per account: the guardian co-signs one
      // delta per account at a time, and concurrent same-account txs make its
      // expected commitment diverge from on-chain, stalling canonicalization
      // for minutes (see guardian/serialize.ts and OpenZeppelin/guardian#303).
      // Canonicalize the lock key: the same guardian account can arrive as a bare
      // bech32 address (dApp) or the composite publicKey (in-wallet); both must take
      // the SAME per-account chain, else concurrent deltas stall canonicalization.
      await withGuardianAccountLock(canonicalWalletAccountId(transaction.accountId), () =>
        generateGuardianTransaction(transaction, signCallback, guardianProvider)
      );
    } catch (error) {
      // The wallet locked (vault === null) somewhere in the guardian flow: DEFER,
      // don't cancel. Re-throw so generateTransactionsLoop's locked-requeue path
      // leaves the tx Queued for retry after unlock instead of marking it Failed
      // and losing the note-claim (issue #313).
      if (isLockedError(error)) {
        throw error;
      }
      // Submit-succeeded-but-local-apply-failed on a structural op (replace-hot-key
      // / switch-guardian) is special: the change IS on chain, but the failure
      // happened before generateGuardianTransaction's completion handler ran, so
      // the vault hot pointer / guardian re-registration are un-reconciled. Cancelling
      // would strand the account (signing with a rotated-out key, or talking to the
      // old guardian). Run the same finalization the happy path would; only cancel if
      // that reconcile itself fails.
      if (
        extractSdkErrorCode(error) === 'ApplyTransactionAfterSubmitFailed' &&
        (transaction.type === 'replace-hot-key' || transaction.type === 'switch-guardian')
      ) {
        try {
          await reconcileStructuralApplyFailure(transaction, guardianProvider);
          return;
        } catch (reconcileError) {
          console.error('Structural-op apply-failure reconcile failed; cancelling', reconcileError);
        }
      }
      // Value-moving guardian op (consume/send/swap/execute) whose submit landed on
      // chain but whose LOCAL apply failed. The tx IS live — cancelling would leave
      // it terminally Failed while the note is spent on chain (conservation loss),
      // and verifyStuckTransactionsFromNode only scans in-progress rows so it can't
      // recover a Failed one. Mirror generateTransactionsLoop's generic
      // ApplyTransactionAfterSubmitFailed handler: mark Completed so the next sync
      // reconciles the note state via ConsumedExternal. (Structural ops are handled
      // above and never reach here on success.)
      //
      // Earn-deposit is the exception among value-moving guardian ops: its caller
      // (`createEarnP2IDNote` via `waitForTransactionCompletion`) reads
      // `resultBytes`/`outputNoteIds` back off the finished row. On a post-submit
      // failure — a local apply throw OR a canonicalization race — there is NO
      // TransactionResult to repopulate them, so marking the row Completed (as the
      // branches below do for send/consume/swap/execute) would leave the caller to
      // `TransactionResult.deserialize(undefined)`, which throws AFTER `cleanup()` and
      // hangs the wait promise (and `openEarnPosition`) forever. Fail the row instead
      // so the caller resolves via the error branch; the on-chain P2IDE collateral note
      // reclaims itself at its recall height. Mirrors generateTransactionsLoop's
      // non-guardian guard; earn-deposit is excluded from `REQUEUEABLE_TYPES` (retry.ts)
      // so a Failed row is never re-queued into a duplicate collateral note. (It IS a
      // member of REQUEUEABLE_ON_PENDING_CONFLICT, but that set only requeues still-Queued
      // rows on a transient pre-submit 409; a Failed row is terminal.)
      if (
        transaction.type === 'earn-deposit' &&
        (extractSdkErrorCode(error) === 'ApplyTransactionAfterSubmitFailed' || isGuardianCanonicalizationError(error))
      ) {
        console.warn(
          '[Guardian] earn-deposit submitted but post-submit reconcile failed — marking Failed so the awaiting caller stops waiting:',
          error
        );
        await cancelTransaction(transaction, error);
        return;
      }
      if (
        extractSdkErrorCode(error) === 'ApplyTransactionAfterSubmitFailed' &&
        (transaction.type === 'consume' ||
          transaction.type === 'send' ||
          transaction.type === 'swap' ||
          transaction.type === 'execute')
      ) {
        console.warn(
          '[Guardian] submit landed but local apply failed — marking Completed; sync will reconcile:',
          error
        );
        try {
          await updateTransactionStatus(transaction.id, ITransactionStatus.Completed, {
            displayMessage: transaction.type === 'consume' ? 'Claimed' : 'Sent',
            completedAt: Math.floor(Date.now() / 1000) // seconds
          });
        } catch (markErr) {
          // updateTransactionStatus throws if the tx is already finalized — fine.
          console.warn('[Guardian] could not re-mark Completed (likely already finalized):', markErr);
        }
        return;
      }
      // Guardian canonicalization is eventually-consistent: the SDK can throw
      // "Refusing to overwrite local state: incoming nonce N is not greater
      // than local nonce M" when the guardian's view lags the local client.
      // The on-chain tx is fine — only the local sync refused. Mark Completed
      // so the user sees the success state; the next sync tick will reconcile.
      if (isGuardianCanonicalizationError(error)) {
        console.warn('[Guardian] canonicalization race during tx generation — marking Completed:', error);
        try {
          await updateTransactionStatus(transaction.id, ITransactionStatus.Completed, {
            displayMessage: transaction.type === 'consume' ? 'Claimed' : 'Sent',
            completedAt: Math.floor(Date.now() / 1000) // seconds
          });
        } catch (markErr) {
          // updateTransactionStatus throws if the tx is already finalized — fine.
          console.warn('[Guardian] could not re-mark Completed (likely already finalized):', markErr);
        }
        return;
      }
      // A transient guardian 409 (a prior delta still canonicalizing) that
      // outlasted withGuardianConflictRetry's budget is NOT a terminal failure
      // for a VALUE-MOVING op: the single-delta lock clears on its own, and its
      // proposal creator is side-effect-free/idempotent, so returning the tx to
      // the queue for the next generateTransactionsLoop cycle is safe. We reset
      // the status to Queued AND clear processingStartedAt — a bare return would
      // leave it GeneratingTransaction, which cancelStuckTransactions would then
      // reap as stalled; cancelStaleQueuedTransactions (MAX_QUEUED_AGE) remains
      // the terminal cap. We also stamp `nextEligibleAt` so the loop backs this
      // tx off for a cycle rather than re-picking it as the oldest row every
      // time — otherwise it would starve another account's queued tx.
      //
      // Structural ops are gated OUT (see REQUEUEABLE_ON_PENDING_CONFLICT): a
      // replace-hot-key 409 escapes createReplaceHotKeyProposal AFTER the hardware
      // hot key was minted, so requeueing would re-mint and orphan a key every
      // cycle; switch-guardian / update-procedure-threshold re-runs can register a
      // duplicate delta. They fall through to cancelTransaction — the user retries.
      if (isGuardianPendingConflict(error) && REQUEUEABLE_ON_PENDING_CONFLICT.has(transaction.type)) {
        console.warn('[Guardian] proposal still conflicting after retry budget — requeueing for a later cycle');
        await updateTransactionStatus(transaction.id, ITransactionStatus.Queued, {
          processingStartedAt: undefined,
          stage: 'creating-proposal',
          nextEligibleAt: Math.floor(Date.now() / 1000) + PENDING_CONFLICT_REQUEUE_COOLDOWN_SEC
        });
        // An earn-deposit's requestBytes freeze an ABSOLUTE reclaim height at build
        // time (syncHeight + recallBlocks). Unlike send/swap — whose reused note stays
        // valid indefinitely — the Epoch allocator rejects a collateral note whose
        // REMAINING reclaim window has shrunk below its minimum, so reusing the frozen
        // bytes across a long requeue loop (up to MAX_QUEUED_AGE) would strand the
        // collateral at the allocator. Drop the cached request so the next cycle rebuilds
        // the P2IDE note against a fresh sync height. Safe here: no collateral note reached
        // the chain — any proposal that a 409 from the un-retried
        // signAndCreateTransactionRequest may have registered was already abandoned by the
        // submit catch — so rebuilding a fresh note orphans nothing.
        if (transaction.type === 'earn-deposit') {
          await Repo.transactions.where({ id: transaction.id }).modify(t => {
            t.requestBytes = undefined;
          });
        }
        return;
      }
      await cancelTransaction(transaction, error);
    }
    return;
  }

  const options: MidenClientCreateOptions = {
    signCallback: async (publicKey: Uint8Array, signingInputs: Uint8Array) => {
      const keyString = Buffer.from(publicKey).toString('hex');
      const signingInputsString = Buffer.from(signingInputs).toString('hex');
      try {
        return await signCallback(keyString, signingInputsString);
      } catch (err) {
        // The SDK (WebKeyStore) captures the raw thrown value and exposes
        // it via `midenClient.lastAuthError()`. Attach a stable `reason`
        // tag so callers that catch the eventual executeTransaction
        // failure can distinguish "wallet got locked mid-sign" from other
        // failure modes (user rejection, keystore IO error, etc.).
        throw buildSignCallbackError(err);
      }
    }
  };

  // MidenClient handles the full pipeline (execute → prove → submit → apply)
  const result = await withWasmClientLock(async () => {
    const midenClient = await getMidenClient(options);
    switch (transaction.type) {
      case 'send':
        return await midenClient.sendTransaction(transaction as SendTransaction);
      case 'consume':
        return await midenClient.consumeNoteId(transaction as ConsumeTransaction);
      case 'swap':
        return await midenClient.swapTransaction(transaction as SwapTransaction);
      case 'bridged-send':
        // Epoch bridges by sending a recallable P2IDE note (send-style, no
        // `requestBytes`); Agglayer carries a pre-built request.
        if (!transaction.requestBytes) {
          return midenClient.sendTransaction(transaction as SendTransaction);
        }
        return midenClient.newTransaction(
          transaction.accountId,
          transaction.requestBytes,
          transaction.delegateTransaction
        );
      case 'earn-deposit':
        // Always send-style (recallable P2IDE note to the Epoch allocator).
        return midenClient.sendTransaction(transaction as SendTransaction);
      case 'execute':
      default:
        return await midenClient.newTransaction(
          transaction.accountId,
          transaction.requestBytes!,
          transaction.delegateTransaction
        );
    }
  });

  switch (transaction.type) {
    case 'send':
      await completeSendTransaction(transaction as SendTransaction, result);
      break;
    case 'consume':
      await completeConsumeTransaction(transaction.id, result);
      break;
    case 'swap':
      await completeSwapTransaction(transaction as SwapTransaction, result);
      break;
    case 'bridged-send':
      await completeBridgedSendTransaction(transaction as BridgedSendTransaction, result);
      break;
    case 'earn-deposit':
      await completeEarnDepositTransaction(transaction as EarnDepositTransaction, result);
      break;
    case 'execute':
    default:
      await completeCustomTransaction(transaction, result);
      break;
  }
};

/**
 * Build a transient cold-bound MultisigService for `accountId`. Cold signing
 * goes through the SDK keystore (not the SE/StrongBox-wrapped hot key) — used
 * for structural ops that must be cold-signed.
 */
const buildColdServiceForAccount = async (
  accountId: string,
  guardianProvider: GuardianAccountProvider
): Promise<MultisigService> => {
  const walletAccount = (await guardianProvider.getAccounts()).find(a => a.publicKey === accountId);
  if (!walletAccount) {
    throw new Error(`Guardian account ${accountId} not found in provider`);
  }
  const sdkAccount = await withWasmClientLock(async () => {
    const midenClient = await getMidenClient();
    return midenClient.getAccount(accountId);
  });
  if (!sdkAccount) {
    throw new Error(`Guardian account ${accountId} not found in local client`);
  }
  return MultisigService.buildColdMultisigService(sdkAccount, walletAccount, guardianProvider.signWord);
};

/**
 * Generate a transaction for a Guardian account using the MultisigService.
 * Routes the transaction through MultisigService proposal methods.
 */
const generateGuardianTransaction = async (
  transaction: ITransaction,
  signCallback: (publicKey: string, signingInputs: string) => Promise<Uint8Array>,
  guardianProvider: GuardianAccountProvider
): Promise<void> => {
  // Gate ordinary guardian-signed ops while the stored endpoint is untrustworthy.
  // 'switch-guardian' is exempt: it's the deliberate, user-initiated provider
  // change (GuardianSettings) and must stay available as a manual recovery path.
  // The primary recovery mechanisms — resolveGuardianDrift's auto-resolution and
  // applyUserGuardianEndpoint's verified-URL apply — reconcile the vault directly
  // and never route through this function, so exempting switch-guardian here only
  // affects the deliberate Settings-driven switch flow, not account recovery.
  if (transaction.type !== 'switch-guardian') {
    const walletAccount = (await guardianProvider.getAccounts()).find(a =>
      sameWalletAccountId(a.publicKey, transaction.accountId)
    );
    if (walletAccount) {
      assertGuardianInSync(walletAccount);
    }
  }

  // Set the stage eagerly — `getOrCreateMultisigService` and the subsequent
  // `createXxxProposal` call can both hit the guardian over the network,
  // so surfacing "Creating proposal" immediately is more honest than
  // leaving the label stuck on "Sending transaction".
  await setTransactionStage(transaction.id, 'creating-proposal');
  let proposalResult: Proposal;
  // The service that creates the proposal AND issues the final
  // signAndCreateTransactionRequest. Hot-bound for routine ops; cold-bound for
  // structural ops (replace-hot-key / update-procedure-threshold). The
  // hot-bound path is the only one cached by guardian-manager; cold services
  // here are transient.
  //
  // `withGuardianConflictRetry` waits out a transient 409 ConflictPendingDelta
  // (a prior delta still canonicalizing) instead of failing the tx. It wraps
  // only side-effect-free proposal creation — NOT replace-hot-key, whose
  // createReplaceHotKeyProposal mints a fresh hardware hot key, so retrying it
  // would orphan SE/StrongBox keys.
  let service: MultisigService;

  switch (transaction.type) {
    case 'send': {
      const sendTx = transaction as SendTransaction;
      service = await getOrCreateMultisigService(transaction.accountId, guardianProvider);
      const recallBlocks = sendTx.extraInputs?.recallBlocks;
      if (recallBlocks) {
        // TEMP WORKAROUND (OpenZeppelin/guardian#366): the multisig client's
        // P2ID send proposal has no reclaim support, so the expiration the
        // user picked used to be silently dropped on Guardian accounts —
        // every guardian send went out as a plain P2ID, never recallable.
        // Route recallable sends through a custom proposal built from a P2IDE
        // send request instead; once createP2idProposal grows
        // reclaimHeight/timelockHeight options, replace this branch with the
        // typed API. `recallBlocks` is a
        // RELATIVE blocks-until-recall offset; this is the guardian-path
        // counterpart of the relative→absolute conversion in
        // `MidenClientInterface.sendTransaction`.
        //
        // The P2IDE note's serial number is random, so the request must be
        // built ONCE and the exact same bytes reused for BOTH
        // `createCustomProposal` and `signAndCreateTransactionRequest` below —
        // persist them so a retry after a restart reuses the same request
        // (same rule as the PSWAP case).
        if (!transaction.requestBytes) {
          const requestBytes = await withWasmClientLock(async () => {
            const midenClient = await getMidenClient();
            const syncHeight = await midenClient.client.getSyncHeight();
            const client = await WasmWebClient.createClient(MIDEN_NETWORK_ENDPOINTS.get(DEFAULT_NETWORK)!);
            try {
              const tr = await client.newSendTransactionRequest(
                accountIdStringToSdk(sendTx.accountId),
                accountIdStringToSdk(sendTx.secondaryAccountId),
                accountIdStringToSdk(sendTx.faucetId),
                sendTx.noteType === NoteTypeEnum.Public ? NoteType.Public : NoteType.Private,
                BigInt(sendTx.amount),
                syncHeight + recallBlocks,
                null
              );
              return tr.serialize();
            } finally {
              client.terminate();
            }
          });
          transaction.requestBytes = requestBytes;
          await Repo.transactions.where({ id: transaction.id }).modify(t => {
            t.requestBytes = requestBytes;
          });
        }
        proposalResult = await withGuardianConflictRetry(() =>
          service.createCustomProposal(transaction.requestBytes!, 'recallable_send')
        );
      } else {
        proposalResult = await withGuardianConflictRetry(() =>
          service.createSendProposal(sendTx.secondaryAccountId, sendTx.faucetId, BigInt(sendTx.amount))
        );
      }
      break;
    }
    case 'consume': {
      const consumeTx = transaction as ConsumeTransaction;
      // Always hot-bound, including background/auto-consume. Auto-consume used
      // to be routed through the COLD key because the iOS SE hot key carried
      // `.userPresence` — hot-signing a silent background claim would have
      // popped Face ID on every attempt. That flag is gone (hot signing is
      // silent everywhere now), so the cold detour buys nothing and the cached
      // hot service is strictly cheaper than building a transient cold one.
      const consumeNoteIds = consumeTx.noteIds?.length > 0 ? consumeTx.noteIds : [consumeTx.noteId];
      service = await getOrCreateMultisigService(transaction.accountId, guardianProvider);
      proposalResult = await withGuardianConflictRetry(() => service.createConsumeNotesProposal(consumeNoteIds));
      break;
    }
    case 'switch-guardian': {
      const sgTx = transaction as SwitchGuardianTransaction;
      service = await getOrCreateMultisigService(transaction.accountId, guardianProvider);
      const { proposal } = await withGuardianConflictRetry(() =>
        service.createSwitchGuardianProposal(sgTx.extraInputs.newGuardianEndpoint)
      );
      proposalResult = proposal;
      break;
    }
    case 'replace-hot-key': {
      const walletAccount = (await guardianProvider.getAccounts()).find(a => a.publicKey === transaction.accountId);
      if (!walletAccount) {
        throw new Error(`Guardian account ${transaction.accountId} not found in provider`);
      }
      const sdkAccount = await withWasmClientLock(async () => {
        const midenClient = await getMidenClient();
        return midenClient.getAccount(transaction.accountId);
      });
      if (!sdkAccount) {
        throw new Error(`Guardian account ${transaction.accountId} not found in local client`);
      }
      service = await MultisigService.buildColdMultisigService(sdkAccount, walletAccount, guardianProvider.signWord);
      // NOT retry-wrapped — createReplaceHotKeyProposal mints a hot key.
      const { proposal, newHot } = await service.createReplaceHotKeyProposal(sdkAccount);
      if (!guardianProvider.persistNewHotKey) {
        throw new Error('persistNewHotKey not implemented in this provider');
      }
      // Persist the new hot ciphertext BEFORE submitting. Old hot stays valid
      // until the on-chain rotation lands so this is idempotent. If the app
      // dies between submit and complete, the new ciphertext is on disk and
      // complete reconciles against the on-chain state.
      // KNOWN LEAK: if this rotation terminally fails (submit error → tx
      // cancelled, never reconciled) and the user re-initiates, a fresh hardware
      // key is minted while this one's SE/Keystore entry + ciphertext blob are
      // left orphaned (inert). A blind delete-on-failure here is unsafe — the
      // persist-before-submit design relies on this blob surviving for the
      // reconcile path — so reaping orphaned pending keys belongs in a dedicated
      // cleanup, not this hot path.
      await guardianProvider.persistNewHotKey(newHot.publicKeyHex, newHot.ciphertext);
      // Stash the new pubkey on the in-memory transaction AND in dexie so
      // complete (which may run after a process restart) can find it.
      const rTx = transaction as ReplaceHotKeyTransaction;
      rTx.extraInputs = { ...(rTx.extraInputs ?? {}), newHotPublicKey: newHot.publicKeyHex };
      await Repo.transactions.where({ id: transaction.id }).modify(t => {
        t.extraInputs = rTx.extraInputs;
      });
      proposalResult = proposal;
      break;
    }
    case 'bridged-send': {
      const bridgeTx = transaction as BridgedSendTransaction;
      service = await getOrCreateMultisigService(transaction.accountId, guardianProvider);
      if (bridgeTx.requestBytes) {
        // Agglayer: preview the pre-built request into a custom multisig proposal.
        proposalResult = await service.createCustomProposal(bridgeTx.requestBytes);
      } else {
        // Epoch: a recallable P2IDE note to the solver's allocator — propose it as
        // a send. (The multisig send proposal is P2ID today, so the Epoch recall
        // safety net is not yet available on Guardian accounts.)
        proposalResult = await service.createSendProposal(
          bridgeTx.secondaryAccountId!,
          bridgeTx.faucetId,
          BigInt(bridgeTx.amount)
        );
      }
      break;
    }
    case 'earn-deposit': {
      // Guardian earn deposit: the Epoch mandate requires a P2IDE collateral note
      // with a reclaim height, which the multisig client's P2ID proposal cannot
      // express — so route it through a custom proposal built from a P2IDE send
      // request, exactly like the recallable `send` case (see OpenZeppelin/
      // guardian#366). `recallBlocks` (set on the row by `openEarnPosition`) is a
      // RELATIVE blocks-until-reclaim offset; the note's absolute reclaim height is
      // `syncHeight + recallBlocks` at build time, the same relative→absolute
      // conversion the non-Guardian path uses. The Epoch allocator validates the
      // REMAINING reclaim window against its own (later) chain head — not an exact
      // height — so the extra guardian propose/sign/submit delay is absorbed by
      // `MIDEN_RECLAIM_BUFFER_BLOCKS` baked into `recallBlocks` (see earn-note.ts).
      const earnTx = transaction as EarnDepositTransaction;
      service = await getOrCreateMultisigService(transaction.accountId, guardianProvider);
      const recallBlocks = earnTx.extraInputs?.recallBlocks;
      if (!recallBlocks || !earnTx.secondaryAccountId) {
        throw new Error(
          'Earn deposit is missing recallBlocks/allocator — the collateral must be a recallable P2IDE note.'
        );
      }
      // If openEarnPosition already abandoned this deposit — its 5-min
      // waitForTransactionCompletion timed out, or the Epoch intent was aborted — it
      // marked extraInputs.epochStatus 'failed'. A guardian requeue can keep this row
      // live past that wait (up to MAX_QUEUED_AGE), so bail out rather than submit a
      // collateral note the allocator has no live intent for: that would strand the note
      // until its recall height AND falsely mark the row 'Deposited to lending'. This
      // throw is terminal (→ cancelTransaction below), and a Failed row is never re-picked.
      if (earnTx.extraInputs?.epochStatus === 'failed') {
        throw new Error(
          'Earn deposit was already abandoned by the caller (epochStatus=failed) — refusing to submit an orphan collateral note.'
        );
      }
      // The P2IDE note's serial number is random, so build the request ONCE and
      // reuse the exact same bytes for BOTH `createCustomProposal` and
      // `signAndCreateTransactionRequest` below; persist them so a retry after a
      // process restart reuses the same request (same rule as send/swap).
      if (!transaction.requestBytes) {
        const requestBytes = await withWasmClientLock(async () => {
          const midenClient = await getMidenClient();
          // Prefer a fresh sync (like the non-Guardian earn path,
          // MidenClientInterface.sendTransaction) so the absolute reclaim height is
          // measured against a CURRENT chain head — a stale cached height on a
          // cold-started wallet could understate it enough that the note's remaining
          // reclaim window falls below the allocator's minimum and the deposit is
          // rejected. But a network sync can fail/time out, and that must NOT fail an
          // otherwise-submittable deposit, so fall back to the last-synced height (the
          // recall buffer absorbs mild lag). This keeps the guardian path no more
          // network-fragile than the pre-fresh-sync behavior.
          let syncHeight: number;
          try {
            syncHeight = (await midenClient.client.sync()).blockNum();
          } catch (syncError) {
            console.warn(
              '[Guardian] fresh sync before earn-deposit note build failed; using last-synced height',
              syncError
            );
            syncHeight = await midenClient.client.getSyncHeight();
          }
          const client = await WasmWebClient.createClient(MIDEN_NETWORK_ENDPOINTS.get(DEFAULT_NETWORK)!);
          try {
            const tr = await client.newSendTransactionRequest(
              accountIdStringToSdk(earnTx.accountId),
              accountIdStringToSdk(earnTx.secondaryAccountId!),
              accountIdStringToSdk(earnTx.faucetId),
              // Earn collateral is always a PUBLIC P2IDE note — the Epoch allocator
              // discovers and consumes it on-chain (createEarnP2IDNote hardcodes it).
              NoteType.Public,
              BigInt(earnTx.amount),
              syncHeight + recallBlocks,
              null
            );
            return tr.serialize();
          } finally {
            client.terminate();
          }
        });
        transaction.requestBytes = requestBytes;
        await Repo.transactions.where({ id: transaction.id }).modify(t => {
          t.requestBytes = requestBytes;
        });
      }
      proposalResult = await withGuardianConflictRetry(() =>
        service.createCustomProposal(transaction.requestBytes!, 'earn_deposit')
      );
      break;
    }
    case 'swap': {
      service = await getOrCreateMultisigService(transaction.accountId, guardianProvider);
      const swapTx = transaction as SwapTransaction;
      // PSWAP notes carry a randomly-generated serial number, so the request
      // must be built ONCE and the exact same bytes reused for BOTH
      // `createCustomProposal` and `signAndCreateTransactionRequest` below (the
      // latter rebuilds the final tx from these bytes + the proposal's advice
      // map, and throws if they're missing). Persist them so a retry after a
      // process restart reuses the same request instead of registering a
      // second, divergent proposal.
      if (!transaction.requestBytes) {
        const requestBytes = await withWasmClientLock(async () => {
          const client = await WasmWebClient.createClient(MIDEN_NETWORK_ENDPOINTS.get(DEFAULT_NETWORK)!);
          try {
            const tr = await client.newPswapCreateTransactionRequest(
              accountIdStringToSdk(swapTx.accountId),
              accountIdStringToSdk(swapTx.faucetId),
              swapTx.amount,
              accountIdStringToSdk(swapTx.extraInputs.requestedFaucetId),
              swapTx.extraInputs.requestedAmount,
              NoteType.Public,
              NoteType.Public
            );
            return tr.serialize();
          } finally {
            client.terminate();
          }
        });
        transaction.requestBytes = requestBytes;
        await Repo.transactions.where({ id: transaction.id }).modify(t => {
          t.requestBytes = requestBytes;
        });
      }
      proposalResult = await withGuardianConflictRetry(() =>
        service.createCustomProposal(transaction.requestBytes!, 'swap')
      );
      break;
    }
    case 'update-procedure-threshold': {
      // Cold-routed structural change (same class as switch-guardian /
      // replace-hot-key): cold + guardian satisfies it on-chain.
      const uptTx = transaction as UpdateProcedureThresholdTransaction;
      service = await buildColdServiceForAccount(transaction.accountId, guardianProvider);
      proposalResult = await withGuardianConflictRetry(() =>
        service.createUpdateProcedureThresholdProposal(uptTx.extraInputs.procedure, uptTx.extraInputs.threshold)
      );
      break;
    }
    case 'execute':
    default: {
      // For custom transactions, build a custom proposal from the serialized
      // request bytes. Hot-routed (threshold-1). A custom proposal that embeds a
      // structural op (e.g. update_guardian / add_signer) cannot bypass the
      // hardening: the on-chain `procedureThresholds` map enforces per-procedure
      // thresholds (update_guardian = 2 → needs cold + guardian) during proof
      // verification regardless of which key signed the proposal here.
      const requestBytes = transaction.requestBytes;
      if (!requestBytes) {
        throw new Error('Request Bytes not available for custom transaction');
      }
      service = await getOrCreateMultisigService(transaction.accountId, guardianProvider);
      proposalResult = await withGuardianConflictRetry(() => service.createCustomProposal(requestBytes));
      break;
    }
  }

  // Sign and execute the proposal
  await setTransactionStage(transaction.id, 'signing-proposal');

  // switch_guardian is on-chain threshold-2 (set at create time via
  // procedureThresholds). Hot's signAndCreateTransactionRequest below
  // contributes one sig; we add the cold sig here. Sigs accumulate on the
  // Guardian server keyed by proposal id so order doesn't matter, and the
  // transient cold service is dropped at scope exit.
  if (transaction.type === 'switch-guardian') {
    const walletAccount = (await guardianProvider.getAccounts()).find(a => a.publicKey === transaction.accountId);
    if (!walletAccount) {
      throw new Error(`Guardian account ${transaction.accountId} not found in provider`);
    }
    const sdkAccount = await withWasmClientLock(async () => {
      const midenClient = await getMidenClient();
      return midenClient.getAccount(transaction.accountId);
    });
    if (!sdkAccount) {
      throw new Error(`Guardian account ${transaction.accountId} not found in local client`);
    }
    const coldService = await MultisigService.buildColdMultisigService(
      sdkAccount,
      walletAccount,
      guardianProvider.signWord
    );
    // Wait out a transient 409 ConflictPendingDelta on the cold co-sign too —
    // otherwise a prior delta mid-canonicalization fails the whole switch even
    // though the hot proposal already landed.
    await withGuardianConflictRetry(() => coldService.signProposal(proposalResult.id));
  }

  let submittedTransaction;
  try {
    const tr = await service.signAndCreateTransactionRequest(proposalResult.id, transaction.requestBytes);
    const options: MidenClientCreateOptions = {
      signCallback: async (publicKey: Uint8Array, signingInputs: Uint8Array) => {
        const keyString = Buffer.from(publicKey).toString('hex');
        const signingInputsString = Buffer.from(signingInputs).toString('hex');
        return await signCallback(keyString, signingInputsString);
      }
    };

    await setTransactionStage(transaction.id, 'sending');
    submittedTransaction = await withWasmClientLock(async () => {
      const midenClient = await getMidenClient(options);
      await setTransactionStage(transaction.id, 'executing');
      const executedTx = await midenClient.client.transactions.executeRequest(transaction.accountId, tr);
      await setTransactionStage(transaction.id, 'proving');
      let provenTx;
      if (!transaction.delegateTransaction) {
        // Local (non-delegated) proving. The guardian pipeline drives the raw
        // client directly, whose default local prover is the single-threaded
        // WASM one — which on iOS WKWebView runs on the main thread and freezes
        // the UI for the whole multi-second prove. Route to the native Rust
        // prover on mobile (off the main thread via @miden/native-prover),
        // exactly like `proveWithFallback`'s localProverFactory and the
        // delegated fallback below; WASM local prover elsewhere.
        const localProver = isMobile()
          ? TransactionProver.newCallbackProver(buildNativeProverCallback())
          : TransactionProver.newLocalProver();
        provenTx = await executedTx.prove({ prover: localProver });
      } else {
        // Delegated (remote) proving. The client's default prover is the remote
        // gRPC prover on every platform, and its ~10s deadline is too tight for a
        // heavyweight guardian multisig proof when the machine is under load — a
        // single "Deadline expired" used to kill the whole co-signed transaction
        // (surfacing as the guardian 409 canonicalize-conflict retry loop and a
        // claim timeout), because the guardian pipeline drives the raw client
        // directly and had none of the local fallback the non-guardian path gets
        // for free from `proveWithFallback`. Give it that resilience: on remote
        // failure, re-prove the SAME executed tx locally. Re-proving is safe
        // because `proveTransaction` borrows the executed result (only the prover
        // is consumed, and each attempt passes a fresh one). The local prover
        // mirrors `proveWithFallback`: the native Rust prover on mobile (WASM
        // proving isn't viable in iOS WKWebView), the WASM local prover elsewhere.
        try {
          provenTx = await executedTx.prove({});
        } catch (proveError) {
          console.warn('Delegated guardian prove failed; retrying with local prover', proveError);
          const fallbackProver = isMobile()
            ? TransactionProver.newCallbackProver(buildNativeProverCallback())
            : TransactionProver.newLocalProver();
          provenTx = await executedTx.prove({ prover: fallbackProver });
        }
      }
      await setTransactionStage(transaction.id, 'submitting');
      const submittedTx = await provenTx.submit();
      await submittedTx.apply();
      return executedTx;
    });
  } catch (error) {
    console.error('Error during Guardian transaction submission or execution', { error });
    try {
      await service.abandonCandidate(proposalResult.nonce);
    } catch (abandonError) {
      // Cleanup must never mask the transaction failure. The abandonment call
      // is idempotent, so a later recovery path can safely retry it.
      console.error('Failed to request Guardian candidate abandonment', {
        nonce: proposalResult.nonce,
        error: abandonError
      });
    }
    throw error;
  }

  const { id, result } = submittedTransaction;

  // For switch-guardian, the new guardian must be seeded with the POST-switch
  // account state. submit() returns after submission, not after inclusion, so
  // without this wait finalizeGuardianSwitch would serialize the pre-switch
  // account and register that stale state with the new guardian.
  // For replace-hot-key, we wait so the WalletAccount.hotPublicKey swap in
  // complete only happens once the on-chain rotation is final — otherwise a
  // resync could race with stale on-chain state and pick the wrong canonical
  // hot pubkey.
  // For update-procedure-threshold, we wait so the post-completion guardian
  // re-registration serializes the COMMITTED post-threshold state — otherwise it
  // could push a pre-threshold blob and leave the guardian diverged again.
  if (
    transaction.type === 'switch-guardian' ||
    transaction.type === 'replace-hot-key' ||
    transaction.type === 'update-procedure-threshold'
  ) {
    await setTransactionStage(transaction.id, 'confirming');
    await withWasmClientLock(async () => {
      const midenClient = await getMidenClient();
      await midenClient.waitForTransactionCommit(id.toHex());
    });
  }

  // Sync the cached hot service so the next consumer sees post-tx state.
  //
  // Skipped for the structural ops (replace-hot-key / update-procedure-threshold
  // / switch-guardian): each runs on a transient/cold service and invalidates
  // the cached hot service in its completion handler (clearGuardianServiceFor),
  // so there's nothing useful to sync here. For switch-guardian specifically a
  // sync here would also be MIS-ORDERED: completeSwitchGuardianTransaction must
  // run finalizeGuardianSwitch (register on the new guardian) "before anything
  // else touches the local cache or storage", and this runs before the
  // completion switch below.
  //
  // Post-completion bookkeeping only: the transaction is already marked Completed
  // and the on-chain submit succeeded, so a sync failure here must NOT propagate
  // (it would flip a genuinely-successful transaction to Failed). The next sync
  // tick reconciles.
  if (
    transaction.type !== 'replace-hot-key' &&
    transaction.type !== 'update-procedure-threshold' &&
    transaction.type !== 'switch-guardian'
  ) {
    try {
      await setTransactionStage(transaction.id, 'guardian-syncing');
      await service.sync();
      await setTransactionStage(transaction.id, 'guardian-synced');
    } catch (error) {
      console.warn('[Guardian] post-completion sync failed; will reconcile on next tick', error);
    }
  }

  switch (transaction.type) {
    case 'send':
      await completeSendTransaction(transaction as SendTransaction, result);
      break;
    case 'consume':
      await completeConsumeTransaction(transaction.id, result);
      break;
    case 'switch-guardian':
      await completeSwitchGuardianTransaction(
        transaction as SwitchGuardianTransaction,
        result,
        service,
        guardianProvider
      );
      break;
    case 'replace-hot-key':
      await completeReplaceHotKeyTransaction(transaction as ReplaceHotKeyTransaction, result, guardianProvider);
      break;
    case 'update-procedure-threshold':
      await completeUpdateProcedureThresholdTransaction(
        transaction as UpdateProcedureThresholdTransaction,
        result,
        service
      );
      break;
    case 'swap':
      await completeSwapTransaction(transaction as SwapTransaction, result);
      break;
    case 'bridged-send':
      await completeBridgedSendTransaction(transaction as BridgedSendTransaction, result);
      break;
    case 'earn-deposit':
      // Same completion as the non-Guardian path: extract the committed P2IDE
      // collateral note id and mark the row Deposited. `createEarnP2IDNote` reads
      // `outputNoteIds[0]` off this row to hand the note back to the Epoch SDK, so
      // routing this to the generic custom-tx completion would strand the deposit.
      await completeEarnDepositTransaction(transaction as EarnDepositTransaction, result);
      break;
    case 'execute':
    default:
      await completeCustomTransaction(transaction, result);
      break;
  }

  await setTransactionStage(transaction.id, 'complete');
};

export const generateTransactionsLoop = async (
  signCallback: (publicKey: string, signingInputs: string) => Promise<Uint8Array>,
  useWorker: boolean = true,
  guardianProvider: GuardianAccountProvider
): Promise<boolean | void> => {
  await cancelStuckTransactions();
  await cancelStaleQueuedTransactions();

  // Import any notes needed for queued transactions
  await importAllNotes();

  // Wait for other in progress transactions
  const inProgressTransactions = await getTransactionsInProgress();
  if (inProgressTransactions.length > 0) {
    return;
  }

  // Find transactions waiting to process
  const queuedTransactions = await Repo.transactions.filter(rec => rec.status === ITransactionStatus.Queued).toArray();
  queuedTransactions.sort((tx1, tx2) => tx1.initiatedAt - tx2.initiatedAt);
  if (queuedTransactions.length === 0) {
    return;
  }

  // Process the oldest ELIGIBLE transaction. A tx requeued after a transient
  // guardian pending-delta 409 carries a `nextEligibleAt` cooldown; skip it while
  // that is in the future so it doesn't monopolize the loop as the oldest row and
  // starve another account's queued tx. A tx with no `nextEligibleAt` is always
  // eligible (backward compatible). If every queued tx is still cooling down there
  // is nothing to do this cycle; MAX_QUEUED_AGE remains the terminal cap.
  const now = Math.floor(Date.now() / 1000);
  const nextTransaction = queuedTransactions.find(tx => tx.nextEligibleAt === undefined || tx.nextEligibleAt <= now);
  if (!nextTransaction) return;

  // Call safely to cancel transaction and unlock records if something goes wrong
  try {
    await generateTransaction(nextTransaction, signCallback, useWorker, guardianProvider);
    return true;
  } catch (e) {
    logger.warning('Failed to generate transaction', e);
    // The SDK attaches a stable `errorCode` string to thrown errors for
    // variants callers are expected to dispatch on. See
    // `error_code_from_client_error` in miden-client.
    const errorCode = extractSdkErrorCode(e);

    // If the failure was caused by the wallet being locked mid-sign,
    // leave the tx Queued rather than marking it Failed — the next
    // auto-consume cycle (after the wallet unlocks) will retry it.
    // This prevents the note-loss scenario the 1000-op stress run
    // surfaced: lock during executeTransaction → tx cancelled → next
    // cycle starts fresh but some races can leave the note stuck.
    // Two locked signals: the SDK-captured sign-callback auth error (non-guardian
    // path), and an explicit locked error thrown by the guardian provider when the
    // vault is null (guardian path — never reaches the SDK sign callback). Either
    // one defers the tx for retry after unlock rather than marking it Failed.
    const authReason = await readLastAuthReason();
    if (authReason === 'locked' || isLockedError(e)) {
      logger.warning('Wallet locked during tx generation; leaving tx queued for retry');
      return false;
    }

    // Submit succeeded but apply failed: the tx IS live on chain. Mark
    // as Completed (not Failed) so the activity tab shows the right
    // outcome; the next sync will reconcile note states via
    // ConsumedExternal. Retrying would hit the node's nullifier check
    // and produce a misleading "already consumed" error.
    if (errorCode === 'ApplyTransactionAfterSubmitFailed') {
      const tx = await Repo.transactions.where({ id: nextTransaction.id }).first();

      // `earn-deposit` is the one type whose caller (`createEarnP2IDNote` via
      // `waitForTransactionCompletion`) reads `resultBytes`/`outputNoteIds` back off
      // the completed row. This generic post-submit path has no `TransactionResult`
      // to repopulate them from (the apply threw before we could capture it), so
      // marking the row Completed here would leave the caller to
      // `TransactionResult.deserialize(undefined)` — which throws *after* cleanup()
      // fires, settling the wait promise as neither success nor timeout and hanging
      // the Epoch solve callback (and `openEarnPosition`) forever. Fail the row
      // instead so the caller resolves via the error branch and gives up cleanly;
      // the on-chain P2IDE collateral note reclaims itself at its recall height.
      // `earn-deposit` is excluded from `REQUEUEABLE_TYPES`, so a Failed row is never
      // blindly re-queued into a duplicate collateral note.
      if (tx && tx.type === 'earn-deposit') {
        logger.warning(
          'Earn-deposit submitted but local apply failed; marking Failed so the awaiting caller stops waiting'
        );
        if (tx.status !== ITransactionStatus.Failed) await cancelTransaction(tx, e);
        return false;
      }

      logger.warning('Transaction submitted but local apply failed; marking Completed, sync will reconcile');
      if (tx && tx.status !== ITransactionStatus.Completed) {
        // Guardian ops never reach here — they're routed through the guardian branch
        // of `generateTransaction`, whose own catch handles apply-after-submit-failed
        // for value-moving ops (send/consume/swap/execute) by marking Completed, and
        // for replace-hot-key/switch-guardian via `reconcileStructuralApplyFailure`.
        // (update-procedure-threshold is currently handled by neither and still falls
        // through to cancel there — a separate, pre-existing gap.) This generic path
        // covers non-guardian send/consume, whose note states the next sync reconciles
        // via ConsumedExternal.
        await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {
          displayMessage: 'Completed',
          completedAt: Math.floor(Date.now() / 1000)
        });
      }
      return false;
    }

    // If the input note was already consumed on chain, the pre-flight
    // nullifier check transitioned it to ConsumedExternal. Mark this tx
    // Failed (it never reached chain) but the note is already reconciled
    // — subsequent cycles won't retry it.
    if (errorCode === 'InputNoteAlreadyConsumedOnChain') {
      logger.warning('Input note already consumed on chain; tx unnecessary');
    }

    // Cancel the transaction if it hasn't already been cancelled
    const tx = await Repo.transactions.where({ id: nextTransaction.id }).first();
    if (tx && tx.status !== ITransactionStatus.Failed) await cancelTransaction(tx, e);
    return false;
  }
};

/**
 * Pulls the stable SDK error code off a thrown value, if present. The
 * SDK attaches `errorCode` via `Reflect::set` on JsError — see
 * `js_error_with_context` in miden-client.
 */
function extractSdkErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const code = (err as { errorCode?: unknown }).errorCode;
  return typeof code === 'string' ? code : undefined;
}

export const safeGenerateTransactionsLoop = async (
  signCallback: (publicKey: string, signingInputs: string) => Promise<Uint8Array>,
  useWorker: boolean = true,
  guardianProvider: GuardianAccountProvider
) => {
  return navigator.locks
    .request(`generate-transactions-loop`, { ifAvailable: true }, async lock => {
      if (!lock) return;

      const result = await generateTransactionsLoop(signCallback, useWorker, guardianProvider);
      if (result === false) {
        return false;
      }

      // Either a transaction was processed successfully (true)
      // or there was nothing to do / another transaction is in progress (undefined).
      return true;
    })
    .catch(e => {
      logger.error('Error in safe generate transactions loop', e);
      return false;
    });
};

/**
 * Start background transaction processing for dApp transactions.
 * This runs the transaction loop without any UI, using the backend's signTransaction directly.
 * Polls every 5 seconds until all queued transactions are processed.
 */
export const startBackgroundTransactionProcessing = (
  signCallback: (publicKey: string, signingInputs: string) => Promise<Uint8Array>,
  useWorker: boolean = false,
  guardianProvider: GuardianAccountProvider
) => {
  // Process transactions in a loop until none are left
  const processLoop = async () => {
    let hasMore = true;
    let attempts = 0;
    // Cap the number of loop passes, not wall-clock time. Each pass now runs one
    // full generate cycle whose guardian ops can spend up to the conflict-retry
    // budget (~60s) before returning, so 60 passes is NOT "5 minutes" — it's a
    // pass ceiling that, together with the 5s inter-pass wait, just bounds how
    // long this background driver keeps polling. Terminal per-tx caps live
    // elsewhere: MAX_QUEUED_AGE (queued) and MAX_WAIT_BEFORE_CANCEL (in-flight).
    const maxAttempts = 60;

    while (hasMore && attempts < maxAttempts) {
      attempts++;
      await safeGenerateTransactionsLoop(signCallback, useWorker, guardianProvider);

      // Check if there are more transactions to process
      const remaining = await getAllUncompletedTransactions();
      hasMore = remaining.length > 0;

      if (hasMore) {
        // Wait before next attempt
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  };

  // Run in background (don't await)
  processLoop().catch(e => {
    console.error('[BackgroundTxProcessor] Error:', e);
  });
};
