# 003 — Move the toggle knob with transform, not `left`

- **Status**: DONE
- **Commit**: cfdf3853
- **Severity**: HIGH
- **Category**: Performance
- **Estimated scope**: 1 file, ~6 lines

## Problem

The toggle switch knob animates the CSS `left` property via `transition-all`. Animating `left` runs off-GPU — layout + paint + composite on every frame — and `transition-all` additionally transitions any property that happens to change. The track directly above it already does this correctly with `transition-colors`; only the knob is defective. Toggles are hit in Settings and forms throughout the app.

Current code (verbatim):

```tsx
// src/app/atoms/ToggleSwitch.tsx:63-74
{/* Dot */}
<div
  className="absolute rounded-full transition-all duration-200 ease-in-out shadow-sm"
  style={{
    width: '18px',
    height: '18px',
    top: '2px',
    left: localChecked ? '20px' : '2px',
    backgroundColor: '#FFFFFF',
    pointerEvents: 'none'
  }}
/>
```

## Target

The knob sits at a fixed `left: 2px` and travels via `transform: translateX(18px)` (20px − 2px = 18px travel), transitioning **only** `transform`:

```tsx
{/* Dot */}
<div
  className="absolute rounded-full transition-transform duration-200 ease-in-out shadow-sm"
  style={{
    width: '18px',
    height: '18px',
    top: '2px',
    left: '2px',
    transform: localChecked ? 'translateX(18px)' : 'translateX(0)',
    backgroundColor: '#FFFFFF',
    pointerEvents: 'none'
  }}
/>
```

Keep `duration-200 ease-in-out` — a knob moving between two on-screen positions is on-screen movement, where `ease-in-out` is the correct curve, and CSS transitions retarget mid-flight so rapid toggling stays interruptible.

## Repo conventions to follow

- The track element in the same file (`src/app/atoms/ToggleSwitch.tsx:55`) already uses the scoped `transition-colors` pattern — mirror that scoping discipline (`transition-transform` for the knob).
- Inline `style` objects with px strings are this component's existing idiom; stay with it.

## Steps

1. In `src/app/atoms/ToggleSwitch.tsx`, on the knob `<div>` (line 65): replace `transition-all` with `transition-transform` in the className.
2. In the same element's `style` object: change `left: localChecked ? '20px' : '2px',` to the two lines `left: '2px',` and `transform: localChecked ? 'translateX(18px)' : 'translateX(0)',`.

## Boundaries

- Do NOT touch the track div, the invisible input, or any logic/handlers in the file.
- Do NOT change sizes, colors, duration, or easing.
- Do NOT add new dependencies.
- If the code doesn't match the excerpt (drift since commit cfdf3853), STOP and report instead of improvising.

## Verification

- **Mechanical**: `yarn build` passes. `grep -n 'transition-all' src/app/atoms/ToggleSwitch.tsx` returns nothing.
- **Feel check**: `yarn dev`, open Settings and flip any toggle:
  - The knob glides exactly as before (same 18px travel, same 200ms) — the change must be visually indistinguishable.
  - Rapidly spam the toggle: the knob reverses smoothly mid-travel, never jumping to an endpoint.
  - In DevTools → Performance, record a toggle flip: no Layout entries attributable to the knob (transform-only animation composites on the GPU).
- **Done when**: the knob animates via transform only, spamming stays smooth, and the flip looks identical to the previous behavior at normal speed.
