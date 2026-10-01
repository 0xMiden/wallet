/**
 * Whether `value` has the shape of a Guardian's public-key commitment: exactly one
 * 32-byte word of hex (64 digits), with or without a `0x` prefix. Every legitimate
 * operator serves one from `GET /pubkey`, so this is the one rule both the
 * liveness checks and the switch paths judge a Guardian by. Dependency-free, so the
 * lightweight picker modules can share it without pulling in the account code.
 */
export function isGuardianKeyCommitment(value: unknown): value is string {
  return typeof value === 'string' && /^(0x)?[0-9a-fA-F]{64}$/.test(value);
}
