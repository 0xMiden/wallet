/**
 * Shared CSS micro-interaction classes: Tailwind utility strings that still need one home so a
 * duration/easing pair isn't retyped (and drifts) in every component that wants it.
 * `lib/animation`'s presets cover framer-motion transitions; this covers the plain-CSS transition
 * a `components/ui` control puts on its own `className`.
 */

/** Hover/press color feedback on a glyph or its background — the design system's icon-button
 *  micro-interaction (`skills/miden-wallet-frontend/references/design-system.md`, "Icon button"). */
export const colorTransitionClass = 'transition-colors duration-150 ease-hover';
