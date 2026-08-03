import type { BrowserContext, Route } from '@playwright/test';

/**
 * Guardian fault-injection layer.
 *
 * Intercepts guardian HTTP calls at the BrowserContext level (by origin +
 * path segment) and applies whichever GuardianFaultPolicy is currently
 * armed, so switch/recovery specs can assert wallet behavior under guardian
 * unavailability without touching the docker containers themselves.
 *
 * MUST be installed on a context that allows service workers (the
 * two-wallets fixture's default -- Playwright's `serviceWorkers` context
 * option defaults to 'allow'): guardian HTTP calls happen inside the
 * extension's service worker (`@openzeppelin/guardian-client`'s fetch calls
 * run there, not on the page), so `context.route` only has a chance of
 * faulting them if SW network traffic isn't blocked.
 */

/** Which locally-spawned guardian container a fault targets (A: :3000, B: :3001). Omit to match either. */
export type GuardianFaultTarget = 'A' | 'B';

/**
 * Guardian HTTP endpoint family a fault matches, keyed on a URL path
 * segment (matched as a `/${path}` substring of the request URL).
 *
 * These are the guardian's REAL endpoint path segments, confirmed against
 * `GuardianHttpClient` (`@openzeppelin/guardian-client/src/http.ts`):
 *   - `pubkey`    -> `GET /pubkey`      (`getPubkey`)
 *   - `configure` -> `POST /configure`  (`configure`, used by
 *                    `Multisig.registerOnGuardian` -- the wallet's
 *                    register/re-register call, invoked from
 *                    `registerOnGuardianWithRetry`)
 *   - `delta`     -> everything under `/delta*`: `POST /delta` (push),
 *                    `GET /delta`, `GET /delta/since`,
 *                    `GET|POST|PUT /delta/proposal[/single]` (propose/sign),
 *                    `POST /delta/candidate/abandon`. There is no distinct
 *                    `/proposals` or `/sign` endpoint on the wire -- propose
 *                    and sign both live under `/delta/proposal`, so faulting
 *                    them is done via `path: 'delta'` (optionally narrowed
 *                    with `target`).
 *
 * A prior taxonomy had `'register'` (never matched -- the real endpoint is
 * `/configure`, so any `path: 'register'` fault was silently a no-op) and
 * `'proposals'`/`'sign'` (never matched either, since `/delta` always wins
 * as an earlier substring of any `/delta/proposal*` URL -- see `pathOf`).
 * Fixed to the real endpoint names below.
 */
export type GuardianFaultPath = 'pubkey' | 'configure' | 'delta';

/**
 * `conflictPendingDelta` fulfills a `409` shaped exactly like the guardian's
 * REAL `conflict_pending_delta` response (see `CONFLICT_PENDING_DELTA_BODY`
 * below) -- distinct from `status500`/`failFirstN`, which fulfill a generic
 * `500` and so can never exercise `isGuardianPendingConflict`
 * (`src/lib/miden/guardian/serialize.ts`), the wallet's conflict-vs-generic-
 * failure branch. Like `failFirstN`, it self-clears after `count` matching
 * requests (see the `count` field doc below) -- a real guardian's conflict is
 * transient (it clears once the prior delta canonicalizes), so a fault that
 * never clears wouldn't model the real failure mode.
 */
export type GuardianFaultMode = 'status500' | 'abort' | 'delay' | 'failFirstN' | 'conflictPendingDelta';

export interface GuardianFaultPolicy {
  /** Guardian instance to fault. Omit to match either A or B. */
  target?: GuardianFaultTarget;
  /** URL path segment to match. */
  path: GuardianFaultPath;
  mode: GuardianFaultMode;
  /** Delay (ms) before continuing the request. Only used by 'delay' (default 3000). */
  delayMs?: number;
  /**
   * Number of matching requests to fail before falling back to continue().
   * Used by 'failFirstN' and 'conflictPendingDelta' (default 1).
   */
  count?: number;
}

export interface GuardianFaultControls {
  /** Arm a fault policy, replacing any previously-armed one and resetting its hit counter. */
  arm(policy: GuardianFaultPolicy): void;
  /** Disarm -- all subsequent requests pass through untouched. */
  clear(): void;
}

/**
 * The Route surface guardian-fault actually touches. Deliberately narrower
 * than Playwright's real `Route` (which satisfies this structurally) so the
 * fault-decision logic below is unit-testable with a plain fake object --
 * no BrowserContext/browser required.
 */
export interface GuardianRouteLike {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
  fulfill(response: { status: number; body: string }): Promise<void>;
}

const GUARDIAN_FAULT_PATHS: readonly GuardianFaultPath[] = ['pubkey', 'configure', 'delta'];

/** Guardian A listens on :3000, guardian B on :3001 (see local-stack/docker-compose.local.yml). */
export function targetOf(url: string): GuardianFaultTarget | null {
  if (url.startsWith('http://localhost:3000/')) return 'A';
  if (url.startsWith('http://localhost:3001/')) return 'B';
  return null;
}

/** First `/{path}` segment (in GuardianFaultPath declaration order) found in the URL, or null if none match. */
export function pathOf(url: string): GuardianFaultPath | null {
  for (const path of GUARDIAN_FAULT_PATHS) {
    if (url.includes(`/${path}`)) return path;
  }
  return null;
}

export type GuardianFaultAction =
  | { kind: 'continue' }
  | { kind: 'abort' }
  | { kind: 'delay'; delayMs: number }
  | { kind: 'fulfill500' }
  | { kind: 'fulfillConflictPendingDelta' };

/**
 * Pure fault decision for a single request: does the armed policy match
 * this URL, and if so what should happen? Exported standalone (no
 * Playwright dependency at all) so target/path matching and the
 * `failFirstN`/`conflictPendingDelta` hit-counting are unit testable without
 * a browser.
 */
export function decideGuardianFault(
  url: string,
  policy: GuardianFaultPolicy | null,
  hits: number
): { action: GuardianFaultAction; hits: number } {
  const target = targetOf(url);
  if (!policy || !target) return { action: { kind: 'continue' }, hits };
  if (policy.target && policy.target !== target) return { action: { kind: 'continue' }, hits };
  if (pathOf(url) !== policy.path) return { action: { kind: 'continue' }, hits };
  if ((policy.mode === 'failFirstN' || policy.mode === 'conflictPendingDelta') && hits >= (policy.count ?? 1)) {
    return { action: { kind: 'continue' }, hits };
  }

  const nextHits = hits + 1;
  switch (policy.mode) {
    case 'abort':
      return { action: { kind: 'abort' }, hits: nextHits };
    case 'delay':
      return { action: { kind: 'delay', delayMs: policy.delayMs ?? 3000 }, hits: nextHits };
    case 'status500':
    case 'failFirstN':
      return { action: { kind: 'fulfill500' }, hits: nextHits };
    case 'conflictPendingDelta':
      return { action: { kind: 'fulfillConflictPendingDelta' }, hits: nextHits };
  }
}

/**
 * Realistic `409 conflict_pending_delta` error body, shaped exactly like the
 * envelope `GuardianHttpError` parses on the wire
 * (`@openzeppelin/guardian-client/dist/http.js`'s `parseGuardianErrorBody`):
 * `{ code, message, meta }` where `meta.retryable` is a required boolean and
 * `code` is a recognized `GuardianErrorCode` (`conflict_pending_delta` is
 * NOT one of the four SCREAMING_SNAKE server aliases -- it already travels
 * on the wire in this exact snake_case form, see
 * `@openzeppelin/guardian-client/dist/error-codes.js`).
 *
 * Matching this shape (rather than an arbitrary 409) is what makes
 * `isGuardianPendingConflict` (`src/lib/miden/guardian/serialize.ts`) --
 * which checks `err.status === 409` and a non-"paused" `err.body`/`.message`
 * -- actually recognize the fault as the SAME transient conflict a live
 * guardian's canonicalization-in-progress 409 produces, so
 * `withGuardianConflictRetry` and the wallet's pending-conflict requeue path
 * (`transaction/index.ts`) both engage exactly as they would against a real
 * guardian.
 */
const CONFLICT_PENDING_DELTA_BODY = JSON.stringify({
  code: 'conflict_pending_delta',
  message: 'A delta is already pending canonicalization for this account',
  meta: { retryable: true }
});

/** Apply a fault decision to a live route (or a unit-test fake satisfying GuardianRouteLike). */
export async function applyGuardianFaultAction(route: GuardianRouteLike, action: GuardianFaultAction): Promise<void> {
  switch (action.kind) {
    case 'continue':
      return route.continue();
    case 'abort':
      return route.abort('failed');
    case 'delay':
      await new Promise<void>(resolve => setTimeout(resolve, action.delayMs));
      return route.continue();
    case 'fulfill500':
      return route.fulfill({ status: 500, body: 'injected guardian fault' });
    case 'fulfillConflictPendingDelta':
      return route.fulfill({ status: 409, body: CONFLICT_PENDING_DELTA_BODY });
  }
}

/**
 * Installs a context-wide route handler that intercepts guardian HTTP calls
 * by target (A: :3000, B: :3001) and path segment, applying whichever
 * GuardianFaultPolicy is currently armed. Requests to any other origin
 * (node, prover, note-transport, ...) or that don't match the armed
 * policy's target/path pass through via `route.continue()`. Only one
 * policy can be armed at a time -- `arm()` replaces it and resets the
 * `failFirstN` hit counter.
 */
export function installGuardianFaults(context: BrowserContext): GuardianFaultControls {
  let policy: GuardianFaultPolicy | null = null;
  let hits = 0;

  context.route('**/*', async (route: Route) => {
    const url = route.request().url();
    const decision = decideGuardianFault(url, policy, hits);
    hits = decision.hits;
    await applyGuardianFaultAction(route, decision.action);
  });

  return {
    arm(next) {
      policy = next;
      hits = 0;
    },
    clear() {
      policy = null;
      hits = 0;
    }
  };
}
