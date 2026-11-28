/** Motion tunables for the Home pages: the tab switch, and how long a switch holds background work. */
export const pagerMotion = {
  /** The leaving page fades out linearly over this, from the tap's frame (scaled by its drawn opacity). */
  switchExitMs: 90,
  /** The entering page then fades in and settles over this. */
  switchEnterMs: 170,
  /** How far the entering page starts toward its tab's side. */
  switchNudgePx: 12,
  /** M3 emphasized decelerate, for entering content. */
  switchEnterEasing: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
  /** Background work and the refresh boost hold this long per switch: the panes (260) and the pill (quiet by ~351). */
  switchHoldMs: 360,
  /** Longest a held gesture may defer background work before it runs anyway. */
  interactionDeferCapMs: 1500
} as const;
