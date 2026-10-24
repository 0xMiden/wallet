import { decodeEventLog, type Hex } from 'viem';

import { AGGLAYER_BRIDGE_ABI } from '../../../src/lib/agglayer/constant';
import {
  agglayerClaimedFields,
  isAgglayerDepositClaimed,
  isAgglayerDepositReady,
  sameTxHash,
  type AgglayerDeposit
} from '../../../src/lib/agglayer/status';

/** The AggLayer network id of Ethereum, where a Miden exit is claimed. */
export const L1_NETWORK_ID = 0;
/** A mainnet exit took 40 to 45 minutes to be claimed on 2026-10-23 and 2026-10-24. */
export const EXIT_WAIT_MS = 120 * 60_000;
/** The auto-claimer claims within about two minutes of an exit becoming claimable. */
export const SELF_CLAIM_GRACE_MS = 5 * 60_000;

export interface ExitTarget {
  /** The Miden rollup id the indexer files the exit under (Cedar: 30). */
  rollupId: number;
  /** The Ethereum address the exit pays. */
  address: string;
}

const isExitTo = (deposit: AgglayerDeposit, target: ExitTarget): boolean =>
  deposit.network_id === target.rollupId &&
  deposit.dest_net === L1_NETWORK_ID &&
  deposit.dest_addr.toLowerCase() === target.address.toLowerCase();

/** The highest exit number to `target` the indexer lists, or -1: tonight's exit is numbered above it. */
export function exitCursor(deposits: readonly AgglayerDeposit[], target: ExitTarget): number {
  return deposits.filter(deposit => isExitTo(deposit, target)).reduce((max, d) => Math.max(max, d.deposit_cnt), -1);
}

/**
 * Tonight's exit. When `exitTxHash` is given and a listed exit to `target` has that `tx_hash` (`sameTxHash`), that
 * exit is returned. Otherwise the lowest-numbered exit to `target` above the cursor read before the bridge-out that
 * carries exactly the wei bridged. The counter is the rollup's, so a number above the cursor was filed after that
 * read; the amount keeps an earlier night's exit that the indexer filed late from passing for tonight's. The hash
 * only narrows: it is never required, and a hash no listed exit carries leaves this rule unchanged.
 */
export function tonightsExit(
  deposits: readonly AgglayerDeposit[],
  args: ExitTarget & { afterDepositCnt: number; wei: bigint; exitTxHash?: string }
): AgglayerDeposit | undefined {
  const { exitTxHash } = args;
  if (exitTxHash !== undefined) {
    const named = deposits.find(
      d => isExitTo(d, args) && typeof d.tx_hash === 'string' && sameTxHash(d.tx_hash, exitTxHash)
    );
    if (named) return named;
  }
  return deposits
    .filter(d => isExitTo(d, args) && d.deposit_cnt > args.afterDepositCnt && BigInt(d.amount) === args.wei)
    .sort((left, right) => left.deposit_cnt - right.deposit_cnt)[0];
}

const EXITS_PAGE = 10;
/** One exit a night: 50 pages cover more than a year of them. */
const MAX_EXIT_PAGES = 50;
const INDEXER_TIMEOUT_MS = 15_000;

/**
 * `total_cnt` is a non-negative integer, whether the JSON value is a number or a string of digits. Missing, blank,
 * negative, and non-whole values are not a complete listing.
 */
function indexedDepositTotal(value: unknown, url: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  throw new Error(`the AggLayer indexer answered ${url} with a total_cnt that is not a non-negative integer`);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

function isDeposit(value: unknown): value is AgglayerDeposit {
  if (!isRecord(value)) return false;
  return (
    typeof value.network_id === 'number' &&
    typeof value.dest_net === 'number' &&
    typeof value.dest_addr === 'string' &&
    typeof value.deposit_cnt === 'number' &&
    typeof value.amount === 'string' &&
    /^\d+$/.test(value.amount) &&
    typeof value.global_index === 'string'
  );
}

/** The part of a fetch Response the indexer read uses. */
export interface IndexerResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/**
 * Every deposit the indexer files under `address`, all pages. The listing mixes Miden exits with L1 deposits and is
 * not ordered by exit number, so a single page cannot answer which exit is the newest.
 */
export async function fetchIndexedDeposits(
  indexerUrl: string,
  address: string,
  read: (url: string) => Promise<IndexerResponse> = url =>
    fetch(url, { signal: AbortSignal.timeout(INDEXER_TIMEOUT_MS) })
): Promise<AgglayerDeposit[]> {
  const found: AgglayerDeposit[] = [];
  let total = Number.POSITIVE_INFINITY;
  for (let page = 0; page < MAX_EXIT_PAGES && page * EXITS_PAGE < total; page += 1) {
    const url = `${indexerUrl}/bridges/${address}?limit=${EXITS_PAGE}&offset=${page * EXITS_PAGE}`;
    const response = await read(url);
    if (!response.ok) throw new Error(`the AggLayer indexer answered ${response.status} for ${url}`);
    const body: unknown = await response.json();
    const deposits = isRecord(body) ? body.deposits : undefined;
    if (!Array.isArray(deposits) || !deposits.every(isDeposit)) {
      throw new Error(`the AggLayer indexer answered ${url} with an unreadable deposit list`);
    }
    found.push(...deposits);
    total = indexedDepositTotal(isRecord(body) ? body.total_cnt : undefined, url);
    if (deposits.length === 0) break;
  }
  if (found.length < total && Number.isFinite(total)) {
    throw new Error(`the AggLayer indexer lists ${total} deposits for ${address}, more than ${found.length} read`);
  }
  return found;
}

export type ExitStep =
  | { kind: 'wait'; readySince?: number }
  | { kind: 'settled'; claimTxHash: string }
  | { kind: 'claim'; readySince: number };

/**
 * What to do with tonight's exit at `now`. A claim by anyone settles it. A ready exit nobody has claimed is the job's
 * to claim only once it has stayed so for `graceMs`, which leaves the auto-claimer its turn. `readySince` is the first
 * poll that saw it ready, carried from the previous step.
 */
export function exitStep(
  exit: AgglayerDeposit | undefined,
  readySince: number | undefined,
  now: number,
  graceMs = SELF_CLAIM_GRACE_MS
): ExitStep {
  if (exit === undefined) return { kind: 'wait' };
  if (isAgglayerDepositClaimed(exit)) {
    const { claimTxHash } = agglayerClaimedFields(exit);
    // Claimed without a hash: there is nothing to verify on Ethereum yet, and nothing left to claim.
    return claimTxHash === undefined ? { kind: 'wait', readySince } : { kind: 'settled', claimTxHash };
  }
  if (!isAgglayerDepositReady(exit)) return { kind: 'wait' };
  const since = readySince ?? now;
  return now - since >= graceMs ? { kind: 'claim', readySince: since } : { kind: 'wait', readySince: since };
}

export interface ClaimReceipt {
  status: 'success' | 'reverted';
  logs: ReadonlyArray<{ address: string; data: Hex; topics: readonly Hex[] }>;
}

/** Why `receipt` is not a claim of `exit` paying `destination` through `bridge`, or undefined when it is. */
export function claimPaysExit(
  receipt: ClaimReceipt,
  exit: AgglayerDeposit,
  args: { bridge: string; destination: string }
): string | undefined {
  if (receipt.status !== 'success') return 'the claim transaction reverted';
  const paid = receipt.logs.some(log => {
    if (log.address.toLowerCase() !== args.bridge.toLowerCase()) return false;
    const [signature, ...rest] = log.topics;
    if (signature === undefined) return false;
    try {
      const event = decodeEventLog({ abi: AGGLAYER_BRIDGE_ABI, data: log.data, topics: [signature, ...rest] });
      if (event.eventName !== 'ClaimEvent') return false;
      return (
        event.args.globalIndex === BigInt(exit.global_index) &&
        event.args.destinationAddress.toLowerCase() === args.destination.toLowerCase() &&
        event.args.amount === BigInt(exit.amount)
      );
    } catch {
      return false;
    }
  });
  return paid
    ? undefined
    : `no ClaimEvent from ${args.bridge} pays exit ${exit.deposit_cnt} (${exit.amount} wei) to ${args.destination}`;
}

/** What the AggLayer job knows about tonight, for the run summary. Every field is set when it happens. */
export interface AgglayerNight {
  depositTx?: string;
  depositAt?: string;
  landedAt?: string;
  bridgedText?: string;
  bridgedWei?: string;
  bridgeOutAt?: string;
  exitCursor?: number;
  exitDepositCnt?: number;
  exitMidenBlock?: string;
  exitSeenAt?: string;
  readyAt?: string;
  claimTx?: string;
  claimBlock?: string;
  claimAt?: string;
  claimer?: string;
  claimedBy?: 'another party' | 'this job';
  outcome?: string;
}

/** The night as a Markdown table, in the order things happen. */
export function agglayerNightMarkdown(night: AgglayerNight): string {
  const rows: Array<[string, string | undefined]> = [
    ['Deposit to Miden', night.depositTx && `${night.depositTx} at ${night.depositAt ?? 'unknown'}`],
    ['Deposit landed', night.landedAt],
    ['Bridged out', night.bridgedText && `${night.bridgedText} ETH (${night.bridgedWei ?? '?'} wei)`],
    ['Bridge-out at', night.bridgeOutAt],
    ['Exit cursor', night.exitCursor === undefined ? undefined : String(night.exitCursor)],
    ['Exit number', night.exitDepositCnt === undefined ? undefined : String(night.exitDepositCnt)],
    ['Exit Miden block', night.exitMidenBlock],
    ['Exit indexed at', night.exitSeenAt],
    ['Ready to claim at', night.readyAt],
    ['Claim tx', night.claimTx],
    ['Claim block', night.claimBlock],
    ['Claim at', night.claimAt],
    ['Claimed by', night.claimer && `${night.claimer} (${night.claimedBy ?? 'unknown'})`],
    ['Outcome', night.outcome]
  ];
  const lines = rows.flatMap(([label, value]) => (value === undefined ? [] : [`| ${label} | ${value} |`]));
  return ['### AggLayer loop', '', '| Step | Value |', '| --- | --- |', ...lines, ''].join('\n');
}
