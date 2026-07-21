export type RootView = 'unlock' | 'loading' | 'welcome' | 'app';

/**
 * Decide the top-level view before any specific route resolves.
 *
 * `hydrated` = the frontend has received at least one backend state response.
 * It exists to break a magic-value collision: `WalletStatus.Idle` is BOTH the
 * frontend's initial (un-hydrated) status AND the backend's "no wallet exists"
 * status. Without `hydrated`, a returning user hits the MV3 service-worker
 * cold-start window (status still Idle, backend not yet responded) and gets
 * routed to onboarding/restore-from-seed instead of unlock.
 */
export function resolveRootView(ctx: { locked: boolean; ready: boolean; hydrated: boolean }): RootView {
  if (ctx.locked) return 'unlock';
  if (!ctx.hydrated) return 'loading';
  if (!ctx.ready) return 'welcome';
  return 'app';
}
