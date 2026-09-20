/**
 * Unit cover for the miden-client version guard.
 *
 * The guard's whole job is to stop a mismatched CLI reaching the node, because
 * the node rejects it with `server rejected request … version mismatch`, which
 * names neither the binary nor the version and reads like a wallet fault. A
 * substring comparison let the single most likely mismatch - a prerelease build
 * of the pinned version - through, so these cases pin the distinction.
 */
import { reportedVersionMatches } from './miden-cli';

describe('reportedVersionMatches', () => {
  it('accepts the exact pin', () => {
    expect(reportedVersionMatches('miden-client 0.16.0', '0.16.0')).toBe(true);
  });

  it('rejects a prerelease of the pinned version', () => {
    // The regression: `includes()` said true here, and the run then failed
    // inside a CLI call against public testnet instead of at resolution.
    expect(reportedVersionMatches('miden-client 0.16.0-rc.5', '0.16.0')).toBe(false);
  });

  it('rejects a stable build when the pin is a prerelease', () => {
    // The node matches the prerelease LABEL, so this direction fails too.
    expect(reportedVersionMatches('miden-client 0.16.0', '0.16.0-rc.5')).toBe(false);
  });

  it('accepts a prerelease that matches the pin exactly', () => {
    expect(reportedVersionMatches('miden-client 0.16.0-rc.5', '0.16.0-rc.5')).toBe(true);
  });

  it('does not treat a longer patch number as the pin', () => {
    // `"0.16.10".includes("0.16.1")` is true; a token comparison is not fooled.
    expect(reportedVersionMatches('miden-client 0.16.10', '0.16.1')).toBe(false);
  });

  it('rejects a different version', () => {
    expect(reportedVersionMatches('miden-client 0.16.1', '0.16.0')).toBe(false);
  });

  it('rejects output carrying no version at all', () => {
    expect(reportedVersionMatches('miden-client', '0.16.0')).toBe(false);
  });
});
