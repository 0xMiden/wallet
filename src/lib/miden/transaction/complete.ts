import { Note, TransactionResult } from '@miden-sdk/miden-sdk/lazy';

import { sameTxHash } from 'lib/agglayer/status';
import { earnWithdrawExecutionIdentity, validateEarnWithdrawPreparedExecution } from 'lib/epoch/earn-withdraw-policy';
import {
  matchesEarnDepositIntent,
  matchesEarnWithdrawIntent,
  type ExpectedEarnDepositIntent,
  type ExpectedEarnWithdrawIntent
} from 'lib/epoch/intent-key';
import { clearGuardianServiceFor, type GuardianAccountProvider } from 'lib/miden/front/guardian-manager';
import { MultisigService } from 'lib/miden/guardian';
import {
  didDirectSwitchLand,
  finalizeDirectGuardianSwitch,
  GuardianSwitchDiscardedError,
  isGuardianKeyMismatchRefusal,
  isGuardianSwitchDiscardedError
} from 'lib/miden/guardian/direct-switch';
import { withTimeout } from 'lib/miden/guardian/discover';
import {
  adoptPostSwitchState,
  type PostSwitchAdopter,
  type PostSwitchLocalState
} from 'lib/miden/guardian/post-switch-state';
import * as Repo from 'lib/miden/repo';
import { classifyError } from 'lib/telemetry/classify';
import { reportOperation } from 'lib/telemetry/report-operation';
import { elapsedMsSince, operationOfType, stepOfStage } from 'lib/telemetry/transaction-operation';

import {
  applyVerifiedLanding,
  landedTransactionIdFields,
  type LandedWithoutResult,
  recordNoteDelivery,
  reportVerifiedLanding,
  setTransactionStage,
  undeliveredDisplayMessage,
  updateTransactionStatus
} from './helper';
import { ensureGuardianProcedureThresholds } from './initiate';
import { applyBridgeInInfoForNotes, applyBridgeInToConsumeRow, takeAgglayerBridgeInInfo } from '../activity/bridge-in';
import { feeFieldsFromResult, splitExecutedOutputNotes } from '../activity/fee';
import { interpretTransactionResult } from '../activity/helpers';
import { compareAccountIds } from '../activity/utils';
import { midenClientProxy } from '../back/miden-client-proxy';
import {
  BridgedSendTransaction,
  EarnDepositTransaction,
  IBridgeClaimStatus,
  IBridgedReceiveExtraInputs,
  IBridgedReceivePhase,
  IBridgedSendExtraInputs,
  IConsumedAssetTotal,
  IConsumeSwapSettleExtraInputs,
  IEarnDepositExtraInputs,
  IEarnWithdrawExtraInputs,
  IEarnWithdrawPhase,
  IEarnWithdrawPreparedExecution,
  INoteDeliveryState,
  ITransaction,
  ITransactionStatus,
  ReplaceHotKeyTransaction,
  SendTransaction,
  SwapTransaction,
  SwitchGuardianTransaction,
  UpdateProcedureThresholdTransaction
} from '../db/types';
import { isPrivateNoteType, toNoteTypeString } from '../helpers';
import { getBech32AddressFromAccountId, sameWalletAccountId } from '../sdk/helpers';
import { assertWasmHoldCurrent, withWasmClientLock } from '../sdk/miden-client';
import { isPoisonedPipeline } from '../sdk/sdk-error-code';
import { NoteTypeEnum } from '../types';

export const completeCustomTransaction = async (transaction: ITransaction, result: TransactionResult) => {
  const executedTx = result.executedTransaction();
  // Fee note excluded, like the other two paths that walk output notes: the loop below
  // RELAYS every private note to `transaction.secondaryAccountId`, a recipient named by
  // the requesting site, so a fee note reaching it would be sent to the user's
  // counterparty. Consistent with `extractFullNote` and `completeSwapTransaction`.
  const { userNotes: outputNotes } = splitExecutedOutputNotes(executedTx);

  // Every private note this transaction produced. Collected first so the relays
  // below are a flat sequence: the commit wait then happens ONCE, after them,
  // rather than once per note inside the loop.
  const notesToRelay: Note[] = [];

  // How many of this transaction's private notes cannot be shown to have reached
  // the transport. Counted across BOTH phases — conversion and relay — because a
  // note that could not even be turned into a relayable note is as undelivered as
  // one whose relay was rejected, and dropping either with only a console line is
  // how a note goes missing without a trace.
  //
  // A count rather than a flag so the row can say how many, which is the difference
  // between a user knowing one note of several is stuck and assuming the whole
  // transaction failed.
  let undeliveredNotes = 0;
  // Every private note, relayable or not, since `noteDelivery` and the label cover them all.
  const relayNoteIds: string[] = [];
  // Read before `interpretTransactionResult`, which puts the input note's sender in `secondaryAccountId` on a consume.
  const relayRecipientId = transaction.secondaryAccountId;

  for (const note of outputNotes) {
    // Only care about private notes
    if (toNoteTypeString(note.metadata().noteType()) !== NoteTypeEnum.Private) {
      continue;
    }
    relayNoteIds.push(note.id().toString());

    if (!transaction.secondaryAccountId) {
      // The recipient is supplied by the requesting site and is optional, so a
      // custom request that emits a private note without naming one lands here.
      console.error('Missing recipient account id for private note', { txId: transaction.id });
      undeliveredNotes++;
      continue;
    }

    // intoFull() can throw or return undefined
    try {
      const maybeFullNote = note.intoFull();
      if (!maybeFullNote) {
        console.error('intoFull() returned undefined for output note', { txId: transaction.id });
        undeliveredNotes++;
        continue;
      }
      notesToRelay.push(maybeFullNote);
    } catch (error) {
      console.error('Failed to convert output note into full note', { txId: transaction.id, error });
      undeliveredNotes++;
      continue;
    }
  }

  let noteDelivery: INoteDeliveryState | undefined;

  if (notesToRelay.length > 0) {
    // Record the debt before incurring it, for the same reason the send path does:
    // the SDK's outbox is written from inside the relay, so nothing upstream of that
    // point leaves any durable trace that a note is owed.
    try {
      await recordNoteDelivery(transaction.id, 'pending', { transactionId: executedTx.id().toHex() });
    } catch (error) {
      console.warn('Could not record the pending note delivery', { txId: transaction.id, error });
    }

    // Relay every note FIRST, then wait for the commit once.
    //
    // The wait used to sit inside the per-note loop, which made note N+1's relay
    // wait out note N's commit — up to a full commit interval of extra exposure per
    // note, during which a realm teardown or a closed service worker loses the
    // remaining relays entirely. It also re-waited on the same transaction id once
    // per note, which is the same answer every time.
    //
    // Ordering relays before the wait is otherwise unchanged, and NOT for the reason
    // the old comment gave: under 0.15 the hint was the client's live sync height,
    // so waiting first advanced it past the note's commitment block and the
    // recipient — who scans FORWARD from the hint — silently never found the note.
    // 0.16's `sendPrivateOutput` derives the hint from the note's stored
    // `expected_height`, which does not move with sync. The order is kept because it
    // is still the right shape (hand over the note the moment it exists, gate the
    // row's status on the commit), not because delivery depends on it.
    //
    // Relays route through `midenClientProxy` (issue #260, slice 7b): under the flag
    // the write ran offscreen, so each note is an APPLIED OUTPUT note of the
    // OFFSCREEN client's store — and `sendPrivateOutput` resolves it by id out of
    // that store — so the relay MUST run there, not on the dormant SW client.
    for (const fullNote of notesToRelay) {
      try {
        await midenClientProxy.sendPrivateNote(fullNote, transaction.secondaryAccountId!);
      } catch (error) {
        // One note's failure must not skip the others: each is separately owed.
        console.error('Failed to send private note through the transport layer', {
          txId: transaction.id,
          secondaryAccountId: transaction.secondaryAccountId,
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error)
        });
        undeliveredNotes++;
      }
    }

    // Pessimistic aggregate: one undelivered note among several still means value is
    // unreachable, so the row must not read as fully delivered.
    noteDelivery = undeliveredNotes > 0 ? 'undelivered' : 'relayed';

    try {
      await recordNoteDelivery(transaction.id, noteDelivery);
    } catch (error) {
      console.warn('Could not record the note delivery outcome', { txId: transaction.id, noteDelivery, error });
    }

    // Confirmation only, once, and after the relays have settled. Its failure says
    // nothing about delivery, so it is caught separately — folding it in with the
    // relay's catch (as before) made a healthy relay followed by a slow commit
    // indistinguishable from a note that never reached the transport at all.
    try {
      await midenClientProxy.waitForTransactionCommit(executedTx.id().toHex());
    } catch (error) {
      console.warn('Commit wait failed after relaying private notes; relying on SDK reconcile', {
        txId: transaction.id,
        error
      });
    }
  } else if (undeliveredNotes > 0) {
    // Private notes existed but none could be turned into a relayable note.
    noteDelivery = 'undelivered';
    try {
      await recordNoteDelivery(transaction.id, noteDelivery, { transactionId: executedTx.id().toHex() });
    } catch (error) {
      console.warn('Could not record the note delivery outcome', { txId: transaction.id, error });
    }
  }

  const updatedTransaction = interpretTransactionResult(transaction, result);
  updatedTransaction.completedAt = Math.floor(Date.now() / 1000); // seconds
  // `interpretTransactionResult` carries type/amount/notes but no fee fields, so this
  // route — the `execute` and default transaction types — was the one completion path
  // that recorded no fee, leaving its history row without the fee line every other
  // type shows.
  Object.assign(updatedTransaction, feeFieldsFromResult(result));
  // Set explicitly AFTER interpretTransactionResult: that returns the whole
  // pick-time row, which predates every delivery write above and would otherwise
  // hand back the stale (absent) value.
  if (noteDelivery) {
    updatedTransaction.noteDelivery = noteDelivery;
    updatedTransaction.relayNoteIds = relayNoteIds;
    updatedTransaction.relayRecipientId = relayRecipientId;
  }

  if (undeliveredNotes > 0) {
    // Completed, not Failed: the transaction is on chain and the assets have left
    // the account, so failing the row would be untrue and would offer a Retry that
    // spends again. What is wrong is the DELIVERY, and the row is the only place
    // the user would ever learn about it — `error` is rendered for failed rows
    // only, so the label is what carries it.
    updatedTransaction.displayMessage = undeliveredDisplayMessage('Completed', undeliveredNotes);
  }

  await updateTransactionStatus(transaction.id, ITransactionStatus.Completed, updatedTransaction);
};

export const completeConsumeTransaction = async (id: string, result: TransactionResult) => {
  const inputNotes = result.executedTransaction().inputNotes().notes();
  const firstInputNote = inputNotes[0];
  if (!firstInputNote) {
    throw new Error('completeConsumeTransaction: no input notes on executed transaction');
  }
  const note = firstInputNote.note();
  const sender = getBech32AddressFromAccountId(note.metadata().sender());
  const executedTransaction = result.executedTransaction();

  const dbTransaction = await Repo.transactions.where({ id }).first();
  const reclaimed = compareAccountIds(dbTransaction?.accountId ?? '', sender);
  const displayMessage = reclaimed ? 'Reclaimed' : 'Received';
  const secondaryAccountId = reclaimed ? undefined : sender;
  const asset = note.assets().fungibleAssets()[0];
  if (!asset) {
    throw new Error('completeConsumeTransaction: note has no fungible assets');
  }
  const faucetId = getBech32AddressFromAccountId(asset.faucetId());
  // Per-faucet totals over EVERY asset of EVERY consumed note. The queue-time
  // value the `ConsumeTransaction` constructor wrote is only an estimate — its
  // `ConsumableNote` inputs carry just the first fungible asset per note — so a
  // completed row recomputes it here against the executed transaction and stays
  // consistent with `amount` below (which is this list's `faucetId` entry).
  const totalsByFaucet = new Map<string, bigint>();
  for (const inputNote of inputNotes) {
    for (const noteAsset of inputNote.note().assets().fungibleAssets()) {
      const assetFaucetId = getBech32AddressFromAccountId(noteAsset.faucetId());
      totalsByFaucet.set(assetFaucetId, (totalsByFaucet.get(assetFaucetId) ?? 0n) + noteAsset.amount());
    }
  }
  const assetTotals: IConsumedAssetTotal[] = Array.from(totalsByFaucet, ([id, total]) => ({
    faucetId: id,
    amount: total
  }));
  const amount = totalsByFaucet.get(faucetId) ?? 0n;

  // Only a uniform batch has a single answer, matching the constructor's rule —
  // otherwise the details card would label a mixed claim by its first note alone.
  const noteTypes = inputNotes.map(inputNote => toNoteTypeString(inputNote.note().metadata().noteType()));
  const firstNoteType = noteTypes[0];
  const uniformNoteType = noteTypes.every(type => type === firstNoteType) ? firstNoteType : undefined;

  await updateTransactionStatus(id, ITransactionStatus.Completed, {
    ...feeFieldsFromResult(result),
    displayMessage,
    transactionId: executedTransaction.id().toHex(),
    secondaryAccountId,
    faucetId,
    amount,
    assetTotals,
    noteType: uniformNoteType,
    completedAt: Math.floor(Date.now() / 1000), // Convert to seconds.
    resultBytes: result.serialize()
  });

  // Best-effort bridge-in tagging: if this consume claimed a note parked by an
  // EVM→Miden intent (plain bridge deposit OR a Smart Withdraw delivery), tag the
  // row as "Bridged from EVM". A bridge-in with a `bridgeReceiveTxId` also flips
  // that tracking row to `received`; one with an `earnWithdrawTxId` flips the
  // linked Smart Withdraw row instead, with the actual consumed amount. Must never
  // fail the consume itself.
  try {
    const consumedNoteIds = inputNotes.map(inputNote => inputNote.note().id().toString());
    const applied = await applyBridgeInInfoForNotes(consumedNoteIds, info => applyBridgeInToConsumeRow(id, info));
    if (!applied) {
      const info = await takeAgglayerBridgeInInfo({
        accountId: dbTransaction?.accountId ?? '',
        senderAccountId: sender,
        amount
      });
      if (info) await applyBridgeInToConsumeRow(id, { ...info, midenNoteId: consumedNoteIds[0] });
    }
  } catch (err) {
    console.warn('[bridge-in] consume tagging failed (non-fatal)', err);
  }

  // Swap settlement: a consume queued by `reconcileSwapOrderNotes` carries a
  // link to its swap order. Stamp the settlement on the swap row so history
  // can flip the single swap row's chip (Pending → Confirmed / Reclaimed)
  // while the linked consume row itself stays suppressed. Must never fail the
  // consume itself.
  try {
    const settle: IConsumeSwapSettleExtraInputs | undefined =
      dbTransaction?.extraInputs?.swapOrderTxId != null ? dbTransaction.extraInputs : undefined;
    if (settle) {
      const stampedAt = Math.floor(Date.now() / 1000);
      await Repo.transactions.where({ id: settle.swapOrderTxId }).modify(tx => {
        if (tx.type !== 'swap') return;
        tx.extraInputs = {
          ...(tx.extraInputs ?? {}),
          ...(settle.swapSettleKind === 'reclaim' ? { reclaimedAt: stampedAt } : { settledAt: stampedAt })
        };
      });
    }
  } catch (err) {
    console.warn('[swap-settlement] consume stamping failed (non-fatal)', err);
  }
};

export const completeSwapTransaction = async (tx: SwapTransaction, result: TransactionResult) => {
  const executedTx = result.executedTransaction();
  // The kernel's fee note is an output note of this transaction too, and the order the
  // notes come back in is the kernel's business, not ours. Taking index 0 blind means
  // that on a fee-charging chain the `orderId` below -- the serial number this swap is
  // tracked by for its entire lineage -- can be read off the FEE note instead of the
  // PSWAP note, which points settlement at a note that will never be filled.
  const { userNotes } = splitExecutedOutputNotes(executedTx);
  const outputNote = userNotes[0];

  if (!outputNote) {
    throw new Error('Swap Transaction Failed');
  }

  // orderId for tracking the swap note through the lineage
  const orderId = outputNote.intoFull()?.recipient().serialNum().toFelts()[1]?.asInt();

  // TODO: track the created PSWAP note + payback note for richer activity
  // display (offered/requested asset breakdown). For now record the tx as
  // Completed with the output note ids so the swap shows up in history.
  const completedAt = Math.floor(Date.now() / 1000); // seconds
  await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {
    ...feeFieldsFromResult(result),
    displayMessage: 'Swapped',
    transactionId: executedTx.id().toHex(),
    outputNoteIds: [outputNote.id().toString()],
    completedAt,
    resultBytes: result.serialize(),
    // Stamp the absolute expiry so `reconcileSwapOrderNotes` can expiry-reclaim
    // the unfilled remainder of a partial fill. This is load-bearing: the
    // reconcile gate requires an explicit `expiresAt` (no fallback since the
    // "explicit expiry" review change), and an earlier hot-key-rotation commit
    // accidentally reverted this stamp — leaving `expiresAt` undefined so active
    // orders were never reclaimed (swap-partial-fill lineage stuck `active`).
    extraInputs: { ...tx.extraInputs, orderId, expiresAt: completedAt + (tx.extraInputs.expirySeconds ?? 120) }
  });
};

/**
 * Attempts for the post-rotation guardian re-register, covering the WHOLE block
 * (provider read -> sync -> local account -> cold service -> push), not just the
 * final push which retries internally. A miss here leaves the freshly-rotated
 * hot key unauthorized, so every later guardian request 401s.
 */
const POST_ROTATION_REREGISTER_ATTEMPTS = 3;
/** Linear backoff base between those attempts. */
const POST_ROTATION_REREGISTER_BACKOFF_MS = 1_000;

/**
 * Ceiling on the post-commit endpoint write, which is a local vault write behind
 * (on the frontend) an intercom request that cannot time out on its own.
 *
 * Generous, because exceeding it books an audit flag rather than retrying: this
 * only has to be longer than any healthy round trip to a busy service worker,
 * and the cost of being wrong in the short direction is a false "may not have
 * persisted" on a write that did land.
 */
export const ENDPOINT_PERSIST_TIMEOUT_MS = 15_000;

/**
 * The stored WalletAccount id for a row queued under any spelling of it. The
 * vault matches account records with ===, so a write keyed on the queued id can
 * silently miss the account. Falls back to the queued id when nothing matches or
 * the lookup fails: a post-commit completion must still reach its terminal writes.
 */
const storedAccountIdFor = async (guardianProvider: GuardianAccountProvider, accountId: string): Promise<string> => {
  try {
    const accounts = await withTimeout(
      Promise.resolve(guardianProvider.getAccounts()),
      ENDPOINT_PERSIST_TIMEOUT_MS,
      'reading the stored guardian account'
    );
    return accounts.find(a => sameWalletAccountId(a.publicKey, accountId))?.publicKey ?? accountId;
  } catch (error) {
    console.warn('Could not resolve the stored guardian account id (using the queued id):', error);
    return accountId;
  }
};

/**
 * How many times to try writing the terminal status of a rotation that has
 * ALREADY committed on chain, and how long to space the attempts.
 *
 * Only reached when the first write already failed, so the cost is paid only on a
 * path that is going wrong. The point of more than one retry is that the failures
 * worth surviving here (an IndexedDB transaction abort under contention) recur
 * immediately and then clear, which is precisely the shape a single immediate
 * retry cannot survive. Small and bounded because the alternative to giving up is
 * not waiting forever: past this the row is reaped into Failed, which for a
 * committed rotation is a lie, so the budget exists to make that outcome rare
 * rather than to eliminate it (see the residual noted at the call site).
 */
export const TERMINAL_STATUS_WRITE_ATTEMPTS = 4;
export const TERMINAL_STATUS_WRITE_BACKOFF_MS = 250;

export const completeReplaceHotKeyTransaction = async (
  tx: ReplaceHotKeyTransaction,
  result: TransactionResult | undefined,
  guardianProvider: GuardianAccountProvider,
  // Set only by the landed reconcile, where `result` is absent (#1233).
  landed?: LandedWithoutResult
) => {
  try {
    const newHotPublicKey = tx.extraInputs?.newHotPublicKey;
    if (!newHotPublicKey) {
      throw new Error('Replace-hot-key tx is missing newHotPublicKey in extraInputs');
    }

    if (!guardianProvider.swapHotKey) {
      throw new Error('swapHotKey not implemented in this provider');
    }

    // Re-register on the guardian — REQUIRED, and it must carry the
    // POST-rotation signer set. The guardian's request-auth allowlist
    // (`auth.cosigner_commitments`) is written ONLY by `/configure`
    // (`registerOnGuardian`); the delta pipeline canonicalizes the state blob
    // but never touches the allowlist, so without this push every request
    // signed by the NEW hot key 401s ("session expired") forever.
    // `registerOnGuardian` derives the allowlist from the service's in-memory
    // `signerCommitments`. `buildColdMultisigService` loads that field from the
    // guardian's stored blob (which can still be pre-rotation), so
    // `reRegisterCurrentStateOnGuardian` re-derives it from the freshly-synced
    // on-chain account (now [new-hot, cold]) right before registering (#619 gap
    // 3) — otherwise this could re-push the OLD allowlist, the historical
    // permanent-401 bug. Runs BEFORE `swapHotKey` arms the ~3s hot-sync.
    // Best-effort: an on-chain-successful rotation must not be failed by a
    // guardian blip (`registerOnGuardianWithRetry` retries up to
    // GUARDIAN_RETRY_MAX_ATTEMPTS times, honouring Retry-After); a miss is
    // recorded as `reRegisterFailed` for observability and healed by the
    // guardian-sync 401 self-heal.
    // Retried as a WHOLE, not just at its last call. `registerOnGuardianWithRetry`
    // only covers the final push; everything that feeds it — reading the provider
    // accounts, the `syncState`, the local `getAccount`, building the cold service
    // — runs exactly once, and any of them throwing lands in the catch below with
    // the allowlist never written. That is not a theoretical gap: a guardian
    // recovery run rotated the key, missed the re-register, and then 401'd
    // ("session has expired") on every consume that followed, because nothing
    // re-attempts a miss on this path. The frontend self-heal does eventually
    // repair it, but only after SELF_HEAL_AUTH_FAILURE_THRESHOLD consecutive
    // 401s on SYNC ticks plus a 60s cooldown — so a wallet that rotates and
    // immediately transacts stays broken for the whole of that window.
    let reRegisterFailed = false;
    let reRegisterError: unknown;
    let reRegisterAttempts = 0;
    let storedAccountId = tx.accountId;
    // The landed reconcile pushes nothing (#1233): the apply failed, so the local store still holds
    // the pre-rotation account and allowlist, and a push landing after canonicalization would put
    // the guardian back on them, so every hot-signed request 401s with no cold self-heal. The
    // guardian's canonicalization of the rotation re-derives both; a hot-signed request in the
    // seconds before it fails and is retried by its caller.
    const reRegisterAttemptBudget = landed ? 0 : POST_ROTATION_REREGISTER_ATTEMPTS;
    if (landed) storedAccountId = await storedAccountIdFor(guardianProvider, tx.accountId);
    for (let attempt = 1; attempt <= reRegisterAttemptBudget; attempt++) {
      reRegisterAttempts = attempt;
      try {
        const accounts = await guardianProvider.getAccounts();
        const walletAccount = accounts.find(a => sameWalletAccountId(a.publicKey, tx.accountId));
        if (!walletAccount) {
          throw new Error(`Guardian account ${tx.accountId} not found in provider`);
        }
        storedAccountId = walletAccount.publicKey;
        const sdkAccount = await withWasmClientLock(async hold => {
          await midenClientProxy.syncState();
          assertWasmHoldCurrent(hold, 'post-rotation re-register: after the state sync');
          return midenClientProxy.getAccount(walletAccount.publicKey);
        });
        if (!sdkAccount) {
          throw new Error(`Guardian account ${tx.accountId} not found in local client`);
        }
        const coldService = await MultisigService.buildColdMultisigService(
          sdkAccount,
          walletAccount,
          guardianProvider.signWord
        );
        await coldService.reRegisterCurrentStateOnGuardian();
        reRegisterError = undefined;
        break;
      } catch (e) {
        reRegisterError = e;
        // After an eviction, wrapped or not, the next attempt's sync would join the abandoned one and park again.
        if (isPoisonedPipeline(e)) break;
        if (attempt < POST_ROTATION_REREGISTER_ATTEMPTS) {
          console.warn(
            `Post-rotation guardian re-register attempt ${attempt}/${POST_ROTATION_REREGISTER_ATTEMPTS} failed; retrying:`,
            e
          );
          // Linear backoff. The common failures here are a not-yet-canonicalized
          // account read and a guardian still settling the rotation, both of
          // which clear in seconds — so waiting is what makes the retry useful.
          await new Promise(resolve => setTimeout(resolve, POST_ROTATION_REREGISTER_BACKOFF_MS * attempt));
        }
      }
    }
    const reRegisterEvicted = isPoisonedPipeline(reRegisterError);
    if (reRegisterError) {
      reRegisterFailed = true;
      console.error(
        `Failed to re-register post-rotation signer set on guardian after ${reRegisterAttempts} attempt(s) - ` +
          'the new hot key stays unauthorized (401) until a re-register lands:',
        reRegisterError
      );
    }

    // Vault.swapHotKey resolves the previous hot pubkey from the persisted
    // WalletAccount and is idempotent: if the record already reflects
    // `newHotPublicKey` (retry), the cleanup branch is a no-op.
    await guardianProvider.swapHotKey(storedAccountId, newHotPublicKey);
    // Drop the cached MultisigService — its bound hot signer is now stale.
    clearGuardianServiceFor(storedAccountId);

    await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {
      ...feeFieldsFromResult(result),
      displayMessage: 'Everyday key rotated',
      completedAt: Math.floor(Date.now() / 1000),
      // Spread the whole record (updateTransactionStatus Object.assigns the whole extraInputs):
      // newHotPublicKey and the stamped guardianEndpoint both survive. Then record whether the
      // guardian re-register landed (#619 gap 1).
      extraInputs: { ...tx.extraInputs, reRegisterFailed },
      // `result` is absent on the landed reconcile path: the rotation is already on chain, and all
      // the reconcile has is the id its failure carried (#1233).
      ...(result
        ? { transactionId: result.executedTransaction().id().toHex(), resultBytes: result.serialize() }
        : landedTransactionIdFields(landed))
    });

    // The account now has both signers on-chain, so bring it up to the same
    // hardening a freshly-created 3-key account has (update_guardian threshold
    // 2 — which the update_signers rotation above can't carry). Best-effort and
    // idempotent; never affects the rotation's success. After an eviction it is
    // skipped rather than rebuilding the service against the node that just
    // parked: the next guardian sync lap re-runs the check, because the swap
    // above changed the hot key that sync's once-per-session gate is keyed on.
    if (!reRegisterEvicted) {
      await ensureGuardianProcedureThresholds(storedAccountId, tx.delegateTransaction, guardianProvider);
    }
  } catch (error) {
    console.error('Error completing replace-hot-key transaction:', error);
    await updateTransactionStatus(tx.id, ITransactionStatus.Failed, {
      displayMessage: 'Failed to rotate everyday key',
      completedAt: Math.floor(Date.now() / 1000),
      ...(result && { resultBytes: result.serialize() }),
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

export const completeUpdateProcedureThresholdTransaction = async (
  tx: UpdateProcedureThresholdTransaction,
  result: TransactionResult,
  // The cold MultisigService used to drive the threshold change, so we can push
  // the new state to the guardian (the OZ lib doesn't re-register it).
  service?: MultisigService
) => {
  const executedTx = result.executedTransaction();
  await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {
    ...feeFieldsFromResult(result),
    displayMessage: 'Account secured',
    transactionId: executedTx.id().toHex(),
    completedAt: Math.floor(Date.now() / 1000),
    resultBytes: result.serialize()
  });
  // The cached service's procedureThresholds are now stale - drop it. The cache is
  // keyed canonically, so the queued id needs no account-list read first.
  clearGuardianServiceFor(tx.accountId);

  // Same gap as replace-hot-key: the OZ lib submitted `update_procedure_threshold`
  // on-chain but never re-registered the new state on the guardian. Push it so the
  // guardian's blob tracks the new threshold and the next sync doesn't diverge.
  // Best-effort; runSync self-heals if this slips.
  if (service) {
    try {
      await service.reRegisterCurrentStateOnGuardian();
    } catch (e) {
      console.warn('Failed to re-register state on guardian post-update-procedure-threshold (non-fatal):', e);
    }
  }
};

/**
 * Extract the persistable fields of a {@link TransactionResult} without letting
 * a WASM-handle failure propagate. Returns `undefined` when there is no result
 * (the apply-after-submit reconcile path) or when the handle can no longer be
 * read, so callers can spread it into a status payload unconditionally.
 */
const readTransactionResultFields = (
  result: TransactionResult | undefined
): { transactionId: string; resultBytes: Uint8Array } | undefined => {
  if (!result) return undefined;
  try {
    return { transactionId: result.executedTransaction().id().toHex(), resultBytes: result.serialize() };
  } catch (error) {
    console.warn('Could not read the transaction result for the guardian switch row (completing without it):', error);
    return undefined;
  }
};

/**
 * Point a discarded switch's account back at its previous guardian (#1233), retried like the terminal
 * status write. The write needs an unlocked wallet, and one that stays locked outlasts the attempts,
 * so false (or no previous endpoint on the row) is what the Failed row then names.
 */
const restorePreviousGuardianEndpoint = async (
  guardianProvider: GuardianAccountProvider,
  storedAccountId: string,
  previousGuardianEndpoint: string | undefined
): Promise<boolean> => {
  if (!previousGuardianEndpoint) {
    console.error('The node discarded the guardian switch, and the row records no previous endpoint to restore');
    return false;
  }
  for (let attempt = 1; attempt <= TERMINAL_STATUS_WRITE_ATTEMPTS; attempt++) {
    try {
      await withTimeout(
        Promise.resolve(guardianProvider.setGuardianEndpoint?.(storedAccountId, previousGuardianEndpoint)),
        ENDPOINT_PERSIST_TIMEOUT_MS,
        'restoring the previous guardian endpoint'
      );
      return true;
    } catch (restoreError) {
      console.error(
        `Could not restore the previous guardian endpoint (attempt ${attempt}/${TERMINAL_STATUS_WRITE_ATTEMPTS}):`,
        restoreError
      );
      if (attempt < TERMINAL_STATUS_WRITE_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, TERMINAL_STATUS_WRITE_BACKOFF_MS * attempt));
      }
    }
  }
  return false;
};

export const completeSwitchGuardianTransaction = async (
  tx: SwitchGuardianTransaction,
  result: TransactionResult | undefined,
  // Undefined on the DIRECT-switch fallback (outgoing guardian unreachable):
  // no MultisigService exists — building one loads from the old guardian —
  // so registration on the new guardian runs standalone instead.
  multisigService: MultisigService | undefined,
  guardianProvider: GuardianAccountProvider,
  // True when the caller submitted but could never establish that the rotation
  // COMMITTED. Recorded on the row so the receipt can decline to claim a
  // confirmation the code never obtained.
  //
  // Two callers pass it: the direct path when `didDirectSwitchLand` answers
  // `undefined`, and `reconcileStructuralApplyFailure` always. It runs only on an
  // apply-after-submit failure, which no pre-submit step produces, so it knows the
  // node accepted the transaction and nothing beyond that.
  //
  // The default is `false` for the paths that WAITED for the commit and got it.
  // That is a claim about the commit wait, not about which path called: do not
  // read this default as "coordinated means confirmed" and add a caller without
  // checking which of the two it is.
  commitUnconfirmed = false,
  // Set only by the landed reconcile, where `result` is absent (#1233).
  landed?: LandedWithoutResult
) => {
  // Read the WASM-backed result fields ONCE, up front, before anything that can
  // select a terminal status depends on them.
  //
  // `executedTransaction()` and `serialize()` reach into a WASM handle that by
  // now has been idle across the commit wait, an optional node-state read, and
  // up to eight registration attempts with backoff — long enough for a #775
  // poison eviction to have replaced the client and disposed the module
  // underneath it. Read inline in the status payload, that throw landed INSIDE
  // the post-commit section, where it selected the Failed path for a rotation
  // that had already committed — the exact state the ordering below exists to
  // prevent. Worse, the catch's own payload called `serialize()` again, so it
  // threw a second time and escaped this function entirely, leaving the row with
  // no terminal status at all.
  const resultFields = readTransactionResultFields(result);
  // Declared OUT here, not in the try, because the fallback write in the catch
  // needs them: they are the only record that a post-commit step did not land,
  // and `GuardianSwitchSuccess` renders its "setup incomplete" warning off
  // exactly these two. Scoped inside, the fallback wrote a row that claimed a
  // clean switch on the two states the user most needs told about.
  let endpointPersistFailed = false;
  let registerFailed = false;
  let localStateNotSaved = false;
  let localStateUnrecoverable = false;
  try {
    const { newGuardianEndpoint } = tx.extraInputs;
    const storedAccountId = await storedAccountIdFor(guardianProvider, tx.accountId);

    // Mirror upstream `multisig.executeProposal`'s post-submit block for
    // switch_guardian proposals: register on the new guardian with the updated
    // account state, so the new operator holds the post-switch blob.
    //
    // Best-effort, like `replace-hot-key`'s post-rotation re-register: by the
    // time this runs, `update_guardian` has COMMITTED, so the account's guardian
    // IS the new operator and a vault still naming the old one is simply wrong.
    // Aborting here used to leave exactly that state, and the comment claiming
    // "the user can retry" was not true — `switch-guardian` is in no requeue set
    // and `isRequeueableTransaction` excludes it, so the row was terminal.
    //
    // On the DIRECT path that stranding is unrecoverable rather than merely
    // untidy, because the direct path's whole premise is that the OLD operator is
    // unreachable: `syncGuardianAccounts` builds its service from the STORED
    // endpoint, so a vault pointing at the dead operator can never reach the new
    // one. Persisting the endpoint is what restores recoverability — the next
    // tick talks to the new operator, and an account it has no record of is
    // repaired by `guardian-sync`'s missing-registration self-heal.
    //
    // So the endpoint write goes FIRST, ahead of the registration it used to
    // follow. It is the load-bearing anti-stranding write and it is idempotent,
    // while registration is the step allowed to fail; ordering it second put the
    // only unguarded call after a multi-minute rotation, where an auto-lock makes
    // `setGuardianEndpoint` throw `Wallet is locked` — and the outer catch then
    // marked a COMMITTED rotation Failed with the dead operator still stored,
    // which is precisely the state this ordering exists to prevent. Both steps
    // now record their outcome instead of aborting the completion.
    //
    // The same reasoning extends to the BOOKKEEPING either side of them. Past the
    // commit, the rotation is a fact on chain, so the only honest terminal status
    // is Completed — and every remaining call here is incidental: a progress stamp
    // and a cache eviction. Leaving them unguarded meant a Dexie rejection on a
    // stage write, before the endpoint had been persisted, produced the identical
    // stranded-and-Failed state through a purely cosmetic call. Nothing between
    // here and the status write may select the Failed path.
    await setTransactionStage(tx.id, 'registering-guardian').catch(stageError => {
      console.warn(
        'Could not stamp the registering-guardian stage (non-fatal, the switch has already committed):',
        stageError
      );
    });

    // Persist the endpoint PER-ACCOUNT (not the legacy global key) so other
    // Guardian accounts on different operators aren't clobbered. Backend
    // providers implement setGuardianEndpoint; the optional-call guard keeps a
    // frontend provider without it from throwing.
    try {
      // BOUNDED, because a hang here is worse than a rejection. On the frontend
      // this provider method is an intercom request, and `request()` in
      // lib/intercom/client.ts has no timeout while its `onDisconnect` reconnects
      // the port WITHOUT settling anything in flight — so an MV3 worker recycle
      // at this moment strands the promise. Every other step in this sequence
      // records its outcome and moves on precisely so the row always reaches a
      // terminal status; an unbounded await defeats that from the inside, leaving
      // a committed rotation parked at GeneratingTransaction forever, with the
      // audit flags never written because the status write is never reached.
      //
      // A timeout is NOT evidence the write did not land, so it books the same
      // flag as a rejection: "may not have landed, reconcile it". If it did land,
      // the flag is a harmless false positive — drift reconciliation reads the
      // stored endpoint, finds it correct, and affirms in-sync.
      await withTimeout(
        Promise.resolve(guardianProvider.setGuardianEndpoint?.(storedAccountId, newGuardianEndpoint)),
        ENDPOINT_PERSIST_TIMEOUT_MS,
        'persisting the new guardian endpoint'
      );
    } catch (persistError) {
      endpointPersistFailed = true;
      console.error(
        'On-chain guardian switch committed but persisting the new endpoint failed — the vault still names the ' +
          'previous operator; guardian drift reconciliation is the remaining repair path:',
        persistError
      );
    }

    // A landed switch (#1233): the apply failed, so this device's copy may still be the pre-switch
    // account, whose guardian slot names the outgoing operator, and the new one refuses to register
    // that. Adopt the post-switch state from the outgoing guardian first (it holds it once it
    // canonicalizes the delta pushed after submit), and skip a registration that can only be refused.
    // A read that throws counts as unknown: nothing here may select the Failed path. A guardian the delta
    // did not reach in time is not polled: the background self-heal re-pushes it and adopts then.
    const outgoing = tx.extraInputs.switchDeltaPushed === true ? multisigService : undefined;
    const adopter: PostSwitchAdopter | undefined = outgoing
      ? { probe: () => outgoing.probeGuardianState(), adoptOnce: () => outgoing.adoptGuardianStateOnce() }
      : undefined;
    const localState: PostSwitchLocalState = landed
      ? await adoptPostSwitchState(adopter, storedAccountId, newGuardianEndpoint).catch(
          (adoptError: unknown): PostSwitchLocalState => {
            console.warn('Could not read the post-switch local state; registering as before:', adoptError);
            return 'unknown';
          }
        )
      : 'post-switch';
    // Pre-switch at the bound is also what a switch the node discarded leaves, since the outgoing
    // guardian then never holds a post-switch state, and an unknown copy may be either. A post-switch
    // copy can be the failed apply's own account write (the store's apply writes the record, then the
    // account, then notes and tags), which proves no commit; one an adopt produced can only meet a
    // commit or no verdict, so asking there costs one bounded verdict read and changes no outcome.
    // So ask the node about the transaction whatever the copy reads, as the direct path does: a discard
    // means the switch did not happen, so the endpoint persisted above goes back to the previous
    // guardian and the caller fails the row. No verdict keeps the flag.
    const askNodeAbout = landed?.transactionId;
    if (askNodeAbout !== undefined && (await didDirectSwitchLand(askNodeAbout)) === false) {
      const restored = await restorePreviousGuardianEndpoint(
        guardianProvider,
        storedAccountId,
        tx.extraInputs.previousGuardianEndpoint
      );
      throw new GuardianSwitchDiscardedError(askNodeAbout, restored ? undefined : newGuardianEndpoint);
    }
    // Only a coordinated row has a repair path: the self-heal adopts from the previous guardian, which
    // a direct switch fled before it ever received the delta.
    const switchedDirectly = tx.extraInputs.switchedDirectly === true;
    try {
      if (localState === 'pre-switch') {
        if (switchedDirectly) localStateUnrecoverable = true;
        else localStateNotSaved = true;
      } else if (multisigService) {
        await multisigService.finalizeGuardianSwitch(newGuardianEndpoint);
      } else {
        await finalizeDirectGuardianSwitch(storedAccountId, newGuardianEndpoint, guardianProvider);
      }
    } catch (registerError) {
      registerFailed = true;
      // Refused, maybe, for a copy nobody could show was post-switch: the self-heal that adopts
      // one has to know.
      // A direct switch has no repair path, and another key is the 'pre-switch' read, found by the registration.
      if (localState === 'unknown') {
        if (!switchedDirectly) localStateNotSaved = true;
        else if (isGuardianKeyMismatchRefusal(registerError)) localStateUnrecoverable = true;
      }
      console.error(
        'On-chain guardian switch committed but registering on the new guardian failed — the account stays ' +
          'unknown to the new operator until the guardian-sync self-heal lands a registration:',
        registerError
      );
    }

    try {
      clearGuardianServiceFor(storedAccountId);
    } catch (evictError) {
      console.warn('Could not evict the cached guardian service (non-fatal):', evictError);
    }

    await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {
      ...feeFieldsFromResult(result),
      // The Activity list renders this string as the row title, so it is a
      // claim about the chain, not a log line. "Guardian switched" is one the
      // unconfirmed path cannot make — and the receipt's recovery copy used to
      // send the user to Activity to check, where this asserted the opposite.
      displayMessage: commitUnconfirmed ? 'Guardian switch submitted' : 'Guardian switched',
      completedAt: Math.floor(Date.now() / 1000), // seconds
      // Preserve the audit fields (updateTransactionStatus Object.assigns the
      // whole extraInputs) and record which post-commit steps landed.
      extraInputs: {
        ...tx.extraInputs,
        registerFailed,
        endpointPersistFailed,
        commitUnconfirmed,
        localStateNotSaved,
        localStateUnrecoverable
      },
      // On the landed reconcile path there is no local TransactionResult, so the row takes the id
      // the failure carried, if any (#1233); the switch is on chain either way.
      ...(resultFields ?? landedTransactionIdFields(landed))
    });
  } catch (error) {
    // Past the commit, Failed is not an honest terminal status: the rotation IS
    // on chain. Every step above records its own outcome instead of throwing, so
    // reaching here means the status write itself failed — and answering that by
    // writing the OPPOSITE status would tell the user their rotation failed when
    // it succeeded, with no Retry available (`switch-guardian` is in no requeue
    // set). Retry the honest status instead, and leave the row alone if even
    // that fails: the transaction page's own reaper is a better fallback than a
    // lie.
    //
    // The retry carries the SAME payload as the primary write. An earlier
    // version dropped `resultFields` here "in case those were the problem",
    // which stopped being possible once the handle reads were hoisted above the
    // try — `resultFields` is inert plain data by this point, so omitting it
    // only cost the row its on-chain transaction id and the receipt's explorer
    // link.
    //
    // RETRIED MORE THAN ONCE, and spaced. A single retry made the honest status
    // depend on two consecutive IndexedDB writes, and the reachable cause of the
    // first failure — a transaction abort under contention, a storage hiccup — is
    // exactly the kind that recurs immediately and then clears. What happens if
    // both fail is not "the row is left alone": it stays at
    // `GeneratingTransaction`, and `cancelStuckTransactions` reaps an in-progress
    // row into FAILED, so the fallback IS the lie this block refuses to write,
    // just delivered later and with a generic reason. Spacing the attempts costs
    // nothing on the happy path (it is only reached when a write has already
    // failed) and removes the single-retry coincidence.
    //
    // Except the node's discard (#1233): that switch did not happen, so its caller fails the row.
    if (isGuardianSwitchDiscardedError(error)) throw error;
    console.error('Error completing switch guardian transaction (the switch itself has already committed):', error);
    const completedPayload = {
      displayMessage: commitUnconfirmed ? 'Guardian switch submitted' : 'Guardian switched',
      completedAt: Math.floor(Date.now() / 1000), // seconds
      extraInputs: {
        ...tx.extraInputs,
        registerFailed,
        endpointPersistFailed,
        commitUnconfirmed,
        localStateNotSaved,
        localStateUnrecoverable
      },
      ...(resultFields ?? landedTransactionIdFields(landed))
    };
    for (let attempt = 1; attempt <= TERMINAL_STATUS_WRITE_ATTEMPTS; attempt++) {
      try {
        await updateTransactionStatus(tx.id, ITransactionStatus.Completed, completedPayload);
        return;
      } catch (retryError) {
        console.error(
          `Could not record the completed status for the guardian switch row ` +
            `(attempt ${attempt}/${TERMINAL_STATUS_WRITE_ATTEMPTS}):`,
          retryError
        );
        if (attempt < TERMINAL_STATUS_WRITE_ATTEMPTS) {
          await new Promise(resolve => setTimeout(resolve, TERMINAL_STATUS_WRITE_BACKOFF_MS * attempt));
        }
      }
    }
  }
};

const extractFullNote = (result: TransactionResult): Note | undefined => {
  try {
    // Excluding the kernel's fee note, which is an output note of this transaction like
    // any other and whose position among them is the kernel's business. The note this
    // returns is the one a PRIVATE send RELAYS to its recipient, so picking the fee note
    // here would hand the transport the wrong note and leave the payment undeliverable
    // while the row still completed.
    const { userNotes } = splitExecutedOutputNotes(result.executedTransaction());

    const firstOutput = userNotes[0];
    if (!firstOutput) {
      console.error('No output notes found for executed transaction');
      return undefined;
    }

    const fullNote = firstOutput.intoFull();

    if (!fullNote) {
      console.error('intoFull() returned undefined for first output note');
      return undefined;
    }

    return fullNote;
  } catch (error) {
    console.error('Failed to extract full note from transaction result', { error });
    return undefined;
  }
};

/**
 * Does this send owe a transport relay?
 *
 * Asks the row first and then the note, and lets the note win when the two
 * disagree about privacy. The row's `noteType` is a wallet-side string recorded at
 * initiate time; the note's metadata is what the transaction actually put on
 * chain. When they diverge, only one of them determines whether the recipient can
 * ever see the note.
 *
 * The asymmetry is deliberate. Relaying a note that turns out to be public wastes a
 * request. NOT relaying one that is actually private strands the funds with no
 * trace, because a private note is unreachable without its relayed body. So a
 * mismatch resolves toward attempting the relay.
 *
 * A row whose `noteType` is unreadable is treated the same way: unknown means
 * "ask the note", not "assume public".
 */
const isPrivateOutputSend = (tx: SendTransaction, note: Note | undefined): boolean => {
  // Via `isPrivateNoteType`, not a bare `=== NoteTypeEnum.Private` compare: a row can
  // carry the SDK's NUMERIC note type (the enum is accepted wherever a note type is
  // taken, and `Private` is `0`), which a string compare answers "public" for. That
  // would build a private note and then skip its relay entirely.
  //
  // The throw is swallowed rather than propagated because this runs AFTER the
  // transaction is on chain: failing a LANDED send before its id is captured would
  // leave Retry to rebuild the request and pay a second time. An unreadable value
  // falls through to the note's own metadata below, which is the better answer than
  // either assuming public or escalating a delivery problem into a double spend.
  try {
    if (isPrivateNoteType(tx.noteType)) return true;
  } catch (error) {
    console.warn('Unrecognized noteType on the row; deferring to the note metadata', {
      txId: tx.id,
      noteType: tx.noteType,
      error
    });
  }

  if (note) {
    try {
      if (toNoteTypeString(note.metadata().noteType()) === NoteTypeEnum.Private) {
        if (tx.noteType === NoteTypeEnum.Public) {
          console.warn('Row says public but the note is private; relaying anyway', { txId: tx.id });
        }
        return true;
      }
    } catch (error) {
      // Metadata unreadable — keep the row's answer rather than inventing one.
      console.warn('Could not read note metadata to verify note type', { txId: tx.id, error });
    }
  }

  return false;
};

export const completeSendTransaction = async (tx: SendTransaction, result: TransactionResult) => {
  const executedTx = result.executedTransaction();
  const note = extractFullNote(result);
  const noteId = note?.id().toString();
  const outputNoteIds = noteId ? [noteId] : [];

  const isPrivateSend = isPrivateOutputSend(tx, note);

  // Delivery state for the terminal write below. `undefined` on a public send —
  // the chain carries the whole note, so there is nothing to deliver.
  let noteDelivery: INoteDeliveryState | undefined;

  if (isPrivateSend && note && noteId) {
    await setTransactionStage(tx.id, 'delivering');

    // Record that a relay is OWED before attempting it, together with the landed
    // transaction id and the note it produced.
    //
    // The ordering is the whole point. The SDK's retry outbox is written INSIDE the
    // Rust relay and only after it resolves the transport API, so every failure
    // upstream of that write queues nothing — and the wallet used to write nothing
    // of its own either until the terminal "Sent". Between submit and that write
    // there was no durable statement anywhere that a note was owed to anyone, so an
    // interrupted relay was indistinguishable from a delivered one. Now the worst
    // case is a row left at `pending`, which is at least a question someone can ask.
    try {
      await recordNoteDelivery(tx.id, 'pending', { transactionId: executedTx.id().toHex(), outputNoteIds });
    } catch (error) {
      // Best-effort: a failed journal write must not stop the relay, which is the
      // thing that actually delivers the note.
      console.warn('Could not record the pending note delivery', { txId: tx.id, noteId, error });
    }

    try {
      // Relay BEFORE waiting for commit. Under 0.16 the hint comes from the note's
      // stored `expected_height` rather than the client's live sync height, so this
      // ordering is no longer what keeps the hint below the commitment block — but
      // it is still right: it puts the irreversible, unrecoverable step first, while
      // the wait is only a confirmation gate.
      //
      // Both the relay and the paired wait route through `midenClientProxy` (issue
      // #260, slice 7b) so they run on the SAME client that created the note — the
      // OFFSCREEN client flag-on, whose store holds it as an applied output note and
      // is therefore the only one `sendPrivateOutput` can resolve it from; the SW
      // client flag-off (each proxy call owns its WASM lock).
      await midenClientProxy.sendPrivateNote(note, tx.secondaryAccountId);
      noteDelivery = 'relayed';
    } catch (error) {
      // This used to log "SDK outbox will retry on next sync" and fall through to a
      // clean "Sent". That premise does not hold for the failures that arrive here.
      // Rust writes the outbox entry inside the relay, after resolving the transport
      // API, so everything upstream of that point queues nothing while throwing
      // exactly like a mid-transport timeout that DID queue: transport not
      // configured, a realm torn down before the op ran, and — new under 0.16 —
      // `sendPrivateOutput` failing to resolve the note by id in this client's store
      // (`No output note found for the given id`), which is the whole relay refusing
      // before it starts.
      //
      // The two are indistinguishable from here, so record the pessimistic one.
      // Over-reporting a note that arrives anyway costs a stale warning;
      // under-reporting costs the funds.
      console.error('Private-note relay failed; note may be undelivered', {
        txId: tx.id,
        noteId,
        secondaryAccountId: tx.secondaryAccountId,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error)
      });
      noteDelivery = 'undelivered';
    }

    // Persist the outcome immediately, not only via the terminal write below. If
    // this row was failed from outside its pipeline — Cancel, or the stuck-row
    // reaper — that terminal write throws on the finalized row and the relay's
    // outcome would be lost with it. This is the same reason `recordNoteDelivery`
    // carries no terminal guard.
    try {
      await recordNoteDelivery(tx.id, noteDelivery);
    } catch (error) {
      console.warn('Could not record the note delivery outcome', { txId: tx.id, noteId, noteDelivery, error });
    }

    // Confirmation only, and only once the relay has settled either way. Its own
    // failure says nothing about delivery, so it must not disturb the state above.
    try {
      await setTransactionStage(tx.id, 'confirming');
      await midenClientProxy.waitForTransactionCommit(executedTx.id().toHex());
    } catch (error) {
      // The on-chain tx may not be confirmed yet from this client's perspective;
      // falling through to the normal Completed path is still correct because
      // executedTx.id() is the canonical id and the chain is the source of truth —
      // a subsequent sync reconciles it.
      console.warn('Commit wait failed during private send; relying on SDK reconcile', { txId: tx.id, error });
    }
  } else if (isPrivateSend && (!note || !noteId)) {
    console.error('Missing full note for private send', { txId: tx.id });
    await updateTransactionStatus(tx.id, ITransactionStatus.Failed, {
      displayMessage: 'Send failed: note unavailable',
      displayIcon: 'FAILED',
      transactionId: executedTx.id().toHex(),
      outputNoteIds,
      // Failed, but the transaction LANDED — the id above is the proof — so a
      // private note exists on chain that was never relayed. Recorded because
      // "failed" and "undelivered" are different claims and only the second one
      // tells a later reader that value is sitting somewhere unreachable.
      noteDelivery: 'undelivered',
      completedAt: Math.floor(Date.now() / 1000) // seconds
    });
    return;
  }

  try {
    await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {
      ...feeFieldsFromResult(result),
      // Completed is correct even when the relay failed: the assets have left the
      // account, so Failed would be untrue and would offer a Retry that spends a
      // second time. But it must not read as an unqualified success either.
      displayMessage: noteDelivery === 'undelivered' ? undeliveredDisplayMessage('Sent') : 'Sent',
      transactionId: executedTx.id().toHex(),
      outputNoteIds,
      noteDelivery,
      completedAt: Math.floor(Date.now() / 1000), // seconds
      resultBytes: result.serialize()
    });
  } catch (error) {
    console.error('Failed to update transaction status', {
      txId: tx.id,
      error
    });
  }
};

export const completeBridgedSendTransaction = async (tx: BridgedSendTransaction, result: TransactionResult) => {
  const executedTx = result.executedTransaction();
  const note = extractFullNote(result);
  const noteId = note?.id().toString();
  const outputNoteIds = noteId ? [noteId] : [];

  await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {
    ...feeFieldsFromResult(result),
    displayMessage: 'Bridged to EVM',
    transactionId: executedTx.id().toHex(),
    outputNoteIds,
    completedAt: Math.floor(Date.now() / 1000), // seconds
    resultBytes: result.serialize()
  });
};

/** Complete the Miden collateral-note leg of an Epoch Earn deposit. */
export const completeEarnDepositTransaction = async (tx: EarnDepositTransaction, result: TransactionResult) => {
  const executedTx = result.executedTransaction();
  const note = extractFullNote(result);
  const noteId = note?.id().toString();
  const outputNoteIds = noteId ? [noteId] : [];

  await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {
    ...feeFieldsFromResult(result),
    displayMessage: 'Deposited to lending',
    transactionId: executedTx.id().toHex(),
    outputNoteIds,
    completedAt: Math.floor(Date.now() / 1000), // seconds
    resultBytes: result.serialize()
  });
};

/** Patch the allocator-side settlement state after the Miden note is finalized. */
export const updateEarnDepositStatus = async (
  id: string,
  epochStatus: NonNullable<IEarnDepositExtraInputs['epochStatus']>,
  extra?: Partial<Pick<IEarnDepositExtraInputs, 'evmTxHash' | 'intentNonce' | 'outputAmount' | 'outputSymbol'>>,
  expected?: ExpectedEarnDepositIntent
) => {
  await Repo.transactions.where({ id }).modify(tx => {
    if (
      expected &&
      (tx.restoredFromBackup ||
        tx.status !== ITransactionStatus.Completed ||
        !matchesEarnDepositIntent(tx, expected) ||
        tx.extraInputs?.epochStatus === 'confirmed' ||
        tx.extraInputs?.epochStatus === 'failed')
    )
      return;
    const inputs: IEarnDepositExtraInputs = tx.extraInputs;
    tx.extraInputs = { ...inputs, epochStatus, ...(extra ?? {}) };
  });
};

/**
 * Ordering of the `earn-withdraw` lifecycle. `received` and `failed` are both
 * terminal (equal rank): a delivered-and-consumed withdrawal is done, and a failed
 * intent is done. `redeeming` → `delivering` → terminal is the only legal direction.
 */
const EARN_WITHDRAW_PHASE_RANK: Record<IEarnWithdrawPhase, number> = {
  redeeming: 0,
  delivering: 1,
  received: 2,
  failed: 2
};

const EARN_WITHDRAW_TERMINAL_PHASES: ReadonlySet<IEarnWithdrawPhase> = new Set<IEarnWithdrawPhase>([
  'received',
  'failed'
]);

/**
 * Whether `next` is a legal move from `current`.
 *
 * Exported for tests. The load-bearing rule is that a TERMINAL phase never moves:
 * `pollEarnWithdrawDelivery` races the auto-consume path — `resolveBridgeInNoteId`
 * can flip a row to `received` while the poller is still about to write
 * `delivering`, which used to downgrade the row and strand it at "Delivering"
 * forever. Same-phase writes stay allowed so callers can idempotently patch extras
 * (note id, output amount, tx hash) onto an already-terminal row.
 */
export const canAdvanceEarnWithdrawPhase = (current: IEarnWithdrawPhase, next: IEarnWithdrawPhase): boolean => {
  if (current === next) return true;
  if (EARN_WITHDRAW_TERMINAL_PHASES.has(current)) return false;
  return EARN_WITHDRAW_PHASE_RANK[next] >= EARN_WITHDRAW_PHASE_RANK[current];
};

function currentEarnWithdrawExecution(
  tx: ITransaction,
  expected: ExpectedEarnWithdrawIntent,
  isCurrent: () => boolean
) {
  if (
    !isCurrent() ||
    tx.restoredFromBackup ||
    tx.status !== ITransactionStatus.Completed ||
    !matchesEarnWithdrawIntent(tx, expected)
  )
    return undefined;
  return earnWithdrawExecutionIdentity(tx);
}

function sameEarnWithdrawExecution(left: IEarnWithdrawPreparedExecution, right: IEarnWithdrawPreparedExecution) {
  return (
    left.attemptId === right.attemptId &&
    left.chainId === right.chainId &&
    left.delivery.allocationIndex === right.delivery.allocationIndex &&
    left.delivery.owner === right.delivery.owner &&
    left.delivery.nonce === right.delivery.nonce &&
    left.delivery.destinationChainId === right.delivery.destinationChainId &&
    left.delivery.recipientAccountId === right.delivery.recipientAccountId &&
    left.delivery.destinationFaucetId === right.delivery.destinationFaucetId &&
    left.allocations.length === right.allocations.length &&
    left.allocations.every((allocation, index) => {
      const other = right.allocations[index];
      return (
        other !== undefined &&
        allocation.sponsor === other.sponsor &&
        allocation.nonce === other.nonce &&
        allocation.expires === other.expires &&
        allocation.requestJson === other.requestJson
      );
    })
  );
}

export async function prepareEarnWithdrawExecution(
  id: string,
  preparedExecution: IEarnWithdrawPreparedExecution,
  expected: ExpectedEarnWithdrawIntent,
  isCurrent: () => boolean
): Promise<boolean> {
  let applied = false;
  const count = await Repo.transactions.where({ id }).modify(tx => {
    const identity = currentEarnWithdrawExecution(tx, expected, isCurrent);
    if (!identity) return;
    const inputs: IEarnWithdrawExtraInputs = tx.extraInputs;
    if (inputs.phase !== 'redeeming' && inputs.phase !== 'delivering') return;
    const validated = validateEarnWithdrawPreparedExecution(preparedExecution, identity);
    if (!validated || (expected.nonce !== undefined && expected.nonce !== preparedExecution.delivery.nonce)) return;
    if (inputs.submissionState === 'prepared' || inputs.submissionState === 'accepted') {
      const stored = validateEarnWithdrawPreparedExecution(inputs.preparedExecution, identity);
      if (
        !stored ||
        inputs.withdrawIntentNonce !== preparedExecution.delivery.nonce ||
        !sameEarnWithdrawExecution(stored.preparedExecution, preparedExecution)
      )
        return;
      applied = true;
      return;
    }
    if (
      inputs.submissionState !== 'preparing' ||
      inputs.withdrawIntentNonce !== undefined ||
      inputs.preparedExecution !== undefined
    )
      return;
    tx.extraInputs = {
      ...inputs,
      withdrawIntentNonce: preparedExecution.delivery.nonce,
      preparedExecution: validated.preparedExecution,
      submissionState: 'prepared'
    };
    applied = true;
  });
  return applied && count > 0;
}

export async function markEarnWithdrawNotSent(
  id: string,
  error: string,
  expected: ExpectedEarnWithdrawIntent,
  capturedExecution: IEarnWithdrawPreparedExecution | undefined,
  mayConfirmNotSent: () => boolean
): Promise<boolean> {
  let applied = false;
  const count = await Repo.transactions.where({ id }).modify(tx => {
    const identity = currentEarnWithdrawExecution(tx, expected, mayConfirmNotSent);
    if (!identity) return;
    const inputs: IEarnWithdrawExtraInputs = tx.extraInputs;
    if (
      (inputs.phase !== 'redeeming' && inputs.phase !== 'failed') ||
      inputs.evmTxHash !== undefined ||
      inputs.midenNoteId !== undefined ||
      inputs.outputAmount !== undefined ||
      inputs.outputSymbol !== undefined
    )
      return;
    if (inputs.submissionState === 'prepared') {
      const stored = validateEarnWithdrawPreparedExecution(inputs.preparedExecution, identity);
      const captured = validateEarnWithdrawPreparedExecution(capturedExecution, identity);
      if (
        !stored ||
        !captured ||
        inputs.withdrawIntentNonce !== captured.preparedExecution.delivery.nonce ||
        !sameEarnWithdrawExecution(stored.preparedExecution, captured.preparedExecution)
      )
        return;
    } else if (
      inputs.submissionState !== 'preparing' ||
      inputs.withdrawIntentNonce !== undefined ||
      inputs.preparedExecution !== undefined
    ) {
      return;
    }
    // Only the still-current callback can prove execution permission was never granted.
    tx.extraInputs = {
      ...inputs,
      withdrawIntentNonce: undefined,
      preparedExecution: undefined,
      submissionState: 'preparing',
      phase: 'failed',
      error
    };
    tx.error = error;
    applied = true;
  });
  return applied && count > 0;
}

export async function markEarnWithdrawAccepted(
  id: string,
  expected: ExpectedEarnWithdrawIntent,
  isCurrent: () => boolean
): Promise<boolean> {
  let applied = false;
  const count = await Repo.transactions.where({ id }).modify(tx => {
    const identity = currentEarnWithdrawExecution(tx, expected, isCurrent);
    if (!identity) return;
    const inputs: IEarnWithdrawExtraInputs = tx.extraInputs;
    if (inputs.submissionState !== 'prepared' && inputs.submissionState !== 'accepted') return;
    const stored = validateEarnWithdrawPreparedExecution(inputs.preparedExecution, identity);
    if (
      !stored ||
      !inputs.withdrawIntentNonce ||
      inputs.withdrawIntentNonce !== stored.preparedExecution.delivery.nonce
    )
      return;
    tx.extraInputs = { ...inputs, submissionState: 'accepted' };
    applied = true;
  });
  return applied && count > 0;
}

/**
 * Advance an `earn-withdraw` row's lifecycle. The row is finalized (`Completed`)
 * from birth, so this mutates ONLY `extraInputs` (via a direct `modify`) — never
 * `updateTransactionStatus`, which would reject the already-finalized row. On the
 * `failed` phase the failure reason is also mirrored onto `tx.error`.
 *
 * Transitions are MONOTONIC (`canAdvanceEarnWithdrawPhase`): a backwards or
 * out-of-terminal move is dropped whole — phase AND extras — so a late writer can't
 * resurrect a settled row. The one sanctioned way back out of `failed` is the
 * user-initiated retry in `resubmitEarnWithdrawal`, which resets the row with its
 * own `modify` and deliberately bypasses this guard.
 */
export const updateEarnWithdrawPhase = async (
  id: string,
  phase: IEarnWithdrawPhase,
  extra?: Partial<
    Pick<
      IEarnWithdrawExtraInputs,
      'withdrawIntentNonce' | 'evmTxHash' | 'midenNoteId' | 'outputAmount' | 'outputSymbol' | 'error'
    >
  >,
  // Actual delivered amount (base units), patched onto the row when the bridged
  // note is consumed so the history hero reflects what really landed.
  amount?: bigint,
  expected?: ExpectedEarnWithdrawIntent
) => {
  let settled: ITransaction | undefined;
  await Repo.transactions.where({ id }).modify(tx => {
    if (
      expected &&
      (tx.restoredFromBackup || tx.status !== ITransactionStatus.Completed || !matchesEarnWithdrawIntent(tx, expected))
    )
      return;
    const inputs: IEarnWithdrawExtraInputs = tx.extraInputs;
    if (!canAdvanceEarnWithdrawPhase(inputs.phase, phase)) {
      console.warn(`[earn-withdraw] refusing phase downgrade ${inputs.phase} -> ${phase} on ${id}`);
      return;
    }
    // Only the move INTO a terminal phase, so the idempotent same-phase patches
    // this function deliberately allows do not each report an outcome.
    if (!EARN_WITHDRAW_TERMINAL_PHASES.has(inputs.phase) && EARN_WITHDRAW_TERMINAL_PHASES.has(phase)) settled = tx;
    tx.extraInputs = { ...inputs, phase, ...(extra ?? {}) };
    if (amount !== undefined) tx.amount = amount;
    if (phase === 'failed' && extra?.error) tx.error = extra.error;
  });

  // Reported from here because there is nowhere else it could be. This row is
  // `Completed` in the database from birth and its real outcome lives in
  // `extraInputs.phase`, so it never makes a terminal write through
  // `updateTransactionStatus` and neither of the reporters wired to that function
  // can see it. Without this, a withdrawal that failed produced no event at all
  // — and neither did one that succeeded, so `tx_earn_settled` counted only
  // deposits. That is the same blind spot this whole feature exists to close,
  // left open for half of Earn.
  //
  // It matters more here than the shape of the row suggests: `earn-withdraw` is
  // excluded from `REQUEUEABLE_TYPES`, so a failed one cannot be retried through
  // the normal path and the user's funds simply appear stuck.
  if (settled !== undefined) {
    reportOperation({
      operation: operationOfType(settled.type),
      result: phase === 'failed' ? 'errored' : 'completed',
      durationMs: elapsedMsSince(settled.initiatedAt),
      ...(phase === 'failed' ? { errorKind: classifyError(extra?.error), step: 'submitting' } : {})
    });
  }
};

/** Advance a tracking-only EVM → Miden bridge row without touching its terminal DB status. */
const BRIDGED_RECEIVE_PHASE_ORDER: IBridgedReceivePhase[] = ['submitting', 'delivering', 'ready', 'received'];

/**
 * A bridged-receive phase only moves forward: `received` is final, and `failed`
 * gives way only to `received`, the funds having arrived after all. Writers read
 * the row, await the network or a wallet, then write, so a write can land after
 * the row moved on (a consume marking it `received` while a reconcile pass still
 * awaits the indexer); such a write is dropped whole.
 */
const canMoveBridgedReceivePhase = (from: IBridgedReceivePhase | undefined, to: IBridgedReceivePhase): boolean => {
  if (from === 'received') return false;
  if (from === 'failed') return to === 'received';
  if (from === undefined || to === 'failed') return true;
  return BRIDGED_RECEIVE_PHASE_ORDER.indexOf(to) >= BRIDGED_RECEIVE_PHASE_ORDER.indexOf(from);
};

export const updateBridgedReceivePhase = async (
  id: string,
  phase: IBridgedReceivePhase,
  extra?: Partial<
    Pick<
      IBridgedReceiveExtraInputs,
      'evmTxHash' | 'intentNonce' | 'midenNoteId' | 'outputAmount' | 'outputSymbol' | 'error'
    >
  >,
  received?: { amount: bigint; faucetId: string; transactionId?: string }
) => {
  let settled: ITransaction | undefined;
  await Repo.transactions.where({ id }).modify(tx => {
    const inputs: IBridgedReceiveExtraInputs | undefined = tx.extraInputs;
    if (!canMoveBridgedReceivePhase(inputs?.phase, phase)) return;
    // Unlike the earn-withdraw writer there is no monotonic guard here, so the
    // only thing keeping one bridge from reporting twice is comparing against
    // the phase already on the row. `ready` and `received` are both terminal —
    // the note exists and is claimable, then it is claimed — so a row can pass
    // through both and must report on the first.
    const fromPhase = inputs?.phase;
    if (
      (fromPhase === undefined || !BRIDGED_RECEIVE_SETTLED_PHASES.has(fromPhase)) &&
      BRIDGED_RECEIVE_SETTLED_PHASES.has(phase)
    ) {
      settled = tx;
    }
    tx.extraInputs = { ...inputs, phase, ...(extra ?? {}) };
    if (received) {
      tx.amount = received.amount;
      tx.faucetId = received.faucetId;
      if (received.transactionId) tx.transactionId = received.transactionId;
      tx.displayMessage = 'Bridged from EVM';
    }
    if (phase === 'failed' && extra?.error) tx.error = extra.error;
  });

  // Same reason as the earn-withdraw writer above: this row is `Completed` from
  // birth and carries its real outcome in `extraInputs.phase`, so it never makes
  // a terminal write through `updateTransactionStatus` and reported nothing at
  // all. `tx_bridge_settled` counted only the outbound half, which made bridging
  // look like it had half the failure surface it has — and an inbound bridge that
  // fails is money the user cannot see.
  if (settled !== undefined) {
    reportOperation({
      operation: operationOfType(settled.type),
      result: phase === 'failed' ? 'errored' : 'completed',
      durationMs: elapsedMsSince(settled.initiatedAt),
      ...(phase === 'failed' ? { errorKind: classifyError(extra?.error), step: 'submitting' } : {})
    });
  }
};

/**
 * The phases at which an inbound bridge has finished, for reporting purposes.
 *
 * `ready` counts as well as `received`: at `ready` the bridge itself has done its
 * job and the note is on Miden waiting to be claimed, and whether the user then
 * claims it is a question about the user rather than about the bridge. Reporting
 * only `received` would make an unclaimed-but-delivered bridge look like a
 * bridge that never landed.
 */
const BRIDGED_RECEIVE_SETTLED_PHASES: ReadonlySet<IBridgedReceivePhase> = new Set<IBridgedReceivePhase>([
  'ready',
  'received',
  'failed'
]);

/**
 * The display fields a bridged-send row takes on the moment its landing is
 * proven - whether that proof arrives from a claim or fill write already in
 * progress (`updateBridgeClaimStatus`) or from evidence already stored on a
 * row nobody is actively polling (`reconcileBridgedSends`, #1250). One
 * function so the two sites can never drift on what "landed" looks like.
 */
export const bridgedSendLandedValues = (): Partial<ITransaction> => ({
  displayMessage: 'Bridged to EVM',
  displayIcon: 'SEND',
  completedAt: Math.floor(Date.now() / 1000)
});

/**
 * Patch the EVM-side claim status of a `bridged-send` row. The L1 claim happens
 * long after the Miden-side send has reached `Completed`, so this mutates
 * `extraInputs` directly rather than through `updateTransactionStatus` (which
 * would reject a Completed row as "already finalized"). Used by the
 * activity-detail claim flow.
 *
 * `boundDepositTxHash` is the Agglayer deposit's own `tx_hash`, passed by a caller that just
 * looked one up bound to THIS row's `transactionId` (`findClaimableMidenToEvmDeposit`). When the
 * merged write proves this row's own Miden transaction landed - that hash matches
 * (`sameTxHash`), or the Epoch fill poll reports `epochStatus: 'confirmed'` - a row that is
 * Failed or Unconfirmed in the store is promoted to Completed in that same write, via
 * `applyVerifiedLanding` (#1250, #1081), so the evidence and the status can never be stored apart.
 * A write whose merged route status is itself 'failed' never promotes. `bindTransactionId` is the
 * attempt id `pollBridgedSend` matched for a row with none (#1081).
 */
export const updateBridgeClaimStatus = async (
  id: string,
  claimStatus: IBridgeClaimStatus,
  extra?: Partial<
    Pick<
      IBridgedSendExtraInputs,
      | 'depositReady'
      | 'claimTxHash'
      | 'evmTxHash'
      | 'intentNonce'
      | 'outputAmount'
      | 'outputSymbol'
      | 'fillTxHash'
      | 'fillChainId'
      | 'epochStatus'
    >
  >,
  boundDepositTxHash?: string,
  bindTransactionId?: string
) => {
  let landed: ITransaction | undefined;
  await Repo.transactions.where({ id }).modify(tx => {
    const ei: IBridgedSendExtraInputs = tx.extraInputs ?? {};
    const merged: IBridgedSendExtraInputs = { ...ei, claimStatus, ...(extra ?? {}) };
    tx.extraInputs = merged;

    // The attempt id an Agglayer lookup matched becomes the row's, in the write that may promote it (#1081). Never
    // over an id the row already has.
    if (bindTransactionId !== undefined && tx.transactionId === undefined) tx.transactionId = bindTransactionId;
    const routeFailed = merged.claimStatus === 'failed' || merged.epochStatus === 'failed';
    const agglayerLanded =
      !routeFailed &&
      (claimStatus === 'ready' || claimStatus === 'claiming' || claimStatus === 'claimed') &&
      boundDepositTxHash !== undefined &&
      tx.transactionId !== undefined &&
      sameTxHash(boundDepositTxHash, tx.transactionId);
    const epochLanded = !routeFailed && merged.epochStatus === 'confirmed';
    const landingUnknown = tx.status === ITransactionStatus.Failed || tx.status === ITransactionStatus.Unconfirmed;
    if (landingUnknown && (agglayerLanded || epochLanded)) {
      applyVerifiedLanding(tx, bridgedSendLandedValues());
      landed = tx;
    }
  });

  if (landed !== undefined) {
    reportVerifiedLanding(landed);
  }
};

/**
 * A `bridged-send` (Epoch) row reaches Completed / 'Bridged to EVM' the instant
 * its P2IDE note commits — but the SDK submits the intent to the allocator AFTER
 * that, so a post-commit rejection (reclaim window, solver liquidity, quote
 * drift, allocator downtime) means the bridge did NOT succeed and the funds sit
 * in a recallable P2IDE note. Demote the false success to Failed and record it so
 * the activity view stops claiming success. Modifies the row directly because
 * `updateTransactionStatus` rejects re-finalizing a Completed tx. The row is
 * usually Completed here, but the 5-minute wait in `createBridgeP2IDENote` can
 * give up while it is still queued or in flight; that pipeline is then refused
 * at its submit claim (`claimBridgeSubmit`) unless it already made it, in which
 * case its `submitClaimed` says the note may exist.
 *
 * A row the note pipeline already failed for its own reason - its own status,
 * error and classification already stored - keeps that failure instead of this
 * one: the early return below leaves an already-Failed row untouched, since
 * that failure was already reported by `cancelTransaction` (#1250).
 */
export const markBridgedSendFailed = async (id: string, error: string) => {
  let demoted: ITransaction | undefined;
  let committed = false;
  await Repo.transactions.where({ id }).modify(tx => {
    // A row the note pipeline already failed keeps the pipeline's own Failed
    // write rather than this later one; `demoted` stays undefined, so nothing
    // is reported for a row nothing here actually changed (#1250).
    if (tx.status === ITransactionStatus.Failed) return false;
    const ei: IBridgedSendExtraInputs = tx.extraInputs ?? {};
    committed = tx.status === ITransactionStatus.Completed;
    const noteMayExist = committed || ei.submitClaimed === true;
    tx.status = ITransactionStatus.Failed;
    tx.displayMessage = noteMayExist ? 'Bridge failed - funds reclaimable' : 'Bridge failed';
    tx.extraInputs = { ...ei, claimStatus: 'failed', epochStatus: 'failed' };
    demoted = tx;
    return undefined;
  });
  if (demoted === undefined) return;

  console.error(
    committed
      ? '[epoch] bridged-send intent rejected after the P2IDE note committed; demoting row to Failed'
      : '[epoch] bridged-send abandoned before its P2IDE note was confirmed; demoting row to Failed',
    { id, error }
  );

  // The mirror of `completeVerifiedLandedTransaction`, and needed for the same
  // reason. A committed row already reported `completed` on its way through
  // `updateTransactionStatus`, because as far as the send pipeline was concerned
  // it succeeded. Without this the only settled event a rejected bridge ever
  // produces says it worked — which is worse than reporting nothing, since it
  // moves a failure into the denominator and makes the bridge look healthier the
  // more often it fails this way.
  //
  // `step: 'submitting'` rather than a mapped stage for a committed row: it is
  // stamped `complete` by now, and what failed is the intent the note was
  // submitted for. A row abandoned before completing reports where it stood,
  // since nothing else will report it: its own completion and cancel are refused
  // on the Failed row.
  reportOperation({
    operation: operationOfType(demoted.type),
    result: 'errored',
    durationMs: elapsedMsSince(demoted.initiatedAt),
    errorKind: classifyError(error),
    step: committed ? 'submitting' : stepOfStage(demoted.stage)
  });
};
