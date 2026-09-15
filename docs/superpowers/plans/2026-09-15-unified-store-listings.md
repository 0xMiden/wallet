# Unified Store Listings Implementation Plan

> **For the implementer:** Use `superpowers:test-driven-development` for manifests, copy composition, validation, capture, and deterministic rendering. Use `superpowers:verification-before-completion` before commits and claims. Do not publish external store changes without an explicit publisher authorization for that platform.

**Goal:** Produce one reproducible, factual Bread Wallet listing package for iOS, Android, and Chrome, with platform-specific copy and current product screenshots, then close #497 only after the public listings match it.

**Architecture:** Machine-readable copy and scene manifests are the source of truth. Deterministic Node scripts compose platform copy, validate current first-party store rules, and render branded images from raw wallet captures. Raw product pixels remain separate from generated marketing frames. Repository tests prove dimensions, opacity, content limits, claim policy, scene order, alt text, and byte-for-byte rebuild determinism.

**Tech stack:** JSON Schema-style validation, Node.js, Sharp, Jest, Playwright capture helpers, App Store Connect, Play Console, Chrome Web Store dashboard.

**Verified store rules:** Apple accepts 1-10 screenshots per display target and forbids alpha. Google Play requires a 512 by 512 icon, 1024 by 500 no-alpha feature graphic, 80-character short description, and at least two screenshots with 320-3840 px dimensions and a long side no more than twice the short side. Chrome requires a 128 icon, 440 by 280 small promo, and 1-5 full-bleed screenshots at 1280 by 800 or 640 by 400; 1400 by 560 marquee is optional but included. Record the official URLs and a 2026-09-15 checked date in the manifest.

**Approved Chrome capacity mapping:** Use the four shared scenes plus **Connect to Miden sites** as the five screenshots. Put **Review every request** confirmation-window imagery in the 440 by 280 small promo and **Your wallet, close by** side-panel imagery in the 1400 by 560 marquee.

---

## Task 1: Inventory the current listings and approved claims

**Files:**

- Create: `store-listing/README.md`
- Create: `store-listing/current-public-state.json`
- Modify: `tasks/todo.md`

1. Capture read-only public snapshots of the live App Store, Google Play, and Chrome Web Store pages, including visible name, lead copy, feature claims, screenshot order, and image URLs.
2. Record the public URLs, observation date, and discrepancies from the approved design without copying internal credentials, account identifiers, or private console data.
3. Verify every proposed claim against current product source, feature flags, and public documentation. Mark platform availability explicitly and reject superlatives, absolutes, stale version text, and unsupported recovery claims.
4. Record the source evidence and accepted claim vocabulary in the README. Commit the read-only inventory.

## Task 2: Create the canonical copy model

**Files:**

- Create: `store-listing/listing-copy.json`
- Create: `store-listing/schema/listing-copy.schema.json`
- Create: `scripts/store-listing/compose-copy.mjs`
- Create: `scripts/store-listing/compose-copy.test.ts`
- Generate: `store-listing/generated/app-store/copy.json`
- Generate: `store-listing/generated/play-store/copy.json`
- Generate: `store-listing/generated/chrome-web-store/copy.json`
- Replace: `STORE_LISTING.md`

1. Add failing tests for shared paragraph identity, platform block ordering, iOS swap exclusion, platform-specific authentication wording, field-length limits, no duplicate facts, no forbidden claims, and no Unicode dashes.
2. Define shared identity, security, feature, recovery, and open-source blocks once. Define platform overrides as additive ordered sections, not copied full descriptions.
3. Generate each store's complete text plus a concise human-readable `STORE_LISTING.md` from the same source.
4. Include short descriptions, keywords where supported, screenshot headlines, alt text, and official product/source URLs.
5. Run the focused tests twice, compare generated copy hashes, and commit only deterministic output.

## Task 3: Define scenes and first-party rule validation

**Files:**

- Create: `store-listing/scenes.json`
- Create: `store-listing/schema/scenes.schema.json`
- Create: `store-listing/store-rules.json`
- Create: `scripts/store-listing/validate.mjs`
- Create: `scripts/store-listing/validate.test.ts`
- Modify: `package.json`

1. Add failing tests for missing raw captures, unsupported output sizes, alpha where forbidden, screenshot counts, order gaps, missing alt text, incorrect shared-scene order, unsupported platform scenes, stale rule-check dates, and forbidden dashes.
2. Encode the current Apple, Google Play, and Chrome requirements with direct first-party source URLs and the checked date. Separate mandatory requirements from recommendations.
3. Map every output to a raw capture, crop, platform surface, headline, alt text, width, height, and output path.
4. Require the four shared scenes first and in the same order, followed only by approved platform scenes.
5. Add `store-listing:validate` and focused test scripts. Run them red then green and commit.

## Task 4: Capture deterministic current product states

**Files:**

- Create: `playwright/store-listing/store-listing.capture.ts`
- Create: `playwright/store-listing/store-listing.capture.test.ts`
- Modify: existing wallet, iOS, and Android page helpers only for missing reusable navigation methods.
- Create: `store-listing/raw/app-store/`
- Create: `store-listing/raw/play-store/`
- Create: `store-listing/raw/chrome-web-store/`

1. Add failing capture-plan tests proving every scene has a deterministic fixture state, exact viewport/platform flags, and a source output path.
2. Use isolated E2E wallets with testnet labels, deterministic accounts, non-sensitive balances, and no personal data. Never capture seeds, private keys, passwords, addresses belonging to a person, errors, or unavailable features.
3. Capture Chrome extension or side-panel pixels directly. Capture iOS and Android layouts under their actual platform feature flags, not by resizing Chrome.
4. Save raw PNGs without marketing edits. Immediately resize separate inspection copies to a maximum 1800 px long side before opening them.
5. Compare each raw capture with the live simulator/emulator surface and grade the approved scene criterion in a literal pass/fail table.
6. Run the capture test with retries disabled and commit the raw source set.

## Task 5: Build the shared visual system deterministically

**Files:**

- Create: `store-listing/theme.json`
- Create: `scripts/store-listing/build-assets.mjs`
- Create: `scripts/store-listing/build-assets.test.ts`
- Create: `store-listing/generated/app-store/`
- Create: `store-listing/generated/play-store/`
- Create: `store-listing/generated/chrome-web-store/`
- Reuse: existing Bread logo and packaged store icon assets.

1. Add failing renderer tests for output dimensions, alpha rules, crop containment, deterministic file ordering, brand colors, text safe areas, and complete scene coverage.
2. Use Sharp to compose one orange/grid/typography system around untouched raw product pixels. Reuse the current Bread mark and icon assets rather than generating replacements.
3. Keep screenshot headline text below 20 percent of each image. Chrome promo assets minimize text per Chrome guidance.
4. Render all platform outputs, then render them again in a clean temporary directory and require identical content hashes.
5. Run the validator against the generated package and commit only after every rule passes.

## Task 6: Review every copy and visual artifact

**Files:**

- Modify: `store-listing/README.md`
- Modify: `tasks/todo.md`

1. Open resized review copies of every generated image and compare them with the approved design and raw source.
2. Produce one pass/fail table per platform covering shared identity, platform-specific behavior, current UI accuracy, no invented data, copy limits, image rules, and ordering.
3. Run `review-council:rev` on the copy, claims, manifests, scripts, raw captures, and generated assets with the exact Sol, Terra, Opus, and Sonnet roster. Freeze prompts before launching seats and relay every 10-minute status.
4. Apply every actionable finding with new commits, rerun validation and deterministic rebuilds, then repeat visual grading for changed images.
5. Run repository TypeScript, lint, formatting, E2E harness lint, focused tests, dependency integrity, full 95% coverage, and affected builds before pushing.

## Task 7: Open the issue-closing PR and prepare exact publication inputs

1. Push the reviewed branch once and open a concise non-draft PR containing a standalone `Closes #497`.
2. Keep the PR open while external publication is pending so merging cannot close the issue before the public acceptance condition is met.
3. Attach or link the three generated asset directories, exact generated copy files, public-before snapshots, pass/fail tables, and a short `Reviewers:` line focused on factual claims and screenshot currency.
4. Babysit repository CI and review comments to green. Any code or asset change returns through validation, visual inspection, and Council as required.

## Task 8: Publish, verify public state, and merge

1. Obtain explicit platform-by-platform authorization from an account holder before changing App Store Connect, Play Console, or Chrome Web Store.
2. Upload only the reviewed generated files and paste only the generated copy. Do not improvise in a store dashboard.
3. Record each submission or metadata-review state without exposing private console details. Wait for the public listing update rather than treating upload acceptance as completion.
4. Reopen every public page and compare its name, lead paragraph, feature claims, screenshot order, and art against the repository package. Grade each platform in a final pass/fail table.
5. Once all three public listings pass and the PR's required CI is green, admin squash merge the PR.
6. Verify the squash commit on `main`, PR merge state, standalone `Closes #497`, and issue #497 closure.
