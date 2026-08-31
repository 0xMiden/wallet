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
  claim_tx_hash: string;
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

/** True once AggLayer says the destination-side bridge may be completed. */
export function isAgglayerDepositReady(deposit: AgglayerDeposit): boolean {
  const normalizedStatus = deposit.status
    ?.trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return Boolean(
    deposit.ready_for_claim ||
    deposit.ready_to_claim ||
    deposit.finalized ||
    deposit.finalised ||
    (normalizedStatus && TERMINAL_DEPOSIT_STATUSES.has(normalizedStatus))
  );
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

// The most recent Miden→EVM (L2→L1) deposit to `l1Dest` that's ready to claim
// on L1, or null. L2-logged deposits carry `network_id === 1`.
export async function findClaimableMidenToEvmDeposit(l1Dest: string): Promise<AgglayerDeposit | null> {
  const deposits = await fetchDeposits(l1Dest);
  const claimable = deposits
    .filter(d => d.ready_for_claim && d.network_id === 1)
    .sort((a, b) => b.deposit_cnt - a.deposit_cnt);
  return claimable[0] ?? null;
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
