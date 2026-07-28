import { DEFAULT_NETWORK, MIDEN_FAUCET_API_ENDPOINTS } from './constants';

export interface PowChallenge {
  challenge: string;
  target: bigint;
}

export interface MintedNote {
  txId: string;
  noteId: string;
}

export function getFaucetApiUrl(networkId: string = DEFAULT_NETWORK): string {
  return MIDEN_FAUCET_API_ENDPOINTS.get(networkId) ?? MIDEN_FAUCET_API_ENDPOINTS.get(DEFAULT_NETWORK)!;
}

export async function getPowChallenge(baseUrl: string, accountId: string, amount: bigint): Promise<PowChallenge> {
  const params = new URLSearchParams({ account_id: accountId, amount: amount.toString() });
  const response = await fetch(`${baseUrl}/pow?${params}`);

  if (!response.ok) {
    throw new Error(`Faucet PoW request failed with status ${response.status}: ${await response.text()}`);
  }

  const json: { challenge: string; target: number } = await response.json();
  return { challenge: json.challenge, target: BigInt(json.target) };
}

// A nonce solves the challenge when the first 8 bytes of
// SHA-256(challengeBytes ‖ nonce_as_be_u64), read as a big-endian u64, are < target.
export async function solvePowChallenge(challengeHex: string, target: bigint): Promise<number> {
  const challengeBytes = hexToBytes(challengeHex);
  const buffer = new Uint8Array(challengeBytes.length + 8);
  buffer.set(challengeBytes);
  const view = new DataView(buffer.buffer);

  for (;;) {
    const nonce = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    view.setBigUint64(challengeBytes.length, BigInt(nonce), false);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
    if (new DataView(digest.buffer).getBigUint64(0, false) < target) {
      return nonce;
    }
  }
}

export async function requestTokens(
  baseUrl: string,
  accountId: string,
  amount: bigint,
  challenge: string,
  nonce: number
): Promise<MintedNote> {
  const params = new URLSearchParams({
    account_id: accountId,
    is_private_note: 'false',
    asset_amount: amount.toString(),
    challenge,
    nonce: nonce.toString()
  });
  const response = await fetch(`${baseUrl}/get_tokens?${params}`);

  if (!response.ok) {
    throw new Error(`Faucet token request failed with status ${response.status}: ${await response.text()}`);
  }

  const json: { tx_id: string; note_id: string } = await response.json();
  return { txId: json.tx_id, noteId: json.note_id };
}

export async function mintFromMidenFaucet(address: string, amount: bigint): Promise<MintedNote> {
  const baseUrl = getFaucetApiUrl();
  const { challenge, target } = await getPowChallenge(baseUrl, address, amount);
  const nonce = await solvePowChallenge(challenge, target);
  return requestTokens(baseUrl, address, amount, challenge, nonce);
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
