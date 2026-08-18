import { expect } from '@playwright/test';

/**
 * Shared assertion helpers for the infra-resilience suite.
 *
 * These encode the *behavioural* invariants the resilience specs assert about a
 * wallet under infra fault — "a read must not hang forever", "a fund total must
 * not silently move while the backend is unreachable" — as small, named, reusable
 * checks. Reading the invariant by name in a spec keeps each scenario focused on
 * WHICH dependency it faults and WHICH surface it drives, not on re-deriving the
 * race-safe assertion each time.
 */

/**
 * Assert an operation SETTLES (resolves or rejects) within `budgetMs`, rather
 * than hanging indefinitely.
 *
 * This is the core anti-hang invariant of the whole suite: under a blackholing
 * dependency (a node that accepts the socket then goes silent, a prover that
 * never answers) a wallet must bound its wait and surface *something* — not spin
 * a forever-spinner. We deliberately do NOT assert success: a bounded, clean
 * FAILURE is a graceful outcome under a total outage. Only an unbounded hang is
 * the defect.
 *
 * Returns `{ outcome, error }` so a caller can additionally assert on HOW it
 * settled when that matters (e.g. a typed connectivity error vs. a raw string).
 * `label` names the operation in the timeout message.
 */
export async function expectSettlesWithin<T>(
  op: () => Promise<T>,
  budgetMs: number,
  label: string
): Promise<{ outcome: 'resolved' | 'rejected'; value?: T; error?: unknown }> {
  const HANG = Symbol('hang');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof HANG>(resolve => {
    timer = setTimeout(() => resolve(HANG), budgetMs);
  });

  const settled = await Promise.race([
    op().then(
      value => ({ outcome: 'resolved' as const, value }),
      error => ({ outcome: 'rejected' as const, error })
    ),
    timeout
  ]);
  if (timer) clearTimeout(timer);

  // A never-settling op reaches here as the HANG sentinel — the one failure mode
  // this helper exists to catch. Assert unconditionally (never inside a branch)
  // so the check can't be silently skipped.
  const hung = settled === HANG;
  expect(hung, `${label} must settle within ${budgetMs}ms under fault, but it hung`).toBe(false);

  // Narrowed by the assertion above; the cast documents that `settled` is now the
  // resolved/rejected record, never the sentinel.
  return settled as { outcome: 'resolved' | 'rejected'; value?: T; error?: unknown };
}
