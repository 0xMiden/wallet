import { EpochIntentSDK, TaskType, ActionType } from '@epoch-protocol/epoch-intents-sdk';
import { v4 } from 'uuid';
import { type Address, parseUnits } from 'viem';
import { sepolia } from 'viem/chains';

import {
  findPendingBridgeInByEarnWithdrawTxId,
  initiateEarnWithdrawTransaction,
  registerPendingBridgeIn,
  resolveBridgeInNoteId,
  updateEarnWithdrawPhase,
  prepareEarnWithdrawExecution,
  markEarnWithdrawNotSent,
  markEarnWithdrawAccepted
} from 'lib/miden/activity';
import {
  ITransactionStatus,
  type IBridgeInInfo,
  type IEarnWithdrawPreparedExecution,
  type ITransaction
} from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { getNativeAssetId } from 'lib/miden-chain/native-asset';

import { normalizeMidenIdToHex } from './bridge';
import { BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS } from './bridgeable-token';
import { EPOCH_ALLOCATOR_URL, MIDEN_DESTINATION_CHAIN_ID } from './config';
import { EARN_PROTOCOL_HASH, EARN_UNDERLYING, resolveEarnIntentOutcome } from './earn';
import { tryWithEarnSubmissionLock, withEarnSubmissionLock } from './earn-submission-lock';
import {
  earnWithdrawalRetryKind,
  earnWithdrawExecutionIdentity,
  hasEarnWithdrawRecoveryWork,
  selectEarnWithdrawPreparedExecution,
  validateEarnWithdrawPreparedExecution
} from './earn-withdraw-policy';
import { buildVaultEvmWalletClient } from './evm-account';
import { isEvmAddress } from './evm-address';
import {
  earnWithdrawPollKey,
  effectiveWithdrawAttemptId,
  isEarnWithdrawalStale,
  matchesEarnWithdrawIntent,
  type ExpectedEarnWithdrawIntent
} from './intent-key';
import { startIntentPoll } from './poll-registry';
import { getEpochReadOnlySdk, ensureEpochSmartAccount } from './sdk';

/** Non-terminal `earn-withdraw` phases the reconciler resumes; terminal ones are skipped. */
const NON_TERMINAL_WITHDRAW_PHASES = new Set(['redeeming', 'delivering']);

/** Shown when a restored row is refused: its EVM owner and amount are unverified. */
const RESTORED_WITHDRAW_UNVERIFIABLE = 'Restored from a backup - this withdrawal could not be verified.';

export interface GaslessEarnWithdrawalArgs {
  midenAccountPublicKey: string;
  evmAddress: string;
  marketUid: string;
  underlyingAddress: string;
  /** Human-decimal withdrawable amount returned by the positions API. */
  amount: string;
  underlyingDecimals: number;
  /** Fired once the tracking `earn-withdraw` row exists (before the intent work),
   * so the caller can navigate to the generating-transaction screen, matching
   * `openEarnPosition`'s callback. */
  onRowCreated?: (txId: string) => void;
}

export interface GaslessEarnWithdrawalResult {
  /** id of the tracking `earn-withdraw` row created for this withdrawal. */
  txId: string;
  /** Epoch intent nonce driving delivery polling. */
  nonce: string;
  gaslessUsed: boolean;
}

interface GaslessEarnWithdrawalDeps {
  sdk?: EpochIntentSDK;
  prepareExecution?: typeof prepareEarnWithdrawExecution;
  markNotSent?: typeof markEarnWithdrawNotSent;
  markAccepted?: typeof markEarnWithdrawAccepted;
  ensureSmartAccount?: typeof ensureEpochSmartAccount;
  registerBridgeIn?: typeof registerPendingBridgeIn;
  initiateRow?: typeof initiateEarnWithdrawTransaction;
  updatePhase?: typeof updateEarnWithdrawPhase;
  /** Injectable delivery poller (tests pass a no-op). */
  startDeliveryPoll?: typeof pollEarnWithdrawDelivery;
  withSubmissionLock?: typeof withEarnSubmissionLock;
}

function asAddress(value: string, label: string): Address {
  if (!isEvmAddress(value)) throw new Error(`${label} is not a valid EVM address.`);
  return value;
}

function parseWithdrawAmount(value: string, decimals: number): bigint {
  const match = value.trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error('Withdraw amount is invalid.');
  const fraction = (match[2] ?? '').slice(0, decimals);
  return parseUnits(fraction ? `${match[1]}.${fraction}` : match[1]!, decimals);
}

/** Read the untyped `midenNoteId` field the allocator includes on EVM→Miden status entries. */
function extractMidenNoteId(results: unknown[]): string | undefined {
  for (const result of results) {
    if (!result || typeof result !== 'object') continue;
    const value: unknown = Reflect.get(result, 'midenNoteId');
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** Build the direct lending-protocol withdrawal task (retained for reference / non-gasless path). */
export function buildEarnWithdrawTaskDataParams(args: {
  sponsorAddress: Address;
  marketUid: string;
  underlyingAddress: Address;
  amountAtomic: string;
  chainId: number;
}) {
  return {
    taskType: TaskType.ProtocolInteraction,
    intentData: {
      isNative: false,
      depositTokenAddress: args.underlyingAddress,
      tokenInAmount: args.amountAtomic,
      outputTokenAddress: args.underlyingAddress,
      minTokenOut: '0',
      destinationChainId: String(args.chainId),
      protocolHashIdentifier: EARN_PROTOCOL_HASH,
      recipient: args.sponsorAddress
    },
    extraDataTypestring: 'string marketUid,string action,string payAsset,bool isAll,bool simulate',
    extraData: {
      marketUid: args.marketUid,
      action: 'withdraw',
      payAsset: args.underlyingAddress,
      isAll: false,
      simulate: true
    }
  };
}

/** Submit one withdrawal attempt while recovery can observe its active ownership. */
export async function gaslessEarnWithdrawalToMiden(
  args: GaslessEarnWithdrawalArgs,
  deps: GaslessEarnWithdrawalDeps = {}
): Promise<GaslessEarnWithdrawalResult> {
  const sponsorAddress = asAddress(args.evmAddress, 'Position owner');
  const underlyingAddress = asAddress(args.underlyingAddress, 'Underlying token');
  const midenRecipientHex = normalizeMidenIdToHex(args.midenAccountPublicKey);
  if (!args.midenAccountPublicKey) throw new Error('A Miden destination account is required.');
  if (!args.marketUid) throw new Error('The lending market identifier is missing.');
  if (
    underlyingAddress.toLowerCase() !== EARN_UNDERLYING.toLowerCase() ||
    args.underlyingDecimals !== BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS
  ) {
    throw new Error('Gasless withdrawal only supports the configured USDC Earn market.');
  }
  const chainId = Number(args.marketUid.split(':')[1]);
  if (chainId !== sepolia.id) throw new Error('Gasless withdrawal currently supports Sepolia only.');
  const amountAtomic = parseWithdrawAmount(args.amount, args.underlyingDecimals);
  if (amountAtomic <= 0n) throw new Error('Withdraw amount must be greater than zero.');

  const initiateRow = deps.initiateRow ?? initiateEarnWithdrawTransaction;
  const startDeliveryPoll = deps.startDeliveryPoll ?? pollEarnWithdrawDelivery;
  const withSubmissionLock = deps.withSubmissionLock ?? withEarnSubmissionLock;
  const destinationFaucetId = await getNativeAssetId();
  const attemptId = v4();
  const attemptStartedAt = Math.floor(Date.now() / 1000);

  return withSubmissionLock(attemptId, async context => {
    const assertCurrent = () => {
      if (!context.isCurrent()) throw new Error('Withdrawal submission was interrupted.');
    };
    assertCurrent();
    const txId = await initiateRow(
      args.midenAccountPublicKey,
      amountAtomic,
      sponsorAddress,
      args.marketUid,
      destinationFaucetId,
      args.amount,
      'USDC',
      attemptId,
      attemptStartedAt
    );
    assertCurrent();
    args.onRowCreated?.(txId);
    const expected: ExpectedEarnWithdrawIntent = { owner: sponsorAddress, attemptId };
    let preparedExecution: IEarnWithdrawPreparedExecution | undefined;
    let executionPermitted = false;
    const bridgeInfo = (nonce: string): IBridgeInInfo => ({
      provider: 'epoch',
      sourceAmount: args.amount,
      sourceSymbol: 'USDC',
      intentOwner: sponsorAddress,
      intentNonce: nonce,
      earnWithdrawTxId: txId,
      earnWithdrawAttemptId: attemptId
    });
    const startRecovery = () => {
      if (!context.isCurrent() || !preparedExecution) return;
      startDeliveryPoll({
        sponsorAddress,
        nonce: preparedExecution.delivery.nonce,
        txId,
        attemptId,
        immediate: true,
        bridgeInfo: bridgeInfo(preparedExecution.delivery.nonce)
      });
    };
    try {
      const ensureSmartAccount = deps.ensureSmartAccount ?? ensureEpochSmartAccount;
      await ensureSmartAccount(args.midenAccountPublicKey, sponsorAddress);
      assertCurrent();
      const walletClient = buildVaultEvmWalletClient(args.midenAccountPublicKey, sponsorAddress);
      const sdk =
        deps.sdk ??
        new EpochIntentSDK({ apiBaseUrl: EPOCH_ALLOCATOR_URL, walletClient, allowGaslessSmartAccount: true });
      const status = await sdk.getWalletGaslessStatus(chainId);
      assertCurrent();
      if (!status.is7702Capable) throw new Error('Wallet/chain is not 7702-capable for a gasless withdrawal.');
      if (status.needsSetup) {
        const setup = await sdk.convertToSmartAccount({ chainId });
        assertCurrent();
        if (!setup.ok) throw new Error('Smart-account conversion failed for the gasless withdrawal.');
      }
      await sdk.helpers.executeActions({
        action: ActionType.Withdraw,
        underlying: underlyingAddress,
        amount: amountAtomic.toString(),
        protocol: 'dummy-lending',
        swapAndBridge: {
          toToken: normalizeMidenIdToHex(destinationFaucetId),
          toChainId: MIDEN_DESTINATION_CHAIN_ID,
          recipient: midenRecipientHex
        },
        gasless: true,
        onBeforeExecute: async execution => {
          assertCurrent();
          if (executionPermitted) throw new Error('Withdrawal execution was already permitted.');
          const identity = {
            owner: sponsorAddress,
            attemptId,
            sourceChainId: chainId,
            destinationChainId: MIDEN_DESTINATION_CHAIN_ID,
            recipientAccountId: args.midenAccountPublicKey,
            destinationFaucetId
          };
          const selected = selectEarnWithdrawPreparedExecution(execution, identity);
          if (!selected) throw new Error('The prepared withdrawal does not match its destination.');
          preparedExecution = selected;
          const prepareExecution = deps.prepareExecution ?? prepareEarnWithdrawExecution;
          if (!(await prepareExecution(txId, selected, expected, context.isCurrent)))
            throw new Error('The withdrawal preparation could not be saved.');
          assertCurrent();
          const fresh = await Repo.transactions.where({ id: txId }).first();
          assertCurrent();
          if (
            !fresh ||
            fresh.restoredFromBackup ||
            fresh.status !== ITransactionStatus.Completed ||
            !NON_TERMINAL_WITHDRAW_PHASES.has(fresh.extraInputs?.phase) ||
            !matchesEarnWithdrawIntent(fresh, expected) ||
            fresh.extraInputs.withdrawIntentNonce !== selected.delivery.nonce ||
            (fresh.extraInputs.submissionState !== 'prepared' && fresh.extraInputs.submissionState !== 'accepted') ||
            !matchesPreparedExecution(fresh, selected)
          )
            throw new Error('The saved withdrawal preparation could not be verified.');
          if (
            selected.allocations.some(allocation => BigInt(allocation.expires) <= BigInt(Math.floor(Date.now() / 1000)))
          )
            throw new Error('The prepared withdrawal expired before execution.');
          executionPermitted = true;
        }
      });
      assertCurrent();
      if (!executionPermitted || !preparedExecution)
        throw new Error('The SDK did not prepare the withdrawal before execution.');
      const markAccepted = deps.markAccepted ?? markEarnWithdrawAccepted;
      await markAccepted(txId, { ...expected, nonce: preparedExecution.delivery.nonce }, context.isCurrent).catch(
        (error: unknown) => console.warn('[earn-withdraw] acceptance patch failed', error)
      );
    } catch (error) {
      if (!executionPermitted && context.isCurrent()) {
        const markNotSent = deps.markNotSent ?? markEarnWithdrawNotSent;
        await markNotSent(
          txId,
          error instanceof Error ? error.message : String(error),
          expected,
          preparedExecution,
          () => context.isCurrent() && !executionPermitted
        ).catch((failure: unknown) => console.warn('[earn-withdraw] not-sent patch failed', failure));
      }
      if (executionPermitted) startRecovery();
      throw error;
    }
    assertCurrent();
    if (!preparedExecution) throw new Error('The withdrawal preparation is missing.');
    const nonceString = preparedExecution.delivery.nonce;
    // The poll owns metadata repair independently from status checking.
    startRecovery();
    return { txId, nonce: nonceString, gaslessUsed: true };
  });
}

interface DeliveryPollDeps {
  tryWithSubmissionLock?: typeof tryWithEarnSubmissionLock;
  getSdk?: typeof getEpochReadOnlySdk;
  markAccepted?: typeof markEarnWithdrawAccepted;
  updatePhase?: typeof updateEarnWithdrawPhase;
  resolveNoteId?: typeof resolveBridgeInNoteId;
  registerBridgeIn?: typeof registerPendingBridgeIn;
  startPoll?: typeof startIntentPoll;
}

async function liveWithdrawal(txId: string, expected: ExpectedEarnWithdrawIntent): Promise<ITransaction | undefined> {
  const row = await Repo.transactions.where({ id: txId }).first();
  return row?.type === 'earn-withdraw' &&
    !row.restoredFromBackup &&
    row.status === ITransactionStatus.Completed &&
    hasEarnWithdrawRecoveryWork(row) &&
    matchesEarnWithdrawIntent(row, expected)
    ? row
    : undefined;
}

function matchesPreparedExecution(row: ITransaction, captured: IEarnWithdrawPreparedExecution): boolean {
  const identity = earnWithdrawExecutionIdentity(row);
  const execution = identity && validateEarnWithdrawPreparedExecution(row.extraInputs?.preparedExecution, identity);
  return Boolean(execution && JSON.stringify(execution.preparedExecution) === JSON.stringify(captured));
}

const allocationLockKey = (attemptId: string, nonce: string): string => `allocation:${attemptId}:${nonce}`;

function positiveStatus(value: unknown): value is { chainId: number; status: string; transactionHash: string }[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      entry =>
        entry !== null &&
        typeof entry === 'object' &&
        Number.isSafeInteger(Reflect.get(entry, 'chainId')) &&
        typeof Reflect.get(entry, 'status') === 'string' &&
        Reflect.get(entry, 'status').length > 0 &&
        typeof Reflect.get(entry, 'transactionHash') === 'string'
    )
  );
}

/** Track delivery while independently repairing each exact prepared allocation. */
export function pollEarnWithdrawDelivery(args: {
  sponsorAddress: `0x${string}`;
  nonce: string;
  txId: string;
  attemptId?: string;
  bridgeInfo?: IBridgeInInfo;
  immediate?: boolean;
  intervalMs?: number;
  maxAttempts?: number;
  deps?: DeliveryPollDeps;
}): void {
  const { sponsorAddress, nonce, txId, intervalMs = 3000, maxAttempts = 100, immediate, deps = {} } = args;
  if (!isEvmAddress(sponsorAddress) || !nonce) return;
  const getSdk = deps.getSdk ?? getEpochReadOnlySdk;
  const updatePhase = deps.updatePhase ?? updateEarnWithdrawPhase;
  const resolveNoteId = deps.resolveNoteId ?? resolveBridgeInNoteId;
  const registerBridgeIn = deps.registerBridgeIn ?? registerPendingBridgeIn;
  const markAccepted = deps.markAccepted ?? markEarnWithdrawAccepted;
  const startPoll = deps.startPoll ?? startIntentPoll;
  const expected: ExpectedEarnWithdrawIntent = {
    owner: sponsorAddress,
    nonce,
    attemptId: effectiveWithdrawAttemptId(txId, args.attemptId)
  };
  let registered = args.bridgeInfo === undefined;
  let registrationInFlight = false;
  let registrationDue = 0;
  let registrationBackoff = 30_000;
  let acceptedWriteInFlight = false;
  let deliveryTerminal = false;
  let capturedExecution: IEarnWithdrawPreparedExecution | undefined;
  let states: { accepted: boolean; inFlight: boolean; failures: number; repairDue: number }[] | undefined;
  startPoll({
    key: earnWithdrawPollKey(sponsorAddress, nonce),
    intervalMs,
    maxAttempts,
    immediate,
    tick: async context => {
      const row = await liveWithdrawal(txId, expected);
      if (!context.isCurrent()) return;
      if (!row) {
        context.markTerminal();
        return;
      }
      const identity = earnWithdrawExecutionIdentity(row);
      const execution = identity && validateEarnWithdrawPreparedExecution(row.extraInputs.preparedExecution, identity);
      if (!execution && row.extraInputs.preparedExecution !== undefined) {
        context.markTerminal();
        return;
      }
      if (!registered && !registrationInFlight && args.bridgeInfo && Date.now() >= registrationDue) {
        registrationInFlight = true;
        void registerBridgeIn(sponsorAddress, nonce, args.bridgeInfo)
          .then(() => {
            if (context.isCurrent()) registered = true;
          })
          .catch((error: unknown) => console.warn('[earn-withdraw] bridge-in registration failed', error))
          .finally(() => {
            registrationInFlight = false;
            registrationDue = Date.now() + registrationBackoff;
            registrationBackoff = Math.min(registrationBackoff * 2, 300_000);
          });
      }
      const applyDelivery = async (results: { chainId: number; status: string; transactionHash: string }[]) => {
        if (!context.isCurrent()) return;
        const fresh = await liveWithdrawal(txId, expected);
        if (!context.isCurrent()) return;
        const { outcome, source } = resolveEarnIntentOutcome(results, MIDEN_DESTINATION_CHAIN_ID);
        if (outcome !== 'pending') deliveryTerminal = true;
        try {
          if (fresh && NON_TERMINAL_WITHDRAW_PHASES.has(fresh.extraInputs.phase)) {
            if (outcome === 'done') {
              const evmTxHash = source?.transactionHash || undefined;
              await updatePhase(txId, 'delivering', evmTxHash ? { evmTxHash } : undefined, undefined, expected);
            } else if (outcome === 'failed') {
              await updatePhase(
                txId,
                'failed',
                { error: 'The withdrawal intent failed on Epoch.' },
                undefined,
                expected
              );
            }
          }
        } finally {
          const noteId = extractMidenNoteId(results);
          if (context.isCurrent() && noteId)
            await resolveNoteId(sponsorAddress, nonce, noteId).catch((error: unknown) =>
              console.warn('[earn-withdraw] note resolution failed', error)
            );
        }
      };
      if (!execution) {
        const sdk = await getSdk(sponsorAddress);
        if (!context.isCurrent() || !(await liveWithdrawal(txId, expected)) || !context.isCurrent()) return;
        const results = await sdk.getIntentStatus(sponsorAddress, nonce);
        if (!context.isCurrent()) return;
        try {
          await applyDelivery(results);
        } finally {
          if (deliveryTerminal && registered) context.markTerminal();
        }
        return;
      }
      if (capturedExecution && !matchesPreparedExecution(row, capturedExecution)) {
        context.markTerminal();
        return;
      }
      capturedExecution = execution.preparedExecution;
      const selectedIndex = execution.preparedExecution.delivery.allocationIndex;
      if (execution.preparedExecution.delivery.nonce !== nonce) {
        context.markTerminal();
        return;
      }
      if (!states)
        states = execution.allocationRequests.map(() => ({
          accepted: row.extraInputs.submissionState === 'accepted',
          inFlight: false,
          failures: 0,
          repairDue: 0
        }));
      const allocationStates = states;
      const selectedState = allocationStates[selectedIndex];
      if (selectedState && row.extraInputs.phase === 'received' && row.extraInputs.midenNoteId)
        selectedState.accepted = true;
      const finishAcceptance = async () => {
        if (!context.isCurrent() || acceptedWriteInFlight || !allocationStates.every(state => state.accepted)) return;
        acceptedWriteInFlight = true;
        try {
          const fresh = await liveWithdrawal(txId, expected);
          if (!context.isCurrent() || !fresh || !matchesPreparedExecution(fresh, execution.preparedExecution)) return;
          if (
            fresh.extraInputs.submissionState !== 'accepted' &&
            !(await markAccepted(txId, expected, context.isCurrent))
          )
            return;
          if (!context.isCurrent()) return;
          if (
            (deliveryTerminal || fresh.extraInputs.phase === 'received' || fresh.extraInputs.phase === 'failed') &&
            registered
          )
            context.markTerminal();
        } finally {
          acceptedWriteInFlight = false;
        }
      };
      for (const [index, request] of execution.allocationRequests.entries()) {
        const state = allocationStates[index];
        if (!state || state.inFlight) continue;
        const selected = index === selectedIndex;
        if (!selected && (state.accepted || Date.now() < state.repairDue)) continue;
        if (selected && row.extraInputs.phase === 'received') continue;
        state.inFlight = true;
        void (async () => {
          const repairAttempted = !state.accepted && Date.now() >= state.repairDue;
          try {
            const sdk = await getSdk(sponsorAddress);
            if (!context.isCurrent() || !(await liveWithdrawal(txId, expected)) || !context.isCurrent()) return;
            let results: unknown;
            try {
              results = await sdk.getIntentStatus(request.compact.sponsor, request.compact.nonce);
            } catch (error) {
              console.warn('[earn-withdraw] allocation status failed', error);
            }
            if (!context.isCurrent()) return;
            if (positiveStatus(results)) {
              state.accepted = true;
              if (selected) await applyDelivery(results);
            }
            if (!context.isCurrent() || state.accepted || Date.now() < state.repairDue) return;
            const fresh = await liveWithdrawal(txId, expected);
            if (
              !context.isCurrent() ||
              !fresh ||
              !matchesPreparedExecution(fresh, execution.preparedExecution) ||
              (selected && fresh.extraInputs.phase === 'failed')
            )
              return;
            const tryWithAllocationLock = deps.tryWithSubmissionLock ?? tryWithEarnSubmissionLock;
            const result = await tryWithAllocationLock(
              allocationLockKey(expected.attemptId, request.compact.nonce),
              async lock => {
                const current = await liveWithdrawal(txId, expected);
                if (
                  !lock.isCurrent() ||
                  !context.isCurrent() ||
                  !current ||
                  !matchesPreparedExecution(current, execution.preparedExecution)
                )
                  return false;
                await sdk.retryIntentSolve(request);
                return lock.isCurrent() && context.isCurrent();
              }
            );
            if (context.isCurrent() && result.acquired && result.value) state.accepted = true;
          } catch (error) {
            console.warn('[earn-withdraw] allocation repair failed', error);
          } finally {
            state.inFlight = false;
            if (!state.accepted && repairAttempted) {
              state.repairDue = Date.now() + Math.min(30_000 * 2 ** state.failures, 300_000);
              state.failures += 1;
            }
            await finishAcceptance().catch((error: unknown) =>
              console.warn('[earn-withdraw] acceptance patch failed', error)
            );
          }
        })();
      }
      await finishAcceptance();
    }
  });
}

interface ResumeDeps extends DeliveryPollDeps {
  startDeliveryPoll?: typeof pollEarnWithdrawDelivery;
  findBridgeIn?: typeof findPendingBridgeInByEarnWithdrawTxId;
  tryWithSubmissionLock?: typeof tryWithEarnSubmissionLock;
}

/** Recover an interrupted attempt only after its submitting document releases ownership. */
export async function resumeEarnWithdrawal(txId: string, deps: ResumeDeps = {}): Promise<void> {
  const row = await Repo.transactions.where({ id: txId }).first();
  if (!row || !hasEarnWithdrawRecoveryWork(row)) return;
  const expected: ExpectedEarnWithdrawIntent = {
    owner: row.extraInputs.evmOwner,
    nonce: row.extraInputs.withdrawIntentNonce,
    attemptId: effectiveWithdrawAttemptId(txId, row.extraInputs.submissionAttemptId)
  };
  const updatePhase = deps.updatePhase ?? updateEarnWithdrawPhase;
  if (
    row.restoredFromBackup ||
    (!row.extraInputs.withdrawIntentNonce && !row.extraInputs.preparedExecution && isEarnWithdrawalStale(row))
  ) {
    await updatePhase(
      txId,
      'failed',
      { error: row.restoredFromBackup ? RESTORED_WITHDRAW_UNVERIFIABLE : 'Withdrawal timed out.' },
      undefined,
      row.restoredFromBackup ? undefined : expected
    );
    return;
  }
  const tryWithSubmissionLock = deps.tryWithSubmissionLock ?? tryWithEarnSubmissionLock;
  await tryWithSubmissionLock(expected.attemptId, async context => {
    const fresh = await Repo.transactions.where({ id: txId }).first();
    if (!context.isCurrent() || fresh?.type !== 'earn-withdraw' || fresh.restoredFromBackup) return;
    if (!hasEarnWithdrawRecoveryWork(fresh) || !matchesEarnWithdrawIntent(fresh, expected)) return;
    const ei = fresh.extraInputs;
    if (!isEvmAddress(ei.evmOwner)) {
      await updatePhase(
        txId,
        'failed',
        { error: 'Withdrawal was interrupted before it was submitted.' },
        undefined,
        expected
      );
      return;
    }
    let nonce = ei.withdrawIntentNonce;
    if (!nonce) {
      const findBridgeIn = deps.findBridgeIn ?? findPendingBridgeInByEarnWithdrawTxId;
      const pending = await findBridgeIn(txId, expected.attemptId);
      if (!context.isCurrent()) return;
      if (pending && pending.userAddress.toLowerCase() === ei.evmOwner.toLowerCase()) {
        nonce = pending.intentNonce;
        await updatePhase(txId, 'redeeming', { withdrawIntentNonce: nonce }, undefined, { ...expected, nonce }).catch(
          (error: unknown) => console.warn('[earn-withdraw] resume nonce re-persist failed', error)
        );
        if (!context.isCurrent()) return;
      }
    }
    if (!nonce) {
      await updatePhase(
        txId,
        'failed',
        { error: 'Withdrawal was interrupted before it was submitted.' },
        undefined,
        expected
      );
      return;
    }
    const startDeliveryPoll = deps.startDeliveryPoll ?? pollEarnWithdrawDelivery;
    startDeliveryPoll({
      sponsorAddress: ei.evmOwner,
      nonce,
      txId,
      attemptId: expected.attemptId,
      immediate: true,
      bridgeInfo: {
        provider: 'epoch',
        sourceAmount: ei.sourceAmount,
        sourceSymbol: ei.sourceSymbol,
        intentOwner: ei.evmOwner,
        intentNonce: nonce,
        earnWithdrawTxId: txId,
        earnWithdrawAttemptId: expected.attemptId
      },
      deps
    });
  });
}

/** Repair stale/restored rows locally before attempting any polling ownership. */
export async function reconcileEarnWithdrawals(deps: ResumeDeps = {}): Promise<void> {
  const rows = await Repo.transactions.filter(tx => tx.type === 'earn-withdraw').toArray();
  for (const row of rows) {
    if (!hasEarnWithdrawRecoveryWork(row)) continue;
    await resumeEarnWithdrawal(row.id, deps).catch((error: unknown) =>
      console.warn('[earn-withdraw] reconcile resume failed', error)
    );
  }
}

type ResubmitDeps = Omit<GaslessEarnWithdrawalDeps, 'initiateRow'>;

/** Retry with a new intent and attempt identity while keeping the existing history row. */
export async function resubmitEarnWithdrawal(txId: string, deps: ResubmitDeps = {}): Promise<void> {
  const row = await Repo.transactions.where({ id: txId }).first();
  if (row?.type !== 'earn-withdraw') throw new Error(`Transaction ${txId} is not an earn-withdraw`);
  if (row.restoredFromBackup) throw new Error(RESTORED_WITHDRAW_UNVERIFIABLE);
  const ei = row.extraInputs;
  if (earnWithdrawalRetryKind(row) !== 'source') return;
  if (!isEvmAddress(ei.evmOwner)) {
    throw new Error('This withdrawal has no valid position owner recorded - start a new withdrawal.');
  }
  if (!ei.marketUid || !ei.sourceAmount) {
    throw new Error('This withdrawal is missing the market details needed to retry - start a new withdrawal.');
  }
  const previous: ExpectedEarnWithdrawIntent = {
    owner: ei.evmOwner,
    nonce: ei.withdrawIntentNonce,
    attemptId: effectiveWithdrawAttemptId(txId, ei.submissionAttemptId)
  };
  await gaslessEarnWithdrawalToMiden(
    {
      midenAccountPublicKey: row.accountId,
      evmAddress: ei.evmOwner,
      marketUid: ei.marketUid,
      underlyingAddress: EARN_UNDERLYING,
      amount: ei.sourceAmount,
      underlyingDecimals: BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS
    },
    {
      ...deps,
      initiateRow: async (
        _account,
        _amount,
        _owner,
        _market,
        _faucet,
        _sourceAmount,
        _symbol,
        attemptId,
        startedAt
      ) => {
        if (!attemptId || startedAt === undefined) throw new Error('Withdrawal attempt identity is missing.');
        let claimed = false;
        await Repo.transactions.where({ id: txId }).modify(current => {
          if (
            current.type !== 'earn-withdraw' ||
            current.restoredFromBackup ||
            earnWithdrawalRetryKind(current) !== 'source' ||
            !matchesEarnWithdrawIntent(current, previous)
          ) {
            return;
          }
          current.extraInputs = {
            ...current.extraInputs,
            phase: 'redeeming',
            submissionState: 'preparing',
            preparedExecution: undefined,
            submissionAttemptId: attemptId,
            attemptStartedAt: startedAt,
            withdrawIntentNonce: undefined,
            evmTxHash: undefined,
            midenNoteId: undefined,
            outputAmount: undefined,
            outputSymbol: undefined,
            error: undefined
          };
          current.error = undefined;
          claimed = true;
        });
        if (!claimed) throw new Error('This withdrawal attempt is no longer available to retry.');
        return txId;
      }
    }
  );
}

type EarnWithdrawalRetryDeps = ResubmitDeps & ResumeDeps;

/** Retry only the operation permitted by the durable submission evidence. */
export async function retryEarnWithdrawal(txId: string, deps: EarnWithdrawalRetryDeps = {}): Promise<void> {
  const row = await Repo.transactions.where({ id: txId }).first();
  const kind = earnWithdrawalRetryKind(row);
  if (kind === 'source') {
    await resubmitEarnWithdrawal(txId, deps);
    return;
  }
  if (kind !== 'allocation' || !row) return;
  const expected: ExpectedEarnWithdrawIntent = {
    owner: row.extraInputs.evmOwner,
    nonce: row.extraInputs.withdrawIntentNonce,
    attemptId: effectiveWithdrawAttemptId(txId, row.extraInputs.submissionAttemptId)
  };
  const withSubmissionLock = deps.withSubmissionLock ?? withEarnSubmissionLock;
  await withSubmissionLock(expected.attemptId, async context => {
    let claimed: ITransaction | undefined;
    await Repo.transactions.where({ id: txId }).modify(current => {
      if (
        !context.isCurrent() ||
        earnWithdrawalRetryKind(current) !== 'allocation' ||
        !matchesEarnWithdrawIntent(current, expected)
      )
        return;
      current.extraInputs = { ...current.extraInputs, phase: 'redeeming', error: undefined };
      current.error = undefined;
      claimed = current;
    });
    if (!context.isCurrent() || !claimed) return;
    const identity = earnWithdrawExecutionIdentity(claimed);
    const execution =
      identity && validateEarnWithdrawPreparedExecution(claimed.extraInputs.preparedExecution, identity);
    if (!execution || !isEvmAddress(expected.owner) || !expected.nonce) return;
    const request = execution.allocationRequests[execution.preparedExecution.delivery.allocationIndex];
    if (!request) return;
    try {
      const sdk = await (deps.getSdk ?? getEpochReadOnlySdk)(expected.owner);
      if (!context.isCurrent()) return;
      const fresh = await liveWithdrawal(txId, expected);
      if (!context.isCurrent() || !fresh || !matchesPreparedExecution(fresh, execution.preparedExecution)) return;
      await withSubmissionLock(allocationLockKey(expected.attemptId, request.compact.nonce), async lock => {
        const current = await liveWithdrawal(txId, expected);
        if (
          !context.isCurrent() ||
          !lock.isCurrent() ||
          !current ||
          !matchesPreparedExecution(current, execution.preparedExecution)
        )
          return;
        await sdk.retryIntentSolve(request);
      });
    } catch (error) {
      if (context.isCurrent())
        await (deps.updatePhase ?? updateEarnWithdrawPhase)(
          txId,
          'failed',
          { error: error instanceof Error ? error.message : String(error) },
          undefined,
          expected
        ).catch((failure: unknown) => console.warn('[earn-withdraw] retry-phase patch failed', failure));
      throw error;
    } finally {
      if (context.isCurrent())
        (deps.startDeliveryPoll ?? pollEarnWithdrawDelivery)({
          sponsorAddress: expected.owner,
          nonce: expected.nonce,
          txId,
          attemptId: expected.attemptId,
          immediate: true,
          bridgeInfo: {
            provider: 'epoch',
            sourceAmount: claimed.extraInputs.sourceAmount,
            sourceSymbol: claimed.extraInputs.sourceSymbol,
            intentOwner: expected.owner,
            intentNonce: expected.nonce,
            earnWithdrawTxId: txId,
            earnWithdrawAttemptId: expected.attemptId
          },
          deps
        });
    }
  });
}
