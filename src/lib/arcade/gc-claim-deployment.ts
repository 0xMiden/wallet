import type { GcClaimContext } from './gc-claim-operation';

/** Reviewed, pinned deployment data. This is backend configuration, never an intercom input. */
export interface GcClaimDeployment extends Omit<GcClaimContext, 'accountId'> {
  claimScriptRoot: string;
  claimScriptBytes: Uint8Array;
  deploymentBlock: number;
  reclaimDelayBlocks: number;
  nativeSymbol: string;
  nativeDecimals: number;
}

/** Disabled until a reviewed deployment is pinned. Missing configuration is not eligibility. */
export async function resolveGcClaimDeployment(): Promise<GcClaimDeployment | undefined> {
  return undefined;
}
