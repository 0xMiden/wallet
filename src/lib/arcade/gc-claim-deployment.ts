import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';

import testnet from './deployments/testnet-gc.json';
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

/** Pinned replacement issuer. Mainnet and other networks remain unavailable. */
export async function resolveGcClaimDeployment(): Promise<GcClaimDeployment | undefined> {
  if (getEffectiveNetworkName() !== 'testnet') return undefined;
  const { claimScriptHex, ...identity } = testnet;
  return {
    ...identity,
    network: 'testnet',
    claimScriptBytes: Uint8Array.from(claimScriptHex.match(/.{2}/g) ?? [], byte => Number.parseInt(byte, 16))
  };
}
