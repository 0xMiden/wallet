# 004 — Fix the dropdown's ease-in exit and its consumer's dead easing class

- **Status**: DONE
- **Commit**: cfdf3853
- **Severity**: MEDIUM
- **Category**: Easing & duration
- **Estimated scope**: 2 files, 2 lines

## Problem

Two defects in the shared dropdown atom and its single consumer:

**A.** The dropdown's exit uses `ease-in`. `ease-in` starts slow, delaying the exact moment the user is watching (the panel starting to leave). Entering and exiting UI should both use `ease-out`. The enter (line 28) is already correct.

```tsx
// src/app/atoms/DropdownWrapper.tsx:23-31 — current
classNames={{
  enter: classNames('transform opacity-0', scaleAnimation && 'scale-95'),
  enterActive: classNames(
    'transform opacity-100',
    scaleAnimation && 'scale-100',
    'transition ease-out duration-100'
  ),
  exit: classNames('transform opacity-0', scaleAnimation && 'scale-95', 'transition ease-in duration-100')
}}
```

**B.** The option rows inside the dropdown's only consumer carry a typo'd easing class — `easy-in-out` is not a Tailwind utility, so it silently does nothing and the transition falls back to the default curve at a hand-typed 200ms:

```tsx
// src/app/templates/IconifiedSelect.tsx:150-155 — current (option row button)
className={classNames(
  'w-full',
  'mb-1',
  'rounded',
  'transition easy-in-out duration-200',
  selected ? 'bg-chip-bg' : !disabled && 'hover:bg-gray-100',
```

The only properties that change on these rows are background colors (`bg-chip-bg` / `hover:bg-gray-100`), i.e. hover/color feedback — budget 100–160ms.

(Transform-origin is already correct: `IconifiedSelect.tsx:110` passes `origin-top`, so the panel scales from its trigger edge.)

## Target

```tsx
// src/app/atoms/DropdownWrapper.tsx:30 — target
exit: classNames('transform opacity-0', scaleAnimation && 'scale-95', 'transition ease-out duration-100')
```

```tsx
// src/app/templates/IconifiedSelect.tsx:154 — target
'transition-colors ease-out duration-150',
```

## Repo conventions to follow

- Class lists built with `classNames(...)` string fragments; edit only the transition tokens in place.
- The scoped-property pattern to imitate is `transition-colors` as used in `src/app/atoms/ToggleSwitch.tsx:55`.
- If plan 001 has already landed (it adds an `ease-hover` token to `tailwind.config.ts`), prefer `'transition-colors ease-hover duration-150'` for the IconifiedSelect row; otherwise use `ease-out` as written above.

## Steps

1. `src/app/atoms/DropdownWrapper.tsx:30`: in the `exit` entry, change `'transition ease-in duration-100'` to `'transition ease-out duration-100'`.
2. `src/app/templates/IconifiedSelect.tsx:154`: change `'transition easy-in-out duration-200',` to `'transition-colors ease-out duration-150',` (or `ease-hover`, per the convention note above).

## Boundaries

- Do NOT touch the enter/enterActive classes, the `timeout={100}` prop, or any markup.
- Do NOT change the `origin-top` class on IconifiedSelect.tsx:110.
- Do NOT add new dependencies.
- If either line doesn't match its excerpt (drift since commit cfdf3853), STOP and report instead of improvising.

## Verification

- **Mechanical**: `yarn build` passes. `grep -rn 'easy-in-out' src` returns nothing. `grep -n 'ease-in ' src/app/atoms/DropdownWrapper.tsx` returns nothing.
- **Feel check**: `yarn dev`, open a screen using `IconifiedSelect` (any iconified select dropdown), open and close it repeatedly:
  - On close, the panel starts collapsing immediately — no perceptible hesitation before it begins to shrink/fade.
  - In DevTools → Animations at 10% speed, the exit visibly decelerates (fast start, slow finish), mirroring the enter.
  - Hovering option rows tints them promptly (~150ms).
- **Done when**: no `ease-in` or `easy-in-out` remains in these two files and the close feels as responsive as the open.
