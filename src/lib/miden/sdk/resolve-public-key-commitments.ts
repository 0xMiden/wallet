import { type Account, Word } from '@miden-sdk/miden-sdk/lazy';
import { AccountInspector } from '@openzeppelin/miden-multisig-client';

import { sameCommitment } from 'lib/secure-hot-key/commitment';

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
 * The fallback picks THIS DEVICE's hot signer when the caller knows its
 * commitment (`ownHotCommitment`, derived from the device's hot public key with
 * `commitmentFromPublicKeyHex`): the signer set can hold more than one hot key,
 * and a membership change moves the slots, so slot 0 is not this device's by
 * position. Without that commitment, or when no slot holds it, the fallback
 * keeps the creation convention and returns signer index 0.
 *
 * Returns `[]` if neither source yields a commitment (genuinely keyless account);
 * callers keep their existing empty-result handling.
 *
 * Callers must already hold the WASM client lock (`withWasmClientLock`).
 */
export function resolvePublicKeyCommitments(account: Account, ownHotCommitment?: string): Word[] {
  try {
    const fromInterface = account.getPublicKeyCommitments();
    if (fromInterface.length > 0) return ownHotSignerFirst(fromInterface, ownHotCommitment);
  } catch (error) {
    const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
    if (
      !message.startsWith(
        "cannot derive public key commitments from account state: the account's auth procedure is not owned by exactly one standard auth component bundled with this SDK"
      )
    )
      throw error;
  }

  let signerHexes: string[];
  try {
    signerHexes = AccountInspector.getSignerPublicKeyCommitments(account).map(String);
  } catch {
    // Not a guarded-multisig account (or an unreadable one): no commitment.
    return [];
  }

  // This device's own hot signer, in any slot, else signer index 0 (the creation convention).
  const ownHotSigner =
    ownHotCommitment === undefined
      ? undefined
      : signerHexes.find(signerHex => sameCommitment(signerHex, ownHotCommitment));
  const hotSignerHex = ownHotSigner ?? signerHexes[0];

  if (hotSignerHex === undefined) return [];

  // An absent entry can read back as the empty word (all zeros); treat that as
  // "no signer", matching getSignerDetailsFromAccount and findOwnSignerCommitment.
  const unprefixed = hotSignerHex.startsWith('0x') ? hotSignerHex.slice(2) : hotSignerHex;
  if (/^0*$/.test(unprefixed)) return [];

  return [Word.fromHex(`0x${unprefixed}`)];
}

/**
 * Puts this device's hot signer first. Callers read `[0]` as the key the wallet signs with, and the
 * interface lists the signers in slot order, where an added device follows the earlier ones.
 */
function ownHotSignerFirst(commitments: Word[], ownHotCommitment: string | undefined): Word[] {
  if (ownHotCommitment === undefined) return commitments;
  const ownIndex = commitments.findIndex(commitment => sameCommitment(commitment.toHex(), ownHotCommitment));
  if (ownIndex <= 0) return commitments;
  const own = commitments[ownIndex]!;
  return [own, ...commitments.filter((_, index) => index !== ownIndex)];
}
