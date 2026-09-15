# Unified Store Listings Design

## Goal

Make the iOS App Store, Google Play, and Chrome Web Store listings unmistakably one Bread Wallet product while preserving the platform-specific reasons someone would install each version.

This design addresses wallet issue #497. Repository work creates the canonical copy, reproducible assets, validation, and publication checklist. The issue closes only after the three public listings match the approved package.

## Product Decision

All listings share the same core identity, security claims, terminology, and visual system. Feature order, screenshots, authentication wording, and integration details remain platform-specific.

## Current State

- The iOS listing leads with private self-custody, device-held keys, Face ID or passcode, public and private transfers, the dApp browser, Guardian recovery, and recallable sends.
- Google Play already uses Bread branding and a more recent feature set, but its copy structure differs from iOS and its orange-framed screenshots show an older application interface.
- Chrome still uses broad claims such as leading, highest privacy and performance, state-of-the-art security, and support for all transaction types. Those claims are not specific enough to verify and do not explain the same recovery or self-custody model as mobile.
- STORE_LISTING.md combines iOS and Google Play metadata, contains stale version-specific copy, and has no Chrome listing source of truth.
- iOS assets are raw current screenshots, Google Play assets use a branded marketing frame around older UI, and no checked-in Chrome listing set exists.
- There is no build or validation command that proves image dimensions, opacity, file limits, ordering, or copy limits before upload.

## Shared Product Story

Every listing starts from these claims, in this order:

1. Bread Wallet by Miden is the official self-custodial wallet for the Miden network.
2. Wallet keys are generated and kept encrypted on the user's device.
3. Users can send and receive Miden assets and choose public or private transfer behavior where supported by the flow.
4. No account or sign-up is required.
5. A recovery phrase restores key ownership. Guardian accounts add recovery and private-state continuity through the selected operator without giving that operator unilateral spending authority.
6. Bread is open source.

Avoid unqualified superlatives and absolutes. Do not claim highest security, leading wallet, all transaction types, total confidentiality, or that every transaction is private. Do not call Miden a zkRollup. Do not imply that a Guardian can recover a lost recovery phrase or spend funds alone.

The short shared value line is:

**Self-custody and private-by-design payments for the Miden network.**

The phrase private-by-design describes product intent without promising that every selected transfer, dApp, RPC, or delegated proof reveals nothing.

## Platform Copy

### iOS

Lead with personal money management and recovery. Name Face ID and passcode, the built-in dApp browser, send and receive, QR sharing, Guardian selection, and recallable transfers. Do not advertise swap while the iOS feature flag excludes it for App Store policy.

### Android

Use the same core paragraphs and section names as iOS. Name biometric or passcode unlock, the built-in dApp browser, send and receive, Guardian selection, local proving, and supported dApp actions. Mention swap only in the Android-specific feature section, not the shared core.

### Chrome

Use the same core paragraphs and section names, then lead the platform section with connecting to Miden sites, reviewing requests in a wallet-owned confirmation window, side-panel access, password protection, local or delegated proving, and supported send and dApp flows. Do not reuse mobile biometric wording.

Descriptions should read as prose with short factual bullets. Keep shared paragraphs byte-identical where each store permits it, then append the relevant platform block.

## Visual System

### Shared frame

- Bread orange is the dominant background with the current white Bread mark.
- Use the same grid texture, typography, corner radius, shadow, and headline placement across platforms.
- Put actual current application pixels at the center. No invented balances, operators, availability, or transaction results.
- Keep taglines under 20 percent of the image and avoid rankings, prices, calls to action, or time-sensitive claims.
- Remove personal data and use deterministic test accounts and testnet labels.

### Shared first four scenes

1. **Your wallet, your keys**: account home and encrypted local ownership.
2. **Send publicly or privately**: send review with the privacy choice visible.
3. **Receive with confidence**: receive address or QR flow.
4. **Recover with a Guardian**: operator selection or Guardian security overview.

These scenes use the same headline and order on all three stores, with an iPhone surface on iOS, Android surface on Google Play, and extension or side-panel surface on Chrome.

### Platform scenes

- iOS: dApp browser and Face ID or passcode protection.
- Android: dApp browser, local proving, and Android security settings.
- Chrome: connect to a site, inspect a confirmation request, and use the side panel.

The first three images prioritize recognizable application UI. Promotional images use the same brand background but minimize text and avoid a generic screenshot pasted into the center.

## Reproducible Asset Package

Add a store-listing directory with:

- listing-copy.json containing shared and platform blocks, short descriptions, keywords, screenshot headlines, alt text, and source URLs;
- scenes.json mapping each output to a checked-in raw capture and crop;
- a README with capture, build, review, and publication steps;
- raw subdirectories for deterministic current captures;
- generated output directories for app-store, play-store, and chrome-web-store.

Add a Node script using the repository's Sharp dependency to compose the shared frame and validate outputs. Generated assets remain checked in so reviewers can inspect the exact upload package, but they must be reproducible from the raw captures and manifests.

The script validates:

- every referenced raw capture exists;
- no generated asset has an alpha channel where a store disallows it;
- output dimensions and aspect ratios match the current store requirements recorded in the manifest;
- Apple has 1-10 valid images for each supported display target;
- Google Play has 2-8 phone images, at least four at 1080 resolution, a 1024 by 500 feature graphic, and a 512 by 512 icon;
- Chrome has at least one 1280 by 800 or 640 by 400 screenshot, a 440 by 280 small promo image, a 1400 by 560 marquee image, and the packaged 128 icon;
- short descriptions and keyword fields stay within their platform limits;
- screenshot order and alt text exist for every scene;
- no generated or metadata text contains a Unicode dash.

Store requirements and their official source URLs live in the manifest with a checked date so later releases know when to re-verify them.

## Capture Strategy

Use existing Playwright wallet fixtures and deterministic test hooks to capture current product states. Capture extension surfaces directly for Chrome. Capture mobile layout at the exact iOS and Android viewport and platform feature flags, then verify representative assets against a simulator or device before publication.

Raw screenshots are capture outputs, not hand-edited product mockups. The compositor may crop, mask, scale proportionally, add a browser or device-shaped surface, and add the shared brand background and headline. It may not change wallet UI values or hide error states inside the application surface.

Any capture over 1800 pixels on its long side is resized to that ceiling before visual inspection. Publication outputs retain their required native dimensions and are inspected through resized review copies.

## Publication Boundary

Merging the PR does not change a public store listing. After merge, a publisher with the required store role uploads the exact generated outputs and pastes the canonical copy into:

- App Store Connect for the active iOS version;
- Google Play Console main store listing;
- Chrome Web Store developer dashboard for the Bread Wallet item.

Take a read-only snapshot of all three public pages before publishing. After each store accepts the update, reopen the public listing and compare its name, lead paragraph, feature claims, screenshot order, and artwork against the repository manifest.

Do not close #497 from the PR alone. Close it only after all three public listings are verified. If publisher credentials or review timing are unavailable, leave the PR merged and the issue open with the exact remaining publication checklist.

## Test and Review Strategy

- Unit-test copy composition, platform overrides, field lengths, and prohibited claims.
- Unit-test scene completeness, dimensions, opacity, deterministic ordering, and alt-text coverage.
- Build all assets twice and compare hashes to prove determinism.
- Inspect every generated image through resized review copies.
- For each platform, record a pass or fail table against the shared identity, platform-specific details, current UI accuracy, and official asset rules.
- Run Review Council on the copy, claims, scripts, and rendered outputs. Fix every actionable finding.
- Review the public listings after publication rather than treating successful upload as proof.

## Non-Goals

- Making every platform description or screenshot identical.
- Advertising features unavailable on that platform.
- Changing the wallet application UI merely to simplify a marketing image.
- Localizing all promotional text in this issue. The manifest must make localization possible without redesign.
- Publishing to a store without an authorized publisher role.
