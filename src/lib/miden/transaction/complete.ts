import { Note, TransactionResult } from '@miden-sdk/miden-sdk/lazy';

import { clearGuardianServiceFor, type GuardianAccountProvider } from 'lib/miden/front/guardian-manager';
import { MultisigService } from 'lib/miden/guardian';
import { finalizeDirectGuardianSwitch } from 'lib/miden/guardian/direct-switch';
import * as Repo from 'lib/miden/repo';

import { recordNoteDelivery, setTransactionStage, updateTransactionStatus } from './helper';
import { ensureGuardianProcedureThresholds } from './initiate';
import { takeAgglayerBridgeInInfo, takeBridgeInInfoForNotes } from '../activity/bridge-in';
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
import { withWasmClientLock } from '../sdk/miden-client';
import { NoteTypeEnum } from '../types';

export const completeCustomTransaction = async (transaction: ITransaction, result: TransactionResult) => {
  const executedTx = result.executedTransaction();
  const outputNotes = executedTx.outputNotes().notes();

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

  for (const note of outputNotes) {
    // Only care about private notes
    if (toNoteTypeString(note.metadata().noteType()) !== NoteTypeEnum.Private) {
      continue;
    }

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
  // Set explicitly AFTER interpretTransactionResult: that returns the whole
  // pick-time row, which predates every delivery write above and would otherwise
  // hand back the stale (absent) value.
  if (noteDelivery) updatedTransaction.noteDelivery = noteDelivery;

  if (undeliveredNotes > 0) {
    // Completed, not Failed: the transaction is on chain and the assets have left
    // the account, so failing the row would be untrue and would offer a Retry that
    // spends again. What is wrong is the DELIVERY, and the row is the only place
    // the user would ever learn about it — `error` is rendered for failed rows
    // only, so the label is what carries it.
    updatedTransaction.displayMessage =
      undeliveredNotes === 1
        ? 'Completed — a private note could not be delivered'
        : `Completed — ${undeliveredNotes} private notes could not be delivered`;
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
    const bridgeIn =
      (await takeBridgeInInfoForNotes(consumedNoteIds)) ??
      (await takeAgglayerBridgeInInfo({
        accountId: dbTransaction?.accountId ?? '',
        senderAccountId: sender,
        amount
      }));
    if (bridgeIn) {
      await Repo.transactions.where({ id }).modify(tx => {
        tx.extraInputs = { ...(tx.extraInputs ?? {}), bridgeIn };
        tx.displayMessage = 'Bridged from EVM';
      });
      if (bridgeIn.earnWithdrawTxId) {
        await updateEarnWithdrawPhase(
          bridgeIn.earnWithdrawTxId,
          'received',
          {
            midenNoteId: bridgeIn.midenNoteId ?? consumedNoteIds[0],
            outputSymbol: bridgeIn.sourceSymbol
          },
          amount
        );
      }
      if (bridgeIn.bridgeReceiveTxId) {
        await updateBridgedReceivePhase(
          bridgeIn.bridgeReceiveTxId,
          'received',
          {
            midenNoteId: bridgeIn.midenNoteId ?? consumedNoteIds[0],
            outputSymbol: bridgeIn.sourceSymbol
          },
          { amount, faucetId, transactionId: executedTransaction.id().toHex() }
        );
      }
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
  const outputNote = executedTx.outputNotes().notes()[0];

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

export const completeReplaceHotKeyTransaction = async (
  tx: ReplaceHotKeyTransaction,
  result: TransactionResult | undefined,
  guardianProvider: GuardianAccountProvider
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
    // MAX_GUARDIAN_REGISTER_RETRIES times, honouring Retry-After); a miss is
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
    for (let attempt = 1; attempt <= POST_ROTATION_REREGISTER_ATTEMPTS; attempt++) {
      try {
        const accounts = await guardianProvider.getAccounts();
        const walletAccount = accounts.find(a => sameWalletAccountId(a.publicKey, tx.accountId));
        if (!walletAccount) {
          throw new Error(`Guardian account ${tx.accountId} not found in provider`);
        }
        const sdkAccount = await withWasmClientLock(async () => {
          await midenClientProxy.syncState();
          return midenClientProxy.getAccount(tx.accountId);
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
    if (reRegisterError) {
      reRegisterFailed = true;
      console.error(
        `Failed to re-register post-rotation signer set on guardian after ${POST_ROTATION_REREGISTER_ATTEMPTS} attempts — ` +
          'the new hot key stays unauthorized (401) until a re-register lands:',
        reRegisterError
      );
    }

    // Vault.swapHotKey resolves the previous hot pubkey from the persisted
    // WalletAccount and is idempotent: if the record already reflects
    // `newHotPublicKey` (retry), the cleanup branch is a no-op.
    await guardianProvider.swapHotKey(tx.accountId, newHotPublicKey);
    // Drop the cached MultisigService — its bound hot signer is now stale.
    clearGuardianServiceFor(tx.accountId);

    await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {
      displayMessage: 'Device key rotated',
      completedAt: Math.floor(Date.now() / 1000),
      // Preserve newHotPublicKey (updateTransactionStatus Object.assigns the whole
      // extraInputs) and record whether the guardian re-register landed (#619 gap 1).
      extraInputs: { ...tx.extraInputs, reRegisterFailed },
      // `result` is absent on the apply-after-submit-failed reconcile path: the
      // rotation is already on chain, we just lack the local TransactionResult.
      ...(result && {
        transactionId: result.executedTransaction().id().toHex(),
        resultBytes: result.serialize()
      })
    });

    // The account now has both signers on-chain, so bring it up to the same
    // hardening a freshly-created 3-key account has (update_guardian threshold
    // 2 — which the update_signers rotation above can't carry). Best-effort and
    // idempotent; never affects the rotation's success.
    await ensureGuardianProcedureThresholds(tx.accountId, tx.delegateTransaction, guardianProvider);
  } catch (error) {
    console.error('Error completing replace-hot-key transaction:', error);
    await updateTransactionStatus(tx.id, ITransactionStatus.Failed, {
      displayMessage: 'Failed to rotate device key',
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
    displayMessage: 'Account secured',
    transactionId: executedTx.id().toHex(),
    completedAt: Math.floor(Date.now() / 1000),
    resultBytes: result.serialize()
  });
  // The cached service's procedureThresholds are now stale — drop it.
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

export const completeSwitchGuardianTransaction = async (
  tx: SwitchGuardianTransaction,
  result: TransactionResult | undefined,
  // Undefined on the DIRECT-switch fallback (outgoing guardian unreachable):
  // no MultisigService exists — building one loads from the old guardian —
  // so registration on the new guardian runs standalone instead.
  multisigService: MultisigService | undefined,
  guardianProvider: GuardianAccountProvider
) => {
  try {
    const { newGuardianEndpoint } = tx.extraInputs;

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
    // endpoint, so a vault pointing at the dead operator makes `service.sync()`
    // throw before `checkGuardianDrift` is ever reached — the reconciler that
    // rescues the coordinated path cannot run. Persisting the endpoint is what
    // restores it: the next tick talks to the new operator, and a missing
    // registration surfaces as a 401, which the existing cold-re-register
    // self-heal repairs.
    await setTransactionStage(tx.id, 'registering-guardian');
    let registerFailed = false;
    try {
      if (multisigService) {
        await multisigService.finalizeGuardianSwitch(newGuardianEndpoint);
      } else {
        await finalizeDirectGuardianSwitch(tx.accountId, newGuardianEndpoint, guardianProvider);
      }
    } catch (registerError) {
      registerFailed = true;
      console.error(
        'On-chain guardian switch committed but registering on the new guardian failed — the account stays ' +
          'unauthorized (401) with the new operator until the guardian-sync self-heal lands a registration:',
        registerError
      );
    }

    // Persist the endpoint PER-ACCOUNT (not the legacy global key) so other
    // Guardian accounts on different operators aren't clobbered. Backend
    // providers implement setGuardianEndpoint; the optional-call guard keeps a
    // frontend provider without it from throwing.
    await guardianProvider.setGuardianEndpoint?.(tx.accountId, newGuardianEndpoint);
    clearGuardianServiceFor(tx.accountId);

    await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {
      displayMessage: 'Guardian switched',
      completedAt: Math.floor(Date.now() / 1000), // seconds
      // Preserve the audit fields (updateTransactionStatus Object.assigns the
      // whole extraInputs) and record whether the registration landed.
      extraInputs: { ...tx.extraInputs, registerFailed },
      // `result` is absent on the apply-after-submit-failed reconcile path: the
      // switch is already on chain, we just lack the local TransactionResult.
      ...(result && {
        transactionId: result.executedTransaction().id().toHex(),
        resultBytes: result.serialize()
      })
    });
  } catch (error) {
    console.error('Error completing switch guardian transaction:', error);
    await updateTransactionStatus(tx.id, ITransactionStatus.Failed, {
      displayMessage: 'Failed to switch guardian',
      completedAt: Math.floor(Date.now() / 1000), // seconds
      ...(result && { resultBytes: result.serialize() }),
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

const extractFullNote = (result: TransactionResult): Note | undefined => {
  try {
    const outputNotes = result.executedTransaction().outputNotes().notes();

    const firstOutput = outputNotes?.[0];
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
      // Completed is correct even when the relay failed: the assets have left the
      // account, so Failed would be untrue and would offer a Retry that spends a
      // second time. But it must not read as an unqualified success either.
      displayMessage: noteDelivery === 'undelivered' ? 'Sent — the private note could not be delivered' : 'Sent',
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
  extra?: Partial<Pick<IEarnDepositExtraInputs, 'evmTxHash' | 'intentNonce' | 'outputAmount' | 'outputSymbol'>>
) => {
  await Repo.transactions.where({ id }).modify(tx => {
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
  amount?: bigint
) => {
  await Repo.transactions.where({ id }).modify(tx => {
    const inputs: IEarnWithdrawExtraInputs = tx.extraInputs;
    if (!canAdvanceEarnWithdrawPhase(inputs.phase, phase)) {
      console.warn(`[earn-withdraw] refusing phase downgrade ${inputs.phase} -> ${phase} on ${id}`);
      return;
    }
    tx.extraInputs = { ...inputs, phase, ...(extra ?? {}) };
    if (amount !== undefined) tx.amount = amount;
    if (phase === 'failed' && extra?.error) tx.error = extra.error;
  });
};

/** Advance a tracking-only EVM → Miden bridge row without touching its terminal DB status. */
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
  await Repo.transactions.where({ id }).modify(tx => {
    const inputs = tx.extraInputs as IBridgedReceiveExtraInputs;
    tx.extraInputs = { ...inputs, phase, ...(extra ?? {}) };
    if (received) {
      tx.amount = received.amount;
      tx.faucetId = received.faucetId;
      if (received.transactionId) tx.transactionId = received.transactionId;
      tx.displayMessage = 'Bridged from EVM';
    }
    if (phase === 'failed' && extra?.error) tx.error = extra.error;
  });
};

/**
 * Patch the EVM-side claim status of a `bridged-send` row. The L1 claim happens
 * long after the Miden-side send has reached `Completed`, so this mutates ONLY
 * `extraInputs` and never touches `status` (which `updateTransactionStatus`
 * would reject as "already finalized"). Used by the activity-detail claim flow.
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
  >
) => {
  await Repo.transactions.where({ id }).modify(tx => {
    const ei: IBridgedSendExtraInputs = tx.extraInputs ?? {};
    tx.extraInputs = { ...ei, claimStatus, ...(extra ?? {}) };
  });
};

/**
 * A `bridged-send` (Epoch) row reaches Completed / 'Bridged to EVM' the instant
 * its P2IDE note commits — but the SDK submits the intent to the allocator AFTER
 * that, so a post-commit rejection (reclaim window, solver liquidity, quote
 * drift, allocator downtime) means the bridge did NOT succeed and the funds sit
 * in a recallable P2IDE note. Demote the false success to Failed and record it so
 * the activity view stops claiming success. Modifies the row directly because
 * `updateTransactionStatus` rejects re-finalizing a Completed tx; the send
 * pipeline is already done with this row, so there is no race.
 */
export const markBridgedSendFailed = async (id: string, error: string, reclaimHeight?: number) => {
  console.error('[epoch] bridged-send intent rejected after the P2IDE note committed; demoting row to Failed', {
    id,
    error
  });
  await Repo.transactions.where({ id }).modify(tx => {
    tx.status = ITransactionStatus.Failed;
    tx.displayMessage = 'Bridge failed — funds reclaimable';
    const ei: IBridgedSendExtraInputs = tx.extraInputs ?? {};
    tx.extraInputs = {
      ...ei,
      claimStatus: 'failed',
      epochStatus: 'failed',
      ...(reclaimHeight != null ? { reclaimHeight } : {})
    };
  });
};
