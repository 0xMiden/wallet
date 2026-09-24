# Design System

One canonical component per UI element, one set of motion presets, used on every screen. When a
screen needs something this document does not have, extend the canonical component (a variant or a
prop); do not build a local copy. Local copies are how the wallet reached five page headers, four
page-transition models and about 30 section-title styles.

Direction: **crisp and left-aligned** (chosen 2026-09-19 over a centered and a tray-based
direction). Visual reference: the screens page (Bread Screens artifact, direction B) and the Bread
design system page. Rows marked *planned* do not exist yet; until one lands, do not add a new
instance of anything it replaces. Every other row has landed, and its "Replaces" column names what
was deleted (or, where marked, what still has callers to migrate).

## Rules

1. Canonical components live in `src/components/ui`, one per element, styled with Tailwind and the
   tokens below, with variants and sizes declared through `class-variance-authority` (`cva`). A
   variant is a closed, typed set; `className` is for layout (margins, width), not for restyling.
2. Components follow **shadcn/ui**: copied into the repo and owned by us, not installed as a
   dependency. Anything with interactive behavior (focus, keyboard, dismissal, roles) is built on
   **Radix Primitives**; sheets stay on vaul. Pull a component with the shadcn CLI
   (`components.json` points it at `src/components/ui` and `lib/ui/util`'s `cn`), then restyle it to
   these tokens: never keep shadcn's default theme variables or colors.
3. `src/app/atoms` and every component still listed under "Replaces" are frozen: fix bugs in them,
   migrate their callers, then delete them. `.eslintrc` enforces it: `no-restricted-imports` bans
   each deleted module's path (with a message naming its replacement), and
   `@typescript-eslint/no-restricted-imports` bans `app/atoms` for every file outside the allow-list
   of existing importers in its `overrides`. A file that stops importing atoms leaves that list.
4. Motion goes through `lib/animation`: a named preset, or a named spring for anything the presets
   do not cover. No literal duration, easing, stiffness or cubic-bezier in a component.
5. Every animation respects reduced motion. Presets do this for you; a CSS animation needs a
   `motion-reduce:` variant.
6. Text meets 4.5:1 on the surface it sits on (3:1 for 19px bold and larger, icons and control
   edges) in both themes. A new color pair is checked before it ships.
7. The five card colours are brand colours; never shift them for contrast, and never tint them with
   a scrim. Solve readability with type size and weight or a darker well (see Card colours). Brand
   fidelity wins over rule 6 for the card surface itself; the balance card's 13px label and footer
   are the one accepted exception to rule 6 (see Card colours).

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
| `accent` | #E77537 | #E77537 | Primary CTA fill, selected state, focus ring. White on it is 3.0:1: labels on it are 19px bold or larger. Never text: #E77537 is 2.64:1 on `fill` and 3.0:1 on white. |
| `accent-tint` | #FDEEE5 | #3A2418 | Selected pill fill. |
| `accent-tint-ink` | #A84A18 | #F2A57A | Text on `accent-tint` (5.1:1), and every text action: Copy, Edit, See all, a header's text action. |
| `positive` / `positive-ink` | #90BA89 / #3D7A34 | #90BA89 / #90BA89 | Fill / text for success. |
| `pending` / `pending-ink` | #E85D2F / #B8451A | #E85D2F / #F08B57 | Fill / text for in progress. |
| `negative` / `negative-ink` | #FF5500 / #C63A00 | #C51A0A / #FF7A4D | Fill / text for errors and destructive actions. |
| `positive-tint` / `pending-tint` / `negative-tint` | #E8EEE5 / #F4ECDC / #F6E5E1 | #28302A / #3A3222 / #3D2724 | `StatusBadge` fills, from the activity icon family: sage (received #99AC94), sand and clay. Opaque, so a badge reads the same on `page` and `fill`. |
| `positive-tint-ink` / `pending-tint-ink` / `negative-tint-ink` | #4F6549 / #7A5B26 / #9B4638 | #B2C4AC / #D8BC86 / #E7A193 | Text on those tints (5.41 / 5.33 / 5.17:1 light, 7.36 / 6.91 / 6.55:1 dark) and signed amounts in Activity rows and detail cards (at least 5.5:1 on `fill` and `page`). `*-ink` above stays for errors and destructive text. |
| Flow accents | `accent-send`, `accent-receive`, `accent-earn`, `accent-swap` (+ `-tint`, `-ink`) | same | Aliases of the action colours below, so each flow's accent is its tab's colour. Text takes the `-ink`. |
| Networks | `network-miden-*`, `network-ethereum-*` | as today | NetworkChip only. |

A status is a word or an icon plus its color, never color alone. A status word is never bare
colored text: it is a `StatusBadge`. The raw fills (#90BA89, #E85D2F, #FF5500, #C51A0A) are
2.2–3.5:1 on white and never carry text.

### Card colours

The account card colours are brand colours. Their values are fixed; readability on them comes
from the text, never from the colour.

| Token | Light | Dark | White text on it (light) |
| --- | --- | --- | --- |
| `card-slate` | #777386 | #777386 | 4.58:1 |
| `card-orange` | #E77537 | #E77537 | 3.00:1 |
| `card-blue` | #607C92 | #91ACC1 | 4.38:1 |
| `card-green` | #778C72 | #A8BBA3 | 3.63:1 |
| `card-purple` | #847595 | #BEACD2 | 4.23:1 |

Dark mode paints the card at 50% over `page`, where white is 5.6:1 or better on every colour.
In light mode the bare colours reach only 3.0:1. The balance card stays the plain colour, with its
footer set off by a `surface-balance-rule` hairline, and each text sits as follows:

| Text | Size | Needs | Sits on | Weakest (orange, light) |
| --- | --- | --- | --- | --- |
| Amount | 40-56px extrabold | 3:1 | the bare colour | 3.00:1 |
| Currency | 22px bold | 3:1 | the bare colour | 3.00:1 |
| Label ("Total balance") | 13px bold | 4.5:1 | the bare colour | 3.00:1 (below 4.5:1, accepted) |
| Account name and address | 13px bold | 4.5:1 | the bare colour, under the hairline | 3.00:1 (below 4.5:1, accepted) |
| Change pill | 14px | 4.5:1 | `surface-balance-pill` (black 24%) | 4.87:1 |

The label and footer keep the plain brand colour by choice: in light mode they pass 4.5:1 on slate
only (4.58:1) and fall under it on blue, purple, green and orange; in dark mode they pass on every
colour. Large text on a card colour may never drop below 18.66px bold or 24px regular, since the
orange has no margin above 3:1. `design-tokens.test.ts` pins the brand values, the amount and
currency at 3:1 and the change pill at 4.5:1.

### Action colours

Home's five actions each take one colour of the account card palette (`card-*`, the AccountsDrawer
"Card color" picker), and that one brand colour is both the tab's icon in the top action bar and the
accent of the tab's flow: back arrows, chevrons, the address caret, route card borders, the
processing spinner and the summary arrow. The activity icon squares follow it too (`tx-sent`,
`tx-received`, `tx-swap`, `tx-earn`); the faucet has no tab and keeps its rose #CCA4B8.

The action colours are the card colours, so they are brand colours too (rule 7): never darkened for
contrast. Glyphs, icons and borders take the brand colour, which needs 3:1. Text in an action's
colour (Max, the Receive link, a route label) takes its `-ink`, a separate darker shade (lighter in
dark mode) that reads at 4.5:1, the same pattern as `accent-tint-ink` for the brand orange.

| Tab | Token | Card colour | Light | Dark | Ink light / dark | Tint light / dark |
| --- | --- | --- | --- | --- | --- | --- |
| Overview | `action-overview` | `card-orange` | #E77537 | #E77537 | #A95528 / #E77537 | #FCEEE7 / #32241D |
| Send | `action-send` | `card-blue` | #607C92 | #91ACC1 | #566F83 / #91ACC1 | #ECEFF2 / #272B2D |
| Receive | `action-receive` | `card-green` | #778C72 | #A8BBA3 | #60715C / #A8BBA3 | #EFF1EE / #2A2C2A |
| Earn | `action-earn` | `card-slate` | #777386 | #777386 | #6D697B / #8D8A9A | #EFEEF0 / #242426 |
| Swap | `action-swap` | `card-purple` | #847595 | #BEACD2 | #746682 / #BEACD2 | #F0EEF2 / #2D2B2F |

Contrast of the brand colour as a glyph, light (dark is 3.37:1 or better everywhere):

| Action | On `page` | On `fill` | On its tint | Ink, lowest of the three |
| --- | --- | --- | --- | --- |
| Overview | 3.00 | 2.64 | 2.65 | 4.60 |
| Send | 4.38 | 3.85 | 3.79 | 4.55 |
| Receive | 3.63 | 3.20 | 3.20 | 4.61 |
| Earn | 4.58 | 4.04 | 3.96 | 4.59 |
| Swap | 4.23 | 3.73 | 3.67 | 4.59 |

- `accent-{send,receive,earn,swap}` and their tints and inks alias `action-*`; a flow never declares
  its own hex. Change a card colour and its tab, its flow and its activity rows change with it.
- A flow's glyphs sit on `page`, `fill` or its tint, all 3:1 or better. Overview's orange is 3:1 on
  `page` and the action bar's raised bubble only, so it draws the Overview tab icon and nothing on
  `fill`.
- Text never takes the bare action colour: `text-accent-{flow}-ink` (or `ACCENT_CLASSES[flow].ink`),
  never `text-accent-{flow}`. A chevron that belongs to a text action takes the ink with its label.
- The tint is the colour at 12% over the page, solid. The primary CTA stays `accent` (#E77537) in
  every flow.
- `design-tokens.test.ts` asserts the brand values, the mapping, the aliases, the tints and the
  contrast of both the colour and its ink.

### Type

Every piece of text takes one **type style**: a utility that sets family, size, line-height and
weight together (`@utility` in `src/main.css`, listed in `lib/ui/type-styles.ts`). Colour is a
separate class (`text-ink`, `text-muted`, `text-accent-tint-ink`...). Never assemble a role by hand
(`font-heading text-[15px] leading-6 font-bold`): name it. `src/components/ui/type-scale-guard.test.ts`
fails a shared component that does.

**Which face, and why.** Nunito (`--font-heading`) is the voice of the wallet: anything the eye
lands on first or reads as a figure, so titles, amounts and values, and every button label. Its
rounded, heavy shapes are what make a number or a title feel like Miden, and they hold up at 800
to 900. Inter (`--font-sans`) is for reading: paragraphs, labels, captions and anything typed.
It stays legible at 13px where Nunito closes up, keeps addresses and long sentences even, and is
what inputs render (16px, or iOS zooms on focus). The rule of thumb: if it is a thing the user
reads as a sentence or a label, Inter; if it is a name, a number or a thing they tap, Nunito.

| Type style | Face | Size / line | Weight | Where |
| --- | --- | --- | --- | --- |
| `text-display` | Nunito | 48 / 52 | 800 | The balance on the balance card (scaled down inline to fit, `leading-none`) |
| `text-entry-unit` | Nunito | 22 / 28 | 700 | The unit beside an entry or the balance ("USD") |
| `text-title-tab` | Nunito | 28 / 36, −0.5px | 800 | `TabHeader` and tab roots; an onboarding step's title |
| `text-hero-value` | Nunito | 32 / 36 | 900 | `Hero` value: amounts on review and receipt |
| `text-hero-name` | Nunito | 24 / 28 | 900 | `Hero` name, outcome and passcode titles |
| `text-title-page` | Nunito | 20 / 26 | 800 | `PageHeader`, `DrawerTitle`, `AlertSheet`, `SectionHeader` `xl` |
| `text-title-section` | Nunito | 18 / 24 | 800 | `SectionHeader` `lg`, `EmptyState` title, Explore app names |
| `text-cta` | Nunito | 19 / 24 | 800 | `Button` `lg` |
| `text-cta-sm` | Nunito | 15 / 20 | 800 | `Button` `sm` |
| `text-row-title` | Nunito | 16 / 20 | 700 | `ListRow`, Activity and asset row titles, a row's price |
| `text-value` | Nunito | 15 / 20 | 700 | `DetailRow` values, Activity row amounts |
| `text-action` | Nunito | 14 / 20 | 700 | Text actions: Copy, Edit, See all, "Learn more" (`accent-tint-ink`) |
| `text-pill` | Nunito | 14 / 1 | 700 | `Pill` `md`, `SegmentedControl`, the top action bar |
| `text-badge` | Nunito | 12 / 1 | 700 | `Pill` `sm` and `xs` (`xs` adds `font-semibold`), `StatusBadge` |
| `text-body` | Inter | 16 / 24 | 400 | Paragraphs (a `SubPageSection` description, an alert's sentence), inputs |
| `text-body-strong` | Inter | 16 / 24 | 600 | Emphasis inside body copy (`<b>` in a translation) — never the heading face |
| `text-explainer` | Inter | 15 / 22 | 400 | The muted line under a heading: an onboarding step's description, a pushed page's explainer line (Choose Guardian, Rotate Guardian) |
| `text-body-sm` | Inter | 14 / 20 | 400 | Secondary copy: `DetailRow` labels, the `Hero` line, `EmptyState` body, a footnote under a control, a list row's trailing setting |
| `text-label` | Inter | 13 / 17 | 700 | Section labels (`SectionHeader`), field labels, `Notice` titles, balance card labels |
| `text-caption` | Inter | 13 / 17 | 400 | Row subtitles, `Notice` body, field hints and errors, a `DetailRow` sub-line |

Weight and line-height are read through Tailwind's `--tw-font-weight` and `--tw-leading`, so a
modifier (`font-semibold`, `leading-none`) applies whatever order the stylesheet emits it in; use
one only where the table says so. A different size is not a modifier: it is a new role, added here,
in `main.css` and in `lib/ui/type-styles.ts` together. `cn()` knows the names (tailwind-merge
otherwise reads `text-value` as a colour and drops it beside `text-ink`).

### Spacing and sizes

A 4px grid. Page margin 16px on every page, header and sheet. 20px between sections. Two buttons
side by side sit 10px apart (`gap-2.5`), each `flex-1`.

| Element | Height |
| --- | --- |
| Page header | 52px |
| CTA (`Button` lg) | 52px |
| Compact button (`Button` sm) | 36px |
| Search, single-line input | 44px / 52px |
| Pill | 32px (24px status in a header, 20px status in a row) |
| List row | 64px (40px avatar); 56px without a subtitle |
| Touch target | 44px minimum |

Icons: 16px in pills and buttons, 20px in rows, 24px in headers. Avatars 24 / 40 / 88px.

### Radii

`full` for every control (buttons, pills, search, single-line inputs, avatars, toggles); **16px** for
list groups, detail cards and multi-line inputs; **12px** for logo and app tiles; **28px** for sheet
tops. 8, 10, 20, 22 and 24px are retired.

### Elevation

Flat: separation comes from `fill` and hairlines. Shadows only on sheets, the floating nav, a
segmented control's thumb and a raised bubble.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `raised` (surface) + `shadow-raised` | white, 1px ring at 6%, 0 1 2 / 6% + 0 2 8 / 8% drop | `fill`, lit 1px top edge, 1px ring at 6%, a tight dark drop | The active bubble of an interactive toggle: the top action bar's pill, the bottom nav's highlight and a segmented control's selection. One class string, `raisedBubbleClassName` (`components/ui/animate/raised-bubble`), draws all three. |
| `shadow-raised-pressed` | ring + 0 1 1 / 5% | ring + a dimmer top edge | The same bubble while pressed (with the press scale): it sinks. |
| `shadow-ribbon` | 0 1 2 / 18% + 0 2 6 / 12% | same | The test-network corner ribbon, so it reads as wrapping over the bar. |

Raised is only for interactive toggles and bubbles. Cards, list groups and detail cards stay flat.

Cards and row cards are `fill` with no border, except the `outline` surface: a hairline edge on
`page` (Activity's rows). Otherwise hairlines only divide rows inside a group.

### Screen sizes

Designed at 360px wide (extension popup, small Android), verified at 402 × 874 (iPhone), 375 × 667
(iPhone SE) and 600 × 640 (extension full page). Content is one column capped at 600px and centered
above that (desktop, side panel). On short screens only the body scrolls: the header and the pinned
CTA never do. The CTA clears the home indicator on iOS.

## Components

| Element | Canonical (`components/ui`) | Anatomy | Replaces |
| --- | --- | --- | --- |
| Primary action | `Button` (`components/ui/Button`; `components/Button` re-exports it) | 52px pill. `primary`: `accent`, white `text-cta` label. `secondary`: `fill`, `ink` label. `destructive`: `fill`, `negative-ink` label. `sm`: 36px, `text-cta-sm` label. Loading swaps the label for the spinner, width held. One `primary` per screen; two side by side are 10px apart. | `lib/ui/button`, `FormSubmitButton`, `FormSecondaryButton`, raw CTA buttons |
| Icon button | `IconButton` | Header: a bare 24px glyph in a 44px hit area, `ink`. Sheet and overlay: a 32px circle on `fill`, `muted` glyph. | `NavButton`, `CircleButton`, ad-hoc round buttons |
| Pushed page header | `PageHeader` (`components/PageHeader`) | 52px row: bare chevron, 20px title left beside it, then actions (an `accent-tint-ink` text action such as "Edit", a `Pill`, or an `IconButton`), close last. No divider; a hairline appears once content scrolls under it. No horizontal padding of its own: it takes the page's, so a caller in an unpadded parent passes `className="px-4"`. | `NavigationHeader`, `ScreenHeader`, the earn headers (vault, position, positions, withdraw, deposit), the round back buttons and grey title bars |
| Tab root header | `TabHeader` | `text-title-tab` title left, bare 24px icon actions right, search swaps in at 36px. Ends in a 4px rounded rule on `fill`, inset to the page margin. | hand-built tab titles |
| Flow frame | `FlowLayout` | `PageHeader` + scrolling body + pinned CTA. | hand-built frames |
| Top action bar | `SegmentedActionBar` | Ahmad's, unchanged. Shares the segmented control's bubble, motion hooks and `Highlight`, not its markup: only the selected segment shows its label, and every segment resizes on the same spring as the bubble. | — |
| Segmented control | `SegmentedControl` | One choice out of a few, drawn like the tab bars (see below). `items` (`id`, label, `disabled`, test id), controlled `value`/`onChange`; `size` `sm` 32px or `md` 40px; `layout` `scroll` (natural-width items in a row that scrolls sideways and keeps the selection in view: filters) or `fill` (equal-width segments across the width: timeframes, settings choices); `appearance` `bubble` (default) or `pills`: an `accent-tint` selection with an `accent-tint-ink` label, the others outlined by a hairline on `page` (Activity's filters, Explore's categories). Always a radio group: arrow keys move focus and the selection together, and a settings choice takes `fill`. | the Activity filter pills, the token detail timeframe row, `TabPicker` (theme, developer endpoint preset and network id) |
| Search | `SearchInput` | 44px pill on `fill`, no border, 16px glyph, left-aligned 16px text, clear button; a 1.5px `accent` ring while focused. | `SearchField`, `SearchAssetField` |
| Text field | `TextField` | `text-label` `muted` label above; `text-body` text; single-line 52px pill or multi-line 16px-radius box on `fill`; trailing pills (Paste, Scan) on `page` inside the field; error: `negative` ring and a `negative-ink` message. | `TextArea`; still to migrate: `Input`, atoms `FormField`, ad-hoc inputs |
| Entry | `AmountInput`, recipient entry | Centered 48px amount with a 22px unit, 15px `muted` fiat line, token and Max pills; recipient entry 30px, 24px once it holds an address. | — |
| Toggle | `Toggle` on Radix Switch (*planned*) | 51 × 31, `accent` when on. Until then `components/Toggle` (on the `press` preset) is the one to use. | `ToggleSwitch`, `SettingToggle` |
| Checkbox | `CheckboxRow`, `CheckboxIndicator` (`components/ui/Checkbox`) | `CheckboxIndicator`: the one selection mark, 22px round, a `page` disc with a hairline edge (the same mark `ChoiceCardGroup` draws); checked, an `accent` fill springs in (`snappy`) and the check draws in (`pathLength`, tab-bar spring), reversed on uncheck, instant under reduced motion. `CheckboxRow`: a `ListGroup` row that is itself the `role="checkbox"` button (box leading, `text-row-title` title, `text-caption` `muted` description, inset hairline); tap, Space or Enter toggles it with `hapticSelection` and the press dip. A native `button` today; Radix Checkbox can replace the internals later. | `components/Checkbox` (deleted); still to migrate: atoms `Checkbox`, `FormCheckbox` |
| List group | `ListGroup` | 16px radius on `fill`; hairlines between rows, inset past the leading visual. `surface="plain"`: no surface, the rows flush on the page margin with full-width hairlines (Settings' groups, under their coloured headers). | ad-hoc stacks |
| List row | `ListRow` | 64px: leading 40px avatar or 30px icon circle, `text-row-title` over a `text-caption` `muted` subtitle, trailing value, toggle, check or chevron. A row that navigates has a chevron. | `CardItem`, `ListItem`, `MenuItem`, local rows |
| Section label | `SectionHeader` | `text-label` `muted`, sentence case, 8px above its group, 4px inset. `size="xl"`: a tab root's section title, `text-title-page` `ink`. Optional `icon` draws it `aria-hidden` in a 32px `bg-fill` circle before the label; `size="lg"` swaps the label to `text-title-section` `ink` (Settings' coloured group headers). A caller removes the 4px inset with `className="px-0"` to sit flush with a `plain` group (Settings). | ~40 hand-styled headings, uppercase labels |
| Detail card | `DetailCard` + `DetailRow` | `fill`, 16px radius, hairlines between rows; `text-body-sm` `muted` label, `text-value` `ink` value right; addresses stacked, in full, with an `accent-tint-ink` "Copy". | `FlowDetails`, history `DetailCard`, `lib/ui/DetailCard`, `ReviewRow`, local detail rows |
| Card | `Card`, `CardButton` | `fill`, 16px radius, no border, on `page`; cards in a list are separated by space (12px). `Card`'s `surface="outline"` draws a hairline edge on `page` instead of the fill (Activity rows and pending transfers). `padding`: `row` (16 × 12px, 64px with a 40px icon: an Activity row), `tile` (16px: an Explore app, a position, an option), `none` (content that pads itself). `CardButton` is one tap target: `button`, tap haptic, `press` motion, `fill-pressed` when pressed, `accent` focus ring. `asChild` draws the surface onto a child that is its own element (a layout-animated row, an `article`). Anything drawn inside a card sits on `page` (an icon tile, a neutral icon circle), since grey on `fill` disappears. | outlined `rounded-2xl border bg-white` cards: Explore app cards, earn position cards, the send fee notice, dApp approval and settings cards, import-type choices |
| Choice cards | `ChoiceCardGroup` | One choice out of a set of cards (a guardian operator, a recovery method, an import type): each a `Card`-look `fill` surface, 16px radius, no border, min 72px, all rows as tall as the tallest; leading 48px logo tile or icon, `text-row-title` title, `text-caption` `muted` subtitle or meta line, a badge top right (`Pill` "Current", `StatusBadge`), a trailing `CheckboxIndicator` as its radio mark. Chosen: a 2px inset `accent` ring and the mark filled `accent` with the drawn check (not raised: cards stay flat). Behaves like `SegmentedControl`: `radiogroup`/`radio`, roving tab stop, arrows and Home/End move focus and choice together, `hapticSelection` once per real change, tab-bar press dip and check pop, still under reduced motion. | the guardian picker's bordered tiles and grey header strip, outlined option buttons |
| Text action | `TextAction` | `text-action` `accent-tint-ink`, no underline, 44px hit area, tap haptic: "Learn more", "Use a custom URL". | underlined `primary-500` links, hand-styled text buttons |
| Hero | `Hero` | Centered: 88px avatar or 64px status circle, then the `text-hero-value` or `text-hero-name`, then a `text-body-sm` `muted` line. On a contact page the name is in the header and the avatar stands alone. | `ReviewAmount`, per-screen heroes |
| Pill | `Pill` | 32px on `fill` with `ink`; selected: `accent-tint` with `accent-tint-ink` (a multi-select chip or a tag; a single choice in a row is a `SegmentedControl`); 16px icon slot. Status tones (`positive`, `warning`, `negative` on their opaque tints; `inactive` on `fill-pressed` with `ink`) are for `StatusBadge`, which picks them. | `lib/ui/badge`, seed-word `Chip`, `AccountTypeBadge`, `PriceChangeBadge`, ad-hoc pills |
| Status badge | `StatusBadge` (on `Pill`) | The status word alone, no dot, on the status's tint: positive (confirmed, claimed, received, filled, online) sage, pending (pending, in progress, redeeming, delivering, open, checking) sand, negative (failed, offline, needs attention) clay, each `*-tint` with its `*-tint-ink`; neutral (cancelled, reclaimed, unavailable, not connected) `fill-pressed` with `ink`. `sm`: 20px, 12px semibold, in rows (Activity, pending transfers, the swap fill list). `md`: 24px, 12px bold, in detail headers. A closed `status` set maps each state to its i18n label and tone; a new state is added there. `live` adds `role="status"` where the status changes on screen (detail headers, the swap order line, the guardian pill); never in a list. | the Activity row's dot and 10px colored text, history's `StatusPill` (now a wrapper that maps a transaction row to a status), the bridge and earn detail pills, the legacy summary rows' dots, the swap order's colored line and pending text, the guardian's red/green pill |
| Network chip | `NetworkChip` | A `Pill` in the network's own tint, logo unchanged. | — |
| Avatar | `Avatar` | Round: image, initials or icon; 24 / 40 / 88px; a network badge on the corner for `0x` contacts. Contact colors come from the address hash. | ad-hoc icon circles; Activity's square icons become round |
| Empty state | `EmptyState` | On `fill`, 16px radius: 56px icon circle on `page`, `text-title-section` title, `text-body-sm` `muted` body, a 36px `secondary` button. | `components/EmptyState` (moved), ad-hoc "No …" lines |
| Sheet | `Drawer` (vaul) | 28px top corners, 36 × 5 handle, 20px title left, 32px ✕ right, 16px margin; one decision per sheet; CTA pinned. | `CustomModal`, `ModalWithTitle`, custom overlays; the react-modal dependency goes last |
| Confirm / alert | `useConfirm` / `useAlert` (`lib/ui/dialog`), rendered by `AlertSheet` with Radix AlertDialog semantics | Title, one sentence, a `destructive` or `primary` button over a `secondary` Cancel. | `ConfirmationModal`, `AlertModal` |
| Spinner | `Spinner` | 0.9s ring, `accent` on `fill`. | atoms `Spinner`, `ActivitySpinner`, `CircularProgress` |
| Skeleton | `Skeleton` | `fill` blocks shaped like the content (`inverse` on a colored surface); tests find it by `data-slot="skeleton"`. | `lib/ui/skeleton`, ad-hoc `animate-pulse` |
| Menu, tooltip | `DropdownMenu`, `Tooltip` on Radix (*planned*) | Until then `components/Tooltip` stays on tippy.js. | overflow menus, tippy.js |
| Passcode keypad | `Numpad` (`components/Numpad`), `PasscodeDots`, `PasscodeScreen` | `Numpad`: twelve slots, 1–9, biometric key or empty, 0, bare backspace; round 76px keys on `fill` (`fill-pressed` held), 32px 800 digits, 28 / 16px gaps, 64px keys with 24 / 12px gaps under 720px of viewport height; `press` motion and the tap haptic on every key. `PasscodeDots`: 14px dots, `hairline` empty and `ink` filled with a pop, the `shake` preset and the error haptic on a rejected code. `PasscodeScreen`: title, message (`negative-ink` for errors) and dots, then the keypad, as one group a little below centre (the leftover height splits 3:2 above and below), and an optional text action centred 16px under the last key row, clear of a thumb aimed at 0. Unlock and onboarding draw `PasscodeScreen`; sheets draw `PasscodeEntry` over the same keypad and dots. | the square 92px keys, the unlock and onboarding copies of the dots |
| Copy | `CopyButton`, `CopyChip`; `AnimatedCopyIcon`, `CopyLabel` | `CopyButton`: an `accent-tint-ink` text action in a detail row, or with `icon` (`leading`, `trailing`, `only`) the copy glyph beside a value (balance card, Receive address). `CopyChip`: a `Pill` with copy for hashes and addresses (`AddressChip` and `HashChip` are thin wrappers over it). Every copy confirms in place, the same way (`lib/animation/copy`): the glyph morphs to a check (`AnimatePresence mode="popLayout"`, scale 0.6 → 1, a 25° turn and blur 4px → 0 on `springs.tabSwitch`, opacity and blur on a short tween so they never overshoot); a text label rolls up to "Copied" in a vertically clipped slot on the same spring. Both hold for `COPY_FEEDBACK_MS` (1.5 s) and run back. One light haptic per tap (`CopyButton`'s, or `Pill`'s), none on a failed write, which shows nothing. Reduced motion: an instant swap, no blur, turn or travel. An `aria-live` region carries "Copied"; the leaving side is `aria-hidden`. Colour is the caller's: glyph and label paint in `currentColor`. No toast: the control that was tapped confirms. A copy owned elsewhere (the seed phrase's hidden-field copy) uses `AnimatedCopyIcon` and `CopyLabel` with its own `copied`. | atoms `CopyButton`, raw clipboard calls, per-site `Checkmark`/`CopyNew` swaps, `FileCopy`/`CheckboxCircleFill` copy glyphs |

## Motion

Presets live in `lib/animation/presets.ts` and are read through `usePreset(name)` (or
`resolvePreset(name, reduce)` where a hook cannot be called), so reduced motion is handled once:
every transition becomes `reducedMotionTransition` (an instant tween, still firing completion
callbacks). The app root sets `<MotionConfig reducedMotion="user">`.

| Preset | Motion | Replaces |
| --- | --- | --- |
| `fade` | opacity, `durations.fast`, `easeOutCubic` | fades at 0.12, 0.18, 0.2 and 0.3s |
| `reveal` | height 0↔auto + opacity, `springs.standard` | three reveals with three curves |
| `pop` | in from opacity 0 / scale 0.92, out to scale 0.96, `springs.snappy` | six pops |
| `sheet` | y 24 + scale 0.96 + opacity, `springs.sheetPresent`, `fade` backdrop | dApp confirm, switcher, peek card, seed warning |
| `page` | incoming page from the right over `durations.page` (0.34s) on `easings.standard`; the page beneath to `pageSlideParallax` (−24%) under a `pageSlideDim` dim (`FullScreenPage`, `MobilePageLayers`) | four page-transition models |
| `press` | `whileTap` scale 0.96, `springs.snappy` | `Button` (inline 800/35), `Toggle` (700/30), CSS `active:scale-*` |
| `shimmer` | 1.2s linear loop, still under reduced motion | two pending-activity runners |
| `shake` | x keyframes out and back to rest over `durations.slow`, `easeInOut`; does not run under reduced motion | — (a rejected passcode's dots) |

### Tab bars and segmented controls

The bottom nav, the top action bar and every `SegmentedControl` move alike, through
`lib/animation/tab-bar.ts` (`useTabBarMotion`, `useTabIconPop`):

- **Anatomy.** No strip behind the items: they sit on the page. The selected item carries the
  raised bubble (`bg-raised` + `shadow-raised`, full radius), one bubble per control, drawn by the
  shared `Highlight` (`components/ui/animate/highlight`) under the item's content; a `pills`
  control draws an `accent-tint` pill there instead. A selected item is `ink` (the bottom nav's
  icon is `accent-primary`, a pill's label `accent-tint-ink`), the others `muted`; a 2px focus ring
  in `accent-primary` at 30%. A segmented control
  keeps 4px above and below its items so a scrolling row clips neither the bubble's shadow nor the
  ring.
- **Switch.** The bubble slides to the new item on `springs.tabSwitch`, one visible overshoot; its
  `layoutId` is scoped to the control, so two mounted controls never trade bubbles.
- **Pop.** The newly selected item's icon (a segmented control's whole content) rises to
  `iconPopScale` (1.12) on `springs.tabIconPop` and settles on `tabSwitch`. Nothing pops on mount.
- **Press.** A held item dips to `pressScale` (0.92) on `springs.snappy`, and the bubble sinks to
  `shadow-raised-pressed`.
- **Haptic.** `hapticSelection` once per real change; a tap on the selected item is silent and
  reports nothing. Arrow keys, Home and End move focus and the selection together.
- **Reduced motion.** The bubble moves instantly, nothing pops, a press does not scale.

A step inside one page (the `Navigator` flows: send, swap, bridge deposit, encrypted file) is not a
page push: its `AnimatePresence` runs in `mode="wait"`, so the leaving
step is gone before the next mounts and there is no page beneath to park. It swaps on
`pageStepTransition` (`durations.pageStep`, 0.15s, on the page's curve): a `Navigator` push comes
in from `pageStepOffset` (8%) on the right and from the left going back, a presented step rises
from `pageStepPresentOffset` (25vw). `resolvePageStepTransition(reduce, animate)` makes it instant under reduced motion and
a zero-length swap off mobile. A page that fades in (`FullScreenPage` with `entrance="fade"`, a
slide page that cannot slide, and `TabLayout` on mount) uses `fade`.

Onboarding's steps move like pushed pages (`OnboardingStepLayer`): both steps are on screen while
they cross, in one grid cell. Forward, the new step comes in from the `page` preset's right edge
while the old one parks at `pageSlideParallax` under `pageSlideDim`; back is the mirror. The leaving
step is `aria-hidden` and takes no pointer. Only mobile animates; reduced motion is instant.

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
10. **Sheets and overlays**: confirmations as sheets, react-modal removed; tippy.js stays until the
    Radix `Tooltip` lands.
11. **Page transitions**: one `page` model for `FullScreenPage`, `MobilePageLayers`, `Navigator`
    and onboarding.
12. **Anchor fixes** for Ahmad's screens, reviewed with him.

## Keeping it consistent

- `no-restricted-imports` in `.eslintrc` bans every retired module (its message names the
  replacement) and new importers of `app/atoms` (existing importers are allow-listed in its
  `overrides`); `src/lib/ui/restricted-imports.test.ts` proves both fire. Add a module to the ban
  in the PR that deletes it.
- `src/components/ui/type-scale-guard.test.ts` fails a shared component that sets a family,
  size or arbitrary line-height by hand instead of a type style.
- A reviewer rejects a new local header, row, pill, section label, color literal, type style or inline
  transition that this document covers.
