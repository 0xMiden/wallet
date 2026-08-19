/**
 * The shape of a wallet account id, in one place.
 *
 * The wallet reports a COMPOSITE id: `<bech32 address>_<suffix>`, e.g.
 * `mtst1arkw66qkadrf5g2j7km9u7pqrqs3ze5n_qr7qqq9wr6w`. An anchored pattern that
 * stops at the bech32 part rejects every real address, and that exact mistake
 * has now been made three separate times in this suite — each time as a
 * hand-rolled `/^m[a-z]{1,4}1[a-z0-9]+$/` that failed on the first live run.
 *
 * Import these instead of writing the pattern again.
 */

/** Anchored: the WHOLE string must be an account id, composite suffix included. */
export const ACCOUNT_ID_RE = /^m[a-z]{1,4}1[a-z0-9]+(_[a-z0-9]+)?$/i;

/**
 * Prefix probe: "this string STARTS with an account id". Use when reading a
 * value that may carry trailing content; use ACCOUNT_ID_RE to validate a value
 * that should be nothing but an id.
 */
export const ACCOUNT_ID_PREFIX_RE = /^m[a-z]{1,4}1[a-z0-9]+/i;
