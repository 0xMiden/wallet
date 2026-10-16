import type { TokenBalanceData } from './front/balance';

/** Captured under the WASM lock from the SAME account object as its vault assets. */
export interface BalanceSnapshot {
  network: string;
  accountNonce?: string;
}

export interface BalanceRequirement {
  accountId: string;
  faucetId: string;
  minimumNonce: string;
}

// Proof belongs to the exact rows landed in Zustand, not to an address or a fetch timestamp.
// Replacing/clearing balances drops the proof, and nothing is persisted across wallet resets.
const snapshots = new WeakMap<readonly TokenBalanceData[], BalanceSnapshot>();
export function tagBalanceSnapshot(rows: readonly TokenBalanceData[], snapshot: BalanceSnapshot): void {
  snapshots.set(rows, snapshot);
}

export function isBalanceReflected(
  requirement: BalanceRequirement,
  balances: Record<string, TokenBalanceData[] | undefined>
): boolean {
  const entry = Object.entries(balances).find(
    ([account]) => account.split('_')[0] === requirement.accountId.split('_')[0]
  );
  if (!entry?.[1]) return false;
  const rows = entry[1];
  const snapshot = snapshots.get(rows);
  if (snapshot?.network !== 'mainnet' || !snapshot.accountNonce || !/^\d+$/.test(snapshot.accountNonce)) return false;
  if (!/^\d+$/.test(requirement.minimumNonce) || BigInt(snapshot.accountNonce) < BigInt(requirement.minimumNonce))
    return false;
  return rows.some(
    row => row.tokenId === requirement.faucetId && !row.metadata.scaleIsUnknown && Number.isFinite(row.balance)
  );
}
