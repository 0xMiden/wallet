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
 * The Guardian lookup-auth domain tag as four field elements: `domainTagWord('guardian.lookup.v1')` in
 * `@openzeppelin/miden-multisig-client` (`lookupAuth.js`). The package does not export the tag, so it is written
 * here. `dapp-sign-inputs.real-sdk.test.ts` derives it again on the real SDK and pins it against `lookupAuthDigest`.
 */
export const GUARDIAN_LOOKUP_DOMAIN_TAG: readonly bigint[] = [
  12760442403760176969n,
  2807383406242250561n,
  12812781962877582355n,
  4063594356491030589n
];

/**
 * True when `elements` has the layout of a protocol message that the hot key must not sign as arbitrary inputs:
 * a transaction summary (24 elements, the first is version 1) or a Guardian lookup-auth message (9 elements, the
 * first four are the lookup domain tag).
 */
export function isProtocolMessageLayout(elements: readonly bigint[]): boolean {
  switch (elements.length) {
    case TRANSACTION_SUMMARY_ELEMENT_COUNT:
      return elements[0] === TRANSACTION_SUMMARY_VERSION;
    case GUARDIAN_LOOKUP_ELEMENT_COUNT:
      return GUARDIAN_LOOKUP_DOMAIN_TAG.every((tagElement, index) => elements[index] === tagElement);
    default:
      return false;
  }
}
