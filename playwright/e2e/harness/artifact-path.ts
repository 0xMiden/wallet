/**
 * A per-test artifact directory name that `actions/upload-artifact` will accept.
 *
 * The fixtures name each run's output directory after the test's title path. A
 * title is prose, so it can contain anything — and GitHub rejects an ENTIRE
 * artifact if any single path inside it contains one of:
 *
 *   double-quote, colon, less-than, greater-than, pipe, asterisk, question mark,
 *   carriage return, line feed
 *
 * That is not a theoretical constraint. `receive-address.spec.ts`'s title —
 * "QR encodes miden:<publicKey> and the copy button writes the bare publicKey" —
 * carries a colon and angle brackets, so `Chrome E2E (testnet)` on main ran the
 * whole suite GREEN and then failed the job on `Upload artifacts`:
 *
 *   ##[error]The path for one of the files in artifact is not valid: …
 *   QR_encodes_miden:<publicKey>_and_the_copy_button_writes_the_bare_publicKey/…
 *
 * A green test run reported as a red job, with the diagnostics for it thrown
 * away — the exact opposite of what the artifact is for.
 *
 * Path separators go too: "random send/claim" (stress.spec.ts) silently split
 * one test's run directory into nested folders.
 *
 * Kept in one place because three fixtures (chrome, iOS, Android) each build
 * this name, and a fix applied to one of them is a fix the other two re-break.
 */

/**
 * Anything that is not a safe path-component character collapses to `-`.
 *
 * An ALLOW-list, not a deny-list: the set of characters GitHub rejects is not
 * the same as the set Windows rejects, which is not the same as the set that
 * confuses a shell, and a deny-list silently grows a hole every time a test
 * title reaches for a new symbol. Letters, digits, `_`, `.` and `-` are enough
 * to keep a directory name readable.
 */
const UNSAFE_PATH_CHARS = /[^a-zA-Z0-9_.-]/g;

export function testArtifactDirName(titlePath: readonly string[]): string {
  const sanitized = titlePath
    .join('-')
    .replace(/\s+/g, '_')
    .replace(UNSAFE_PATH_CHARS, '-')
    // Collapse the separator runs the substitution above creates, so the name
    // stays readable rather than turning into "a---b----c".
    .replace(/-{2,}/g, '-')
    // A leading dot hides the directory; a trailing dot or dash is invalid or
    // ugly. Trim both ends down to something alphanumeric.
    .replace(/^[^a-zA-Z0-9]+/, '')
    .replace(/[^a-zA-Z0-9]+$/, '')
    // Long titles plus a long CI workspace prefix can exceed path limits, and
    // the tail of a title is rarely what identifies it.
    .slice(0, 120);

  return sanitized || 'test';
}
