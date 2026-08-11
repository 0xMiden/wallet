---
name: miden-wallet-frontend
description: Use when building, styling, animating, or reviewing React UI in Miden Wallet, including components, Tailwind or CSS, Framer Motion, mobile interactions, theme behavior, accessibility, or cross-platform layout.
---

# Miden Wallet Frontend

## Overview

Build wallet UI by extending the established system instead of copying legacy or one-off patterns. Preserve a consistent feel across extension, mobile, and desktop while keeping motion accessible and CSS scoped.

## Workflow

1. Read the relevant reference before editing. Search the nearby feature first, then reuse the designated component layer.
2. Choose the smallest styling and motion mechanism that fits the behavior.
3. Implement semantics, localization, haptics, theme behavior, and platform constraints with the UI.
4. Verify the affected states and platforms before declaring the change ready.

## Quick Decisions

| Need | Use |
| --- | --- |
| Existing wallet control or display | Current feature, then `src/components/ui` |
| Primary wallet CTA | `src/components/Button` |
| Drawer, dialog, or compact generic primitive | Existing `src/lib/ui` convention |
| New style | Tailwind + `cn()` + semantic token |
| Component state, layout, gesture, or enter/exit motion | Framer Motion + reduced-motion-aware springs |
| Simple status effect | Tailwind or `tw-animate-css` utility |
| Root, platform, library, or cross-tree style | `src/main.css` |

## Required Rules

- Do not extend `src/app/atoms` for new UI; it is maintenance-only.
- Use semantic theme tokens. Existing hardcoded colors and redundant `dark:` variants are not precedent.
- Do not add component-specific classes or keyframes to `src/main.css`.
- Use `useMotion`, `useSprings`, or `resolveTransition` with `lib/animation/springs`; do not inline spring physics.
- Use native interactive elements where possible. Otherwise provide keyboard activation, visible focus, and an accessible name.
- Localize user-facing text, use v2 icons, and add the established mobile haptic for meaningful interaction.
- Isolate platform behavior through `lib/platform`; preserve mobile safe areas and native navbar ownership.

## References

- [Components and styling](references/components-and-styling.md)
- [Motion and interaction](references/motion-and-interaction.md)
- [Platform, accessibility, and verification](references/platform-accessibility-verification.md)

## Common Mistakes

- Adding a one-off keyframe to global CSS because it is quick.
- Using a raw `div` as a button when a native button works.
- Adding `dark:` to a token that already auto-flips.
- Copying legacy atoms, literal colors, or inline spring values into new UI.
- Treating mobile as a CSS breakpoint rather than a platform with safe-area, native-nav, and haptic behavior.
