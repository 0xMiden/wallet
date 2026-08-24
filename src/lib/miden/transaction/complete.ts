import { Note, TransactionResult } from '@miden-sdk/miden-sdk/lazy';

import { clearGuardianServiceFor, type GuardianAccountProvider } from 'lib/miden/front/guardian-manager';
import { MultisigService } from 'lib/miden/guardian';
import * as Repo from 'lib/miden/repo';
import { classifyError } from 'lib/telemetry/classify';
import { reportOperation } from 'lib/telemetry/report-operation';
import { elapsedMsSince, operationOfType } from 'lib/telemetry/transaction-operation';

import { setTransactionStage, updateTransactionStatus } from './helper';
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

  // A private note is only reachable by its recipient if the bytes are handed to
  // them out of band — the chain carries a commitment, not the note. So a private
  // output note we never pass to the transport is stranded: the recipient cannot
  // see or consume it, and a custom note need not carry any reclaim window for the
  // sender either. That is a silent loss of whatever it holds, and it used to be
  // reported as a clean success. Counted here and surfaced on the row below.
  //
  // Only the cases where the transport never received the note count. A throw from
  // `sendPrivateNote` does not: by then the note is in the client's store and the
  // SDK outbox retries it on the next sync, which is the same reasoning
  // `completeSendTransaction` applies to its own relay failures.
  let strandedPrivateNotes = 0;

  for (const note of outputNotes) {
    // Only care about private notes
    if (toNoteTypeString(note.metadata().noteType()) !== NoteTypeEnum.Private) {
      continue;
    }

    if (!transaction.secondaryAccountId) {
      // The recipient is supplied by the requesting site and is optional, so a
      // custom request that emits a private note without naming one lands here.
      console.error('Missing recipient account id for private note', { txId: transaction.id });
      strandedPrivateNotes++;
      continue;
    }

    let fullNote: Note;

    // intoFull() can throw or return undefined
    try {
      const maybeFullNote = note.intoFull();
      if (!maybeFullNote) {
        console.error('intoFull() returned undefined for output note');
        strandedPrivateNotes++;
        continue;
      }
      fullNote = maybeFullNote;
    } catch (error) {
      console.error('Failed to convert output note into full note', { error });
      strandedPrivateNotes++;
      continue;
    }

    // Relay the private note + wait for commit as a coherent unit on ONE client.
    // Both route through `midenClientProxy` (issue #260, slice 7b): under the flag
    // the send ran offscreen, so the note lives in the OFFSCREEN client's store and
    // that realm owns the fresh sync height — the relay + wait MUST run there, not on
    // the dormant SW client. Flag-off both run on the SW client, byte-identical to
    // the former inline `getMidenClient()` calls (each proxy call owns its own WASM
    // lock, so the outer lock this block used to hold is gone). Best-effort: any
    // relay/wait failure is caught and logged, then the row still reaches Completed
    // (degraded, not Failed) below.
    try {
      // Relay to the transport layer BEFORE waiting for commit. The block hint
      // sendPrivateNote attaches is the client's current sync height, and the
      // recipient scans FORWARD from it for the note's on-chain commitment.
      // Waiting for commit first advances sync height to/past the commitment
      // block, so on fast chains the hint overshoots the commitment and the
      // recipient never finds the note (silent non-delivery). Relaying first
      // keeps the hint below the commitment; the commit wait still gates the
      // Completed status below.
      await midenClientProxy.sendPrivateNote(fullNote, transaction.secondaryAccountId!);
      await midenClientProxy.waitForTransactionCommit(executedTx.id().toHex());
    } catch (error) {
      console.error('Failed to send private note through the transport layer', {
        txId: transaction.id,
        secondaryAccountId: transaction.secondaryAccountId,
        error
      });
    }
  }

  const updatedTransaction = interpretTransactionResult(transaction, result);
  updatedTransaction.completedAt = Math.floor(Date.now() / 1000); // seconds

  if (strandedPrivateNotes > 0) {
    // Completed, not Failed: the transaction is on chain and the assets have left
    // the account, so failing the row would be untrue and would offer a Retry that
    // spends again. What is wrong is the DELIVERY, and the row is the only place
    // the user would ever learn about it — `error` is rendered for failed rows
    // only, so the label is what carries it.
    updatedTransaction.displayMessage =
      strandedPrivateNotes === 1
        ? 'Completed — a private note could not be delivered'
        : `Completed — ${strandedPrivateNotes} private notes could not be delivered`;
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
  multisigService: MultisigService,
  guardianProvider: GuardianAccountProvider
) => {
  try {
    const { newGuardianEndpoint } = tx.extraInputs;

    // Mirror upstream `multisig.executeProposal`'s post-submit block for
    // switch_guardian proposals: register on the new guardian with the
    // updated account state before anything else touches the local cache
    // or storage. If this throws, storage + status stay untouched so the
    // user can retry.
    await setTransactionStage(tx.id, 'registering-guardian');
    await multisigService.finalizeGuardianSwitch(newGuardianEndpoint);

    // Persist the endpoint PER-ACCOUNT (not the legacy global key) so other
    // Guardian accounts on different operators aren't clobbered. Backend
    // providers implement setGuardianEndpoint; the optional-call guard keeps a
    // frontend provider without it from throwing.
    await guardianProvider.setGuardianEndpoint?.(tx.accountId, newGuardianEndpoint);
    clearGuardianServiceFor(tx.accountId);

    await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {
      displayMessage: 'Guardian switched',
      completedAt: Math.floor(Date.now() / 1000), // seconds
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

export const completeSendTransaction = async (tx: SendTransaction, result: TransactionResult) => {
  const executedTx = result.executedTransaction();
  const note = extractFullNote(result);
  const noteId = note?.id().toString();
  const outputNoteIds = noteId ? [noteId] : [];

  // Via `isPrivateNoteType`, not a bare `=== NoteTypeEnum.Private` string
  // compare: a row can carry the SDK's NUMERIC note type (the enum is accepted
  // wherever a note type is taken, and `Private` is `0`), and a string compare
  // answers "public" for it. That would build a private note and then skip the
  // relay below — the recipient never learns the note exists, and the "missing
  // full note" guard is skipped too, so it fails silently rather than loudly.
  // The dApp boundary normalizes before persisting; this is the backstop for
  // any other producer.
  //
  // Swallowing the throw is deliberate here and only here. This runs AFTER the
  // transaction is on chain, so letting it propagate would fail a LANDED send
  // before its id is captured — and Retry, seeing no id, would rebuild and pay a
  // second time. An unrecognized value at this point can only come from a row
  // some older build wrote, which is a delivery problem; escalating it into a
  // double spend is strictly worse than logging and skipping the relay.
  let isPrivateSend: boolean;
  try {
    isPrivateSend = isPrivateNoteType(tx.noteType);
  } catch (error) {
    console.error('[completeSendTransaction] unrecognized noteType; skipping the private-note relay', {
      id: tx.id,
      noteType: tx.noteType,
      error
    });
    isPrivateSend = false;
  }

  if (isPrivateSend && note && noteId) {
    // Wrap all WASM client operations in a lock to prevent concurrent access.
    // The SDK persists the relay payload to its durable outbox before invoking
    // transport (miden-client#2127); if the transport call fails, the SDK
    // retries the blob on every subsequent sync_state. So a transport-level
    // failure here is not a wallet-side concern — the on-chain tx is durable
    // and the SDK will deliver the blob eventually. We just log and move on.
    await setTransactionStage(tx.id, 'confirming');
    try {
      await setTransactionStage(tx.id, 'delivering');
      try {
        // Relay BEFORE waiting for commit — same reason as completeCustomTransaction:
        // the sync-height block hint must stay below the note's commitment block, or
        // the recipient scans past it and never receives. Both the relay and the
        // paired wait route through `midenClientProxy` (issue #260, slice 7b) so they
        // run on the SAME client that created the note: the OFFSCREEN client flag-on
        // (which owns the note + the fresh sync height), the SW client flag-off —
        // byte-identical to the former inline block (each proxy call owns its WASM
        // lock, so the outer lock is gone).
        await midenClientProxy.sendPrivateNote(note, tx.secondaryAccountId);
      } catch (error) {
        console.warn('Private-note transport failed; SDK outbox will retry on next sync', {
          txId: tx.id,
          noteId,
          secondaryAccountId: tx.secondaryAccountId,
          error
        });
      }
      await midenClientProxy.waitForTransactionCommit(executedTx.id().toHex());
    } catch (error) {
      // Lock acquisition or pre-transport step (e.g. waitForTransactionCommit)
      // failed. The on-chain tx may not be confirmed yet from this client's
      // perspective; falling through to the normal Completed path is still
      // correct because executedTx.id() is the canonical id and the chain
      // is the source of truth — subsequent sync_state will reconcile.
      console.warn('Pre-transport step failed during private send; relying on SDK reconcile', { txId: tx.id, error });
    }
  } else if (isPrivateSend && (!note || !noteId)) {
    console.error('Missing full note for private send', { txId: tx.id });
    await updateTransactionStatus(tx.id, ITransactionStatus.Failed, {
      displayMessage: 'Send failed: note unavailable',
      displayIcon: 'FAILED',
      transactionId: executedTx.id().toHex(),
      outputNoteIds,
      completedAt: Math.floor(Date.now() / 1000) // seconds
    });
    return;
  }

  try {
    await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {
      displayMessage: 'Sent',
      transactionId: executedTx.id().toHex(),
      outputNoteIds,
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
  let settled: ITransaction | undefined;
  await Repo.transactions.where({ id }).modify(tx => {
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
    const inputs = tx.extraInputs as IBridgedReceiveExtraInputs;
    // Unlike the earn-withdraw writer there is no monotonic guard here, so the
    // only thing keeping one bridge from reporting twice is comparing against
    // the phase already on the row. `ready` and `received` are both terminal —
    // the note exists and is claimable, then it is claimed — so a row can pass
    // through both and must report on the first.
    if (!BRIDGED_RECEIVE_SETTLED_PHASES.has(inputs.phase) && BRIDGED_RECEIVE_SETTLED_PHASES.has(phase)) settled = tx;
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
  let demoted: ITransaction | undefined;
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
    demoted = tx;
  });

  // The mirror of `completeVerifiedLandedTransaction`, and needed for the same
  // reason. This row already reported `completed` on its way through
  // `updateTransactionStatus`, because as far as the send pipeline was concerned
  // it succeeded. Without this the only settled event a rejected bridge ever
  // produces says it worked — which is worse than reporting nothing, since it
  // moves a failure into the denominator and makes the bridge look healthier the
  // more often it fails this way.
  //
  // `step: 'submitting'` rather than a mapped stage: the row is stamped
  // `complete` by now, and what failed is the intent the note was submitted for.
  if (demoted !== undefined) {
    reportOperation({
      operation: operationOfType(demoted.type),
      result: 'errored',
      durationMs: elapsedMsSince(demoted.initiatedAt),
      errorKind: classifyError(error),
      step: 'submitting'
    });
  }
};
