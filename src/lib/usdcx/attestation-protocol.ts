import { Hash, Hex, hexToBigInt, hexToNumber, isHex } from 'viem';

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
  baseUrl: string;
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
  const proof = [payload, messageHash, attestation];
  if (!proof.every(value => isHex(value) && value !== '0x') || remoteDomain === undefined) return undefined;
  return { payload, messageHash, attestation, remoteDomain };
}

/**
 * Read Circle's attestations for one source-chain deposit transaction. The list
 * is empty until Circle's attestation service signs the deposit. Entries that
 * do not match the documented shape are dropped.
 */
export async function fetchXReserveAttestations(
  txHash: Hash,
  { baseUrl, timeoutMs = XRESERVE_FETCH_TIMEOUT_MS }: FetchXReserveAttestationsOptions
): Promise<XReserveAttestation[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/v1/attestations?txHash=${encodeURIComponent(txHash)}`, {
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`xReserve attestation request failed: HTTP ${response.status}`);
    }
    const body: object | string | number | boolean | null = await response.json();
    const list = body && typeof body === 'object' ? Reflect.get(body, 'attestations') : undefined;
    if (!Array.isArray(list)) return [];
    return list.map(parseAttestation).filter((entry): entry is XReserveAttestation => entry !== undefined);
  } finally {
    clearTimeout(timer);
  }
}

/** First 4 bytes of a Circle xReserve DepositIntent payload. */
export const XRESERVE_DEPOSIT_INTENT_MAGIC: Hex = '0x5a2e0acd';
export const XRESERVE_DEPOSIT_INTENT_VERSION = 1;
const DEPOSIT_INTENT_HEADER_BYTES = 240;

/**
 * Circle's xReserve DepositIntent, the message its attestation signs. Byte layout, checked on the captured
 * 0x370bf19a payload (240 bytes, no hook): magic@0[4] version@4[4] amount@8[32] remoteDomain@40[4]
 * remoteToken@44[32] remoteRecipient@76[32] localToken@108[32] localDepositor@140[32] maxFee@172[32] nonce@204[32]
 * hookLength@236[4] hookData@240[hookLength]. Hex fields are lower case.
 */
export interface XReserveDepositIntent {
  version: number;
  amount: bigint;
  remoteDomain: number;
  remoteToken: Hex;
  remoteRecipient: Hex;
  localToken: Hex;
  localDepositor: Hex;
  maxFee: bigint;
  nonce: Hex;
  /** `0x` when the hook length is 0. */
  hookData: Hex;
}

/** The deposit a payload describes, or `undefined` unless its magic, version 1 and length (240 + hook length) hold. */
export function decodeXReserveDepositIntent(payload: Hex): XReserveDepositIntent | undefined {
  if (!isHex(payload) || payload.length % 2 !== 0) return undefined;
  const body = payload.slice(2).toLowerCase();
  const bytes = (offset: number, length: number): Hex => `0x${body.slice(offset * 2, (offset + length) * 2)}`;
  if (body.length < DEPOSIT_INTENT_HEADER_BYTES * 2) return undefined;
  if (bytes(0, 4) !== XRESERVE_DEPOSIT_INTENT_MAGIC) return undefined;
  const version = hexToNumber(bytes(4, 4));
  if (version !== XRESERVE_DEPOSIT_INTENT_VERSION) return undefined;
  const hookLength = hexToNumber(bytes(236, 4));
  if (body.length !== (DEPOSIT_INTENT_HEADER_BYTES + hookLength) * 2) return undefined;
  return {
    version,
    amount: hexToBigInt(bytes(8, 32)),
    remoteDomain: hexToNumber(bytes(40, 4)),
    remoteToken: bytes(44, 32),
    remoteRecipient: bytes(76, 32),
    localToken: bytes(108, 32),
    localDepositor: bytes(140, 32),
    maxFee: hexToBigInt(bytes(172, 32)),
    nonce: bytes(204, 32),
    hookData: bytes(DEPOSIT_INTENT_HEADER_BYTES, hookLength)
  };
}

/** What the wallet expects Circle to attest for one of its deposits to Miden. */
export interface UsdcxDepositExpectation {
  /** The `remoteRecipient` bytes32 the deposit signed. */
  remoteRecipient: Hex;
  /** The native faucet's bytes32: xReserve's registry, not the deposit, names it, so it is checked here. */
  remoteToken: Hex;
  /** The row's amount, in USDC base units: an executor deposit pays its fee on top, so both routes match it. */
  amount: bigint;
  /** The Miden domain saved on the deposit. */
  remoteDomain: number;
}

export type UsdcxAttestationMismatchField = 'remoteDomain' | 'remoteToken' | 'recipient' | 'amount';

export type UsdcxAttestationMatch =
  | { kind: 'attested'; attestation: XReserveAttestation; intent: XReserveDepositIntent }
  | { kind: 'mismatch'; field: UsdcxAttestationMismatchField }
  | { kind: 'unreadable' }
  | { kind: 'pending' };

const sameHex = (left: Hex, right: Hex): boolean => left.toLowerCase() === right.toLowerCase();

function firstDifference(
  intent: XReserveDepositIntent,
  expected: UsdcxDepositExpectation,
  remoteDomain: number
): UsdcxAttestationMismatchField | undefined {
  if (intent.remoteDomain !== remoteDomain) return 'remoteDomain';
  if (!sameHex(intent.remoteToken, expected.remoteToken)) return 'remoteToken';
  if (!sameHex(intent.remoteRecipient, expected.remoteRecipient)) return 'recipient';
  if (intent.amount !== expected.amount) return 'amount';
  return undefined;
}

/**
 * Whether Circle attested what the wallet signed: the entry for the Miden domain must decode, and its domain, token,
 * recipient and amount must equal the expectation, compared in that order. The fee, the hook data and the depositor
 * are not compared: Circle mints a deposit's whole amount whatever fee it allowed, and an executor deposit's depositor
 * is Circle's handler. Across entries an attested one wins, then an unreadable one, then a mismatch.
 */
export function matchUsdcxDepositAttestation(
  list: readonly XReserveAttestation[],
  expected: UsdcxDepositExpectation
): UsdcxAttestationMatch {
  if (list.length === 0) return { kind: 'pending' };
  const remoteDomain = expected.remoteDomain;
  let unreadable = false;
  let mismatch: UsdcxAttestationMismatchField | undefined;
  for (const attestation of list) {
    if (attestation.remoteDomain !== remoteDomain) continue;
    const intent = decodeXReserveDepositIntent(attestation.payload);
    if (intent === undefined) {
      unreadable = true;
      continue;
    }
    const field = firstDifference(intent, expected, remoteDomain);
    if (field === undefined) return { kind: 'attested', attestation, intent };
    mismatch ??= field;
  }
  if (unreadable) return { kind: 'unreadable' };
  return { kind: 'mismatch', field: mismatch ?? 'remoteDomain' };
}

/** The attestation for one remote domain, if Circle signed it. */
export function findAttestationForDomain(
  attestations: XReserveAttestation[],
  remoteDomain: number
): XReserveAttestation | undefined {
  return attestations.find(entry => entry.remoteDomain === remoteDomain);
}
