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

/**
 * This row's own exit deposit, in any state (indexed, ready or claimed), or null. Callers classify it with
 * `isAgglayerDepositReady` and `isAgglayerDepositClaimed`.
 *
 * Bound to the row by `exitTxHash`, the indexer's `tx_hash` for the B2AGG note the row built
 * (`lib/agglayer/b2agg/exit-hash.ts`). The caller claims whatever comes back, and settles its own row on a claim
 * made by anyone, so an unbound answer would claim a sibling's amount or mark this row claimed off a sibling's
 * claim. Nothing unbound is ever answered.
 *
 * `depositCnt` is the row's pin: one GET for that deposit, kept only while it still carries this exit, so a
 * renumbered or reset indexer, or a failed GET, falls back to the address's ten newest deposits.
 */
export async function findAgglayerExitDeposit(
  l1Dest: string,
  exitTxHash: string,
  depositCnt?: number
): Promise<AgglayerDeposit | null> {
  const isThisExit = (deposit: AgglayerDeposit) =>
    isMidenToEvmDeposit(deposit) && sameTxHash(deposit.tx_hash, exitTxHash);
  if (depositCnt !== undefined) {
    try {
      const pinned = await fetchMidenToEvmDeposit(depositCnt);
      if (isThisExit(pinned)) return pinned;
      console.warn('[agglayer] the pinned deposit no longer carries this exit; looking it up by address', {
        depositCnt,
        exitTxHash
      });
    } catch {
      // Not found, or the indexer is down; the address page below answers either way.
    }
  }
  const deposits = await fetchDeposits(l1Dest);
  return deposits.find(isThisExit) ?? null;
}

/**
 * The Miden→EVM (L2→L1) deposit produced by the bridge-out whose Miden
 * transaction id is `originTxHash`, once AggLayer says it can be claimed on L1 —
 * or null. L2-logged deposits carry `network_id === 1`.
 *
 * The lookup is BOUND to the row that is claiming, because the caller submits
 * `claimAsset` for whatever comes back and then stamps that claim (and its hash)
 * onto its own activity row: returning a sibling deposit claims the wrong amount
 * and reports the wrong bridge as claimed, while leaving the row's real deposit
 * unclaimed on L1. `originTxHash` is the row's own `transactionId`, which the
 * indexer echoes as the deposit's `tx_hash` — the same match
 * `reconcileBridgedReceives` makes for the EVM→Miden direction.
 *
 * A row that completed through the apply-after-submit path records the id its
 * failure carried (#1233), but one whose id could not be read has none, so an
 * unbound lookup is still answered - but only while the answer is unambiguous.
 * With two claimable deposits and nothing to tell them apart, null is the only
 * safe answer: the wallet would otherwise pick one at random and call it this
 * row's.
 */
export async function findClaimableMidenToEvmDeposit(
  l1Dest: string,
  originTxHash?: string
): Promise<AgglayerDeposit | null> {
  const deposits = await fetchDeposits(l1Dest);
  const claimable = deposits.filter(
    deposit => deposit.network_id === 1 && isAgglayerDepositReady(deposit) && !isAgglayerDepositClaimed(deposit)
  );

  if (originTxHash) {
    const bound = claimable.find(deposit => sameTxHash(deposit.tx_hash, originTxHash));
    if (!bound && claimable.length > 0) {
      console.warn('[agglayer] no claimable deposit matches this bridge-out; not claiming a sibling deposit', {
        originTxHash,
        claimableTxHashes: claimable.map(deposit => deposit.tx_hash)
      });
    }
    return bound ?? null;
  }

  return claimable.length === 1 ? claimable[0]! : null;
}

// Fetch the merkle proof for a deposit (net_id is the deposit's `network_id`).
export async function fetchMerkleProof(depositCnt: number, netId: number): Promise<AgglayerMerkleProof> {
  const data = await agglayerJson<MerkleProofResponse>(
    `${BRIDGE_SERVICE_URL}/merkle-proof?deposit_cnt=${depositCnt}&net_id=${netId}`,
    'Agglayer merkle-proof status'
  );
  return data.proof;
}
