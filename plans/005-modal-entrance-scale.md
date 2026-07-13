# 005 — Soften the react-modal entrance (scale 0.75 → 0.96, ease-out)

- **Status**: DONE
- **Commit**: cfdf3853
- **Severity**: MEDIUM
- **Category**: Physicality & origin
- **Estimated scope**: 1 file (src/main.css), ~4 values

## Problem

Every react-modal in the app enters by scaling up from **0.75** with `ease-in-out`. Physical UI should enter from `scale(0.9–0.97)` — a 25% shrink reads as the modal "zooming in from far away" rather than settling into place. And entrances should use `ease-out` (fast start, gentle landing); `ease-in-out` delays the start of the very thing the user just asked for. Center origin is correct for modals and must stay.

Current code (verbatim):

```css
/* src/main.css:40-64 — current */
.ReactModal__Overlay {
  opacity: 0;
  transition: opacity 200ms ease-in-out;
}

.ReactModal__Content {
  transform: scale(0.75);
  transition: transform 200ms ease-in-out;
}

.ReactModal__Overlay--after-open {
  opacity: 1;
}

.ReactModal__Overlay--before-close {
  opacity: 0;
}

.ReactModal__Overlay--after-open .ReactModal__Content {
  transform: scale(1);
}

.ReactModal__Overlay--before-close .ReactModal__Content {
  transform: scale(0.75);
}
```

```css
/* src/main.css:66-70 — current (special-cased modal that slides instead of scaling) */
#recall-height-modal.ReactModal__Content {
  transform: scale(1);
  transform: translateY(2rem);
  transition: transform 200ms ease-in-out;
}
```

## Target

```css
.ReactModal__Overlay {
  opacity: 0;
  transition: opacity 200ms ease-out;
}

.ReactModal__Content {
  transform: scale(0.96);
  transition: transform 200ms ease-out;
}

/* --after-open / --before-close rules unchanged except: */
.ReactModal__Overlay--before-close .ReactModal__Content {
  transform: scale(0.96);
}

#recall-height-modal.ReactModal__Content {
  transform: scale(1);
  transform: translateY(2rem);
  transition: transform 200ms ease-out;
}
```

Duration stays 200ms (within the 200–500ms modal budget). The exit returning to 0.96 keeps the close symmetric and subtle.

## Repo conventions to follow

- These are third-party-library hook classes (react-modal) that live in the global stylesheet `src/main.css` — edit them in place; do not move them.
- A correct in-repo exemplar of modal entrance scale: `src/app/pages/Browser/DappConfirmationModal.tsx` enters from `scale: 0.96`.

## Steps

1. `src/main.css:42`: `transition: opacity 200ms ease-in-out;` → `transition: opacity 200ms ease-out;`
2. `src/main.css:46`: `transform: scale(0.75);` → `transform: scale(0.96);`
3. `src/main.css:47`: `transition: transform 200ms ease-in-out;` → `transition: transform 200ms ease-out;`
4. `src/main.css:63` (inside `.ReactModal__Overlay--before-close .ReactModal__Content`): `transform: scale(0.75);` → `transform: scale(0.96);`
5. `src/main.css:69` (inside `#recall-height-modal.ReactModal__Content`): `transition: transform 200ms ease-in-out;` → `transition: transform 200ms ease-out;` (leave the duplicated `transform` lines exactly as they are — the second intentionally wins).

## Boundaries

- Do NOT change any selector, the 200ms duration, the overlay opacity values, or the `#recall-height-modal` translateY values.
- Do NOT introduce transform-origin rules — center is correct for modals.
- Do NOT touch anything else in src/main.css.
- If a line doesn't match its excerpt (drift since commit cfdf3853), STOP and report instead of improvising.

## Verification

- **Mechanical**: `yarn build` passes. `grep -n 'scale(0.75)' src/main.css` returns nothing.
- **Feel check**: `yarn dev`, open any modal (e.g. a confirmation dialog):
  - The modal now settles into place from just-under-full-size instead of zooming up from three-quarters.
  - In DevTools → Animations at 10% speed, the entrance starts fast and decelerates.
  - Close the modal: it recedes slightly (to 0.96) while the overlay fades — no dramatic shrink.
- **Done when**: no `scale(0.75)` remains, all three react-modal transitions use `ease-out`, and the modal open reads as "settling" rather than "zooming".
