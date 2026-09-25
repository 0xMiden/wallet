# Components and Styling

## Component Selection

Search the active feature before creating a primitive. Then follow this order:

1. Use the canonical component for the element from [the design system](design-system.md), in `src/components/ui`: `Button`, `IconButton`, `Pill`, `Avatar`, `ListGroup`/`ListRow`/`SectionHeader`, `DetailCard`, `Hero`, `TextField`, `SearchInput`, `EmptyState`, `Spinner`, `Skeleton`, `CopyButton`/`CopyChip`, `TabHeader`; plus `components/PageHeader` and `AlertSheet` behind `useConfirm`/`useAlert`.
2. `Button` lives at `src/components/ui/Button`; `src/components/Button` re-exports it. Two buttons side by side sit 10px apart (`gap-2.5`), each `flex-1`.
3. `PageHeader` has no horizontal padding: it takes the page's. In an unpadded parent pass `className="px-4"`.
4. Reuse the local feature component when it represents the same product behavior and the design system has no row for it.
5. Use `src/lib/ui` only where the local convention already uses its Radix, Vaul, or shadcn-style primitive. Tooltips are still `components/Tooltip` on tippy.js; the Radix `Tooltip` is pending.
6. Maintain `src/app/atoms` only when changing an existing legacy flow. ESLint bans new importers of it and every retired module (`lib/ui/button`, `lib/ui/badge`, `components/EmptyState`, `components/flow/FlowDetails`, `NavigationHeader`, `CircleButton`, `NavButton`, …); see `.eslintrc`.

A variant is declared with `class-variance-authority` (`cva`) as a closed, typed set (`Button`, `IconButton`, `Pill`, `Avatar`); `className` is for layout.

`components.json` points the shadcn CLI at `components/ui` and `lib/ui/util`. Its aliases have no `@/` prefix because `tsconfig.json` sets `baseUrl: src` and no `paths`, so check what `npx shadcn add` writes: fix any `@/` import it emits, and restyle the component to the tokens below.

Use the v2 icon registry in `src/app/icons/v2` rather than adding inline SVG for a standard wallet icon.

## Styling

Use Tailwind classes and `cn()` from `lib/ui/util` for conditional composition. Use a CSS module only when component-scoped CSS is genuinely necessary for selectors or behavior that Tailwind cannot express; do not add one for ordinary layout or color work.

Use the design-system tokens from `tailwind.config.ts` and `src/main.css`: `bg-page`, `bg-fill`, `bg-fill-pressed`, `border-hairline`, `text-ink`, `text-muted`, `bg-accent-tint` / `text-accent-tint-ink`, `text-positive-ink` / `text-pending-ink` / `text-negative-ink`, and `bg-accent-primary` for a CTA fill. A pressed or hovered element on `page` or `fill` goes to `fill-pressed`. Every one of them flips with the theme through a CSS variable; do not add `dark:` variants to them (nor to `bg-white` or `bg-gray-100`, which flip too).

Text actions (Copy, Edit, See all, a header's text action) are `text-accent-tint-ink`, never `text-accent-primary`: #E77537 is 2.64:1 on `fill` and 3.0:1 on white.

The old surfaces (`gray-25`, `gray-50`, `surface-input`, `surface-interactive`, `surface-nav-button`, `button-secondary`) and `heading-gray` are gone. `black` remains only for overlays (`bg-black/50`) and resolves to `ink`; write text as `text-ink`.

Fixed palettes (`grey.*`, `pure-white`, `pure-black`) and SVG `fill` values need explicit theme treatment. Prefer `currentColor` for icons. Existing literal colors are migration debt, not a template for new code.

## Global CSS Boundary

`src/main.css` owns Tailwind imports, font and theme variables, root surfaces, browser or library overrides, safe-area behavior, and selectors that coordinate separate React trees. It may hold a global animation only when React cannot own the element or behavior is inherently root/platform scoped.

Component-owned visual behavior belongs with the component. Do not add a named global class or `@keyframes` there for a card, prompt, row, button, or local state transition.
