import {
  getActiveOverride,
  getEffectiveNetworkName,
  getEffectiveRpcUrl,
  isNetworkChoiceOverride
} from 'lib/miden-chain/effective-endpoints';

import type { TokenBalanceData } from './front/balance';

/** Captured under the WASM lock from the SAME account object as its vault assets. */
export interface BalanceSnapshot {
  network: string;
  /** Set only while a saved endpoint-free network choice held for the whole read; readers take it as that network. */
  selectedNetwork?: string;
  accountNonce?: string;
}

/**
 * Call immediately before the account read. The returned function builds the snapshot once the read
 * has returned and the hold is still the caller's (the nonce is a WASM call on the account); an
 * endpoint that changed in between labels the read `changed`.
 */
export function beginBalanceSnapshot(): (
  account: { nonce(): { asInt(): bigint } } | null | undefined
) => BalanceSnapshot {
  const override = getActiveOverride();
  const overridden = override !== null;
  const selectedNetwork = override && isNetworkChoiceOverride(override) ? getEffectiveNetworkName() : undefined;
  const network = overridden ? 'override' : getEffectiveNetworkName();
  const rpc = getEffectiveRpcUrl();
  return account => {
    const currentOverride = getActiveOverride();
    const sameRpc = getEffectiveRpcUrl() === rpc;
    return {
      network: sameRpc && (currentOverride !== null) === overridden ? network : 'changed',
      accountNonce: account ? account.nonce().asInt().toString() : undefined,
      ...(selectedNetwork &&
      sameRpc &&
      getEffectiveNetworkName() === selectedNetwork &&
      currentOverride !== null &&
      isNetworkChoiceOverride(currentOverride)
        ? { selectedNetwork }
        : {})
    };
  };
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

/** True only for the exact synchronized vault rows from the selected network. */
export function hasBalanceSnapshotForNetwork(rows: readonly TokenBalanceData[], network: string): boolean {
  const snapshot = snapshots.get(rows);
  return (
    (snapshot?.selectedNetwork ?? snapshot?.network) === network &&
    snapshot?.accountNonce !== undefined &&
    /^\d+$/.test(snapshot.accountNonce)
  );
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
  if (!snapshot?.accountNonce || !hasBalanceSnapshotForNetwork(rows, 'mainnet')) return false;
  if (!/^\d+$/.test(requirement.minimumNonce) || BigInt(snapshot.accountNonce) < BigInt(requirement.minimumNonce))
    return false;
  return rows.some(
    row => row.tokenId === requirement.faucetId && !row.metadata.scaleIsUnknown && Number.isFinite(row.balance)
  );
}
