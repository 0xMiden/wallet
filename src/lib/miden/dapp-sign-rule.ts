/**
 * The rule for a dApp signature request (`signBytes`) on a Guardian account. Every wallet account is a Guardian
 * account, and its hot key signs a request only when the request obeys this rule. The dApp receives this text when
 * the wallet refuses a request.
 *
 * This module has no SDK import, so the E2E harness can read it. `dapp-sign-inputs.ts` applies the rule to a payload.
 */
export const DAPP_SIGN_RULE =
  'This wallet signs only arbitrary signing inputs that carry their preimage. It refuses a raw word, a blind ' +
  'commitment, a transaction summary, and a preimage with the layout of a transaction summary or a Guardian lookup.';

/**
 * The number of field elements in `TransactionSummary::to_elements` (miden-protocol 0.17, `tx_summary.rs`,
 * `TransactionSummary::NUM_ELEMENTS`): the version, one metadata element, six user parameters and four words.
 */
export const TRANSACTION_SUMMARY_ELEMENT_COUNT = 24;

/** The first field element of `TransactionSummary::to_elements`: the summary version (`TransactionSummary::VERSION`). */
export const TRANSACTION_SUMMARY_VERSION = 1n;

/**
 * The number of field elements in a Guardian lookup-auth message: the four domain-tag elements, the timestamp and
 * the four elements of the key commitment (`lookupAuthDigest` in `@openzeppelin/miden-multisig-client`).
 */
export const GUARDIAN_LOOKUP_ELEMENT_COUNT = 9;

/**
 * The domain string of the Guardian lookup-auth tag. It mirrors `DOMAIN_TAG_BYTES` in
 * `@openzeppelin/miden-multisig-client/dist/lookupAuth.js`. The package does not export the tag, so
 * `dapp-sign-inputs.ts` derives it from this string as the package does (`domainTagWord` in `dist/utils/felt.js`).
 */
export const GUARDIAN_LOOKUP_DOMAIN_STRING = 'guardian.lookup.v1';

/** The Goldilocks field order (`2^64 - 2^32 + 1`), as `FELT_ORDER` in the multisig client's `dist/utils/felt.js`. */
const FELT_ORDER = 0xffffffff00000001n;

/**
 * The field elements that `domainTagWord` hashes for `domain`: its UTF-8 bytes packed as 8-byte little-endian
 * values, the last one padded with zeros, each one reduced modulo the field order (`feltFromU64Reduced`).
 */
export function domainTagPreimage(domain: string): bigint[] {
  const bytes = new TextEncoder().encode(domain);
  const elements: bigint[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8) {
    let value = 0n;
    for (let index = 0; index < 8; index += 1) {
      value |= BigInt(bytes[offset + index] ?? 0) << BigInt(8 * index);
    }
    elements.push(value % FELT_ORDER);
  }
  return elements;
}

/** The domain tags that `isProtocolMessageLayout` compares a preimage with. */
export interface ProtocolTags {
  /** The Guardian lookup-auth domain tag as four field elements. */
  readonly guardianLookup: readonly bigint[];
}

/**
 * True when `elements` has the layout of a protocol message that the hot key must not sign as arbitrary inputs:
 * a transaction summary (24 elements, the first is version 1) or a Guardian lookup-auth message (9 elements, the
 * first four are the lookup domain tag in `tags`).
 */
export function isProtocolMessageLayout(elements: readonly bigint[], tags: ProtocolTags): boolean {
  switch (elements.length) {
    case TRANSACTION_SUMMARY_ELEMENT_COUNT:
      return elements[0] === TRANSACTION_SUMMARY_VERSION;
    case GUARDIAN_LOOKUP_ELEMENT_COUNT:
      return tags.guardianLookup.every((tagElement, index) => elements[index] === tagElement);
    default:
      return false;
  }
}
