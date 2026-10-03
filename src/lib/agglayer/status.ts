import type { IBridgedSendExtraInputs } from 'lib/miden/db/types';
import { withRequestTimeout } from 'lib/remote-json';

import { EVM_AGGLAYER_NETWORK_ID } from './b2agg/constant';
import { AGGLAYER_BRIDGE_API, MIDEN_CHAIN_ID } from './constant';

// A bridge indexer that accepts the connection then goes silent must not hang
// the claim/poll flow forever; bound every AggLayer request, its body read
// included. On timeout the request rejects, so the bridge tracker's poll simply
// fails this tick and retries on the next: a transient outage is survived, never
// a wedged "Claim Pending" that can't make progress.
const AGGLAYER_FETCH_TIMEOUT_MS = 15_000;

/** The JSON body at `url`; a non-ok response rejects as `<failure> <status>`. */
function agglayerJson<T>(url: string, failure: string): Promise<T> {
  return withRequestTimeout(AGGLAYER_FETCH_TIMEOUT_MS, async signal => {
    const res = await fetch(url, { signal });
    if (!res.ok) {
      throw new Error(`${failure} ${res.status}`);
    }
    const data: T = await res.json();
    return data;
  });
}

// One row from the bridge indexer's `deposits` array.
export interface AgglayerDeposit {
  leaf_type: number;
  orig_net: number;
  orig_addr: string;
  amount: string;
  dest_net: number;
  dest_addr: string;
  block_num: string;
  deposit_cnt: number;
  network_id: number;
  tx_hash: string;
  /**
   * Set once this deposit has been claimed on the destination chain. Deployments
   * differ on how they report "not claimed yet" — the field can be absent, empty,
   * or an all-zero hash — so only a non-zero hash counts as a claim; see
   * `isAgglayerDepositClaimed`.
   */
  claim_tx_hash?: string;
  metadata: string;
  ready_for_claim: boolean;
  /** Newer bridge indexers expose the same terminal signal under this name. */
  ready_to_claim?: boolean;
  /** Some deployments expose finality separately from claim readiness. */
  finalized?: boolean;
  finalised?: boolean;
  status?: string;
  global_index: string;
}

const TERMINAL_DEPOSIT_STATUSES = new Set(['finalized', 'finalised', 'ready_to_claim', 'ready_for_claim', 'claimed']);

function normalizedDepositStatus(deposit: AgglayerDeposit): string | undefined {
  return deposit.status
    ?.trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

/** True once AggLayer says the destination-side bridge may be completed. */
export function isAgglayerDepositReady(deposit: AgglayerDeposit): boolean {
  const normalizedStatus = normalizedDepositStatus(deposit);
  return Boolean(
    deposit.ready_for_claim ||
    deposit.ready_to_claim ||
    deposit.finalized ||
    deposit.finalised ||
    (normalizedStatus && TERMINAL_DEPOSIT_STATUSES.has(normalizedStatus))
  );
}

// Unclaimed deposits report `claim_tx_hash` as absent, empty, or all zeroes.
const ZERO_TX_HASH = /^(0x)?0*$/i;

/**
 * True once AggLayer has recorded a claim for this deposit.
 *
 * `isAgglayerDepositReady` stays true after a claim on the indexers that keep
 * `ready_for_claim` set (and `claimed` is itself one of its terminal statuses),
 * so readiness alone would keep offering a deposit that can only revert as
 * already-claimed. Claim selection has to exclude these explicitly.
 */
export function isAgglayerDepositClaimed(deposit: AgglayerDeposit): boolean {
  if (claimHashOf(deposit) !== undefined) return true;
  return normalizedDepositStatus(deposit) === 'claimed';
}

function claimHashOf(deposit: AgglayerDeposit): string | undefined {
  const claimHash = deposit.claim_tx_hash?.trim();
  return claimHash && !ZERO_TX_HASH.test(claimHash) ? claimHash : undefined;
}

/**
 * What a `claimed` write records for a deposit the indexer reports claimed, by the wallet or anyone else: the pin,
 * and the claim hash when the indexer has one. An absent hash is left out rather than written as undefined, so it
 * can never erase the hash of the wallet's own claim.
 */
export function agglayerClaimedFields(deposit: AgglayerDeposit): { claimTxHash?: string; agglayerDepositCnt: number } {
  const claimTxHash = claimHashOf(deposit);
  return claimTxHash === undefined
    ? { agglayerDepositCnt: deposit.deposit_cnt }
    : { claimTxHash, agglayerDepositCnt: deposit.deposit_cnt };
}

interface BridgesResponse {
  deposits: AgglayerDeposit[];
  total_cnt: string;
}

// Fetch recent deposits routed to `destAddr` (the Miden account in EVM form).
// We pull a small window rather than just the latest so we can match our own
// deposit by origin tx hash and not confuse it with an earlier bridge.
export async function fetchDeposits(destAddr: string, limit = 10): Promise<AgglayerDeposit[]> {
  const data = await agglayerJson<BridgesResponse>(
    `${AGGLAYER_BRIDGE_API}/${destAddr}?limit=${limit}&offset=0`,
    'Agglayer bridge status'
  );
  return data.deposits ?? [];
}

const AGGLAYER_DEPOSITS_PAGE_SIZE = 10;

/** The page of deposits routed to `destAddr` that starts `offset` deposits back, newest first, and their total. */
export async function fetchDepositsPage(
  destAddr: string,
  offset: number
): Promise<{ deposits: AgglayerDeposit[]; total: number }> {
  const data = await agglayerJson<BridgesResponse>(
    `${AGGLAYER_BRIDGE_API}/${destAddr}?limit=${AGGLAYER_DEPOSITS_PAGE_SIZE}&offset=${offset}`,
    'Agglayer bridge status'
  );
  return { deposits: data.deposits ?? [], total: Number(data.total_cnt) };
}

// The bridge-service merkle proof for a deposit, used to claim it on L1.
export interface AgglayerMerkleProof {
  main_exit_root: string;
  rollup_exit_root: string;
  merkle_proof: string[];
  rollup_merkle_proof: string[];
}

interface MerkleProofResponse {
  proof: AgglayerMerkleProof;
}

// Base URL of the bridge service (the `/bridges` indexer path stripped off).
const BRIDGE_SERVICE_URL = AGGLAYER_BRIDGE_API.replace(/\/bridges$/, '');

// Origin and claim hashes come back from the indexer with inconsistent `0x`
// prefixing and casing, so compare them normalized.
export function sameTxHash(left: string, right: string): boolean {
  const normalize = (hash: string) => hash.trim().toLowerCase().replace(/^0x/, '');
  return normalize(left) === normalize(right);
}

/** A deposit the indexer filed as a Miden -> EVM exit. */
export const isMidenToEvmDeposit = (deposit: AgglayerDeposit): boolean =>
  deposit.network_id === MIDEN_CHAIN_ID && deposit.dest_net === EVM_AGGLAYER_NETWORK_ID;

/**
 * A Slow bridge-out no lookup can ever find, so it is never polled, prompts nothing and offers no claim. Only its
 * stored marks say so: its bytes held no note (`agglayerExitTxHashUnavailable`), or a search of its address's whole
 * history missed an exit filed before the indexer's renumbering (`agglayerExitUnfiled`, #1325).
 */
export function isAgglayerExitUnfindable(
  inputs: Pick<IBridgedSendExtraInputs, 'provider' | 'agglayerExitTxHashUnavailable' | 'agglayerExitUnfiled'>
): boolean {
  if (inputs.provider !== 'agglayer') return false;
  return inputs.agglayerExitTxHashUnavailable === true || inputs.agglayerExitUnfiled === true;
}

interface DepositResponse {
  deposit: AgglayerDeposit;
}

/** Miden -> EVM exit number `depositCnt`. The indexer answers an unknown one with HTTP 500, which rejects. */
export async function fetchMidenToEvmDeposit(depositCnt: number): Promise<AgglayerDeposit> {
  const data = await agglayerJson<DepositResponse>(
    `${BRIDGE_SERVICE_URL}/bridge?net_id=${MIDEN_CHAIN_ID}&deposit_cnt=${depositCnt}`,
    'Agglayer bridge deposit'
  );
  return data.deposit;
}

/** Pages of an address's history, ten deposits each, that one search for an unpinned exit reads at most. */
export const AGGLAYER_EXIT_SEARCH_MAX_PAGES = 10;

// Exits whose address history this realm has searched past the first page. An exit the indexer has not filed yet is
// looked up every 8 s by the background poll and the open detail page, so later lookups read the first page only.
const exitHistoriesSearched = new Set<string>();

/** What a search for one exit found. A miss is `complete` only when it read the address's whole history. */
export interface AgglayerExitSearch {
  deposit: AgglayerDeposit | null;
  complete: boolean;
}

/**
 * This row's own exit deposit, in any state (indexed, ready or claimed), or null, and whether a miss covered the
 * address's whole history. Callers classify the deposit with `isAgglayerDepositReady` and `isAgglayerDepositClaimed`.
 *
 * Bound to the row by `exitTxHash`, the indexer's `tx_hash` for the B2AGG note the row built
 * (`lib/agglayer/b2agg/exit-hash.ts`). The caller claims whatever comes back, and settles its own row on a claim
 * made by anyone, so an unbound answer would claim a sibling's amount or mark this row claimed off a sibling's
 * claim. Nothing unbound is ever answered.
 *
 * `depositCnt` is the row's pin: one GET for that deposit, kept only while it still carries this exit, so a
 * renumbered or reset indexer, or a failed GET, falls back to the address's history. That reads the ten newest
 * deposits, then, once per exit per realm session, pages back through older ones up to
 * `AGGLAYER_EXIT_SEARCH_MAX_PAGES`.
 */
export async function searchAgglayerExitDeposit(
  l1Dest: string,
  exitTxHash: string,
  depositCnt?: number
): Promise<AgglayerExitSearch> {
  const isThisExit = (deposit: AgglayerDeposit) =>
    isMidenToEvmDeposit(deposit) && sameTxHash(deposit.tx_hash, exitTxHash);
  if (depositCnt !== undefined) {
    try {
      const pinned = await fetchMidenToEvmDeposit(depositCnt);
      if (isThisExit(pinned)) return { deposit: pinned, complete: true };
      console.warn('[agglayer] the pinned deposit no longer carries this exit; looking it up by address', {
        depositCnt,
        exitTxHash
      });
    } catch {
      // Not found, or the indexer is down; the address history below answers either way.
    }
  }
  for (let page = 0; page < AGGLAYER_EXIT_SEARCH_MAX_PAGES; page++) {
    if (page === 1) {
      if (exitHistoriesSearched.has(exitTxHash)) break;
      exitHistoriesSearched.add(exitTxHash);
    }
    const offset = page * AGGLAYER_DEPOSITS_PAGE_SIZE;
    const { deposits, total } = await fetchDepositsPage(l1Dest, offset);
    const deposit = deposits.find(isThisExit);
    if (deposit) return { deposit, complete: true };
    if (offset + deposits.length >= total) return { deposit: null, complete: true };
    if (deposits.length === 0) break;
  }
  return { deposit: null, complete: false };
}

/** `searchAgglayerExitDeposit`'s deposit, for a caller that never retires a row on a miss. */
export async function findAgglayerExitDeposit(
  l1Dest: string,
  exitTxHash: string,
  depositCnt?: number
): Promise<AgglayerDeposit | null> {
  return (await searchAgglayerExitDeposit(l1Dest, exitTxHash, depositCnt)).deposit;
}

// Fetch the merkle proof for a deposit (net_id is the deposit's `network_id`).
export async function fetchMerkleProof(depositCnt: number, netId: number): Promise<AgglayerMerkleProof> {
  const data = await agglayerJson<MerkleProofResponse>(
    `${BRIDGE_SERVICE_URL}/merkle-proof?deposit_cnt=${depositCnt}&net_id=${netId}`,
    'Agglayer merkle-proof status'
  );
  return data.proof;
}
