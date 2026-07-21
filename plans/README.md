# Animation improvement plans

Produced by an `improve-animations` audit at commit `cfdf3853` (2026-07-12). Each plan is fully self-contained — an executor needs no other context. Full audit findings (including unplanned MEDIUM/LOW items) are recorded in the audit conversation; plans below cover the top findings by leverage.

| # | Plan | Severity | Category | Status |
| --- | --- | --- | --- | --- |
| 001 | [Speed up the app-wide 300ms hover/color transitions](001-fast-hover-color-transitions.md) | HIGH | Easing & duration | DONE |
| 002 | [Honor prefers-reduced-motion outside the dApp browser](002-reduced-motion-coverage.md) | HIGH | Accessibility | DONE |
| 003 | [Move the toggle knob with transform, not `left`](003-toggle-knob-transform.md) | HIGH | Performance | DONE |
| 004 | [Fix the dropdown's ease-in exit + dead easing class](004-dropdown-exit-easing.md) | MEDIUM | Easing & duration | DONE |
| 005 | [Soften the react-modal entrance (0.75 → 0.96, ease-out)](005-modal-entrance-scale.md) | MEDIUM | Physicality | DONE |

All five plans were executed and verified (typecheck clean, 107 related tests passing) on 2026-07-12. Plan 004 used the `ease-hover` token from 001.

## Recommended execution order

1. **001** — establishes the `ease-hover` Tailwind token that 004 optionally reuses.
2. **004** — tiny; picks up `ease-hover` if 001 landed (falls back to `ease-out` otherwise).
3. **003** — tiny, independent.
4. **005** — tiny, independent.
5. **002** — largest; independent of the others, safest to review last on a real device.

## Dependencies

- 004 → 001 (soft: prefers the `ease-hover` token if present; works standalone with `ease-out`).
- 002, 003, 005 have no dependencies.

## Conventions the plans rely on

- Framer-motion tokens: `src/lib/animation/{springs,easings,durations,use-motion}.ts` (do not bypass; do not port CSS transitions to framer).
- Tailwind v4 via `@config tailwind.config.ts`; new CSS motion tokens go in `theme.extend`.
- Reduced-motion reference pattern: `src/screens/generating-transaction/components.tsx` (`useReducedMotion` + branched values).
- The dApp browser (`src/app/pages/Browser/**`) is the deliberate delight zone — its motion is by design and out of scope for all plans.
