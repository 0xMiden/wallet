import { type Account, Word } from '@miden-sdk/miden-sdk/lazy';
import { AccountInspector } from '@openzeppelin/miden-multisig-client';

/**
 * Resolves an account's auth public-key commitments.
 *
 * Standard auth components use the SDK's interface. SDK 0.18 rejects custom auth
 * and components from a different standards revision instead of returning `[]`.
 * Those accounts retain the Guardian inspector fallback for their hot signer
 * (index 0); malformed account storage and WASM failures still propagate.
 * Read through `AccountInspector`, not hard-coded storage slot names: the
 * namespace changed when Guardian adopted upstream `AuthGuardedMultisig`.
 *
 * Returns `[]` if neither source yields a commitment (genuinely keyless account);
 * callers keep their existing empty-result handling.
 *
 * Callers must already hold the WASM client lock (`withWasmClientLock`).
 */
export function resolvePublicKeyCommitments(account: Account): Word[] {
  try {
    const fromInterface = account.getPublicKeyCommitments();
    if (fromInterface.length > 0) return fromInterface;
  } catch (error) {
    const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
    if (
      !message.startsWith(
        "cannot derive public key commitments from account state: the account's auth procedure is not owned by exactly one standard auth component bundled with this SDK"
      )
    )
      throw error;
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
