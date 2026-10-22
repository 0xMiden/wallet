import { type EarnVaultInfo, type EarnVaultRoute, readEarnVaults } from './pools-read';

export {
  EARN_LENDER_FAMILY_NAMES,
  earnLenderFamily,
  earnMarketForVault,
  type EarnLenderFamily,
  type EarnVaultInfo
} from './pools-read';

// The same bound as one positions request: a stalled page would hold the whole read open.
const POOLS_REQUEST_TIMEOUT_MS = 15_000;

export type FetchEarnVaultsArgs = EarnVaultRoute;

export interface EarnVaultsResult {
  /** The supported vaults, highest `aprTotal` first. Empty when the read failed. */
  vaults: EarnVaultInfo[];
  /** Set when the read failed (a request failed or timed out, or a later page or the fallback failed). */
  error?: string;
  /** The lowercase market uid of each supported item that could not be read and was dropped. */
  droppedMarketUids?: string[];
  /** Set when an item that could not be read had no market uid. */
  droppedUnkeyed?: boolean;
}

/**
 * The Earn vault catalogue of one chain and token: `/pools` of the positions service, else the zero account's
 * positions on a host that has no `/pools` route (see `readEarnVaults`). Never rejects: a failed read resolves to no
 * vaults and an `error`.
 */
export async function fetchEarnVaults(args: FetchEarnVaultsArgs): Promise<EarnVaultsResult> {
  try {
    const read = await readEarnVaults((url, init) => fetch(url, init), args, POOLS_REQUEST_TIMEOUT_MS);
    return {
      vaults: read.vaults,
      ...(read.droppedMarketUids.length > 0 ? { droppedMarketUids: read.droppedMarketUids } : {}),
      ...(read.droppedUnkeyed ? { droppedUnkeyed: true } : {})
    };
  } catch (err) {
    return { vaults: [], error: err instanceof Error ? err.message : 'vault catalogue request threw' };
  }
}
