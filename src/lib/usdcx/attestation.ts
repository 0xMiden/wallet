import { Hash, Hex, isHex } from 'viem';

import { XRESERVE_ATTESTATION_API } from './constant';

// Circle's API can accept the socket and then stay silent. Bound every request
// so a poll tick fails and retries instead of hanging the status screen.
const XRESERVE_FETCH_TIMEOUT_MS = 15_000;

/** One entry of Circle's `GET /v1/attestations?txHash=` response. */
export interface XReserveAttestation {
  /** The encoded deposit message. */
  payload: Hex;
  /** The deposit message hash that identifies the attestation. */
  messageHash: Hex;
  /** Circle's signature over the payload. */
  attestation: Hex;
  /** The remote domain the deposit is for. */
  remoteDomain: number;
}

export interface FetchXReserveAttestationsOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

function parseRemoteDomain(value: unknown): number | undefined {
  switch (typeof value) {
    case 'number':
      return Number.isInteger(value) ? value : undefined;
    case 'string': {
      const parsed = Number(value);
      return /^\d+$/.test(value) && Number.isInteger(parsed) ? parsed : undefined;
    }
    default:
      return undefined;
  }
}

function parseAttestation(entry: unknown): XReserveAttestation | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const payload = Reflect.get(entry, 'payload');
  const messageHash = Reflect.get(entry, 'messageHash');
  const attestation = Reflect.get(entry, 'attestation');
  const remoteDomain = parseRemoteDomain(Reflect.get(entry, 'remoteDomain'));
  if (!isHex(payload) || !isHex(messageHash) || !isHex(attestation) || remoteDomain === undefined) return undefined;
  return { payload, messageHash, attestation, remoteDomain };
}

/**
 * Read Circle's attestations for one source-chain deposit transaction. The list
 * is empty until Circle's attestation service signs the deposit. Entries that
 * do not match the documented shape are dropped.
 */
export async function fetchXReserveAttestations(
  txHash: Hash,
  { baseUrl = XRESERVE_ATTESTATION_API, timeoutMs = XRESERVE_FETCH_TIMEOUT_MS }: FetchXReserveAttestationsOptions = {}
): Promise<XReserveAttestation[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/attestations?txHash=${encodeURIComponent(txHash)}`, {
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`xReserve attestation request failed: HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  const list = body && typeof body === 'object' ? Reflect.get(body, 'attestations') : undefined;
  if (!Array.isArray(list)) return [];
  return list.map(parseAttestation).filter((entry): entry is XReserveAttestation => entry !== undefined);
}

/** The attestation for one remote domain, if Circle signed it. */
export function findAttestationForDomain(
  attestations: XReserveAttestation[],
  remoteDomain: number
): XReserveAttestation | undefined {
  return attestations.find(entry => entry.remoteDomain === remoteDomain);
}
