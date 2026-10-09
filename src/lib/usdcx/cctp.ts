import { Address, Hash, Hex, isHash, isHex } from 'viem';

// Circle's API can accept the socket and then stay silent. Bound every request
// so a poll tick fails and retries instead of hanging the status screen.
const IRIS_FETCH_TIMEOUT_MS = 15_000;

/** One CCTP V2 message of a source transaction, as Iris `GET /v2/messages/{sourceDomain}` reports it. */
export interface CctpMessage {
  /** The encoded message; `0x` until Circle attests it. */
  message: Hex;
  /** Circle's signature over the message; `PENDING` until Circle attests it. */
  attestation: Hex | 'PENDING';
  status: 'complete' | 'pending_confirmations';
  eventNonce?: string;
  /** The forwarding service's state for this message, when the burn paid a forward fee. */
  forwardState?: string;
  /** The destination transaction the forwarding service sent, once it did. */
  forwardTxHash?: Hash;
}

/** The message and proof `GenericExecutor.execute` takes, once Circle attested the burn. */
export interface AttestedCctpMessage {
  message: Hex;
  attestation: Hex;
  forwardState?: string;
  forwardTxHash?: Hash;
}

export interface FetchCctpMessagesOptions {
  baseUrl: string;
  timeoutMs?: number;
}

/** Whether a forwarding state reported by Iris means Circle gave up on the forward. */
export function isCctpForwardFailed(forwardState: string | undefined): boolean {
  return forwardState !== undefined && /fail|reject|error|cancel/i.test(forwardState);
}

function parseMessage(entry: unknown): CctpMessage | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const message = Reflect.get(entry, 'message');
  const attestation = Reflect.get(entry, 'attestation');
  const status = Reflect.get(entry, 'status');
  const eventNonce = Reflect.get(entry, 'eventNonce');
  const forwardState = Reflect.get(entry, 'forwardState');
  const forwardTxHash = Reflect.get(entry, 'forwardTxHash');
  if (!isHex(message)) return undefined;
  if (attestation !== 'PENDING' && !isHex(attestation)) return undefined;
  if (status !== 'complete' && status !== 'pending_confirmations') return undefined;
  return {
    message,
    attestation,
    status,
    eventNonce: typeof eventNonce === 'string' ? eventNonce : undefined,
    forwardState: typeof forwardState === 'string' && forwardState ? forwardState : undefined,
    forwardTxHash: isHash(forwardTxHash) ? forwardTxHash : undefined
  };
}

/**
 * Read the CCTP messages of one source-chain burn transaction. Iris answers 404 until it has indexed the
 * burn, which reads as an empty list; entries that do not match the documented shape are dropped.
 */
export async function fetchCctpMessages(
  sourceDomain: number,
  txHash: Hash,
  { baseUrl, timeoutMs = IRIS_FETCH_TIMEOUT_MS }: FetchCctpMessagesOptions
): Promise<CctpMessage[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${baseUrl}/v2/messages/${sourceDomain}?transactionHash=${encodeURIComponent(txHash)}`,
      { signal: controller.signal }
    );
    if (response.status === 404) return [];
    if (!response.ok) {
      throw new Error(`CCTP message request failed: HTTP ${response.status}`);
    }
    const body: object | string | number | boolean | null = await response.json();
    const list = body && typeof body === 'object' ? Reflect.get(body, 'messages') : undefined;
    if (!Array.isArray(list)) return [];
    return list.map(parseMessage).filter((entry): entry is CctpMessage => entry !== undefined);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The attested message of a burn, or `undefined` while Circle has not signed it. A value that is not a
 * transaction hash is never attested, and no request is made for it.
 */
export async function fetchAttestedCctpMessage(
  sourceDomain: number,
  txHash: string | undefined,
  options: FetchCctpMessagesOptions
): Promise<AttestedCctpMessage | undefined> {
  if (txHash === undefined || !isHash(txHash)) return undefined;
  const messages = await fetchCctpMessages(sourceDomain, txHash, options);
  const attested = messages.find(entry => entry.status === 'complete' && entry.attestation !== 'PENDING');
  if (!attested || attested.attestation === 'PENDING' || attested.message === '0x') return undefined;
  return {
    message: attested.message,
    attestation: attested.attestation,
    forwardState: attested.forwardState,
    forwardTxHash: attested.forwardTxHash
  };
}

/** A signed fee quote from Iris `POST /v2/quote/burn/usdc/{source}/{destination}`. */
export interface CctpBurnQuote {
  /** The blob `TokenMessengerWithFees` takes in its claim. */
  signedQuote: Hex;
  /** The whole fee, in the fee token's base units, taken on top of the burn amount. */
  feeTotalAmount: bigint;
  /** Unix seconds the quote stops being accepted, when Iris states one. About two minutes from issue. */
  expiresAt?: number;
}

export interface FetchCctpBurnQuoteOptions extends FetchCctpMessagesOptions {
  amount: bigint;
  /** The source chain's USDC, so the fee is priced and paid in USDC. */
  feeToken: Address;
  /** The executor as a 32-byte value; the forward fee is bound to it. */
  destinationCaller: Hex;
  /** The full hook data of the burn; the forward fee is bound to it. */
  hookData: Hex;
  /** Also price a Fast Transfer, so Circle attests before source finality. */
  fast: boolean;
}

/** Circle refused to price this burn: the workflow, chain or hook data is not supported. */
export class CctpQuoteRefusedError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string, message: string) {
    super(message);
    this.name = 'CctpQuoteRefusedError';
    this.errorCode = errorCode;
  }
}

function readExpiry(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const expiresAt = Reflect.get(value, 'expiresAt');
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? expiresAt : undefined;
}

/**
 * Ask Circle to price a burn through the fee entry point: a forward fee for executing the message on the
 * destination, and the fast-transfer fee when asked. The quote is bound to every value sent here and expires
 * in about two minutes, so it is fetched right before the burn.
 */
export async function fetchCctpBurnQuote(
  sourceDomain: number,
  destinationDomain: number,
  {
    baseUrl,
    timeoutMs = IRIS_FETCH_TIMEOUT_MS,
    amount,
    feeToken,
    destinationCaller,
    hookData,
    fast
  }: FetchCctpBurnQuoteOptions
): Promise<CctpBurnQuote> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const requests: object[] = [{ type: 'FORWARD', params: { destinationCaller, hookData } }];
    if (fast) requests.unshift({ type: 'PRE_FINALITY' });
    const response = await fetch(`${baseUrl}/v2/quote/burn/usdc/${sourceDomain}/${destinationDomain}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ amount: amount.toString(), feeToken, requests }),
      signal: controller.signal
    });
    const body: object | string | number | boolean | null = await response.json().catch(() => null);
    const read = (key: string): unknown => (body && typeof body === 'object' ? Reflect.get(body, key) : undefined);
    if (!response.ok) {
      const errorCode = read('errorCode');
      const error = read('error');
      throw new CctpQuoteRefusedError(
        typeof errorCode === 'string' ? errorCode : `HTTP_${response.status}`,
        typeof error === 'string' ? error : `CCTP quote request failed: HTTP ${response.status}`
      );
    }
    const signedQuote = read('signedQuote');
    const feeTotalAmount = read('feeTotalAmount');
    if (!isHex(signedQuote) || typeof feeTotalAmount !== 'string' || !/^\d+$/.test(feeTotalAmount)) {
      throw new Error('CCTP quote response is missing the signed quote or the fee');
    }
    return { signedQuote, feeTotalAmount: BigInt(feeTotalAmount), expiresAt: readExpiry(read('expiry')) };
  } finally {
    clearTimeout(timer);
  }
}
