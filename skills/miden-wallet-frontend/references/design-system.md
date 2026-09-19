# Design System

One canonical component per UI element, one set of motion presets, used on every screen. When a
screen needs something this document does not have, extend the canonical component (a variant or a
prop); do not build a local copy. Local copies are how the wallet reached five page headers, four
page-transition models and about 30 section-title styles.

Direction: **crisp and left-aligned** (chosen 2026-09-19 over a centered and a tray-based
direction). Visual reference: the screens page (Bread Screens artifact, direction B) and the Bread
design system page. Rows marked *planned* do not exist yet; the migration order at the end says
when each lands. Until a row lands, do not add a new instance of anything it replaces.

## Rules

1. Canonical components live in `src/components/ui`, one per element, styled with Tailwind and the
   tokens below, with variants and sizes declared through `class-variance-authority` (`cva`). A
   variant is a closed, typed set; `className` is for layout (margins, width), not for restyling.
2. Components follow **shadcn/ui**: copied into the repo and owned by us, not installed as a
   dependency. Anything with interactive behavior (focus, keyboard, dismissal, roles) is built on
   **Radix Primitives**; sheets stay on vaul. Pull a component with the shadcn CLI
   (`components.json` points it at `src/components/ui` and `lib/ui/util`'s `cn`), then restyle it to
   these tokens: never keep shadcn's default theme variables or colors.
3. `src/app/atoms`, `lib/ui/button`, `lib/ui/badge` and every component listed under "Replaces" are
   frozen: fix bugs in them, migrate their callers, then delete them.
4. Motion goes through `lib/animation`: a named preset, or a named spring for anything the presets
   do not cover. No literal duration, easing, stiffness or cubic-bezier in a component.
5. Every animation respects reduced motion. Presets do this for you; a CSS animation needs a
   `motion-reduce:` variant.
6. Text meets 4.5:1 on the surface it sits on (3:1 for 19px bold and larger, icons and control
   edges) in both themes. A new color pair is checked before it ships.

## Foundations

### Surfaces

Two fills replace six (`gray-25`, `gray-50`, `surface-input`, `surface-interactive`,
`surface-nav-button`, `button-secondary`).

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `page` | #FFFFFF | #191919 | The page, headers, sheets. |
| `fill` | #F3F0EC | #262422 | Every contained element: list groups, detail cards, search, pills, inputs, secondary buttons, the sheet ✕. |
| `fill-pressed` | #E9E5E0 | #33302D | A pressed or selected element on `fill`; the sheet handle. |
| `hairline` | #3F3F3F at 10% | #FFFFFF at 9% | Dividers inside groups and detail cards; a header once content scrolls under it. |

### Text

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `ink` | #3F3F3F | #FFFFFF | Titles, values, body. Replaces `text-black` #3F3F3F and `heading-gray` #484848. |
| `muted` | #6B6B6B | #A8A29C | Subtitles, labels, placeholders, secondary copy: 4.7:1 on `fill`, 5.3:1 on `page`. Replaces #ABABAB and every `opacity-50` text. |

### Brand and status

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `accent` | #E77537 | #E77537 | Primary CTA fill, selected state, focus ring, header text actions. White on it is 3.0:1: labels on it are 19px bold or larger. |
| `accent-tint` | #FDEEE5 | #3A2418 | Selected pill fill. |
| `accent-tint-ink` | #A84A18 | #F2A57A | Text on `accent-tint` (5.1:1). |
| `positive` / `positive-ink` | #90BA89 / #3D7A34 | #90BA89 / #90BA89 | Fill / text for success. |
| `pending` / `pending-ink` | #E85D2F / #B8451A | #E85D2F / #F08B57 | Fill / text for in progress. |
| `negative` / `negative-ink` | #FF5500 / #C63A00 | #C51A0A / #FF7A4D | Fill / text for errors and destructive actions. |
| Flow accents | `accent-send` #91ACC1, `accent-receive` #99AC94, `accent-earn` #777487, `accent-swap` #BEACD2 | same | Ahmad's top action bar and each flow's selected states only. Never text or a back chevron: most are under 3:1 on white. |
| Networks | `network-miden-*`, `network-ethereum-*` | as today | NetworkChip only. |

A status is a word or an icon plus its color, never color alone.

### Type

Nunito (`font-heading`) for titles, values and buttons; Inter (`font-sans`) for body and labels.

| Role | Style | Where |
| --- | --- | --- |
| Tab title | 28px / 36, 800, −0.5px | `TabHeader`, tab roots only |
| Page title | **20px / 26, 800, left** | `PageHeader` |
| Sheet title | 20px / 26, 800, left | `DrawerTitle` |
| Hero value | 32px / 36, 900 | amounts on review and receipt |
| Hero name | 24px / 28, 900 | outcome and empty heroes |
| Entry | 30–48px, 800–900 | recipient and amount entry |
| Row title, value | 16px / 20, 700 | `ListRow`, `DetailRow` values (15px) |
| Body | 16px / 24, Inter 400 | paragraphs, inputs (never below 16px: iOS zooms) |
| Subtitle, label | 13px / 17, Inter 400; labels 700 | row subtitles; section labels in sentence case |
| CTA label | 19px, 800 | `Button` lg |

### Spacing and sizes

A 4px grid. Page margin 16px on every page, header and sheet. 20px between sections.

| Element | Height |
| --- | --- |
| Page header | 52px |
| CTA (`Button` lg) | 52px |
| Compact button (`Button` sm) | 36px |
| Search, single-line input | 44px / 52px |
| Pill | 32px (24px status) |
| List row | 64px (40px avatar); 56px without a subtitle |
| Touch target | 44px minimum |

Icons: 16px in pills and buttons, 20px in rows, 24px in headers. Avatars 24 / 40 / 88px.

### Radii

`full` for every control (buttons, pills, search, single-line inputs, avatars, toggles); **16px** for
list groups, detail cards and multi-line inputs; **12px** for logo and app tiles; **28px** for sheet
tops. 8, 10, 20, 22 and 24px are retired.

### Elevation

Flat: separation comes from `fill` and hairlines. Shadows only on sheets, the floating nav and a
segmented control's thumb.

### Screen sizes

Designed at 360px wide (extension popup, small Android), verified at 402 × 874 (iPhone), 375 × 667
(iPhone SE) and 600 × 640 (extension full page). Content is one column capped at 600px and centered
above that (desktop, side panel). On short screens only the body scrolls: the header and the pinned
CTA never do. The CTA clears the home indicator on iOS.

## Components

| Element | Canonical (`components/ui`) | Anatomy | Replaces |
| --- | --- | --- | --- |
| Primary action | `Button` | 52px pill. `primary`: `accent`, white 19px label. `secondary`: `fill`, `ink` label. `destructive`: `fill`, `negative-ink` label. `sm`: 36px, 15px label. Loading swaps the label for the spinner, width held. One `primary` per screen; two side by side are 10px apart. | `components/Button` (moves), `lib/ui/button`, `FormSubmitButton`, `FormSecondaryButton`, raw CTA buttons |
| Icon button | `IconButton` | Header: a bare 24px glyph in a 44px hit area, `ink`. Sheet and overlay: a 32px circle on `fill`, `muted` glyph. | `NavButton`, `CircleButton`, ad-hoc round buttons |
| Pushed page header | `PageHeader` | 52px row: bare chevron, 20px title left beside it, then actions (orange text such as "Edit", or an `IconButton`), close last. No divider; a hairline appears once content scrolls under it. | `NavigationHeader`, `ScreenHeader`, earn headers, the round back buttons and grey title bars |
| Tab root header | `TabHeader` | 28px title left, bare 24px icon actions right, search swaps in at 36px. No grey bar under it. | the 4px grey rule |
| Flow frame | `FlowLayout` | `PageHeader` + scrolling body + pinned CTA. | hand-built frames |
| Top action bar | `SegmentedActionBar` | Ahmad's, unchanged. | — |
| Segmented control | `SegmentedControl` on Radix ToggleGroup (*planned*) | Pill track on `fill`, `page` thumb, `indicator` motion. | `TabPicker`, `TabSwitcher` |
| Search | `SearchInput` | 44px pill on `fill`, no border, 16px glyph, left-aligned 16px text, clear button; a 1.5px `accent` ring while focused. | `SearchField`, `SearchAssetField` |
| Text field | `TextField` (*planned*) | 13px bold `muted` label above; single-line 52px pill or multi-line 16px-radius box on `fill`; trailing pills (Paste, Scan) on `page` inside the field; error: `negative` ring and a `negative-ink` message. | `Input`, `FormField`, ad-hoc inputs |
| Entry | `AmountInput`, recipient entry | Centered 48px amount with a 22px unit, 15px `muted` fiat line, token and Max pills; recipient entry 30px, 24px once it holds an address. | — |
| Toggle | `Toggle` on Radix Switch | 51 × 31, `accent` when on. | `ToggleSwitch`, `SettingToggle` |
| Checkbox | `Checkbox` on Radix Checkbox | 22px, 6px radius, `accent` when checked. | atoms `Checkbox`, `FormCheckbox` |
| List group | `ListGroup` (*planned*) | 16px radius on `fill`; hairlines between rows, inset past the leading visual. | ad-hoc stacks |
| List row | `ListRow` (*planned*) | 64px: leading 40px avatar or 30px icon circle, 16px title over a 13px `muted` subtitle, trailing value, toggle, check or chevron. A row that navigates has a chevron. | `CardItem`, `ListItem`, `MenuItem`, ~20 local rows |
| Section label | `SectionHeader` (*planned*) | 13px Inter bold `muted`, sentence case, 8px above its group, 4px inset. A page-level section title is 20px 800. Optional `icon` draws it `aria-hidden` in a 32px `bg-fill` circle before the label; `size="lg"` swaps the label to 18px Nunito extrabold `ink` (Settings' coloured group headers). | ~40 hand-styled headings, uppercase labels |
| Detail card | `DetailCard` + `DetailRow` | `fill`, 16px radius, hairlines between rows; 14px `muted` label, 15px value right; addresses stacked, in full, with an orange "Copy". | `FlowDetails` (renamed), history `DetailCard`, `ReviewRow`, local detail rows |
| Hero | `Hero` (*planned*) | Centered: 88px avatar or 64px status circle, then the hero value or name, then a 14px `muted` line. On a contact page the name is in the header and the avatar stands alone. | per-screen heroes |
| Pill | `Pill` | 32px on `fill` with `ink`; selected: `accent-tint` with `accent-tint-ink`; 16px icon slot; status pills 24px with a dot and a word. | `lib/ui/badge`, `StatusPill`, seed-word `Chip`, ad-hoc pills |
| Network chip | `NetworkChip` | A `Pill` in the network's own tint, logo unchanged. | — |
| Avatar | `Avatar` | Round: image, initials or icon; 24 / 40 / 88px; a network badge on the corner for `0x` contacts. Contact colors come from the address hash. | ad-hoc icon circles; Activity's square icons become round |
| Empty state | `EmptyState` | On `fill`, 16px radius: 56px icon circle on `page`, 17px title, 14px `muted` body, a 36px `secondary` button. | ad-hoc "No …" lines |
| Sheet | `Drawer` (vaul) | 28px top corners, 36 × 5 handle, 20px title left, 32px ✕ right, 16px margin; one decision per sheet; CTA pinned. | react-modal, custom overlays |
| Confirm / alert | `useConfirm` / `useAlert` as sheets with Radix AlertDialog semantics | Title, one sentence, a `destructive` or `primary` button over a `secondary` Cancel. | `ConfirmationModal`, `AlertModal` |
| Spinner | `Spinner` | 0.9s ring, `accent` on `fill`. | atoms `Spinner`, `ActivitySpinner` |
| Skeleton | `Skeleton` | `fill` blocks shaped like the content. | ad-hoc `animate-pulse` |
| Menu, tooltip | `DropdownMenu`, `Tooltip` on Radix (*planned*) | — | overflow menus, tippy.js |
| Copy | `CopyButton` | Orange text action in a detail row; a `Pill` with copy for hashes. | atoms `CopyButton`, `AddressChip`, `HashChip`, raw clipboard calls |

## Motion

Presets live in `lib/animation/presets.ts` (*planned*) and resolve through `useMotion`, so reduced
motion is handled once. The app root sets `<MotionConfig reducedMotion="user">`.

| Preset | Motion | Replaces |
| --- | --- | --- |
| `fade` | opacity, `durations.fast`, `easeOutCubic` | fades at 0.12, 0.18, 0.2 and 0.3s |
| `reveal` | height 0↔auto + opacity, `springs.standard` | three reveals with three curves |
| `pop` | in from opacity 0 / scale 0.92, out to scale 0.96, `springs.snappy` | six pops |
| `sheet` | y 24 + scale 0.96 + opacity, `springs.sheetPresent`, `fade` backdrop | dApp confirm, switcher, peek card, seed warning |
| `page` | incoming page from the right, the page beneath to −24% and dimmed | four page-transition models |
| `press` | `whileTap` scale 0.96, `springs.snappy` | `Button` (inline 800/35), `Toggle` (700/30), CSS `active:scale-*` |
| `indicator` | shared `layoutId`, `springs.pill` | token detail tabs, `TabPicker` |
| `shimmer` | 1.2s linear loop, still under reduced motion | two pending-activity runners |

## Ahmad's screens (anchor, small fixes)

Home, Explore and the top action bar define the look and change only for consistency: card radii
10px → 16px (prompt card) and 22px → full (action segments); Activity's 40px square icons → round;
`opacity-50` text → `muted`; the hex literals #A8BBA3, #FFFFFF4D, #E5E5EA, #8E8E93, #ECEAE7 and
`bg-red-500` → tokens; the TabHeader grey bar removed; Home and Explore bottom clearance unified.

## Migration order

One concern per stacked PR, each validated on the simulator before the next. A PR migrates every
caller of what it replaces and deletes the retired component.

1. **Foundations**: the tokens above in `main.css` and `tailwind.config.ts`, old tokens aliased to
   them so nothing changes shape yet.
2. **Dead code**: about 20 components with no callers.
3. **Motion foundation**: `presets.ts`, `MotionConfig`, the unguarded `Button` and `Toggle`
   springs.
4. **Headers**: `PageHeader` in direction B, then `NavigationHeader`, `ScreenHeader` and the earn
   headers onto it; `TabHeader` without its bar; `DrawerTitle` at 20px.
5. **Buttons**: `Button` and `IconButton` in `components/ui`.
6. **Lists**: `ListGroup`, `ListRow`, `SectionHeader`, `EmptyState`; the contact picker (search and
   sections) is built on them.
7. **Detail cards and heroes**.
8. **Inputs**: `TextField`.
9. **Pills, avatars, spinner, skeleton, copy**.
10. **Sheets and overlays**: confirmations as sheets, react-modal and tippy.js removed.
11. **Page transitions**: one `page` model for `FullScreenPage`, `MobilePageLayers`, `Navigator`
    and onboarding.
12. **Anchor fixes** for Ahmad's screens, reviewed with him.

## Keeping it consistent

- `no-restricted-imports` bans `app/atoms/*`, `lib/ui/button`, `lib/ui/badge` and each retired
  component as its PR lands.
- A reviewer rejects a new local header, row, pill, section label, color literal or inline
  transition that this document covers.
