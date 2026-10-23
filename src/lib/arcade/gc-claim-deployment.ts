import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';

import legacy from './deployments/testnet-gc-legacy.json';
import testnet from './deployments/testnet-gc.json';
import { GcClaimContext, gcClaimBindingKey, gcClaimU32, gcClaimWord } from './gc-claim-operation';

/** Reviewed, pinned deployment data. This is backend configuration, never an intercom input. */
export interface GcClaimDeployment extends Omit<GcClaimContext, 'accountId'> {
  claimScriptRoot: string;
  claimScriptBytes: Uint8Array;
  deploymentBlock: number;
  reclaimDelayBlocks: number;
  nativeSymbol: string;
  nativeDecimals: number;
}

export interface GcClaimDeploymentData extends Omit<GcClaimDeployment, 'claimScriptBytes'> {
  claimScriptHex: string;
}

/** Backend configuration decoder only; callers cannot select or activate a deployment through intercom. */
export function decodeGcClaimDeployment(data: GcClaimDeploymentData): GcClaimDeployment {
  gcClaimBindingKey(data);
  const distribution = data.distribution;
  if (
    data.network !== 'testnet' ||
    gcClaimU32(data.deploymentBlock) === 0 ||
    gcClaimU32(data.reclaimDelayBlocks) === 0 ||
    !/^(?:[0-9a-f]{2})+$/i.test(data.claimScriptHex) ||
    (distribution !== undefined &&
      (distribution.distributorId !== data.issuerId ||
        distribution.distributorCodeCommitment !== data.issuerCodeCommitment ||
        distribution.gcFaucetId === distribution.distributorId ||
        distribution.gcFaucetId === data.nativeAssetId ||
        distribution.distributorId === data.nativeAssetId))
  )
    throw new Error('Invalid GC claim deployment');
  gcClaimWord(data.genesisCommitment);
  gcClaimWord(data.issuerCodeCommitment);
  gcClaimWord(data.claimScriptRoot);
  const { claimScriptHex, ...identity } = data;
  return {
    ...identity,
    ...(distribution === undefined ? {} : { distribution: { ...distribution } }),
    claimScriptBytes: Uint8Array.from(claimScriptHex.match(/.{2}/g) ?? [], byte => Number.parseInt(byte, 16))
  };
}

/** Pinned inventory-backed Testnet distributor. Mainnet and other networks remain unavailable. */
export async function resolveGcClaimDeployment(): Promise<GcClaimDeployment | undefined> {
  if (getEffectiveNetworkName() !== 'testnet') return undefined;
  const distribution = testnet.distribution;
  if (distribution.protocolVersion !== 2) throw new Error('Invalid active GC protocol');
  return decodeGcClaimDeployment({
    ...testnet,
    network: 'testnet',
    distribution: { ...distribution, protocolVersion: distribution.protocolVersion }
  });
}

/** Retained only for prior receipts and budget recovery, never for new claims. */
export async function resolveLegacyGcClaimDeployment(): Promise<GcClaimDeployment | undefined> {
  if (getEffectiveNetworkName() !== 'testnet') return undefined;
  return decodeGcClaimDeployment({ ...legacy, network: 'testnet' });
}
