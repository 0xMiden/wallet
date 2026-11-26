import type { PendingRelayDeposit } from 'lib/evm-relay/pending-deposit';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { selectRelayChain } from 'lib/remote-config/values';
import { getBridgeNetworkByChainId } from 'screens/send-flow/bridge-networks';

/** The route of the deposit screen. */
export const DEPOSIT_SCREEN_PATH = '/bridge/deposit';

/** The route parameter that names the pending deposit the deposit screen opens on. */
export const PENDING_DEPOSIT_PARAM = 'pending';

/** The deposit screen, opened on the pending deposit `id`. */
export function pendingDepositPath(id: string): string {
  return `${DEPOSIT_SCREEN_PATH}?${PENDING_DEPOSIT_PARAM}=${encodeURIComponent(id)}`;
}

/** True when `pathname` is the deposit screen. */
export function isDepositScreenPath(pathname: string): boolean {
  return pathname === DEPOSIT_SCREEN_PATH || pathname.startsWith(`${DEPOSIT_SCREEN_PATH}/`);
}

/**
 * The pending deposits on a chain that the relay serves now, in their order. A deposit on another chain is not
 * shown and not read: the relay is off, or it does not serve that chain any more.
 */
export function servedPendingDeposits(
  deposits: readonly PendingRelayDeposit[],
  snapshot: BridgeConfigSnapshot
): PendingRelayDeposit[] {
  return deposits.filter(deposit => selectRelayChain(snapshot, deposit.chainId) !== null);
}

/** The name of the source network of a deposit, as the user reads it. The chain id when the wallet has no name. */
export function depositNetworkName(chainId: number): string {
  return getBridgeNetworkByChainId(chainId)?.name ?? String(chainId);
}
