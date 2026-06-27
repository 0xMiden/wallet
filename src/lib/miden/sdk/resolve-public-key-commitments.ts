import { type Account, Word } from '@miden-sdk/miden-sdk/lazy';

// Storage map + key layout owned by @openzeppelin/miden-multisig-client: a Guardian
// account keeps its signer commitments in this map, the hot signer at index 0.
// `getSignerDetailsFromAccount` in guardian/account.ts is the canonical (hot+cold)
// reader and documents why commitments must be read BY KEY, not by SMT position.
const OZ_SIGNER_PUBLIC_KEYS_SLOT = 'openzeppelin::multisig::signer_public_keys';
const hotSignerMapKey = (): Word => new Word(new BigUint64Array([0n, 0n, 0n, 0n]));

/**
 * Resolves an account's auth public-key commitments.
 *
 * Plain wallet accounts carry a miden-standards `AuthSingleSig` component, which
 * the SDK's `AccountInterface` recognizes, so `Account.getPublicKeyCommitments()`
 * returns the key. Guardian accounts instead carry OpenZeppelin's custom multisig
 * auth component (`@openzeppelin/miden-multisig-client`); its procedures live in
 * the `openzeppelin::auth::*` namespace, so they don't MAST-match any bundled
 * standard template, `AccountInterface` buckets the component as `Custom`, and
 * `getPublicKeyCommitments()` returns `[]`. For those accounts we read the hot
 * signer's commitment straight from the account's storage instead — the key the
 * wallet signs with, independent of component recognition.
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

  const hotSigner = account.storage().getMapItem(OZ_SIGNER_PUBLIC_KEYS_SLOT, hotSignerMapKey());
  if (hotSigner) {
    // An absent map entry can read back as the empty word (all zeros); treat that
    // as "no signer", matching getSignerDetailsFromAccount.
    const hex = hotSigner.toHex();
    const unprefixed = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (!/^0*$/.test(unprefixed)) {
      return [hotSigner];
    }
  }

  return [];
}
