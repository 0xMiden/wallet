import { getGuardianCommitmentFromAccount } from 'lib/miden/guardian/account';
import {
  checkEndpointCommitment,
  identifyGuardianOperator,
  verifyEndpointMatchesCommitment
} from 'lib/miden/guardian/operator-map';
import type { GuardianSyncStatus } from 'lib/shared/types';

import { midenClientProxy } from './miden-client-proxy';
import { withWasmClientLock } from '../sdk/miden-client';

/**
 * How long to wait before re-probing operators for an account whose drift is
 * still unresolved.
 *
 * The cheap half of `resolveGuardianDrift` — the local commitment-baseline
 * comparison — is unthrottled and still runs on every tick. This bounds only the
 * HTTP half, which is reached exactly when the baseline does NOT match on chain:
 * one probe of the stored endpoint plus, on a mismatch, a fan-out to every
 * built-in operator. That state is not transient — an account flagged
 * `needs-user-input` stays flagged until the user acts — so at the ~3s cadence
 * this loop runs at, the fan-out would repeat indefinitely, and with a 5s
 * per-probe deadline the requests would overlap rather than queue. Nothing about
 * the verdict changes second to second, so a minute between probes costs
 * responsiveness that no user can perceive.
 */
const DRIFT_PROBE_COOLDOWN_MS = 60_000;

/** `Date.now()` before which an account's drift probes are skipped. */
const nextDriftProbeAt = new Map<string, number>();

/** Test hook: forget every cooldown so a suite's cases stay independent. */
export function __resetGuardianDriftProbeCooldownForTest(): void {
  nextDriftProbeAt.clear();
}

interface GuardianDriftVault {
  getAccount(pk: string): Promise<
    | {
        guardianEndpoint?: string;
        guardianOperatorCommitment?: string;
        guardianSyncStatus?: GuardianSyncStatus;
      }
    | undefined
  >;
  setGuardianEndpoint(pk: string, endpoint: string): Promise<unknown>;
  setGuardianOperatorCommitment(pk: string, commitment: string): Promise<unknown>;
  setGuardianSyncStatus(pk: string, status: GuardianSyncStatus): Promise<unknown>;
}

/**
 * Detect an out-of-band guardian switch and reconcile the local endpoint.
 *
 * Compares the account's stored `guardianOperatorCommitment` baseline against
 * the commitment actually on-chain right now. If they match, nothing to do —
 * except that if a prior run got stranded (baseline already advanced but
 * status never got finalized to `'in-sync'`, e.g. from a partial write),
 * this re-affirms the status so the account self-heals. If they differ,
 * asks the endpoint already stored on the account whether IT holds the on-chain
 * commitment (the common case right after a deliberate custom-URL switch), and
 * only if it answers with a different key does it try to name the new operator
 * among the built-ins (`identifyGuardianOperator`); on a match the new endpoint +
 * status + commitment are persisted and the account is back in sync, otherwise
 * the account is flagged `needs-user-input` for manual resolution. A stored
 * endpoint that cannot be reached at all is still followed by the built-in
 * lookup — a positive match there is evidence in its own right, and skipping it
 * made a committed-but-unpersisted rotation unrecoverable — but silence alone
 * never produces the `needs-user-input` accusation or the `'resolving'` marker.
 *
 * The local baseline comparison runs on every call; the operator probes are
 * rate-limited per account by {@link DRIFT_PROBE_COOLDOWN_MS}, because the state
 * that reaches them persists until it is resolved and the caller ticks every ~3s.
 *
 * Write order matters: the commitment baseline is always written LAST, after
 * the status is finalized to `'in-sync'`. If the final write fails, the
 * account is left with the correct endpoint/status but a stale commitment —
 * the next tick re-detects drift and idempotently retries, rather than
 * leaving the account stuck at `'resolving'` with no banner and no recovery
 * path (see the self-heal branch above).
 *
 * Returns the resulting sync status plus `changed`: whether this call wrote
 * anything to the vault. Callers (e.g. the periodic guardian-sync loop) use
 * `changed` to skip re-fetching/broadcasting account state on the common
 * no-op tick, instead of doing that work unconditionally on every call.
 *
 * The WASM account read is lock-guarded; the built-in-operator HTTP probe
 * runs outside the lock.
 */
export async function resolveGuardianDrift(
  vault: GuardianDriftVault,
  accountPublicKey: string
): Promise<{ status: GuardianSyncStatus; changed: boolean }> {
  const account = await vault.getAccount(accountPublicKey);
  if (!account) return { status: 'in-sync', changed: false };

  const onChain = await withWasmClientLock(async () => {
    const sdkAccount = await midenClientProxy.getAccount(accountPublicKey);
    return sdkAccount ? getGuardianCommitmentFromAccount(sdkAccount) : undefined;
  });
  if (!onChain) return { status: 'in-sync', changed: false };

  if (account.guardianOperatorCommitment && normalizedEqual(onChain, account.guardianOperatorCommitment)) {
    if (account.guardianSyncStatus && account.guardianSyncStatus !== 'in-sync') {
      await vault.setGuardianSyncStatus(accountPublicKey, 'in-sync');
      nextDriftProbeAt.delete(accountPublicKey);
      return { status: 'in-sync', changed: true };
    }
    nextDriftProbeAt.delete(accountPublicKey);
    return { status: 'in-sync', changed: false };
  }

  // Everything below this line talks to operators over HTTP, and the state that
  // reaches it persists for as long as the drift is unresolved — so without a
  // cooldown the ~3s caller turns a stuck account into an indefinite probe of
  // every built-in operator. Cleared above whenever the account is back in sync,
  // so a genuinely new drift is probed immediately rather than inheriting a
  // cooldown from the last one.
  const now = Date.now();
  const nextProbe = nextDriftProbeAt.get(accountPublicKey);
  if (nextProbe !== undefined && now < nextProbe) {
    return { status: account.guardianSyncStatus ?? 'in-sync', changed: false };
  }
  nextDriftProbeAt.set(accountPublicKey, now + DRIFT_PROBE_COOLDOWN_MS);

  // Ask the endpoint already STORED on the account first, BEFORE writing any
  // status and before interrogating every built-in operator. Two reasons.
  //
  // Accuracy: a deliberate in-wallet switch to a custom operator persists the new
  // endpoint (completeSwitchGuardianTransaction → setGuardianEndpoint) but
  // nothing advances the commitment baseline, so this tick sees "drift" for a
  // switch the user just completed — which used to flag every custom-URL
  // rotation `needs-user-input`. The stored endpoint is therefore the LIKELIEST
  // answer here, not the last resort.
  //
  // And a `'unreachable'` verdict must be able to change nothing at all. While
  // the endpoint is down there is no evidence either way, so writing
  // `needs-user-input` would accuse an endpoint that may be exactly right, and
  // writing `'resolving'` first would strand the account in a status with no
  // banner and no recovery path if we then bail. Returning before any write
  // leaves the account as it was and lets the next tick retry.
  let storedEndpointAnswered = true;
  if (account.guardianEndpoint) {
    const stored = await checkEndpointCommitment(account.guardianEndpoint, onChain);
    if (stored === 'match') {
      await vault.setGuardianSyncStatus(accountPublicKey, 'in-sync');
      await vault.setGuardianOperatorCommitment(accountPublicKey, onChain);
      nextDriftProbeAt.delete(accountPublicKey);
      return { status: 'in-sync', changed: true };
    }
    storedEndpointAnswered = stored !== 'unreachable';
  }

  // The stored endpoint is not the on-chain guardian — either it said so, or it
  // did not answer at all. Ask the built-ins which one holds the on-chain
  // commitment.
  //
  // An unreachable stored endpoint used to return here, and that made the worst
  // state in the whole flow unrecoverable. `completeSwitchGuardianTransaction`
  // can commit a rotation and then FAIL to persist the new endpoint
  // (`endpointPersistFailed` — e.g. the wallet auto-locked mid-rotation), which
  // leaves the vault naming the previous operator while the chain names the new
  // one. On the direct path that previous operator is unreachable by definition,
  // so the probe above answered `unreachable` on every tick forever and this
  // reconciler — the documented repair for exactly that state — returned without
  // ever asking whether some built-in operator matches.
  //
  // Asking is safe when the stored endpoint is silent, because a MATCH here is
  // positive evidence: that operator served its own key and it is the one the
  // chain names. What must not follow from silence is the ACCUSATION — see the
  // `needs-user-input` guard below.
  //
  // The `'resolving'` marker is likewise only written when the stored endpoint
  // answered. Writing it on silence would strand the account in a status with no
  // banner and no recovery path for the duration of an ordinary outage.
  if (storedEndpointAnswered) {
    await vault.setGuardianSyncStatus(accountPublicKey, 'resolving');
  }
  const operator = await identifyGuardianOperator(onChain);
  if (operator) {
    await vault.setGuardianEndpoint(accountPublicKey, operator.endpoint);
    await vault.setGuardianSyncStatus(accountPublicKey, 'in-sync');
    await vault.setGuardianOperatorCommitment(accountPublicKey, onChain);
    nextDriftProbeAt.delete(accountPublicKey);
    return { status: 'in-sync', changed: true };
  }

  // No built-in matches. If the stored endpoint never answered, this is not
  // evidence of drift: the account may be pointed at a perfectly correct custom
  // operator that is briefly down, and `needs-user-input` puts a "re-enter your
  // guardian URL" prompt in front of a user with nothing to fix. Leave the
  // account as it was and retry after the cooldown.
  if (!storedEndpointAnswered) {
    return { status: account.guardianSyncStatus ?? 'in-sync', changed: false };
  }

  await vault.setGuardianSyncStatus(accountPublicKey, 'needs-user-input');
  return { status: 'needs-user-input', changed: true };
}

/**
 * Persist a user-supplied Guardian URL, but only once it's verified against
 * the on-chain guardian commitment. Used to resolve accounts flagged
 * `needs-user-input` by `resolveGuardianDrift` (a custom operator that isn't
 * one of the built-in providers): the user pastes the operator's URL, and
 * this checks it before ever writing it to the vault.
 *
 * On a match, persists the endpoint + `'in-sync'` status + commitment, in
 * that order — the commitment baseline is written LAST (mirrors
 * `resolveGuardianDrift`'s ordering) so that if the final write fails, the
 * account is left with the correct endpoint/status and a stale commitment,
 * which the next `resolveGuardianDrift` tick idempotently repairs, instead
 * of stuck stranded at `needs-user-input` with a commitment that already
 * matches on-chain. On a mismatch, or when there's no on-chain guardian
 * commitment to check against, persists nothing and returns `false`.
 *
 * The WASM account read is lock-guarded; the endpoint verification HTTP call
 * runs outside the lock.
 */
export async function applyUserGuardianEndpoint(
  vault: GuardianDriftVault,
  accountPublicKey: string,
  endpoint: string
): Promise<boolean> {
  const onChain = await withWasmClientLock(async () => {
    const sdkAccount = await midenClientProxy.getAccount(accountPublicKey);
    return sdkAccount ? getGuardianCommitmentFromAccount(sdkAccount) : undefined;
  });
  if (!onChain) return false;

  const matches = await verifyEndpointMatchesCommitment(endpoint, onChain);
  if (!matches) return false;

  await vault.setGuardianEndpoint(accountPublicKey, endpoint);
  await vault.setGuardianSyncStatus(accountPublicKey, 'in-sync');
  await vault.setGuardianOperatorCommitment(accountPublicKey, onChain);
  return true;
}

function normalizedEqual(a: string, b: string): boolean {
  const n = (h: string) => (h.startsWith('0x') ? h.slice(2) : h).toLowerCase();
  return n(a) === n(b);
}

export { verifyEndpointMatchesCommitment };
