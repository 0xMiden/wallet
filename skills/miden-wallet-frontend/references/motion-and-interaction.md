# Motion and Interaction

## Motion Selection

| Behavior | Implementation |
| --- | --- |
| Fade, reveal, pop, sheet, page, press, indicator, shimmer | The `lib/animation` preset of that name, through `usePreset` (or `resolvePreset`) |
| Page push or pop | `FullScreenPage` and `MobilePageLayers` on the `page` preset |
| A step inside one page (`Navigator`, onboarding) | `mode="wait"` swap on `pageStepTransition` via `resolvePageStepTransition`, offsets `pageStepOffset` / `pageStepPresentOffset` / `pageStepFadeOffset` |
| Other enter, exit, state swap, layout, shared element, drag, tap | Framer Motion |
| Spring feel | `lib/animation/springs` through `useMotion`, `useSprings`, or `resolveTransition` |
| Loader spin, pulse, or a simple utility effect | A Tailwind utility with a `motion-reduce:` variant (a loading block is `Skeleton`, a ring is `Spinner`) |
| Root, library, or cross-tree transition | `src/main.css`, with reduced-motion behavior |

Use the spring name that matches the interaction: `snappy` for button/chrome feedback, `standard` for screens, `sheetPresent` for sheets, `morph` for shared-element movement, and `dragRelease` for a post-drag rebound. Do not invent per-component stiffness and damping values.

```tsx
import { motion } from 'framer-motion';

import { springs, useMotion } from 'lib/animation';

const transition = useMotion(springs.standard);

return <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={transition} />;
```

For event-handler animation controls, read `useReducedMotion()` at component scope and pass the result to `resolveTransition`. Repeating or decorative motion must become instant, static, or otherwise non-disruptive when reduced motion is enabled. Under reduced motion every helper returns `reducedMotionTransition`; a test asserting the reduced path imports that constant instead of repeating `{ duration: 0.001 }`.

The page and step motion, as built: a pushed page slides in from the right over `durations.page` (0.34s) on `easings.standard` while the page beneath moves to `pageSlideParallax` (−24%) under `pageSlideDim`. Steps inside one page (the `Navigator` flows and onboarding) are not pushes: their `AnimatePresence` runs in `mode="wait"` and swaps on `pageStepTransition` (0.15s, same curve) with a short offset, instant under reduced motion and a zero-length swap off mobile.

## PR #504 Pattern

An indeterminate progress runner, icon flip, and hero state pop are all owned by `PromptCard`. Implement those as component motion rather than appending their keyframes and classes to `src/main.css`. A basic existing `animate-spin` loader remains appropriate because it is a simple status utility.

## Interaction Requirements

Use `Button` (`components/ui/Button`) for standard wallet actions and `IconButton` for icon-only ones. Use a native `button` only for compact, icon-only, or inline controls that the full CTA component cannot represent; use an `a` for navigation. Never replace a suitable button with a `div`. Icon-only controls need an accessible name. Status or asynchronous completion needs the right `role` or live-region behavior. Keyboard users must receive the same action with Enter and Space when a custom control is unavoidable.

Mobile feedback follows intent:

- `hapticLight()` for ordinary taps.
- `hapticMedium()` for toggles or committed selections.
- `hapticSelection()` for tabs and pickers.
- Success, warning, error, and drag helpers for those outcomes.

Do not add haptics to passive state changes or duplicate feedback already owned by a shared component.
