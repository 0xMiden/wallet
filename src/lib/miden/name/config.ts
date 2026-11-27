/**
 * Miden Name deployment config and contract constants.
 */

import type { AssetMetadata } from 'lib/miden/metadata/types';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NAME_DEPLOYMENTS, MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

import { REGISTER_DOMAIN_SCRIPT_ROOT_HEX } from './note-script-roots';

export { MIDEN_NAME_MAX_LENGTH, MIDEN_NAME_SUFFIX } from './encoding';

export interface MidenNameConfig {
  network: MIDEN_NETWORK_NAME;
  registryAccountIdHex: string;
  paymentFaucetIdHex: string;
  registryCreationBlock: number;
}

/** Storage slot names of the domain network account (contract v0.17). */
export const MIDEN_NAME_SLOTS = {
  assetStatus: 'domain_faucet::domain_faucet::asset_status',
  tokenToDomain: 'domain_faucet::domain_faucet::token_to_domain',
  prices: 'domain_faucet::domain_faucet::prices',
  commitmentVersion: 'domain_faucet::domain_faucet::commitment_version',
  domainToAccount: 'domain_registry::domain_registry::domain_to_account',
  registerDomainNoteRoot: 'domain_registry::domain_registry::register_domain_note_root',
  feeSchedule: 'miden::standards::fees::policies::basic_constant_fee::fee_schedule'
} as const;

/** MAST root of the register-domain note script (0x-prefixed hex). */
export const MIDEN_NAME_REGISTER_SCRIPT_ROOT = REGISTER_DOMAIN_SCRIPT_ROOT_HEX;

/** Blocks after the chain tip at which the payer can reclaim a register note. */
export const MIDEN_NAME_RECLAIM_BLOCKS = 300;

/** The only `commitment_version` that this wallet can encode keys for. */
export const MIDEN_NAME_COMMITMENT_VERSION = 1n;

/** Felt 0 of an `asset_status` entry for an issued name. */
export const MIDEN_NAME_ISSUED_MARKER = 1n;

/** Felt 3 of a `fee_schedule` entry. The contract writes [fee, 0, 0, 1]. */
export const MIDEN_NAME_FEE_ENTRY_MARKER = 1n;

/**
 * Return the Miden Name deployment of a network, or undefined when the network
 * has no deployment. The default is the effective network.
 */
export function getMidenNameConfig(
  network: MIDEN_NETWORK_NAME = getEffectiveNetworkName()
): MidenNameConfig | undefined {
  const deployment = MIDEN_NAME_DEPLOYMENTS.get(network);
  if (!deployment) return undefined;
  return {
    network,
    registryAccountIdHex: deployment.registryAccountIdHex,
    paymentFaucetIdHex: deployment.paymentFaucetIdHex,
    registryCreationBlock: deployment.registryCreationBlock
  };
}

/** True when the effective network has a Miden Name deployment. */
export function isMidenNameSupported(): boolean {
  return getMidenNameConfig() !== undefined;
}

/** Payment token of the v17 testnet deployment. */
export const MIDEN_NAME_PAYMENT_METADATA: AssetMetadata = { decimals: 6, symbol: 'USDCX', name: 'USDCX' };
