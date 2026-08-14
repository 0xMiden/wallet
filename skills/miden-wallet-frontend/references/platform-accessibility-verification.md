# Platform, Accessibility, and Verification

## Platform Constraints

The wallet serves extension, Capacitor iOS/Android, and Tauri desktop. Use `lib/platform` to isolate platform behavior; a mobile fix must not leak into extension or desktop.

Mobile uses `100%` and safe-area padding owned by `public/mobile.html`; do not introduce `100dvh` sizing. The mobile bottom navbar is a native overlay, not a React component to recreate. Preserve the existing fixed popup, full-page, side-panel, and desktop sizing patterns before reaching for responsive breakpoints.

## Accessibility and Content

- Use native semantics, visible focus, keyboard access, and accessible names.
- Keep contrast theme-safe through semantic tokens.
- Localize every user-facing string with `t()` or `<T />`; add English source keys to `public/_locales/en/en.json` and run `yarn lint:i18n` when copy changes.
- Use `aria-live`, `role="status"`, or `role="alert"` when asynchronous state needs announcement.

## Verification Matrix

| Change | Verify |
| --- | --- |
| Any TypeScript UI behavior | Targeted Jest/RTL, `yarn ts`, and `yarn lint` |
| User-facing copy | `yarn lint:i18n` |
| Visual styling | Light and dark theme inspection |
| Nontrivial motion | Normal and reduced-motion paths |
| Mobile or shared layout | iPhone 17 simulator screenshot and affected extension/desktop surface |
| New interaction | Keyboard behavior, focus, haptics, and loading/error/success states |

Use test mocks for Framer Motion where established by nearby tests, but assert behavior rather than implementation details. Keep tests colocated with the changed component.
