import { Hash, Hex, isHash, isHex } from 'viem';

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
}

/** The message and proof `GenericExecutor.execute` takes, once Circle attested the burn. */
export interface AttestedCctpMessage {
  message: Hex;
  attestation: Hex;
}

export interface FetchCctpMessagesOptions {
  baseUrl: string;
  timeoutMs?: number;
}

function parseMessage(entry: unknown): CctpMessage | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const message = Reflect.get(entry, 'message');
  const attestation = Reflect.get(entry, 'attestation');
  const status = Reflect.get(entry, 'status');
  const eventNonce = Reflect.get(entry, 'eventNonce');
  if (!isHex(message)) return undefined;
  if (attestation !== 'PENDING' && !isHex(attestation)) return undefined;
  if (status !== 'complete' && status !== 'pending_confirmations') return undefined;
  return { message, attestation, status, eventNonce: typeof eventNonce === 'string' ? eventNonce : undefined };
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
  return { message: attested.message, attestation: attested.attestation };
}
