Isolated UI evidence for wallet issue #1748

The PNGs show actual HistoryView, ActivityRow, Card and StatusBadge markup with the repository's CSS and fonts. Inputs are MOCK DATA, labeled in every screenshot. These are not live wallet screenshots or end-to-end settlement proof.

Rows: 99.9% then reclaimed; never filled then reclaimed; 40% while reclaiming; 100% filled; unknown progress (percentage omitted).

export-fixture.cjs temporarily appends one fixture case to the existing HistoryView unit suite, renders real UI components using that suite's platform/navigation boundary mocks and real English translations, substitutes the shipped Convert SVG into its icon placeholder, exports markup, and restores the test file in finally. The fixture does not exercise the database resolver; resolveSwapHistoryProgress.test.ts covers that mapping separately.

Reproduce from repository root after yarn install --frozen-lockfile:
  node screenshots/partial-swap-fill-progress/export-fixture.cjs
  node_modules/.bin/vite --config screenshots/partial-swap-fill-progress/vite.config.mjs
  node screenshots/partial-swap-fill-progress/capture.cjs

The preview binds 127.0.0.1:5188. No app startup, wallet state, signing, network sync, funding or transaction is performed. Captures: 390px mobile light/dark and 900px desktop light, DPR 2. Placement time is fixture data. Production data arithmetic is tested in bigint base units against the original requested amount, whose token scale cancels in the percentage.
