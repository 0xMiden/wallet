# 002 — Honor prefers-reduced-motion outside the dApp browser

- **Status**: DONE
- **Commit**: cfdf3853
- **Severity**: HIGH
- **Category**: Accessibility
- **Estimated scope**: 5 files (main.css + 4 components), ~60 lines

## Problem

`prefers-reduced-motion` is honored in exactly two places: the framer helpers in `src/lib/animation/use-motion.ts` (used only by the dApp browser module) and `src/screens/generating-transaction/components.tsx`. Everything else — including every mobile page transition — moves regardless of the OS setting. There is **zero** `@media (prefers-reduced-motion: reduce)` in any CSS file.

The rule: reduced motion means fewer and gentler animations, not zero — keep opacity/color feedback, drop position changes.

Current code (verbatim):

```css
/* src/main.css:281-293 — runs on EVERY mobile full-screen page entrance */
@keyframes mobile-slide-in {
  from {
    transform: translateX(8%);
    opacity: 0.5;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

.mobile-page-enter {
  animation: mobile-slide-in 0.15s ease-out both;
}
```

```css
/* src/main.css:303-307 — 200px bubble slide when a drawer opens */
[data-dapp-bubble-host='true'] {
  transition:
    transform 0.42s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.32s cubic-bezier(0.22, 1, 0.36, 1);
}
```

```tsx
// src/components/Navigator.tsx:144-150 — x movement on every Navigator step change (send/swap flows)
const PushInitialPosition: AnimationConfig = {
  x: '8%',
  opacity: 1,
  ...
// src/components/Navigator.tsx:184-190 — y movement for `present` routes
const PresentInitialPosition: AnimationConfig = {
  x: '0vw',
  y: '25vw',
  opacity: 0,
  ...
// src/components/Navigator.tsx:218 — no reduced-motion branch anywhere in the file
const effectiveDuration = isMobile() ? animationDuration : 0;
```

```tsx
// src/screens/onboarding/navigator.tsx:312-325 — onboarding step slides
variants={{
  initialState: {
    x: navigationDirection === 'forward' ? '1vw' : '-1vw',
    opacity: 0
  },
  animateState: { x: 0, opacity: 1 },
  exitState: {
    x: navigationDirection === 'forward' ? '-1vw' : '1vw',
    opacity: 0
  }
}}
```

```tsx
// src/app/pages/Settings.tsx:443-448 — seed-warning overlay slide-up
<motion.div
  className="flex-1 flex flex-col"
  initial={{ y: 40, opacity: 0 }}
  animate={{ y: 0, opacity: 1 }}
  exit={{ y: 40, opacity: 0 }}
  transition={{ duration: 0.3, ease: 'easeOut' }}
>
```

```tsx
// src/components/SyncWaveBackground.tsx:17 — infinite shimmer loop (vestibular trigger)
<div
  className="absolute inset-0 animate-gradient-wave"
```

## Target

Under reduced motion: position changes (translateX/Y) are removed, opacity fades are kept, and the infinite shimmer stops. Exact values per site are in the steps.

## Repo conventions to follow

- The reference JS pattern is `src/screens/generating-transaction/components.tsx:79-81`: call `useReducedMotion()` from `framer-motion` at the top of the component and branch the animated values.
- CSS reduced-motion guards go in `src/main.css` next to the rules they modify.
- Tailwind v4 is in use, so the `motion-reduce:` variant is available in classNames.

## Steps

1. **src/main.css** — directly below the `.mobile-page-enter` rule (line 293), add:
   ```css
   @keyframes mobile-fade-in {
     from {
       opacity: 0.5;
     }
     to {
       opacity: 1;
     }
   }

   @media (prefers-reduced-motion: reduce) {
     .mobile-page-enter {
       animation: mobile-fade-in 0.15s ease-out both;
     }
   }
   ```
2. **src/main.css** — directly below the `body[data-drawer-open] [data-dapp-bubble-host='true']` block (line 316), add:
   ```css
   @media (prefers-reduced-motion: reduce) {
     [data-dapp-bubble-host='true'] {
       transition: opacity 0.32s cubic-bezier(0.22, 1, 0.36, 1);
     }
   }
   ```
   (The bubble still disappears via the opacity fade; the 200px travel becomes instant.)
3. **src/components/Navigator.tsx**:
   - Import `useReducedMotion` from `'framer-motion'` (the file already imports from framer-motion).
   - Below `DefaultAnimationConfig` (line 200-208), add a reduced variant that zeroes all movement but keeps the opacity values:
     ```ts
     export const ReducedMotionAnimationConfig = {
       ...DefaultAnimationConfig,
       pushInitialPosition: { ...PushInitialPosition, x: '0vw' },
       presentInitialPosition: { ...PresentInitialPosition, y: '0vw' },
       presentExitPosition: { ...PresentExitPosition, y: '0vw' }
     };
     ```
   - In the `Navigator` component body (after line 215), add `const reduceMotion = useReducedMotion();` and resolve `const effectiveConfig = reduceMotion ? ReducedMotionAnimationConfig : animationConfig;`. Replace the two uses of `animationConfig` inside the `useMemo` at lines 220-247 with `effectiveConfig`, and add `reduceMotion` / `effectiveConfig` to the memo deps as required.
4. **src/screens/onboarding/navigator.tsx** — in the component containing lines 300-326, call `const reduceMotion = useReducedMotion();` (import from `'framer-motion'`) and change the three `x` values in the variants so movement is dropped under reduce:
   ```tsx
   initialState: {
     x: reduceMotion ? 0 : navigationDirection === 'forward' ? '1vw' : '-1vw',
     opacity: 0
   },
   animateState: { x: 0, opacity: 1 },
   exitState: {
     x: reduceMotion ? 0 : navigationDirection === 'forward' ? '-1vw' : '1vw',
     opacity: 0
   }
   ```
5. **src/app/pages/Settings.tsx** — in the component rendering lines 443-448, call `const reduceMotion = useReducedMotion();` (import from `'framer-motion'`) and change the inner overlay's `y` values: `initial={{ y: reduceMotion ? 0 : 40, opacity: 0 }}`, `exit={{ y: reduceMotion ? 0 : 40, opacity: 0 }}`. Leave the outer backdrop fade (lines 438-441) unchanged — opacity-only is fine under reduced motion.
6. **src/components/SyncWaveBackground.tsx:17** — change the class to stop the loop under reduce:
   ```tsx
   className="absolute inset-0 animate-gradient-wave motion-reduce:animate-none"
   ```

## Boundaries

- Do NOT touch `src/app/pages/Browser/**` or `src/lib/animation/**` — the browser module already routes through `useMotion`/`useSprings`.
- Do NOT touch `src/screens/generating-transaction/**` — already correct (it's the reference pattern).
- Do NOT change any duration, easing, or spring value for the normal-motion path — this plan only adds reduced-motion branches.
- Do NOT add new dependencies.
- If a step doesn't match the code you find (drift since commit cfdf3853), STOP and report instead of improvising.

## Verification

- **Mechanical**: `yarn build` passes. `grep -c 'prefers-reduced-motion' src/main.css` returns 2. `grep -n 'useReducedMotion' src/components/Navigator.tsx src/screens/onboarding/navigator.tsx src/app/pages/Settings.tsx` shows one hit per file.
- **Feel check**: `yarn dev`, then in DevTools → Rendering panel set "Emulate CSS media feature prefers-reduced-motion":
  - Navigate send flow steps: content crossfades in place, no horizontal slide.
  - Open the Settings seed-phrase warning: it fades in without the 40px rise.
  - Trigger a sync: the shimmer stripe does not sweep.
  - Turn emulation off and confirm every original animation still plays exactly as before (movement restored).
- **Done when**: with reduced motion emulated, nothing on screen translates position, yet every state change still has an opacity fade; with it off, behavior is byte-identical to before.
