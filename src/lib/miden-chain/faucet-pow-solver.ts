// The faucet hashes challengeBytes followed by a big-endian u64 nonce and
// compares the first eight digest bytes, read as a big-endian u64, with target.
export async function findPowNonce(challengeHex: string, target: bigint): Promise<number> {
  const hex = challengeHex.startsWith('0x') ? challengeHex.slice(2) : challengeHex;
  const challenge = new Uint8Array(hex.length / 2);
  for (let i = 0; i < challenge.length; i++) challenge[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const buffer = new Uint8Array(challenge.length + 8);
  buffer.set(challenge);
  const view = new DataView(buffer.buffer);
  for (;;) {
    const nonce = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    view.setBigUint64(challenge.length, BigInt(nonce), false);
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    if (new DataView(digest).getBigUint64(0, false) < target) return nonce;
  }
}
