import { getGuardianCommitmentFromAccount } from 'lib/miden/guardian/account';
import {
  checkEndpointCommitment,
  identifyGuardianOperator,
  verifyEndpointMatchesCommitment
} from 'lib/miden/guardian/operator-map';
import { sanitizeGuardianUrl } from 'lib/settings/helpers';
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
 * one probe of the stored endpoint plus a fan-out to every built-in operator,
 * whatever that first probe answers — a `'match'` has to be corroborated against
 * the built-ins, so it fans out too, and a `'match'` the built-ins could not
 * corroborate deliberately leaves the baseline where it was, so it fans out again
 * next window. That state is not transient — an account flagged
 * `needs-user-input` stays flagged until the user acts — so at the ~3s cadence
 * this loop runs at, the fan-out would repeat indefinitely, and with a 5s
 * per-probe deadline the requests would overlap rather than queue. Nothing about
 * the verdict changes second to second, so a minute between probes costs
 * responsiveness that no user can perceive.
 */
const DRIFT_PROBE_COOLDOWN_MS = 60_000;

/**
 * How many CONSECUTIVE informative probe windows must find an account drifted,
 * its stored endpoint silent and no built-in serving the on-chain commitment
 * before the user is asked to supply the URL.
 *
 * The two states this separates are indistinguishable on any single probe: a
 * correct custom operator that is briefly down, and an account genuinely
 * stranded by a rotation that committed on-chain but never got its endpoint
 * persisted. Both show a silent stored endpoint and no built-in match. What
 * differs is DURATION — a blip ends, a stranded account's stored endpoint is
 * the old operator that was unreachable when the rotation started and stays
 * unreachable forever.
 *
 * Counted in WINDOWS rather than wall-clock, and only windows that established
 * something: a `'none'` from `identifyGuardianOperator` means a COMPLETE round
 * of built-ins answered and none holds the key, whereas `'unavailable'` is an
 * offline device, a captive network, or an operator an attacker is suppressing.
 * Accumulating wall-clock would let any of those buy the accusation by simply
 * lasting long enough; requiring informative windows means the device has to be
 * demonstrably able to reach the built-ins while this one endpoint stays dark.
 *
 * At {@link DRIFT_PROBE_COOLDOWN_MS} this is ~30 minutes of continuous, verified
 * silence. Erring long is nearly free here: the prompt is the only exit from the
 * stranded state, but it is not the only thing watching, and a false one is
 * self-clearing — the moment the endpoint answers `'match'` the account goes
 * back to `in-sync` and the banner disappears without the user doing anything.
 */
const SILENT_DRIFT_WINDOWS_BEFORE_PROMPT = 30;

/** `Date.now()` before which an account's drift probes are skipped. */
const nextDriftProbeAt = new Map<string, number>();

/**
 * Consecutive informative probe windows that found an account drifted with a
 * silent stored endpoint and no built-in match. Reset the moment the account
 * leaves that state, so the count always describes an unbroken run.
 */
const silentDriftWindows = new Map<string, number>();

/** Test hook: forget every cooldown so a suite's cases stay independent. */
export function __resetGuardianDriftProbeCooldownForTest(): void {
  nextDriftProbeAt.clear();
  silentDriftWindows.clear();
}

/** Leave the "drifted, stored endpoint silent" run — the account resolved or moved on. */
function clearDriftProbeState(accountPublicKey: string): void {
  nextDriftProbeAt.delete(accountPublicKey);
  silentDriftWindows.delete(accountPublicKey);
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
 * commitment (the common case right after a deliberate custom-URL switch). That
 * answer is a self-report over an unauthenticated `GET /pubkey`, so a `'match'`
 * is CORROBORATED against the built-in operator list rather than believed: a
 * built-in that serves the same commitment overrides the stored endpoint and the
 * account is repaired to it, and only when a COMPLETE round of built-ins reports
 * that none serves it does the stored endpoint's claim stand as a genuine custom
 * operator. A round that could not complete corroborates nothing, and writes
 * nothing — it leaves the account untouched for a later window to settle, rather
 * than latching the self-report on the strength of our own probes failing. If the
 * stored endpoint
 * answers with a different key, the built-ins are asked to name the new operator
 * (`identifyGuardianOperator`); on a match the new endpoint + status +
 * commitment are persisted and the account is back in sync, otherwise the
 * account is flagged `needs-user-input` for manual resolution. A stored
 * endpoint that cannot be reached at all is still followed by the built-in
 * lookup — a positive match there is evidence in its own right, and skipping it
 * made a committed-but-unpersisted rotation unrecoverable. Silence on a single
 * window never produces the `needs-user-input` accusation or the `'resolving'`
 * marker; SUSTAINED silence eventually does, because an account stranded on a
 * custom operator has no other exit (see
 * {@link SILENT_DRIFT_WINDOWS_BEFORE_PROMPT}).
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
      clearDriftProbeState(accountPublicKey);
      return { status: 'in-sync', changed: true };
    }
    clearDriftProbeState(accountPublicKey);
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
  // answer here, not the last resort — though "likeliest" is not "believed on its
  // own word"; see the corroboration below.
  //
  // And a `'unreachable'` verdict must be able to change nothing at all. While
  // the endpoint is down there is no evidence either way, so writing
  // `needs-user-input` would accuse an endpoint that may be exactly right, and
  // writing `'resolving'` first would strand the account in a status with no
  // banner and no recovery path if we then bail. Returning before any write
  // leaves the account as it was and lets the next tick retry.
  let storedEndpointAnswered = true;
  if (account.guardianEndpoint) {
    const storedEndpoint = account.guardianEndpoint;
    const stored = await checkEndpointCommitment(storedEndpoint, onChain);
    if (stored === 'match') {
      // A `'match'` is the stored endpoint's own word for it, and nothing more.
      // `GET /pubkey` is unauthenticated and carries no proof of possession — no
      // challenge, no signature — so any endpoint can assert any commitment, and
      // this is the branch that advances the baseline. Advance it on an unaided
      // self-report and the assertion becomes PERMANENT: the next tick's
      // baseline comparison at the top of this function answers `in-sync` before
      // any probe runs, so a stale or hostile URL that echoes the account's
      // on-chain commitment vetoes reconciliation for good — green pill, no
      // `needs-user-input`, and the wallet keeps pushing proposals to an
      // operator with no on-chain authority. `backfillGuardianEndpoints` cannot
      // undo it either; it only touches accounts with NO stored endpoint.
      //
      // So the claim gets corroborated instead of believed. The built-ins report
      // themselves over the same unauthenticated endpoint, but the asymmetry is
      // in WHO chose the URL: `getBuiltInGuardianOptionsForNetwork` is wallet
      // code, whereas the stored endpoint is mutable vault state that this very
      // function writes. Deliberately NOT the onboarding picker's
      // `getGuardianOptionsForNetwork`, which appends the developer URL override:
      // that is persisted, user-settable state, so including it would seat the
      // same category of value on both sides of the comparison. Trusting wallet
      // code is bounded by the wallet's own configuration; trusting what is in
      // the vault, or in settings, is bounded by nothing.
      const corroboration = await identifyGuardianOperator(onChain);
      // Corroboration that could not RUN is not corroboration that found
      // nothing. Every built-in probe swallows its own failure, so a captive
      // network, an offline device, a plain outage — or an attacker who can drop
      // traffic to one operator — used to arrive here indistinguishable from
      // "no built-in serves this commitment", and take the branch that latches
      // the baseline forever. Change nothing at all instead: no write, no status,
      // no baseline, so the account stays exactly as it was and the next probe
      // window can corroborate for real. The cooldown set above is deliberately
      // NOT cleared, so this costs one probe window per minute, not per tick.
      if (corroboration.outcome === 'unavailable') {
        return { status: account.guardianSyncStatus ?? 'in-sync', changed: false };
      }
      // A built-in serves the on-chain commitment and it is not the endpoint on
      // the account: the stored endpoint is lying or stale either way, so prefer
      // the built-in and repair the account to it.
      if (
        corroboration.outcome === 'identified' &&
        !sameGuardianEndpoint(corroboration.operator.endpoint, storedEndpoint)
      ) {
        await vault.setGuardianEndpoint(accountPublicKey, corroboration.operator.endpoint);
      }
      // Otherwise the stored endpoint stands. Either it IS the built-in that
      // serves this commitment, or a COMPLETE round of built-ins established
      // that none does — in which case its self-report is the only evidence in
      // existence, this is a genuine custom operator, and it is exactly the trust
      // level `applyUserGuardianEndpoint` already accepts for a URL the user
      // typed. This is also what keeps a deliberate rotation to a custom operator
      // from being flagged `needs-user-input` on the very next tick.
      await vault.setGuardianSyncStatus(accountPublicKey, 'in-sync');
      await vault.setGuardianOperatorCommitment(accountPublicKey, onChain);
      clearDriftProbeState(accountPublicKey);
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
    // The endpoint spoke, so whatever silent run was accumulating has ended —
    // and the accusation below no longer needs to wait for one.
    silentDriftWindows.delete(accountPublicKey);
    await vault.setGuardianSyncStatus(accountPublicKey, 'resolving');
  }
  // Only `'identified'` acts here, and `'unavailable'` is deliberately handled
  // as `'none'` is — no repair, and the `needs-user-input` decision below is
  // taken on the stored endpoint's answer alone. That is not the asymmetry it
  // looks like: on this path the evidence of drift came from the stored endpoint
  // DENYING that it holds the on-chain key, so the accusation never rested on
  // the built-in probes, and an incomplete round changes nothing about it. In the
  // `'match'` branch above the built-ins are the only second source there is, and
  // what follows a `'none'` there is permanent.
  const lookup = await identifyGuardianOperator(onChain);
  if (lookup.outcome === 'identified') {
    await vault.setGuardianEndpoint(accountPublicKey, lookup.operator.endpoint);
    await vault.setGuardianSyncStatus(accountPublicKey, 'in-sync');
    await vault.setGuardianOperatorCommitment(accountPublicKey, onChain);
    clearDriftProbeState(accountPublicKey);
    return { status: 'in-sync', changed: true };
  }

  // No built-in matches, and the stored endpoint never answered. On any single
  // window this is not evidence of drift — the account may be pointed at a
  // perfectly correct custom operator that is briefly down, and
  // `needs-user-input` would put a "re-enter your guardian URL" prompt in front
  // of a user with nothing to fix.
  //
  // But it is also exactly what a genuinely STRANDED account looks like, and
  // withholding the accusation forever left that account with no exit at all:
  // the chain names a CUSTOM operator N, the vault names the dead operator O the
  // rotation was fleeing, and the two evidence sources both come up empty — O is
  // unreachable by definition on the direct path, and `identifyGuardianOperator`
  // matches built-ins only, so a custom N never matches. Nothing else reconciles
  // this. The endpoint is not lost (it is on the Failed row in Activity as
  // `extraInputs.newGuardianEndpoint`) and `applyUserGuardianEndpoint` is a
  // verified repair for it, but the prompt that reaches that repair was never
  // shown, so the user was never told there was anything to repair.
  //
  // Duration is the evidence that separates the two, so accuse only after the
  // state has survived a long run of INFORMATIVE windows — see
  // {@link SILENT_DRIFT_WINDOWS_BEFORE_PROMPT} for why windows and not
  // wall-clock. `'unavailable'` contributes nothing: it means the round could
  // not establish that no built-in serves the key, and a device that cannot
  // reach the built-ins tells us nothing about why this one endpoint is silent.
  if (!storedEndpointAnswered) {
    const unchanged = { status: account.guardianSyncStatus ?? 'in-sync', changed: false };
    if (lookup.outcome !== 'none') {
      // Reset, not pause. The verdict has to rest on an UNBROKEN run of windows
      // that each established something, because a count that merely pauses
      // would let a device which is offline half the time accuse this endpoint
      // on the strength of windows spread across days with unknown states in
      // between. A stranded account persists indefinitely and gets unlimited
      // attempts to string a clean run together, so the cost of restarting is
      // delay; the cost of not restarting is an accusation built out of gaps.
      silentDriftWindows.delete(accountPublicKey);
      return unchanged;
    }

    const windows = (silentDriftWindows.get(accountPublicKey) ?? 0) + 1;
    silentDriftWindows.set(accountPublicKey, windows);
    if (windows < SILENT_DRIFT_WINDOWS_BEFORE_PROMPT) return unchanged;
    // Already flagged: the run keeps counting, but re-writing the same status
    // every window would broadcast fresh account state to the popup once a
    // minute for as long as the account stays stranded.
    if (account.guardianSyncStatus === 'needs-user-input') return unchanged;

    await vault.setGuardianSyncStatus(accountPublicKey, 'needs-user-input');
    return { status: 'needs-user-input', changed: true };
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

/**
 * Are these two spellings the same Guardian endpoint?
 *
 * `sanitizeGuardianUrl` is the comparison the rest of the wallet uses (see
 * `RotateGuardian`), and it is not enough on its own here: a built-in
 * operator's endpoint is a literal in wallet config while the stored one may
 * have been typed by a user or written by an older build, so the two can differ
 * in host case as well as in a trailing slash. Reading a difference in case as
 * "a different operator" would rewrite the account's endpoint to an equivalent
 * URL and report `changed` for a tick that changed nothing real.
 *
 * Case is folded via `URL`, which lowercases only the scheme and host — the two
 * parts that ARE case-insensitive. A blanket `toLowerCase()` would also fold the
 * path, and a look-alike endpoint differing from a built-in only in path case
 * would then pass as that built-in and keep its self-report unchallenged. An
 * unparseable value can't be a working endpoint; compare it as plain text so it
 * still matches an identical spelling of itself.
 */
function sameGuardianEndpoint(a: string, b: string): boolean {
  return canonicalGuardianEndpoint(a) === canonicalGuardianEndpoint(b);
}

function canonicalGuardianEndpoint(raw: string): string {
  const trimmed = sanitizeGuardianUrl(raw);
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}${url.search}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

export { verifyEndpointMatchesCommitment };
