import type { Hash } from 'viem';

import {
  fetchXReserveAttestations as fetchAttestations,
  matchUsdcxDepositAttestation as matchAttestation,
  type UsdcxDepositExpectation as ProtocolExpectation,
  type UsdcxAttestationMatch,
  type XReserveAttestation
} from './attestation-protocol';
import { getUsdcxRemoteDomain, getUsdcxAttestationUrl } from './constant';

export {
  decodeXReserveDepositIntent,
  findAttestationForDomain,
  XRESERVE_DEPOSIT_INTENT_MAGIC,
  XRESERVE_DEPOSIT_INTENT_VERSION
} from './attestation-protocol';
export type {
  XReserveAttestation,
  XReserveDepositIntent,
  UsdcxAttestationMatch,
  UsdcxAttestationMismatchField
} from './attestation-protocol';

export interface FetchXReserveAttestationsOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

export type UsdcxDepositExpectation = Omit<ProtocolExpectation, 'remoteDomain'> & { remoteDomain?: number };

/** Read attestations with the saved service URL, or the current provider URL for an older row. */
export async function fetchXReserveAttestations(
  txHash: Hash,
  options: FetchXReserveAttestationsOptions = {}
): Promise<XReserveAttestation[]> {
  return fetchAttestations(txHash, { ...options, baseUrl: options.baseUrl ?? getUsdcxAttestationUrl() });
}

/** Match the saved domain, or the current provider domain for an older row. */
export function matchUsdcxDepositAttestation(
  list: readonly XReserveAttestation[],
  expected: UsdcxDepositExpectation
): UsdcxAttestationMatch {
  return matchAttestation(list, { ...expected, remoteDomain: expected.remoteDomain ?? getUsdcxRemoteDomain() });
}
