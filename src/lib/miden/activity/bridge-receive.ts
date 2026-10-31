import { isHash } from 'viem';

import { midenAddrToEvmAddr } from 'lib/agglayer/contract';
import { fetchDeposits, isAgglayerDepositReady } from 'lib/agglayer/status';
import { MIDEN_DESTINATION_CHAIN_ID } from 'lib/epoch/config';
import { readEpochIntentStatus } from 'lib/epoch/intent-status';
import * as Repo from 'lib/miden/repo';
import { initBridgeConfig } from 'lib/remote-config/runtime';
import {
  type BridgeOrphanCheck,
  type BridgeReceiveFailureStep,
  type BridgeSourceRoute
} from 'lib/telemetry/bridge-receive-failure';
import {
  fetchXReserveAttestations,
  matchUsdcxDepositAttestation,
  UsdcxAttestationMatch,
  UsdcxAttestationMismatchField,
  UsdcxDepositExpectation
} from 'lib/usdcx/attestation';
import {
  fetchAttestedCctpMessage,
  isCctpForwardFailed,
  revertedExecuteLeg,
  stalledExecuteLeg,
  USDCX_EXECUTE_STALL_SEC
} from 'lib/usdcx/cctp';
import { usdcxSourceChains, UsdcxExecutorSource } from 'lib/usdcx/constant';
import { usdcxExpectedRemoteTokenFor, usdcxRemoteRecipientFor } from 'lib/usdcx/deposit-target';
import { DEFAULT_CHAIN_ID, EVM_CHAIN_DEFINITIONS } from 'lib/walletconnect/config';
import { EvmTransactionRevertedError, readEvmReceiptOutcome } from 'lib/walletconnect/receipt';

import {
  BRIDGE_DELIVERY_TIMED_OUT,
  BRIDGE_RECEIVE_MAX_AGE_MS,
  registerPendingBridgeIn,
  resolveBridgeInNoteId
} from './bridge-in';
import { withinDeliveryWindow } from './bridge-receive-window';
import { IBridgedReceiveExtraInputs, ITransaction, IUsdcxCctpLeg } from '../db/types';
import { updateBridgedReceivePhase } from '../transaction/complete';

const SUBMISSION_LOCK = 'bridge-receive-submission';
const INTERRUPTED_BEFORE_HASH = 'Bridge submission was interrupted before a transaction hash was recorded.';

/**
 * A restored bridge row's delivery cannot be confirmed: the tracking state that
 * would resume it lives outside the dump, and the row's own contents are only as
 * trustworthy as the file they came from. If the bridged note really did land,
 * normal sync surfaces it on its own — this row is just the tracker.
 */
const RESTORED_BRIDGE_UNVERIFIABLE = 'Restored from a backup — delivery could not be verified.';

export interface BridgeReceiveLockManager {
  request(
    name: string,
    options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
    callback: (lock: object | null) => Promise<void>
  ): Promise<void>;
}

const getNavigatorLocks = (): BridgeReceiveLockManager | undefined =>
  typeof navigator === 'undefined' ? undefined : navigator.locks;

function sameHash(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function firstString(source: unknown, key: string): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const value: unknown = Reflect.get(source, key);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function reconcileAgglayerRow(
  row: ITransaction,
  inputs: IBridgedReceiveExtraInputs,
  orphanCheck: BridgeOrphanCheck
): Promise<void> {
  if (!inputs.evmTxHash) {
    if (inputs.phase === 'submitting') {
      await updateBridgedReceivePhase(row.id, 'failed', {
        error: INTERRUPTED_BEFORE_HASH,
        failure: { step: 'submission_interrupted', orphanCheck }
      });
    }
    return;
  }

  if (inputs.phase === 'submitting') {
    // A row saved before its route was is from DEFAULT_CHAIN_ID.
    const chainId = inputs.agglayerRoute?.chainId ?? inputs.sourceChainId ?? DEFAULT_CHAIN_ID;
    const chain = EVM_CHAIN_DEFINITIONS.find(candidate => candidate.id === chainId);
    if (!chain || !isHash(inputs.evmTxHash)) {
      console.warn('[bridge-receive] AggLayer receipt not readable', row.id);
      return;
    }
    // Only a confirmed revert fails the row: a failed row leaves reconciliation for good, so a deposit that
    // lands after an unreadable receipt would stay Failed. The delivery window bounds a dropped transaction.
    let outcome: Awaited<ReturnType<typeof readEvmReceiptOutcome>>;
    try {
      outcome = await readEvmReceiptOutcome(inputs.evmTxHash, chain);
    } catch (error) {
      console.warn('[bridge-receive] AggLayer receipt read failed', row.id, error);
      return;
    }
    if (outcome === 'pending') return;
    if (outcome === 'reverted') {
      const revert = new EvmTransactionRevertedError(chain.name);
      await updateBridgedReceivePhase(row.id, 'failed', {
        error: revert.message,
        failure: { step: 'reconciler_receipt', cause: revert }
      });
      return;
    }
    await updateBridgedReceivePhase(row.id, 'delivering');
  }

  try {
    const deposits = await fetchDeposits(midenAddrToEvmAddr(row.accountId), undefined, inputs.agglayerRoute);
    const deposit = deposits.find(candidate => sameHash(candidate.tx_hash, inputs.evmTxHash!));
    if (deposit && isAgglayerDepositReady(deposit)) {
      await updateBridgedReceivePhase(row.id, 'ready');
    }
  } catch (error) {
    // Indexer outages are transient. Leave the row pending so the next tick can
    // retry instead of incorrectly failing delivery.
    console.warn('[bridge-receive] AggLayer status poll failed', row.id, error);
  }
}

async function reconcileEpochRow(
  row: ITransaction,
  inputs: IBridgedReceiveExtraInputs,
  orphanCheck: BridgeOrphanCheck
): Promise<void> {
  if (!inputs.intentNonce) {
    if (inputs.phase === 'submitting') {
      await updateBridgedReceivePhase(row.id, 'failed', {
        error: 'Bridge submission was interrupted before an intent was recorded.',
        failure: { step: 'submission_interrupted', orphanCheck }
      });
    }
    return;
  }

  await registerPendingBridgeIn(inputs.sourceAddress, inputs.intentNonce, {
    provider: 'epoch',
    sourceAmount: inputs.sourceAmount,
    sourceSymbol: inputs.sourceSymbol,
    intentNonce: inputs.intentNonce,
    evmTxHash: inputs.evmTxHash,
    bridgeReceiveTxId: row.id,
    epochAllocatorUrl: inputs.epochAllocatorUrl
  });

  try {
    const { getEpochReadOnlySdk } = await import('lib/epoch/sdk');
    const sdk = await getEpochReadOnlySdk(inputs.sourceAddress as `0x${string}`, inputs.epochAllocatorUrl);
    const results = await readEpochIntentStatus(sdk, inputs.sourceAddress, inputs.intentNonce);
    const noteId = results.map(result => firstString(result, 'midenNoteId')).find(Boolean);
    if (noteId) await resolveBridgeInNoteId(inputs.sourceAddress, inputs.intentNonce, noteId);
    const midenLeg = results.find(result => result.chainId === MIDEN_DESTINATION_CHAIN_ID);
    if (midenLeg && midenLeg.status.toLowerCase() === 'failed') {
      await updateBridgedReceivePhase(row.id, 'failed', {
        error: 'The Epoch bridge intent failed.',
        failure: { step: 'epoch_intent_failed' }
      });
    }
  } catch (error) {
    console.warn('[bridge-receive] Epoch reconcile poll failed', row.id, error);
  }
}

const USDCX_MISMATCH_ERRORS: Record<UsdcxAttestationMismatchField, string> = {
  remoteDomain: 'Circle attested this deposit to a different network.',
  remoteToken: 'Circle attested this deposit to a different token.',
  recipient: 'Circle attested this deposit to a different Miden account.',
  amount: 'Circle attested this deposit to a different amount.'
};

const USDCX_MISMATCH_STEPS: Record<UsdcxAttestationMismatchField, BridgeReceiveFailureStep> = {
  remoteDomain: 'usdcx_mismatch_domain',
  remoteToken: 'usdcx_mismatch_token',
  recipient: 'usdcx_mismatch_recipient',
  amount: 'usdcx_mismatch_amount'
};

const warnedUsdcxRows = new Set<string>();

// Once per row and reason: the watcher polls every 8 s and the verdict it reports does not change.
function warnUsdcxRowOnce(rowId: string, reason: string, detail?: unknown): void {
  const key = `${rowId}:${reason}`;
  if (warnedUsdcxRows.has(key)) return;
  warnedUsdcxRows.add(key);
  console.warn(`[bridge-receive] USDCx ${reason}`, rowId, detail);
}

/**
 * What the deposit signed: the recipient its writer persisted, else the one its account derives, as the deposit screen
 * derived it, so a row written before the recipient was kept still settles. Undefined when the row names no faucet or
 * amount, or its account is no account id.
 */
function usdcxExpectationOf(
  row: ITransaction,
  inputs: IBridgedReceiveExtraInputs
): UsdcxDepositExpectation | undefined {
  if (row.faucetId === undefined || row.amount === undefined) return undefined;
  try {
    const signed = inputs.usdcxRemoteRecipient;
    return {
      remoteRecipient: signed !== undefined && isHash(signed) ? signed : usdcxRemoteRecipientFor(row.accountId),
      remoteToken: usdcxExpectedRemoteTokenFor(row.faucetId),
      amount: row.amount
    };
  } catch (error) {
    warnUsdcxRowOnce(row.id, 'deposit has no readable recipient or token', error);
    return undefined;
  }
}

/** Circle's verdict on the xReserve deposit `txHash` against what the row signed; undefined with nothing to ask. */
async function matchUsdcxDeposit(
  row: ITransaction,
  inputs: IBridgedReceiveExtraInputs,
  txHash: string | undefined,
  attestationApi: string | undefined
): Promise<UsdcxAttestationMatch | undefined> {
  if (txHash === undefined || !isHash(txHash)) return undefined;
  const expected = usdcxExpectationOf(row, inputs);
  if (expected === undefined) return undefined;
  return matchUsdcxDepositAttestation(await fetchXReserveAttestations(txHash, { baseUrl: attestationApi }), {
    ...expected,
    remoteDomain: inputs.usdcxMidenDomain
  });
}

/**
 * Circle's attestation of what the wallet signed proves the deposit, so the row becomes `ready`: Activity shows it as
 * Confirmed. An attestation of anything else fails the row, naming what differs. A row that has its hash but lost its
 * screen before the source-chain receipt settles the same way. The consume of the minted note then moves the row to
 * `received` (`takeUsdcxBridgeInInfo`).
 */
async function reconcileUsdcxRow(
  row: ITransaction,
  inputs: IBridgedReceiveExtraInputs,
  orphanCheck: BridgeOrphanCheck
): Promise<void> {
  // Reached only once no flow holds the submission: with no hash, nothing can ever move the row on.
  if (inputs.phase === 'submitting' && !inputs.evmTxHash) {
    await updateBridgedReceivePhase(row.id, 'failed', {
      error: INTERRUPTED_BEFORE_HASH,
      failure: { step: 'submission_interrupted', orphanCheck, sourceRoute: recordedSourceRoute(inputs) }
    });
    return;
  }
  const source =
    inputs.usdcxSource ??
    (inputs.sourceChainId === undefined ? undefined : usdcxSourceChains().get(inputs.sourceChainId));
  try {
    if (source?.route === 'cctp-executor') {
      await reconcileUsdcxExecutorRow(row, inputs, source);
      return;
    }
    // A legacy Sepolia row has no source chain and reads the testnet service, the attestation default.
    const verdict = await matchUsdcxDeposit(row, inputs, inputs.evmTxHash, source?.attestationApi);
    switch (verdict?.kind) {
      case 'attested':
        await updateBridgedReceivePhase(row.id, 'ready');
        return;
      case 'mismatch':
        await updateBridgedReceivePhase(row.id, 'failed', {
          error: USDCX_MISMATCH_ERRORS[verdict.field],
          failure: { step: USDCX_MISMATCH_STEPS[verdict.field] }
        });
        return;
      case 'unreadable':
        warnUsdcxRowOnce(row.id, 'attestation unreadable', inputs.evmTxHash);
        return;
      default:
        return;
    }
  } catch (error) {
    console.warn('[bridge-receive] USDCx attestation poll failed', row.id, error);
  }
}

/** A leg that holds the message to execute again, whose hash has been unmined for the whole stall window. */
function executeStalled(row: ITransaction, leg: IUsdcxCctpLeg): boolean {
  if (leg.message === undefined || leg.attestation === undefined) return false;
  // A hash saved before the stamp existed is timed from the deposit, which only ever reopens it sooner.
  const savedAt = leg.executeSavedAt ?? row.initiatedAt;
  return Math.floor(Date.now() / 1000) - savedAt >= USDCX_EXECUTE_STALL_SEC;
}

/**
 * An executor-route deposit has two Circle attestations. First Iris attests the CCTP burn. A forwarded burn
 * is then executed on Arc by Circle, and the reconciler waits for the forward transaction hash; a forward
 * Circle gave up on, or a burn made before every burn was forwarded, keeps the attested message on the row,
 * where the status screen and Activity offer the execute. Once an Arc transaction hash is on the row, from either side, the reconciler
 * asks xReserve's attestation service for it, which is the deposit, and the row becomes `ready` as a direct
 * deposit would. An Arc execute that reverted, seen here or by the foreground hook, or that stayed unmined past
 * the stall window, reopens the leg for the wallet to execute, and its hash is never adopted again.
 */
async function reconcileUsdcxExecutorRow(
  row: ITransaction,
  inputs: IBridgedReceiveExtraInputs,
  source: UsdcxExecutorSource
): Promise<void> {
  const leg = inputs.cctp;
  if (!leg) return;
  const { target } = source;
  if (leg.executeTxHash) {
    const verdict = await matchUsdcxDeposit(row, inputs, leg.executeTxHash, target.attestationApi);
    if (verdict?.kind === 'attested') {
      await updateBridgedReceivePhase(row.id, 'ready');
      return;
    }
    // The hash can be a forward Iris reported rather than a transaction this wallet signed: a mismatch only warns.
    if (verdict?.kind === 'mismatch' || verdict?.kind === 'unreadable') {
      warnUsdcxRowOnce(row.id, `execute attestation ${verdict.kind}`, leg.executeTxHash);
      return;
    }
    if (!isHash(leg.executeTxHash)) return;
    // The foreground hook sees a revert only while its screen is open.
    const outcome = await readEvmReceiptOutcome(leg.executeTxHash, target.chain);
    if (outcome === 'reverted') {
      await updateBridgedReceivePhase(row.id, 'delivering', {
        cctp: revertedExecuteLeg(leg.sourceDomain, leg.executeTxHash)
      });
    } else if (outcome === 'pending' && executeStalled(row, leg)) {
      await updateBridgedReceivePhase(row.id, 'delivering', {
        cctp: stalledExecuteLeg(leg.sourceDomain, leg.executeTxHash)
      });
    }
    return;
  }
  // A stalled execute can still mine, and its deposit then lands the row.
  if (leg.stalledExecuteTxHash) {
    const verdict = await matchUsdcxDeposit(row, inputs, leg.stalledExecuteTxHash, target.attestationApi);
    if (verdict?.kind === 'attested') {
      await updateBridgedReceivePhase(row.id, 'ready');
      return;
    }
  }
  if (leg.attestation && !leg.forwarded) return;
  const attested = await fetchAttestedCctpMessage(leg.sourceDomain, inputs.evmTxHash, { baseUrl: source.irisApi });
  if (!attested) return;
  const forwardTxHash = attested.forwardTxHash;
  const forwardRefused =
    forwardTxHash !== undefined &&
    [leg.revertedExecuteTxHash, leg.stalledExecuteTxHash].some(
      hash => hash !== undefined && sameHash(forwardTxHash, hash)
    );
  if (attested.forwardTxHash && !forwardRefused) {
    await updateBridgedReceivePhase(
      row.id,
      'delivering',
      {
        cctp: {
          sourceDomain: leg.sourceDomain,
          executeTxHash: attested.forwardTxHash,
          forwardState: attested.forwardState
        }
      },
      undefined,
      { onlyIfNoExecuteHash: true }
    );
    return;
  }
  if (leg.forwarded && !isCctpForwardFailed(attested.forwardState)) {
    if (attested.forwardState !== leg.forwardState) {
      await updateBridgedReceivePhase(row.id, 'delivering', {
        cctp: { sourceDomain: leg.sourceDomain, forwardState: attested.forwardState }
      });
    }
    return;
  }
  if (leg.attestation) return;
  await updateBridgedReceivePhase(row.id, 'delivering', {
    cctp: {
      sourceDomain: leg.sourceDomain,
      message: attested.message,
      attestation: attested.attestation,
      forwardState: attested.forwardState
    }
  });
}

// Only the route the row itself recorded, never one the current config would pick for its chain.
function recordedSourceRoute(inputs: IBridgedReceiveExtraInputs): BridgeSourceRoute {
  const route: unknown = inputs.usdcxSource?.route;
  if (route === 'xreserve') return 'xreserve';
  return route === 'cctp-executor' ? 'cctp_executor' : 'unrecorded';
}

async function reconcileRow(
  row: ITransaction,
  cutoffSec: number,
  resumeOrphans: boolean,
  orphanCheck: BridgeOrphanCheck
): Promise<void> {
  const inputs: IBridgedReceiveExtraInputs | undefined = row.extraInputs;
  if (inputs === undefined || inputs.provider === 'near-intents') return;
  // Terminalize rather than skip. Resuming would register a pending bridge-in
  // for the dump's `sourceAddress` and drive the incoming-funds UI off it with
  // no user action - but merely skipping strands the row: these rows are born
  // `Completed` with their lifecycle in `extraInputs.phase`, and the only other
  // writers of that phase are driven by the pending-bridge-in registry, which
  // lives in platform storage and does NOT travel in the dump. The row would
  // read "Delivering" forever and keep suppressing its linked consume row.
  if (row.restoredFromBackup) {
    await updateBridgedReceivePhase(row.id, 'failed', { error: RESTORED_BRIDGE_UNVERIFIABLE });
    return;
  }
  if (inputs.sourceSubmission === 'attempted' && !inputs.evmTxHash && !inputs.intentNonce) return;
  if (!withinDeliveryWindow(row, inputs, cutoffSec)) {
    await updateBridgedReceivePhase(row.id, 'failed', {
      error: BRIDGE_DELIVERY_TIMED_OUT,
      failure: { step: 'delivery_timed_out' }
    });
    return;
  }
  // Circle already attested a ready row; only its mint's consume moves it on.
  if (inputs.phase === 'ready') return;
  if (inputs.phase === 'submitting' && !resumeOrphans) return;

  switch (inputs.provider) {
    case 'agglayer':
      await reconcileAgglayerRow(row, inputs, orphanCheck);
      return;
    case 'usdcx':
      await reconcileUsdcxRow(row, inputs, orphanCheck);
      return;
    case 'epoch':
      await reconcileEpochRow(row, inputs, orphanCheck);
      return;
    default:
      return;
  }
}

async function readUnsettledRows(): Promise<ITransaction[]> {
  return Repo.transactions
    .where('type')
    .equals('bridged-receive')
    .filter(tx => {
      // Optional-chained: a throw in here rejects the whole `toArray()`, which
      // this function's only caller swallows - so one legacy or partially
      // written row without `extraInputs` would silently disable reconciliation
      // for every genuine row, on every tick.
      const inputs: IBridgedReceiveExtraInputs | undefined = tx.extraInputs;
      if (
        inputs === undefined ||
        inputs.provider === 'near-intents' ||
        inputs.phase === 'received' ||
        inputs.phase === 'failed'
      )
        return false;
      // A ready USDCx row stays for the cutoff alone: no consume tagged it, so it could otherwise read Confirmed
      // forever. A restored one is left out, since reading it would fail it.
      if (inputs.phase === 'ready') return inputs.provider === 'usdcx' && tx.restoredFromBackup !== true;
      return true;
    })
    .toArray();
}

/**
 * A deposit screen creates its `bridged-receive` row in phase `submitting` before
 * the EVM wallet signs, and writes the hash (AggLayer) or intent nonce (Epoch)
 * only afterwards. Such a row is an orphan only when the flow that created it is
 * gone, so the flow holds `bridge-receive-submission` in shared mode while it
 * drives the row, and a reconcile pass reads its rows under the same lock taken
 * exclusively with `ifAvailable`: rows read while no flow holds it cannot have a
 * live owner. Web Locks span every page of the origin and are released when a
 * page dies. Without them an in-realm counter stands in for the same rule.
 */
export function createBridgeReceiveReconciler({
  getLocks = getNavigatorLocks
}: {
  getLocks?: () => BridgeReceiveLockManager | undefined;
} = {}) {
  let liveSubmissions = 0;
  let startedSubmissions = 0;

  /** Resolves with the new row's id as soon as `create` returns it; the lock is held until `drive` settles. */
  function startSubmission(create: () => Promise<string>, drive: (txId: string) => Promise<void>): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const run = async () => {
        let txId: string;
        try {
          txId = await create();
        } catch (error) {
          reject(error);
          return;
        }
        resolve(txId);
        try {
          await drive(txId);
        } catch (error) {
          console.error('[bridge-receive] deposit submission failed', error);
        }
      };

      const locks = getLocks();
      if (locks) {
        locks.request(SUBMISSION_LOCK, { mode: 'shared' }, run).catch(reject);
        return;
      }
      liveSubmissions += 1;
      startedSubmissions += 1;
      void run().finally(() => {
        liveSubmissions -= 1;
      });
    });
  }

  interface RowsRead {
    rows: ITransaction[];
    resumeOrphans: boolean;
    orphanCheck: BridgeOrphanCheck;
  }

  async function readRows(): Promise<RowsRead> {
    const locks = getLocks();
    if (locks) {
      let read: RowsRead = { rows: [], resumeOrphans: false, orphanCheck: 'origin_lock' };
      await locks.request(SUBMISSION_LOCK, { ifAvailable: true }, async lock => {
        read = { rows: await readUnsettledRows(), resumeOrphans: lock !== null, orphanCheck: 'origin_lock' };
      });
      return read;
    }
    // A flow that was live at the start, or started during the read, may have
    // written after its row was read, so only a quiet read resumes orphans.
    const idle = liveSubmissions === 0;
    const started = startedSubmissions;
    const rows = await readUnsettledRows();
    return {
      rows,
      resumeOrphans: idle && liveSubmissions === 0 && startedSubmissions === started,
      orphanCheck: 'realm_idle'
    };
  }

  /**
   * Poll every unsettled EVM→Miden row once, for both providers, without ever
   * queueing a Miden transaction. The app-root `BridgeIntentWatcher` runs this on
   * an interval; keeping the operation one-shot prevents hidden background
   * timers, and one read per pass keeps the tick to a single query of the `type`
   * index.
   */
  async function reconcile(): Promise<void> {
    // The watcher's first pass can run before this realm read its stored copy, and a row with no saved route is
    // classified (and timed out) by the document; from storage, never the network.
    await initBridgeConfig();
    const { rows, resumeOrphans, orphanCheck } = await readRows();
    const cutoffSec = Math.floor((Date.now() - BRIDGE_RECEIVE_MAX_AGE_MS) / 1000);

    // All at once: each row waits only on its own provider, so a slow receipt or a timed-out status read never delays
    // another row. Each row writes only itself, and registry writes take the registry lock.
    await Promise.all(
      rows.map(row =>
        reconcileRow(row, cutoffSec, resumeOrphans, orphanCheck).catch((error: unknown) => {
          // One row's failing write or registry call must not end the pass for the other rows.
          console.warn('[bridge-receive] reconcile failed', row.id, row.extraInputs?.provider, error);
        })
      )
    );
  }

  return { startSubmission, reconcile };
}

const reconciler = createBridgeReceiveReconciler();
export const startBridgeReceiveSubmission = reconciler.startSubmission;
export const reconcileBridgedReceives = reconciler.reconcile;
