# Components and Styling

## Component Selection

Search the active feature before creating a primitive. Then follow this order:

1. Reuse the local feature component when it represents the same product behavior.
2. Use `src/components/ui` for wallet design-system surfaces such as cards, rows, navigation, prompt, asset, and balance UI.
3. Use `src/components/Button` for the wallet's full-width primary, secondary, and ghost CTAs.
4. Use `src/lib/ui` only where the local convention already uses its Radix, Vaul, or shadcn-style primitive.
5. Maintain `src/app/atoms` only when changing an existing legacy flow; do not make it the home for new UI.

Use the v2 icon registry in `src/app/icons/v2` rather than adding inline SVG for a standard wallet icon.

## Styling

Use Tailwind classes and `cn()` from `lib/ui/util` for conditional composition. Use a CSS module only when component-scoped CSS is genuinely necessary for selectors or behavior that Tailwind cannot express; do not add one for ordinary layout or color work.

Use semantic tokens from `tailwind.config.ts` and `src/main.css`: `text-text-primary-token`, `text-text-secondary-token`, `bg-surface-input`, `bg-surface-interactive`, `bg-accent-primary`, status colors, rules, and token radii. `text-black`, `bg-white`, `bg-gray-25/50/100`, and `text-heading-gray` already resolve through theme variables; do not add `dark:` variants to them.

Fixed palettes (`grey.*`, `pure-white`, `pure-black`) and SVG `fill` values need explicit theme treatment. Prefer `currentColor` for icons. Existing literal colors are migration debt, not a template for new code.

## Global CSS Boundary

`src/main.css` owns Tailwind imports, font and theme variables, root surfaces, browser or library overrides, safe-area behavior, and selectors that coordinate separate React trees. It may hold a global animation only when React cannot own the element or behavior is inherently root/platform scoped.

Component-owned visual behavior belongs with the component. Do not add a named global class or `@keyframes` there for a card, prompt, row, button, or local state transition.
