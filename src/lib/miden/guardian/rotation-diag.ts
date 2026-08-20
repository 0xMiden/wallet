/**
 * TEMPORARY DIAGNOSTIC — delete once the guardian rotation zero-commitment race
 * is understood and fixed.
 *
 * `guardian-recovery.spec.ts` intermittently fails on `main` because the
 * post-recovery hot-key rotation is rejected by the node:
 *
 *   initial account commitment 0x0000…0000 does not match the current
 *   commitment 0x41978d… for account 0x2cb3bb1e…
 *
 * An initial commitment of zero means the transaction was built as if the
 * account had never been on chain. The failing run's trace rules out a stale
 * guardian: walletB's own context received the account state at the same
 * commitment the node reported as current. So the state was right and the
 * transaction was still built as a creation — which points at whether the
 * client tracks an `accounts.insert`ed account as committed.
 *
 * These lines answer that. Service-worker console is captured into the
 * blockchain harness's `timeline.ndjson` (see `two-wallets.ts`), so a
 * dispatched guardian run reports them in its artifact.
 */
import { Account } from '@miden-sdk/miden-sdk/lazy';

const DIAG_PREFIX = '[rotation-diag]';

/**
 * Log the three facts that distinguish "the state is wrong" from "the state is
 * right but the client thinks the account is new": whether the client considers
 * the account uncommitted, its nonce, and its commitment.
 */
export const logGuardianAccountDiag = (at: string, account: Account | null | undefined): void => {
  if (!account) {
    console.log(`${DIAG_PREFIX} ${at}: account=null`);
    return;
  }
  // Each accessor crosses the wasm boundary and any of them can throw on a
  // partially-populated record; a diagnostic must never be the thing that
  // fails the run it is diagnosing.
  const read = (label: string, fn: () => string): string => {
    try {
      return `${label}=${fn()}`;
    } catch (e) {
      return `${label}=<threw ${e instanceof Error ? e.message : String(e)}>`;
    }
  };
  console.log(
    `${DIAG_PREFIX} ${at}: ` +
      [
        read('id', () => account.id().toString()),
        read('isNew', () => String(account.isNew())),
        read('nonce', () => account.nonce().asInt().toString()),
        read('commitment', () => account.to_commitment().toHex()),
        read('isPrivate', () => String(account.isPrivate()))
      ].join(' ')
  );
};
