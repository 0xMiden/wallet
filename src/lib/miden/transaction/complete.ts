import { Note, TransactionResult } from '@miden-sdk/miden-sdk/lazy';

import { clearGuardianServiceFor, type GuardianAccountProvider } from 'lib/miden/front/guardian-manager';
import { MultisigService } from 'lib/miden/guardian';
import * as Repo from 'lib/miden/repo';

import { setTransactionStage, updateTransactionStatus } from './helper';
import { ensureGuardianProcedureThresholds } from './initiate';
import { interpretTransactionResult } from '../activity/helpers';
import { compareAccountIds } from '../activity/utils';
import {
  BridgedSendTransaction,
  IBridgeClaimStatus,
  IBridgedSendExtraInputs,
  ITransaction,
  ITransactionStatus,
  ReplaceHotKeyTransaction,
  SendTransaction,
  SwapTransaction,
  SwitchGuardianTransaction,
  UpdateProcedureThresholdTransaction
} from '../db/types';
import { toNoteTypeString } from '../helpers';
import { getBech32AddressFromAccountId } from '../sdk/helpers';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';
import { NoteTypeEnum } from '../types';

export const completeCustomTransaction = async (transaction: ITransaction, result: TransactionResult) => {
  const executedTx = result.executedTransaction();
  const outputNotes = executedTx.outputNotes().notes();

  for (const note of outputNotes) {
    // Only care about private notes
    if (toNoteTypeString(note.metadata().noteType()) !== NoteTypeEnum.Private) {
      continue;
    }

    if (!transaction.secondaryAccountId) {
      console.error('Missing recipient account id for private note', { txId: transaction.id });
      continue;
    }

    let fullNote: Note;

    // intoFull() can throw or return undefined
    try {
      const maybeFullNote = note.intoFull();
      if (!maybeFullNote) {
        console.error('intoFull() returned undefined for output note');
        continue;
      }
      fullNote = maybeFullNote;
    } catch (error) {
      console.error('Failed to convert output note into full note', { error });
      continue;
    }

    // Get client + send private note (wrapped in lock to prevent concurrent WASM access)
    try {
      await withWasmClientLock(async () => {
        const midenClient = await getMidenClient();

        try {
          await midenClient.waitForTransactionCommit(executedTx.id().toHex());
          await midenClient.sendPrivateNote(fullNote, transaction.secondaryAccountId!);
        } catch (error) {
          console.error('Failed to send private note through the transport layer', {
            txId: transaction.id,
            secondaryAccountId: transaction.secondaryAccountId,
            error
          });
        }
      });
    } catch (error) {
      console.error('Failed to initialize Miden client for private note send', {
        txId: transaction.id,
        error
      });
    }
  }

  const updatedTransaction = interpretTransactionResult(transaction, result);
  updatedTransaction.completedAt = Math.floor(Date.now() / 1000); // seconds

  await updateTransactionStatus(transaction.id, ITransactionStatus.Completed, updatedTransaction);
};

export const completeConsumeTransaction = async (id: string, result: TransactionResult) => {
  const firstInputNote = result.executedTransaction().inputNotes().notes()[0];
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
  const amount = asset.amount();

  await updateTransactionStatus(id, ITransactionStatus.Completed, {
    displayMessage,
    transactionId: executedTransaction.id().toHex(),
    secondaryAccountId,
    faucetId,
    amount,
    noteType: toNoteTypeString(note.metadata().noteType()),
    completedAt: Math.floor(Date.now() / 1000), // Convert to seconds.
    resultBytes: result.serialize()
  });
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
  await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {
    displayMessage: 'Swapped',
    transactionId: executedTx.id().toHex(),
    outputNoteIds: [outputNote.id().toString()],
    completedAt: Math.floor(Date.now() / 1000), // seconds
    resultBytes: result.serialize(),
    extraInputs: { ...tx.extraInputs, orderId }
  });
};

export const completeReplaceHotKeyTransaction = async (
  tx: ReplaceHotKeyTransaction,
  result: TransactionResult | undefined,
  guardianProvider: GuardianAccountProvider,
  // The cold MultisigService used to drive the rotation. Supplied on the normal
  // path so we can push the rotated state to the guardian below; absent on the
  // apply-after-submit-failed reconcile path (runSync self-heals that case).
  service?: MultisigService
) => {
  try {
    const newHotPublicKey = tx.extraInputs?.newHotPublicKey;
    if (!newHotPublicKey) {
      throw new Error('Replace-hot-key tx is missing newHotPublicKey in extraInputs');
    }

    if (!guardianProvider.swapHotKey) {
      throw new Error('swapHotKey not implemented in this provider');
    }

    // The OZ lib submitted `update_signers` on-chain but did NOT re-register the
    // rotated state on the guardian (it only does that for switch_guardian). Push
    // it now — BEFORE `swapHotKey`, which sets `hotPublicKey` and thereby arms the
    // ~3s guardian hot-sync. If we let the hot-sync start with the guardian's blob
    // still pre-rotation, every tick throws on the guardian-vs-on-chain mismatch
    // until a reinstall. Best-effort: an on-chain-successful rotation must not be
    // failed by a guardian blip — runSync re-registers on a later tick if this slips.
    if (service) {
      try {
        await service.reRegisterCurrentStateOnGuardian();
      } catch (e) {
        console.warn('Failed to re-register rotated state on guardian post-replace-hot-key (non-fatal):', e);
      }
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

  if (tx.noteType === NoteTypeEnum.Private && note && noteId) {
    // Wrap all WASM client operations in a lock to prevent concurrent access.
    // The SDK persists the relay payload to its durable outbox before invoking
    // transport (miden-client#2127); if the transport call fails, the SDK
    // retries the blob on every subsequent sync_state. So a transport-level
    // failure here is not a wallet-side concern — the on-chain tx is durable
    // and the SDK will deliver the blob eventually. We just log and move on.
    await setTransactionStage(tx.id, 'confirming');
    try {
      await withWasmClientLock(async () => {
        const midenClient = await getMidenClient();
        await midenClient.waitForTransactionCommit(executedTx.id().toHex());
        await setTransactionStage(tx.id, 'delivering');
        try {
          await midenClient.sendPrivateNote(note, tx.secondaryAccountId);
        } catch (error) {
          console.warn('Private-note transport failed; SDK outbox will retry on next sync', {
            txId: tx.id,
            noteId,
            secondaryAccountId: tx.secondaryAccountId,
            error
          });
        }
      });
    } catch (error) {
      // Lock acquisition or pre-transport step (e.g. waitForTransactionCommit)
      // failed. The on-chain tx may not be confirmed yet from this client's
      // perspective; falling through to the normal Completed path is still
      // correct because executedTx.id() is the canonical id and the chain
      // is the source of truth — subsequent sync_state will reconcile.
      console.warn('Pre-transport step failed during private send; relying on SDK reconcile', { txId: tx.id, error });
    }
  } else if (tx.noteType === NoteTypeEnum.Private && (!note || !noteId)) {
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
