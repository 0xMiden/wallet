import { AGGLAYER_BRIDGE_API } from './constant';

// A bridge indexer that accepts the connection then goes silent must not hang
// the claim/poll flow forever; bound every AggLayer request. On timeout the
// AbortController rejects the fetch, so the bridge tracker's poll simply fails
// this tick and retries on the next — a transient outage is survived, never a
// wedged "Claim Pending" that can't make progress.
const AGGLAYER_FETCH_TIMEOUT_MS = 15_000;

async function agglayerFetch(url: string, timeoutMs: number = AGGLAYER_FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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
  const claimHash = deposit.claim_tx_hash?.trim();
  if (claimHash && !ZERO_TX_HASH.test(claimHash)) return true;
  return normalizedDepositStatus(deposit) === 'claimed';
}

interface BridgesResponse {
  deposits: AgglayerDeposit[];
  total_cnt: string;
}

// Fetch recent deposits routed to `destAddr` (the Miden account in EVM form).
// We pull a small window rather than just the latest so we can match our own
// deposit by origin tx hash and not confuse it with an earlier bridge.
export async function fetchDeposits(destAddr: string, limit = 10): Promise<AgglayerDeposit[]> {
  const res = await agglayerFetch(`${AGGLAYER_BRIDGE_API}/${destAddr}?limit=${limit}&offset=0`);
  if (!res.ok) {
    throw new Error(`Agglayer bridge status ${res.status}`);
  }
  const data: BridgesResponse = await res.json();
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
function sameTxHash(left: string, right: string): boolean {
  const normalize = (hash: string) => hash.trim().toLowerCase().replace(/^0x/, '');
  return normalize(left) === normalize(right);
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
 * `reconcileAgglayerBridgedReceives` makes for the EVM→Miden direction.
 *
 * A row that completed through the apply-after-submit path never recorded a
 * transaction id (see `isApplyAfterSubmitError` in `transaction/index.ts`), so an
 * unbound lookup is still answered — but only while the answer is unambiguous.
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
  const res = await agglayerFetch(`${BRIDGE_SERVICE_URL}/merkle-proof?deposit_cnt=${depositCnt}&net_id=${netId}`);
  if (!res.ok) {
    throw new Error(`Agglayer merkle-proof status ${res.status}`);
  }
  const data: MerkleProofResponse = await res.json();
  return data.proof;
}
