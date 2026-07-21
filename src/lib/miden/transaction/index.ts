import { NoteType, type TransactionResult, WasmWebClient } from '@miden-sdk/miden-sdk/lazy';
import { type Proposal } from '@openzeppelin/miden-multisig-client';

import {
  getOrCreateMultisigService,
  isGuardianAccount,
  type GuardianAccountProvider
} from 'lib/miden/front/guardian-manager';
import { MultisigService } from 'lib/miden/guardian';
import { withGuardianAccountLock, withGuardianConflictRetry } from 'lib/miden/guardian/serialize';
import { assertGuardianInSync } from 'lib/miden/guardian/sync-guard';
import * as Repo from 'lib/miden/repo';
import { DEFAULT_NETWORK, MIDEN_NETWORK_ENDPOINTS } from 'lib/miden-chain/constants';
import { logger } from 'shared/logger';

import { cancelStaleQueuedTransactions, cancelStuckTransactions, cancelTransaction } from './cancel';
import {
  completeConsumeTransaction,
  completeCustomTransaction,
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
  readLastAuthReason,
  setTransactionStage,
  updateTransactionStatus
} from './helper';
import { importAllNotes } from '../activity/notes';
import {
  ConsumeTransaction,
  ITransaction,
  ITransactionStatus,
  ReplaceHotKeyTransaction,
  SendTransaction,
  SwapTransaction,
  SwitchGuardianTransaction,
  Transaction,
  UpdateProcedureThresholdTransaction
} from '../db/types';
import { accountIdStringToSdk, canonicalWalletAccountId, sameWalletAccountId } from '../sdk/helpers';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';
import { MidenClientCreateOptions, proveWithFallback } from '../sdk/miden-client-interface';

export * from './cancel';
export * from './complete';
export * from './get';
export * from './helper';
export * from './initiate';

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
      proposalResult = await withGuardianConflictRetry(() =>
        service.createSendProposal(sendTx.secondaryAccountId, sendTx.faucetId, BigInt(sendTx.amount))
      );
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
      service = await getOrCreateMultisigService(transaction.accountId, guardianProvider);
      proposalResult = await withGuardianConflictRetry(() => service.createConsumeNotesProposal([consumeTx.noteId]));
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

  const tr = await service.signAndCreateTransactionRequest(proposalResult.id, transaction.requestBytes);
  const options: MidenClientCreateOptions = {
    signCallback: async (publicKey: Uint8Array, signingInputs: Uint8Array) => {
      const keyString = Buffer.from(publicKey).toString('hex');
      const signingInputsString = Buffer.from(signingInputs).toString('hex');
      return await signCallback(keyString, signingInputsString);
    }
  };

  await setTransactionStage(transaction.id, 'sending');
  const transactionResult = await withWasmClientLock(async () => {
    try {
      const midenClient = await getMidenClient(options);
      const sdkClient = midenClient.client as unknown as {
        _withInnerWebClient?: <T>(fn: (inner: any) => Promise<T>) => Promise<T>;
      };
      const withInner = sdkClient._withInnerWebClient;
      if (typeof withInner !== 'function') {
        throw new Error('_withInnerWebClient missing from @miden-sdk/miden-sdk; expected version 0.15.5 or newer.');
      }

      return (await withInner.call(sdkClient, async (inner: any) => {
        await setTransactionStage(transaction.id, 'executing');
        const executedTx = await inner.executeTransaction(accountIdStringToSdk(transaction.accountId), tr);
        await setTransactionStage(transaction.id, 'proving');
        // Prove via the shared prover selection (delegate → remote; otherwise
        // native on mobile / WASM local on desktop), identical to the
        // non-guardian path. We MUST pass a prover explicitly: this is the RAW
        // inner WebClient, whose default prover is the single-threaded
        // main-thread WASM one — calling `inner.proveTransaction(executedTx)`
        // with no prover freezes the mobile UI for the whole multi-second prove.
        // In the delegate branch `proveWithFallback` calls the closure with no
        // prover, so we substitute the client's remote prover here.
        const remoteProver = (midenClient.client as unknown as { defaultProver?: unknown }).defaultProver ?? undefined;
        const provedTx = await proveWithFallback(
          prover => inner.proveTransaction(executedTx, prover ?? remoteProver),
          transaction.delegateTransaction
        );
        await setTransactionStage(transaction.id, 'submitting');
        const blockNumber = await inner.submitProvenTransaction(provedTx, executedTx);
        await inner.applyTransaction(executedTx, blockNumber);
        return executedTx;
      })) as TransactionResult;
    } catch (error) {
      console.error('Error during transaction submission or execution', { error });
      throw error;
    }
  });

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
      await midenClient.waitForTransactionCommit(transactionResult.executedTransaction().id().toHex());
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
      await completeSendTransaction(transaction as SendTransaction, transactionResult);
      break;
    case 'consume':
      await completeConsumeTransaction(transaction.id, transactionResult);
      break;
    case 'switch-guardian':
      await completeSwitchGuardianTransaction(
        transaction as SwitchGuardianTransaction,
        transactionResult,
        service,
        guardianProvider
      );
      break;
    case 'replace-hot-key':
      await completeReplaceHotKeyTransaction(
        transaction as ReplaceHotKeyTransaction,
        transactionResult,
        guardianProvider,
        service
      );
      break;
    case 'update-procedure-threshold':
      await completeUpdateProcedureThresholdTransaction(
        transaction as UpdateProcedureThresholdTransaction,
        transactionResult,
        service
      );
      break;
    case 'swap':
      await completeSwapTransaction(transaction as SwapTransaction, transactionResult);
      break;
    case 'execute':
    default:
      await completeCustomTransaction(transaction, transactionResult);
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

  // Process next transaction
  const nextTransaction = queuedTransactions[0];
  if (!nextTransaction) return; // redundant after length check but satisfies the type narrower

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
    const authReason = await readLastAuthReason();
    if (authReason === 'locked') {
      logger.warning('Sign callback reported locked wallet; leaving tx queued for retry');
      return false;
    }

    // Submit succeeded but apply failed: the tx IS live on chain. Mark
    // as Completed (not Failed) so the activity tab shows the right
    // outcome; the next sync will reconcile note states via
    // ConsumedExternal. Retrying would hit the node's nullifier check
    // and produce a misleading "already consumed" error.
    if (errorCode === 'ApplyTransactionAfterSubmitFailed') {
      logger.warning('Transaction submitted but local apply failed; marking Completed, sync will reconcile');
      const tx = await Repo.transactions.where({ id: nextTransaction.id }).first();
      if (tx && tx.status !== ITransactionStatus.Completed) {
        // Structural Guardian ops never reach here — they're routed through the
        // guardian branch of `generateTransaction`, whose own catch handles the
        // apply-after-submit-failed reconcile (see `reconcileStructuralApplyFailure`).
        // This generic path covers send/consume, whose note states the next sync
        // reconciles via ConsumedExternal.
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
    const maxAttempts = 60; // Max 5 minutes (60 * 5 seconds)

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
