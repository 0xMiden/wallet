# 001 — Speed up the app-wide 300ms hover/color transitions

- **Status**: DONE
- **Commit**: cfdf3853
- **Severity**: HIGH
- **Category**: Easing & duration
- **Estimated scope**: 14 files + tailwind.config.ts, one-line class swaps

## Problem

Nearly every interactive control in the app transitions its hover/press/focus colors over **300ms with `ease-in-out`**. The budget for hover/color feedback is 100–160ms with the CSS `ease` curve; 300ms is ~2× too slow and makes list rows, buttons, chips, and inputs feel sluggish on every interaction. These are the highest-frequency surfaces in the wallet (token lists, buttons, copy chips).

Current code (all verbatim):

```tsx
// src/components/Button.tsx:123 — primary design-system button (app-wide)
'transition-colors duration-300 ease-in-out text-base',
```

```tsx
// src/components/ListItem.tsx:50-51 — token/asset list rows (hover:bg-gray-100 on line 52)
'rounded-lg transition', // Shape and transition classes
'duration-300 ease-in-out', // Transition duration and timing function classes
```

```tsx
// src/components/CardItem.tsx:78-79
'rounded-lg transition', // Shape and transition classes
'duration-300 ease-in-out cursor-pointer', // Transition duration and timing function classes
```

```tsx
// src/components/CircleButton.tsx:38 — icon buttons (hover:bg-gray-100 on line 39)
'transition duration-300 ease-in-out focus:outline-none shadow-none',
```

```tsx
// src/app/atoms/CopyButton.tsx:76
'transition ease-in-out duration-300',
```

```tsx
// src/components/Checkbox.tsx:37 — background/border state change
'transition duration-300 ease-in-out',
```

```tsx
// src/components/Input.tsx:32 and src/components/Input.tsx:83 — focus/error border colors
'transition duration-300 ease-in-out',
```

```tsx
// src/components/TextArea.tsx:29
'transition duration-300 ease-in-out',
```

```tsx
// src/components/Chip.tsx:32
'transition duration-300 ease-in-out',
```

```tsx
// src/app/atoms/ImportTabSwitcher.tsx:38 — tab text/border color
'transition ease-in-out duration-300',
```

```tsx
// src/app/atoms/OpenInExplorerChip.tsx:75
'transition ease-in-out duration-300',
```

```tsx
// src/app/templates/DAppSettings.tsx:133
className="p-1 hover:bg-gray-100 rounded-sm transition ease-in-out duration-300"
```

```tsx
// src/app/layouts/PageLayout.tsx:199 — sticky title container
'transition ease-in-out duration-300'
```

## Target

- Duration: **150ms** (`duration-150`).
- Easing: the CSS `ease` curve — `cubic-bezier(0.25, 0.1, 0.25, 1)` — exposed as a Tailwind token class `ease-hover`.
- Property scope: where the element only changes colors on hover/focus/state, use `transition-colors` instead of the bare `transition` (bare `transition` also covers transform/opacity, which none of these sites animate).

Example end state for ListItem:

```tsx
'rounded-lg transition-colors', // Shape and transition classes
'duration-150 ease-hover', // Transition duration and timing function classes
```

## Repo conventions to follow

- Tailwind config is `tailwind.config.ts` (Tailwind v4 loaded via `@config` in `src/main.css`). Motion-ish extensions live under `theme.extend` — see the existing `animation`/`keyframes` entries for `gradient-wave` at `tailwind.config.ts:219-228`. Add the timing-function token there.
- The framer-motion token system (`src/lib/animation/`) is for framer transitions only — do NOT convert these CSS class sites to framer-motion.
- Class lists are built with `classNames(...)`/`cn(...)` string fragments; keep the existing fragment structure and comments, edit only the transition-related tokens.

## Steps

1. In `tailwind.config.ts`, inside `theme.extend` (next to the existing `animation` key), add:
   ```ts
   transitionTimingFunction: {
     hover: 'cubic-bezier(0.25, 0.1, 0.25, 1)' // CSS `ease` — hover/color feedback
   },
   ```
2. `src/components/Button.tsx:123`: `'transition-colors duration-300 ease-in-out text-base'` → `'transition-colors duration-150 ease-hover text-base'`.
3. `src/components/ListItem.tsx:50-51`: `'rounded-lg transition'` → `'rounded-lg transition-colors'`; `'duration-300 ease-in-out'` → `'duration-150 ease-hover'`. Keep the trailing comments.
4. `src/components/CardItem.tsx:78-79`: `'rounded-lg transition'` → `'rounded-lg transition-colors'`; `'duration-300 ease-in-out cursor-pointer'` → `'duration-150 ease-hover cursor-pointer'`.
5. `src/components/CircleButton.tsx:38`: `'transition duration-300 ease-in-out focus:outline-none shadow-none'` → `'transition-colors duration-150 ease-hover focus:outline-none shadow-none'`.
6. `src/app/atoms/CopyButton.tsx:76`: `'transition ease-in-out duration-300'` → `'transition-colors ease-hover duration-150'`.
7. `src/components/Checkbox.tsx:37`: `'transition duration-300 ease-in-out'` → `'transition-colors duration-150 ease-hover'`.
8. `src/components/Input.tsx:32` and `:83`: `'transition duration-300 ease-in-out'` → `'transition-colors duration-150 ease-hover'` (both occurrences).
9. `src/components/TextArea.tsx:29`: same swap as step 8.
10. `src/components/Chip.tsx:32`: same swap as step 8.
11. `src/app/atoms/ImportTabSwitcher.tsx:38`: `'transition ease-in-out duration-300'` → `'transition-colors ease-hover duration-150'`.
12. `src/app/atoms/OpenInExplorerChip.tsx:75`: `'transition ease-in-out duration-300'` → `'transition-colors ease-hover duration-150'`.
13. `src/app/templates/DAppSettings.tsx:133`: `transition ease-in-out duration-300` → `transition-colors ease-hover duration-150` inside the className string.
14. `src/app/layouts/PageLayout.tsx:199`: `'transition ease-in-out duration-300'` → `'transition duration-150 ease-hover'`. **Keep the bare `transition` here** (do not narrow to `transition-colors`) — this sticky header container's transitioned properties are not verified to be colors-only.

## Boundaries

- Do NOT touch `src/screens/onboarding/create-wallet-flow/BackUpSeedPhrase.tsx:68` — its 300ms transition animates a deliberate `blur` reveal on a rare onboarding screen; leave it.
- Do NOT touch `src/app/ConfirmPage.tsx:446` or `src/lib/ui/button.tsx:9` (`transition-all` scoping is a separate concern, not this plan).
- Do NOT convert any of these to framer-motion, and do not change hover colors, layout classes, or markup.
- Do NOT add new dependencies.
- If a cited line doesn't match the excerpt (drift since commit cfdf3853), STOP and report instead of improvising.

## Verification

- **Mechanical**: `yarn build` succeeds. `grep -rn 'duration-300 ease-in-out' src/components src/app/atoms` returns no hits in the files listed above. `grep -n 'ease-hover' tailwind.config.ts` shows the new token.
- **Feel check**: run `yarn dev`, hover a token row on the home list and a primary button:
  - The hover tint now lands almost immediately (~150ms) instead of oozing in.
  - Tab between form inputs on the send screen — focus border color snaps crisply.
  - In DevTools → Animations panel at 10% speed, confirm the hover transition curve decelerates (no symmetric slow-start).
- **Done when**: every listed line uses `duration-150 ease-hover`, the build passes, and hover feedback on lists/buttons reads as instant-but-smooth.
