import { getGuardianCommitmentFromAccount, resolveChosenGuardianEndpoint } from 'lib/miden/guardian/account';
import {
  checkEndpointCommitment,
  identifyGuardianOperator,
  verifyEndpointMatchesCommitment
} from 'lib/miden/guardian/operator-map';
import { sanitizeGuardianUrl } from 'lib/settings/helpers';
import type { ApplyUserEndpointOutcome, GuardianSyncStatus } from 'lib/shared/types';

import { midenClientProxy } from './miden-client-proxy';
import { fetchFromStorage, putToStorage } from '../front/storage';
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
 * The value is bounded from BOTH sides, which is why it is small. The run lives
 * in this module's memory and is only advanced by `checkGuardianDrift`, whose
 * callers all need an unlocked vault and a UI-driven tick — so it accrues only
 * while the wallet is open and unlocked, and a service-worker recycle, a browser
 * restart or an extension update resets it to zero. Any threshold longer than a
 * plausible single session is therefore not "cautious", it is unreachable: on the
 * extension the popup closes, the worker idles out, and the prompt that is the
 * ONLY exit for a stranded custom operator would never be shown at all. That is
 * strictly worse than a false prompt, because a false prompt self-clears — the
 * moment the endpoint answers `'match'` the account returns to `in-sync` and the
 * banner disappears with no user action — whereas an unreachable one leaves the
 * account silently broken forever.
 *
 * At {@link DRIFT_PROBE_COOLDOWN_MS} five windows is ~5 minutes during which the
 * built-ins are demonstrably reachable and this one endpoint stays dark. That
 * clears an operator restart or a redeploy, which is the blip this rule exists
 * to absorb; a longer outage that resolves itself costs one dismissable prompt.
 *
 * The run is PERSISTED ({@link SILENT_DRIFT_RUN_STORAGE_KEY}) rather than held in
 * memory, because in memory the paragraph above was self-defeating on the
 * extension. `syncGuardianAccounts` has exactly one driver — `useSyncTrigger`, a
 * React hook — so windows advance only while a wallet UI realm is open, and the
 * drift state lives in the worker the popup was keeping alive. Five minutes of
 * CONTINUOUSLY open popup is not a plausible extension session, so the prompt
 * this whole rule exists to gate was unreachable there: precisely the outcome the
 * paragraph above calls "strictly worse than a false prompt". Mobile and desktop
 * were unaffected (one long-lived realm), which is why it survived review.
 *
 * Persisting it does NOT weaken the unbroken-run requirement to "windows spread
 * across days with unknown states in between", which is what the reset below
 * refuses. The stored run carries the instant of its last counted window and
 * generalises "unbroken" from ONE REALM SESSION to WALL-CLOCK CONTIGUITY: a
 * window counts only if it is at least {@link DRIFT_PROBE_COOLDOWN_MS} after the
 * previous one (so realm churn cannot buy five windows in ten seconds — the
 * in-memory cooldown alone cannot enforce this, since a realm restart clears it)
 * and at most {@link SILENT_DRIFT_RUN_MAX_GAP_MS} after it (so a device that is
 * offline half the time restarts rather than accumulating across the gap). The
 * realistic path is now the one that matters: a user whose guardian is dead sees
 * the outage pill within seconds of opening the popup, opens it a few times while
 * working out what is wrong, and each open contributes a window.
 *
 * Exported for the tests, which must not hardcode the number — the boundary
 * (accuse on the Nth window, not the N-1th) is the property under test.
 */
export const SILENT_DRIFT_WINDOWS_BEFORE_PROMPT = 5;

/** `Date.now()` before which an account's drift probes are skipped. */
const nextDriftProbeAt = new Map<string, number>();

/**
 * The longest gap between two counted windows that still leaves the run
 * "unbroken". Beyond it the run restarts, because nothing was observed during
 * the gap and the endpoint may well have been answering throughout it.
 *
 * Ten minutes is scaled to the behaviour this has to survive — a user reopening
 * the popup a few times while investigating a guardian that has just gone dark —
 * not to idle wallet time. A gap longer than that is a different investigation.
 */
const SILENT_DRIFT_RUN_MAX_GAP_MS = 10 * 60_000;

/**
 * Storage key for the persisted silent-drift runs; see the threshold's docstring.
 *
 * Exported for the tests, which have to be able to simulate the case this
 * persistence exists for — the realm dying with the run half-accumulated — by
 * dropping the module's memory while leaving storage intact.
 */
export const SILENT_DRIFT_RUN_STORAGE_KEY = 'guardian_silent_drift_run';

/**
 * One account's run of consecutive informative probe windows that found it
 * drifted, its stored endpoint silent, and no built-in serving the on-chain key.
 *
 * `endpoint` and `lastAt` are what make the count meaningful: the run is a
 * statement about a specific stored endpoint over a specific stretch of
 * wall-clock, and a bare number inherits across both (see F-151 for the endpoint
 * half, which was a live defect).
 */
interface SilentDriftRun {
  endpoint: string;
  windows: number;
  lastAt: number;
}

async function readSilentDriftRuns(): Promise<Record<string, SilentDriftRun>> {
  // Best-effort: this gates a prompt, so a storage read that fails must not take
  // the drift check down with it — it just restarts the run.
  try {
    return (await fetchFromStorage<Record<string, SilentDriftRun>>(SILENT_DRIFT_RUN_STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

/**
 * Serializes the read-modify-write below. Every account's run lives in ONE
 * storage object, so two concurrent updates each read the object, mutate their
 * own account's entry, and write the whole thing back — and the later write
 * silently drops the earlier account's progress. The drift check is dispatched
 * per realm (popup, side panel, full page) onto the single backend, and the
 * frontend's in-flight coalescing is module-local to each realm, so two passes
 * genuinely can overlap here. The cost of losing a window is that a stranded
 * account never reaches the run length its only prompt is gated on.
 *
 * DELIBERATELY UNTESTED, which is worth stating rather than leaving as an
 * apparent oversight. The lost update needs the read to suspend between the read
 * and the write, and nothing in the suite can arrange that: the storage stub
 * settles without a scheduling gap, so an unserialized read-modify-write is
 * accidentally atomic under jest and every test written against it passes with
 * this serialization removed. Driving the write directly does not help — the
 * atomicity is in the stub, not the caller — and the module's `fetchFromStorage`
 * import cannot be spied on to insert the gap. A real test needs a storage double
 * with controllable scheduling, which is a harness change well beyond this
 * module. Production storage (chrome.storage) is genuinely async, so the race is
 * real where it counts and unreachable only where it would be observed.
 */
let silentDriftWriteChain: Promise<void> = Promise.resolve();

async function writeSilentDriftRun(accountPublicKey: string, run: SilentDriftRun | undefined): Promise<void> {
  const write = silentDriftWriteChain.then(async () => {
    try {
      const runs = await readSilentDriftRuns();
      if (run) runs[accountPublicKey] = run;
      else if (!(accountPublicKey in runs)) return;
      else delete runs[accountPublicKey];
      await putToStorage(SILENT_DRIFT_RUN_STORAGE_KEY, runs);
    } catch {
      // See above.
    }
  });
  // The chain must not be poisoned by a rejection, and the body above already
  // swallows its own failures — this only keeps a future `putToStorage` throw
  // from stalling every later write.
  silentDriftWriteChain = write.then(
    () => undefined,
    () => undefined
  );
  await write;
}

/**
 * The stored endpoint each account's run above was accumulated against.
 *
 * Both maps are keyed by account, but their SUBJECT is a pair: the run means
 * "this account, with THIS endpoint stored, has been dark for N windows". The
 * rule is explicitly about duration — "a correct custom operator that is briefly
 * down" must not be accused, and what separates it from a wrong one is only how
 * long it stays silent — so a run inherited by a different endpoint can push that
 * endpoint over the threshold on its FIRST window and accuse it with no evidence,
 * which defeats the guard entirely.
 *
 * That is reachable: a rotation whose endpoint write fails leaves the account
 * drifted with a dead operator stored, accumulating windows; rotating again then
 * hands the accumulated run to the new endpoint, whose first window is plausibly
 * silent while a self-hosted operator cold-starts. None of the existing clear
 * paths cover it — they fire on a baseline match, a denial, an identification, or
 * an uninformative round, and "the stored endpoint changed" is none of those.
 */
const driftProbeEndpoint = new Map<string, string>();

/** Test hook: forget every cooldown and run so a suite's cases stay independent. */
export async function __resetGuardianDriftProbeCooldownForTest(): Promise<void> {
  nextDriftProbeAt.clear();
  driftProbeEndpoint.clear();
  try {
    await putToStorage(SILENT_DRIFT_RUN_STORAGE_KEY, {});
  } catch {
    // A suite with no storage provider has nothing to clear.
  }
}

/** Leave the "drifted, stored endpoint silent" run — the account resolved or moved on. */
async function clearDriftProbeState(accountPublicKey: string): Promise<void> {
  nextDriftProbeAt.delete(accountPublicKey);
  driftProbeEndpoint.delete(accountPublicKey);
  await writeSilentDriftRun(accountPublicKey, undefined);
}

/**
 * A repair whose CAS write came back `stale` reasoned from a binding that no
 * longer exists — a rotation (or another repair) landed during this pass's
 * probes. The repair is DISCARDED, not retried against the new state it never
 * looked at; the next tick re-derives everything from a fresh snapshot.
 *
 * The probe cooldown armed earlier in this pass is released, deliberately: a
 * stale-discarded pass established nothing about the NEW binding, and serving
 * out its cooldown would leave the fresh endpoint unprobed (and any real drift
 * unrepaired) for up to a full window. Without this, a repair that keeps
 * losing the race could also keep re-arming its own delay — the "our fix
 * creates the next wedge" shape rounds 17–20 of the #786 review kept finding.
 */
function discardStaleRepair(
  accountPublicKey: string,
  account: { guardianSyncStatus?: GuardianSyncStatus }
): { status: GuardianSyncStatus; changed: boolean } {
  nextDriftProbeAt.delete(accountPublicKey);
  console.warn(
    `[GuardianDrift] discarding a repair for ${accountPublicKey}: the guardian binding changed during the probe`
  );
  return { status: account.guardianSyncStatus ?? 'in-sync', changed: false };
}

interface GuardianDriftVault {
  getAccount(pk: string): Promise<
    | {
        guardianEndpoint?: string;
        guardianOperatorCommitment?: string;
        guardianSyncStatus?: GuardianSyncStatus;
        guardianEpoch?: number;
      }
    | undefined
  >;
  /**
   * CAS-guarded binding write (`Vault.updateGuardianBinding`). Every repair
   * this module makes snapshots the account, spends seconds-to-minutes in HTTP
   * probes, then writes — so each write carries the epoch of the snapshot it
   * reasoned from, and a rotation landing in between turns the write `stale`
   * instead of letting it resurrect the pre-rotation operator (F-220).
   */
  updateGuardianBinding(
    pk: string,
    expectedEpoch: number,
    patch: { guardianEndpoint?: string; guardianOperatorCommitment?: string }
  ): Promise<{ outcome: 'applied' | 'stale' }>;
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
 * operator. A round that could not complete corroborates nothing, and writes no
 * BASELINE — it leaves that for a later window to settle, rather than latching
 * the self-report on the strength of our own probes failing. It does still LIFT a
 * status that blocks, because requiring corroboration to accuse is protection and
 * requiring it to exonerate would make an account's ability to transact depend on
 * the availability of operators it does not use; see the `'unavailable'` branch,
 * which is the authority on this rule. If the stored endpoint
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
  // Everything this pass writes reasons from THIS snapshot; the epoch rides
  // along so a rotation completing during the probes turns the write stale.
  const snapshotEpoch = account.guardianEpoch ?? 0;

  const onChain = await withWasmClientLock(async () => {
    const sdkAccount = await midenClientProxy.getAccount(accountPublicKey);
    return sdkAccount ? getGuardianCommitmentFromAccount(sdkAccount) : undefined;
  });
  if (!onChain) return { status: 'in-sync', changed: false };

  if (account.guardianOperatorCommitment && normalizedEqual(onChain, account.guardianOperatorCommitment)) {
    if (account.guardianSyncStatus && account.guardianSyncStatus !== 'in-sync') {
      await vault.setGuardianSyncStatus(accountPublicKey, 'in-sync');
      await clearDriftProbeState(accountPublicKey);
      return { status: 'in-sync', changed: true };
    }
    await clearDriftProbeState(accountPublicKey);
    return { status: 'in-sync', changed: false };
  }

  // Everything below this line talks to operators over HTTP, and the state that
  // reaches it persists for as long as the drift is unresolved — so without a
  // cooldown the ~3s caller turns a stuck account into an indefinite probe of
  // every built-in operator. Cleared above whenever the account is back in sync,
  // so a genuinely new drift is probed immediately rather than inheriting a
  // cooldown from the last one.
  // Ahead of the cooldown check, which would otherwise `return` and never reach
  // this — the same ordering the sync loop's rotation detector needs. A changed
  // stored endpoint retires the run and the cooldown together: the run is about
  // the old endpoint's silence, and the cooldown would leave the NEW endpoint
  // unprobed (and the account on a stale status) for up to a full period.
  // The pointer this account is actually BOUND to, which is not the same value as
  // the raw `guardianEndpoint` field. `resolveGuardianEndpoint` — what the sync
  // loop builds its service from — falls back to the legacy global key, retained
  // by design as the only pointer a pre-per-account-endpoint account on a
  // custom/self-hosted operator has (the unlock backfill deliberately leaves that
  // account's field empty rather than stamping a guess). Reading the raw field
  // here classified exactly that account `'absent'`, which accuses on the FIRST
  // complete round with no duration rule — so an account whose own operator was
  // answering, and whose `service.sync()` was succeeding on the same tick, got a
  // permanent `needs-user-input` and had every send blocked by
  // `assertGuardianInSync`. F-150 fixed this same field/identity confusion one
  // module over; the reconciler kept it.
  //
  // The DEFAULT arm of the resolver is deliberately not adopted: an endpoint the
  // wallet merely guessed is not a pointer this account chose, and a denial from
  // it says only "the default operator is not your guardian" — which is exactly
  // what `'absent'` already means, and it must keep `'absent'`'s requirement of a
  // complete built-in round before accusing.
  // One definition of "the pointer this account chose", shared with the
  // missing-registration self-heal — the other caller that must not be handed a
  // guessed default.
  //
  // A read failure SKIPS this window rather than degrading to `''`. The two are
  // not interchangeable here: `''` is the value that means "this account named no
  // operator", which is the `'absent'` evidence this function accuses on, so
  // swallowing the error would let a storage hiccup manufacture the accusation
  // instead of merely failing to check for it. Skipping costs one probe window
  // and self-corrects on the next tick; accusing writes `needs-user-input`, which
  // blocks every send through `assertGuardianInSync` and does not self-correct.
  // Note the cooldown is deliberately NOT armed on this path — an unread pointer
  // is not a completed probe, and charging it a cooldown would stretch a
  // transient failure into a multi-minute blind spot.
  let storedEndpoint: string;
  try {
    storedEndpoint = (await resolveChosenGuardianEndpoint(account)) ?? '';
  } catch (error) {
    console.warn(
      `[GuardianDrift] could not read the guardian pointer for ${accountPublicKey}; skipping this window`,
      error
    );
    return { status: account.guardianSyncStatus ?? 'in-sync', changed: false };
  }
  if (driftProbeEndpoint.get(accountPublicKey) !== storedEndpoint) {
    // Only the COOLDOWN, deliberately. The run is scoped by the endpoint recorded
    // inside it, so a changed endpoint already fails `continues` below and starts
    // the new endpoint on its own window — whereas clearing the run from here
    // would key that decision on an IN-MEMORY marker, which a realm restart
    // clears. That made every fresh realm look like a rotation and wipe the very
    // run the persistence exists to preserve: F-150's false positive, one level
    // down. What this reset is for is probing the new endpoint at once instead of
    // serving out the old one's cooldown.
    nextDriftProbeAt.delete(accountPublicKey);
    driftProbeEndpoint.set(accountPublicKey, storedEndpoint);
  }

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
  // And an `'unreachable'` verdict must not accuse on the strength of ONE window:
  // while the endpoint is down there is no evidence either way, so writing
  // `needs-user-input` off a single silent probe would accuse an endpoint that may
  // be exactly right. It is therefore folded into `'silent'` below and takes the
  // duration rule, rather than short-circuiting the function.
  //
  // It deliberately does NOT return early, which is what an earlier version did
  // (F-018-era). Bailing on unreachable is what stranded a custom operator with no
  // exit (F-055): on the direct-switch path the previous operator is unreachable BY
  // DEFINITION, so the account whose vault still names it could never progress past
  // this point, and the prompt that feeds `applyUserGuardianEndpoint` never
  // appeared. Restoring an early return here re-breaks that repair.
  //
  // Three states, not a boolean, because the accusation below turns on WHICH of
  // them holds and a boolean has to fold two of them together:
  //
  //  - `'denied'`  the stored endpoint answered and said it does NOT hold the
  //                on-chain key. That denial is the evidence of drift, and it
  //                stands on its own — an incomplete built-in round subtracts
  //                nothing from it, so this accuses immediately.
  //  - `'silent'`  an endpoint is stored but never answered. No evidence either
  //                way on any single window, so this takes the duration rule.
  //  - `'absent'`  no endpoint is stored at all. Nothing denied anything, so
  //                this must not inherit `'denied'`'s immediacy — which is what
  //                a boolean initialized to `true` gave it: a legacy record
  //                whose backfill had not run yet was accused on the FIRST
  //                window off an `'unavailable'` round, i.e. off our own probes
  //                failing, when a complete round might have named a built-in
  //                and repaired it silently.
  let storedEndpointEvidence: 'denied' | 'silent' | 'absent' = 'absent';
  if (storedEndpoint) {
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
      // the baseline forever. Withhold the BASELINE instead, so the next probe
      // window can corroborate for real — but not, as this originally did, every
      // write: see the block below, which lifts a status that blocks. The
      // cooldown set above is deliberately NOT cleared, so this costs one probe
      // window per minute, not per tick.
      if (corroboration.outcome === 'unavailable') {
        // The endpoint DID answer, so end any silent run first — the rule is
        // "the endpoint spoke ⇒ the run is over", and applying it on some
        // answering branches but not others would let a match mid-outage leave
        // a partial run to be inherited later.
        await writeSilentDriftRun(accountPublicKey, undefined);
        // "Change nothing" is right about the BASELINE and wrong about a status
        // that BLOCKS. `assertGuardianInSync` refuses every send / consume / swap
        // while the status is `'resolving'` or `'needs-user-input'`, so leaving it
        // in place makes this account's ability to transact depend on the
        // availability of operators it does not use: one unreachable built-in —
        // any of them, not this account's — holds the freeze open, window after
        // window, while its own operator answers `'match'` on every one and the
        // sync loop succeeds against it. The user gets a non-dismissable "enter
        // your guardian URL" banner asserting something false, and an attacker who
        // can drop traffic to a single built-in can hold it there.
        //
        // Requiring corroboration to ACCUSE is right and is unchanged. Requiring
        // it to EXONERATE is what freezes the account. Unblocking on the
        // endpoint's own word grants nothing the wallet does not already grant on
        // that same word: `applyUserGuardianEndpoint` — the exit this very banner
        // offers — accepts one unauthenticated `/pubkey` echo for a URL the user
        // types, and the corroborated branch below accepts it too.
        //
        // The BASELINE still is not written, which is the whole point: without it
        // the top-of-function short-circuit does not engage, so every later window
        // re-probes and can re-accuse the moment this endpoint stops matching. The
        // permanent latch the corroboration rule exists to prevent needs the
        // baseline, not the status.
        if (account.guardianSyncStatus && account.guardianSyncStatus !== 'in-sync') {
          await vault.setGuardianSyncStatus(accountPublicKey, 'in-sync');
          return { status: 'in-sync', changed: true };
        }
        return { status: account.guardianSyncStatus ?? 'in-sync', changed: false };
      }
      // A built-in serves the on-chain commitment and it is not the endpoint on
      // the account: the stored endpoint is lying or stale either way, so prefer
      // the built-in and repair the account to it. Otherwise the stored endpoint
      // stands: either it IS the built-in that serves this commitment, or a
      // COMPLETE round of built-ins established that none does — in which case
      // its self-report is the only evidence in existence, this is a genuine
      // custom operator, and it is exactly the trust level
      // `applyUserGuardianEndpoint` already accepts for a URL the user typed.
      // This is also what keeps a deliberate rotation to a custom operator from
      // being flagged `needs-user-input` on the very next tick.
      //
      // One patch, one epoch check: endpoint (when repairing) and baseline land
      // atomically, replacing the hand-ordered endpoint-then-baseline sequence.
      const repairEndpoint =
        corroboration.outcome === 'identified' && !sameGuardianEndpoint(corroboration.operator.endpoint, storedEndpoint)
          ? corroboration.operator.endpoint
          : undefined;
      const write = await vault.updateGuardianBinding(accountPublicKey, snapshotEpoch, {
        ...(repairEndpoint !== undefined ? { guardianEndpoint: repairEndpoint } : {}),
        guardianOperatorCommitment: onChain
      });
      if (write.outcome === 'stale') return discardStaleRepair(accountPublicKey, account);
      await vault.setGuardianSyncStatus(accountPublicKey, 'in-sync');
      await clearDriftProbeState(accountPublicKey);
      return { status: 'in-sync', changed: true };
    }
    storedEndpointEvidence = stored === 'unreachable' ? 'silent' : 'denied';
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
  // The `'resolving'` marker is likewise only written on a DENIAL. Writing it on
  // silence — or on an account with no endpoint at all — would strand the
  // account in a status with no banner and no recovery path for the duration of
  // an ordinary outage, since both of those can end in "change nothing".
  if (storedEndpointEvidence === 'denied') {
    // The endpoint spoke, so whatever silent run was accumulating has ended —
    // and the accusation below no longer needs to wait for one. Live via
    // `applyUserGuardianEndpoint`, which repairs the account WITHOUT going
    // through this function, so a stale run would otherwise survive the repair
    // and be inherited by the account's next drift.
    await writeSilentDriftRun(accountPublicKey, undefined);
    await vault.setGuardianSyncStatus(accountPublicKey, 'resolving');
  }
  // Only `'identified'` repairs. What `'unavailable'` means for the accusation
  // depends on where the evidence of drift came from, which is why the three
  // cases are split below rather than sharing one rule: on a DENIAL the stored
  // endpoint itself supplied the evidence, so an incomplete built-in round
  // subtracts nothing from it; with no denial the built-ins are the only source
  // there is, and an incomplete round establishes nothing at all.
  const lookup = await identifyGuardianOperator(onChain);
  if (lookup.outcome === 'identified') {
    const write = await vault.updateGuardianBinding(accountPublicKey, snapshotEpoch, {
      guardianEndpoint: lookup.operator.endpoint,
      guardianOperatorCommitment: onChain
    });
    if (write.outcome === 'stale') return discardStaleRepair(accountPublicKey, account);
    await vault.setGuardianSyncStatus(accountPublicKey, 'in-sync');
    await clearDriftProbeState(accountPublicKey);
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
  //
  // An `'absent'` account — no stored endpoint at all — shares the
  // `'unavailable'` half of this and not the duration half. It genuinely does
  // need the user, and a COMPLETE round that named no built-in is a real finding
  // about it, so it is accused as soon as there is one. What it must not be
  // accused on is our own probes failing.
  if (storedEndpointEvidence !== 'denied') {
    const unchanged = { status: account.guardianSyncStatus ?? 'in-sync', changed: false };
    if (lookup.outcome !== 'none') {
      // Reset, not pause. The verdict has to rest on an UNBROKEN run of windows
      // that each established something, because a count that merely pauses
      // would let a device which is offline half the time accuse this endpoint
      // on the strength of windows spread across days with unknown states in
      // between. A stranded account persists indefinitely and gets unlimited
      // attempts to string a clean run together, so the cost of restarting is
      // delay; the cost of not restarting is an accusation built out of gaps.
      await writeSilentDriftRun(accountPublicKey, undefined);
      return unchanged;
    }

    // A complete round found no built-in. For a SILENT endpoint that still is
    // not evidence on its own — wait out the run. For an ABSENT one there is
    // nothing to wait for: no endpoint means no operator this wallet can reach,
    // and no duration will change that.
    if (storedEndpointEvidence === 'silent') {
      const previous = (await readSilentDriftRuns())[accountPublicKey];
      // A window continues the run only if it is about the same endpoint and lands
      // inside the contiguity band — no sooner than the cooldown (realm churn
      // clears the in-memory one, so without this five popup opens in ten seconds
      // would buy the accusation) and no later than the maximum gap.
      const continues =
        previous !== undefined &&
        previous.endpoint === storedEndpoint &&
        now - previous.lastAt >= DRIFT_PROBE_COOLDOWN_MS &&
        now - previous.lastAt <= SILENT_DRIFT_RUN_MAX_GAP_MS;
      // Too SOON is not a restart — the evidence stands, this observation simply
      // adds nothing to it. Restarting here would let a fast tick after a realm
      // restart erase a genuine run.
      if (
        previous !== undefined &&
        previous.endpoint === storedEndpoint &&
        now - previous.lastAt < DRIFT_PROBE_COOLDOWN_MS
      )
        return unchanged;

      const windows = continues ? previous.windows + 1 : 1;
      await writeSilentDriftRun(accountPublicKey, { endpoint: storedEndpoint, windows, lastAt: now });
      if (windows < SILENT_DRIFT_WINDOWS_BEFORE_PROMPT) return unchanged;
    }
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
 * On a match, persists endpoint + commitment in ONE epoch-guarded patch, then
 * the `'in-sync'` status. Anything other than `'applied'` persists nothing.
 *
 * The outcome is five states rather than a boolean because the banner that
 * calls this ACCUSES the user's typed URL on failure, and only ONE of those
 * states is evidence against it. `'mismatch'` means the operator answered and
 * declared a different commitment — that is a real mismatch. `'unreachable'`
 * means it never answered, or answered without a commitment, which says
 * nothing about whether the URL is right: a cold-starting self-hosted operator
 * looks exactly like this, and telling that user they typed the wrong operator
 * sends them away from the only prompt that can repair the account.
 * `checkEndpointCommitment` in `operator-map.ts` already made this distinction
 * for the drift reconciler and carries the same reasoning in its comment; this
 * path collapsed it back into a boolean and re-acquired the bug.
 *
 * The WASM account read is lock-guarded; the endpoint verification HTTP call
 * runs outside the lock.
 */
export async function applyUserGuardianEndpoint(
  vault: GuardianDriftVault,
  accountPublicKey: string,
  endpoint: string
): Promise<ApplyUserEndpointOutcome> {
  // Snapshot before the reads this apply reasons from. The URL below is
  // verified against the on-chain commitment AS OF NOW — if a rotation lands
  // during the verification round-trip, that evidence describes a guardian the
  // account no longer has, so the CAS write refuses (`'stale'`) and the banner
  // asks for one retry against the new state rather than binding a
  // stale-verified endpoint.
  const account = await vault.getAccount(accountPublicKey);
  // NOT `'no-onchain-guardian'`, whose copy reads "this account has no on-chain
  // guardian to verify against yet" — a statement about the CHAIN, which this
  // case has established nothing about. The vault record is simply gone or moved
  // (a removed account, a frontend snapshot ahead of the backend), which is
  // exactly what `'stale'` already means to the banner: the state moved under
  // you, try again.
  if (!account) return 'stale';
  const snapshotEpoch = account.guardianEpoch ?? 0;

  const onChain = await withWasmClientLock(async () => {
    const sdkAccount = await midenClientProxy.getAccount(accountPublicKey);
    return sdkAccount ? getGuardianCommitmentFromAccount(sdkAccount) : undefined;
  });
  if (!onChain) return 'no-onchain-guardian';

  const verdict = await verifyEndpointMatchesCommitment(endpoint, onChain);
  if (verdict !== 'match') return verdict;

  // Endpoint + baseline in one guarded patch (the old endpoint-first,
  // baseline-last ordering existed to keep a torn write repairable; the atomic
  // patch removes the tear). Status stays a separate LWW write: if it fails
  // after the binding landed, the next drift tick sees baseline == chain with
  // a blocking status and idempotently repairs it.
  const write = await vault.updateGuardianBinding(accountPublicKey, snapshotEpoch, {
    guardianEndpoint: endpoint,
    guardianOperatorCommitment: onChain
  });
  if (write.outcome === 'stale') return 'stale';
  await vault.setGuardianSyncStatus(accountPublicKey, 'in-sync');
  return 'applied';
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
