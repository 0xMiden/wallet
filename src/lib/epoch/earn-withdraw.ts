import { EpochIntentSDK, TaskType, ActionType } from '@epoch-protocol/epoch-intents-sdk';
import { v4 } from 'uuid';
import { type Address, parseUnits } from 'viem';
import { sepolia } from 'viem/chains';

import {
  findPendingBridgeInByEarnWithdrawTxId,
  initiateEarnWithdrawTransaction,
  registerPendingBridgeIn,
  resolveBridgeInNoteId,
  updateEarnWithdrawPhase
} from 'lib/miden/activity';
import type { IBridgeInInfo } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { getNativeAssetId } from 'lib/miden-chain/native-asset';

import { normalizeMidenIdToHex } from './bridge';
import { BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS } from './bridgeable-token';
import { EPOCH_ALLOCATOR_URL, MIDEN_DESTINATION_CHAIN_ID } from './config';
import { EARN_PROTOCOL_HASH, EARN_UNDERLYING, resolveEarnIntentOutcome } from './earn';
import { tryWithEarnSubmissionLock, withEarnSubmissionLock } from './earn-submission-lock';
import { buildVaultEvmWalletClient } from './evm-account';
import {
  earnWithdrawPollKey,
  effectiveWithdrawAttemptId,
  isEarnWithdrawalStale,
  matchesEarnWithdrawIntent,
  type ExpectedEarnWithdrawIntent
} from './intent-key';
import { startIntentPoll } from './poll-registry';
import { getEpochReadOnlySdk, ensureEpochSmartAccount } from './sdk';

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

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
   * so the caller can navigate to the generating-transaction screen — mirrors
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
  ensureSmartAccount?: typeof ensureEpochSmartAccount;
  registerBridgeIn?: typeof registerPendingBridgeIn;
  initiateRow?: typeof initiateEarnWithdrawTransaction;
  updatePhase?: typeof updateEarnWithdrawPhase;
  /** Injectable delivery poller (tests pass a no-op). */
  startDeliveryPoll?: typeof pollEarnWithdrawDelivery;
  withSubmissionLock?: typeof withEarnSubmissionLock;
}

function isEvmAddress(value: string): value is Address {
  return EVM_ADDRESS_RE.test(value);
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
  const updatePhase = deps.updatePhase ?? updateEarnWithdrawPhase;
  const registerBridgeIn = deps.registerBridgeIn ?? registerPendingBridgeIn;
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
    let nonceString: string;
    try {
      const ensureSmartAccount = deps.ensureSmartAccount ?? ensureEpochSmartAccount;
      await ensureSmartAccount(args.midenAccountPublicKey, sponsorAddress);
      assertCurrent();
      const walletClient = buildVaultEvmWalletClient(args.midenAccountPublicKey, sponsorAddress);
      const sdk =
        deps.sdk ??
        new EpochIntentSDK({
          apiBaseUrl: EPOCH_ALLOCATOR_URL,
          walletClient,
          allowGaslessSmartAccount: true
        });
      const status = await sdk.getWalletGaslessStatus(chainId);
      assertCurrent();
      if (!status.is7702Capable) throw new Error('Wallet/chain is not 7702-capable for a gasless withdrawal.');
      if (status.needsSetup) {
        const setup = await sdk.convertToSmartAccount({ chainId });
        assertCurrent();
        if (!setup.ok) throw new Error('Smart-account conversion failed for the gasless withdrawal.');
      }
      const native = await getNativeAssetId();
      assertCurrent();
      const { nonce } = await sdk.helpers.executeActions({
        action: ActionType.Withdraw,
        underlying: underlyingAddress,
        amount: amountAtomic.toString(),
        protocol: 'dummy-lending',
        swapAndBridge: {
          toToken: normalizeMidenIdToHex(native),
          toChainId: MIDEN_DESTINATION_CHAIN_ID,
          recipient: midenRecipientHex
        },
        gasless: true
      });
      assertCurrent();
      nonceString = String(nonce);
    } catch (error) {
      if (context.isCurrent()) {
        const message = error instanceof Error ? error.message : String(error);
        await updatePhase(txId, 'failed', { error: message }, undefined, expected).catch((err: unknown) =>
          console.warn('[earn-withdraw] failed-phase patch failed', err)
        );
      }
      throw error;
    }

    // Independent durability anchors: either one lets recovery find the submitted intent.
    try {
      await registerBridgeIn(sponsorAddress, nonceString, {
        provider: 'epoch',
        sourceAmount: args.amount,
        sourceSymbol: 'USDC',
        intentOwner: sponsorAddress,
        intentNonce: nonceString,
        earnWithdrawTxId: txId,
        earnWithdrawAttemptId: attemptId
      });
    } catch (error) {
      console.warn('[earn-withdraw] bridge-in registration failed; row nonce + reconcile will recover', error);
    }
    assertCurrent();
    try {
      await updatePhase(txId, 'redeeming', { withdrawIntentNonce: nonceString }, undefined, {
        ...expected,
        nonce: nonceString
      });
    } catch (error) {
      console.warn('[earn-withdraw] nonce persist failed; bridge-in registry + auto-consume will recover', error);
    }
    assertCurrent();
    startDeliveryPoll({ sponsorAddress, nonce: nonceString, txId, attemptId });
    return { txId, nonce: nonceString, gaslessUsed: true };
  });
}

interface DeliveryPollDeps {
  getSdk?: typeof getEpochReadOnlySdk;
  updatePhase?: typeof updateEarnWithdrawPhase;
  resolveNoteId?: typeof resolveBridgeInNoteId;
  registerBridgeIn?: typeof registerPendingBridgeIn;
  startPoll?: typeof startIntentPoll;
}

async function isLiveWithdrawal(txId: string, expected: ExpectedEarnWithdrawIntent): Promise<boolean> {
  const row = await Repo.transactions.where({ id: txId }).first();
  return (
    row?.type === 'earn-withdraw' &&
    !row.restoredFromBackup &&
    NON_TERMINAL_WITHDRAW_PHASES.has(row.extraInputs?.phase) &&
    matchesEarnWithdrawIntent(row, expected)
  );
}

/** Advance destination-leg status before resolving an already-consumed delivery note. */
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
  const startPoll = deps.startPoll ?? startIntentPoll;
  const expected: ExpectedEarnWithdrawIntent = {
    owner: sponsorAddress,
    nonce,
    attemptId: effectiveWithdrawAttemptId(txId, args.attemptId)
  };
  let registered = args.bridgeInfo === undefined;
  startPoll({
    key: earnWithdrawPollKey(sponsorAddress, nonce),
    intervalMs,
    maxAttempts,
    immediate,
    tick: async context => {
      if (!(await isLiveWithdrawal(txId, expected))) {
        context.markTerminal();
        return;
      }
      if (!context.isCurrent()) return;
      if (!registered && args.bridgeInfo) {
        await registerBridgeIn(sponsorAddress, nonce, args.bridgeInfo);
        if (!context.isCurrent()) return;
        registered = true;
      }
      const sdk = await getSdk(sponsorAddress);
      if (!context.isCurrent()) return;
      if (!(await isLiveWithdrawal(txId, expected))) {
        context.markTerminal();
        return;
      }
      if (!context.isCurrent()) return;
      const results = await sdk.getIntentStatus(sponsorAddress, nonce);
      if (!context.isCurrent()) return;
      const stillLive = await isLiveWithdrawal(txId, expected);
      if (!context.isCurrent()) return;
      const { outcome, source } = resolveEarnIntentOutcome(results, MIDEN_DESTINATION_CHAIN_ID);
      if (!stillLive || outcome !== 'pending') context.markTerminal();
      try {
        if (stillLive && outcome === 'done') {
          const evmTxHash = source?.transactionHash || undefined;
          await updatePhase(txId, 'delivering', evmTxHash ? { evmTxHash } : undefined, undefined, expected);
        } else if (stillLive && outcome === 'failed') {
          await updatePhase(txId, 'failed', { error: 'The withdrawal intent failed on Epoch.' }, undefined, expected);
        }
      } finally {
        // A retried primary cannot take this result, but its old delivered receipt still can.
        const midenNoteId = extractMidenNoteId(results);
        if (context.isCurrent() && midenNoteId) await resolveNoteId(sponsorAddress, nonce, midenNoteId);
      }
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
  if (row?.type !== 'earn-withdraw' || !NON_TERMINAL_WITHDRAW_PHASES.has(row.extraInputs?.phase)) return;
  const expected: ExpectedEarnWithdrawIntent = {
    owner: row.extraInputs.evmOwner,
    nonce: row.extraInputs.withdrawIntentNonce,
    attemptId: effectiveWithdrawAttemptId(txId, row.extraInputs.submissionAttemptId)
  };
  const updatePhase = deps.updatePhase ?? updateEarnWithdrawPhase;
  if (row.restoredFromBackup || isEarnWithdrawalStale(row)) {
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
    if (!NON_TERMINAL_WITHDRAW_PHASES.has(fresh.extraInputs?.phase) || !matchesEarnWithdrawIntent(fresh, expected))
      return;
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
  const updatePhase = deps.updatePhase ?? updateEarnWithdrawPhase;
  for (const row of rows) {
    if (row.type !== 'earn-withdraw' || !NON_TERMINAL_WITHDRAW_PHASES.has(row.extraInputs?.phase)) continue;
    if (row.restoredFromBackup || isEarnWithdrawalStale(row)) {
      await updatePhase(
        row.id,
        'failed',
        { error: row.restoredFromBackup ? RESTORED_WITHDRAW_UNVERIFIABLE : 'Withdrawal timed out.' },
        undefined,
        row.restoredFromBackup
          ? undefined
          : {
              owner: row.extraInputs.evmOwner,
              nonce: row.extraInputs.withdrawIntentNonce,
              attemptId: effectiveWithdrawAttemptId(row.id, row.extraInputs.submissionAttemptId)
            }
      ).catch(() => undefined);
      continue;
    }
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
  if (ei.phase !== 'failed') return;
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
            current.extraInputs.phase !== 'failed' ||
            !matchesEarnWithdrawIntent(current, previous)
          ) {
            return;
          }
          current.extraInputs = {
            ...current.extraInputs,
            phase: 'redeeming',
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
