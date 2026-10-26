import { type Account, Word } from '@miden-sdk/miden-sdk/lazy';
import { AccountInspector } from '@openzeppelin/miden-multisig-client';

/**
 * Resolves an account's auth public-key commitments.
 *
 * Plain wallet accounts carry a miden-standards `AuthSingleSig` component, which
 * the SDK's `AccountInterface` recognizes, so `Account.getPublicKeyCommitments()`
 * returns the key. Guardian accounts historically carried OpenZeppelin's custom
 * multisig auth component, whose procedures lived outside the standards
 * namespace: nothing MAST-matched a bundled template, `AccountInterface` bucketed
 * it as `Custom`, and `getPublicKeyCommitments()` returned `[]`. For those we
 * read the hot signer's commitment out of the account instead — the key the
 * wallet signs with, independent of component recognition.
 *
 * Since multisig-client 0.17 the component IS the upstream `AuthGuardedMultisig`,
 * so the interface branch is expected to answer for Guardian accounts too and
 * this fallback should be unreachable. It is kept because being wrong about that
 * costs a keyless account, and it goes through `AccountInspector` rather than a
 * hard-coded storage slot name — the wallet previously inlined those names and
 * they broke silently when the component changed namespace in that same release.
 *
 * Returns `[]` if neither source yields a commitment (genuinely keyless account);
 * callers keep their existing empty-result handling.
 *
 * Callers must already hold the WASM client lock (`withWasmClientLock`).
 */
export function resolvePublicKeyCommitments(account: Account): Word[] {
  const fromInterface = account.getPublicKeyCommitments();
  if (fromInterface.length > 0) {
    return fromInterface;
  }

  let hotSignerHex: string | undefined;
  try {
    // Ordered by signer index; the wallet's hot signer is index 0.
    [hotSignerHex] = AccountInspector.getSignerPublicKeyCommitments(account);
  } catch {
    // Not a guarded-multisig account (or an unreadable one): no commitment.
    return [];
  }

  if (hotSignerHex === undefined) return [];

  // An absent entry can read back as the empty word (all zeros); treat that as
  // "no signer", matching getSignerDetailsFromAccount.
  const unprefixed = hotSignerHex.startsWith('0x') ? hotSignerHex.slice(2) : hotSignerHex;
  if (/^0*$/.test(unprefixed)) return [];

  return [Word.fromHex(`0x${unprefixed}`)];
}
