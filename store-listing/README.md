# Bread Wallet store listing package

This directory is the source of truth for the English App Store, Google Play,
and Chrome Web Store listings. It keeps the shared product claims, platform
differences, capture plan, generated copy, generated artwork, and publication
evidence together so the three listings can be reviewed as one release.

The repository package is not proof that a public listing changed. Publication
is complete only after an authorized publisher uploads the reviewed package and
the corresponding public page is checked against it.

## Public baseline

`current-public-state.json` records the three listings as observed on
2026-09-15. It includes public URLs, visible copy, screenshot order, image URLs,
and discrepancies from the approved design. Text copied from a public page is
normalized to ASCII hyphens so the repository never introduces a Unicode dash.

The baseline shows three separate presentations of the same product:

- App Store copy is current but its unframed screenshots do not share the
  visual system used by the other stores.
- Google Play uses orange marketing frames, but the phone surfaces and Face ID
  wording are from iOS rather than Android.
- Chrome uses an older description with unsupported superlatives and frames
  mobile surfaces rather than extension or side-panel surfaces.

## Approved claim vocabulary

Only the following product claims are accepted for generated listing copy.
Platform-specific copy must use the availability column and source evidence
below. The canonical copy model may make a narrower claim than the source, but
must not make a broader one.

| Claim                                                                            | Availability                 | Evidence                                                                                                                 |
| -------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Bread Wallet by Miden is Miden's official self-custodial wallet                  | All                          | `docs/privacy/index.md`, repository ownership, and the approved issue #497 design                                        |
| Keys are generated and held on the device, with encrypted local storage          | All                          | `README.md`, `docs/privacy/index.md`, `src/lib/miden/back/safe-storage.ts`, and `src/lib/miden/back/vault.ts`            |
| Send and receive Miden assets                                                    | All                          | `README.md` and the send and receive routes under `src/screens/`                                                         |
| Select public or private transfer behavior where the active flow supports it     | All                          | transaction controls and localized labels under `src/` and `public/_locales/en/en.json`                                  |
| No wallet account registration or sign-up is required                            | All                          | onboarding routes under `src/screens/onboarding/` and `docs/privacy/index.md`                                            |
| A recovery phrase restores key ownership                                         | All                          | `README.md`, onboarding and recovery flows, and `public/_locales/en/en.json`                                             |
| A selected Guardian cosigns without unilateral spending authority                | All                          | Guardian account code and the Guardian explanation in `public/_locales/en/en.json`                                       |
| Bread Wallet is open source                                                      | All                          | this public repository and its MIT `LICENSE`                                                                             |
| Face ID, Touch ID, or device passcode protects access                            | iOS                          | `README.md`, `docs/privacy/index.md`, and mobile biometric code under `src/`                                             |
| Fingerprint, face authentication, or device passcode protects access             | Android                      | `README.md`, `docs/privacy/index.md`, and mobile biometric code under `src/`                                             |
| Built-in dApp browsing and QR address sharing                                    | iOS and Android              | `README.md`, mobile routes, and Capacitor platform code under `src/`                                                     |
| Recallable transfer timing                                                       | iOS and Android              | send controls and recall copy in `public/_locales/en/en.json`                                                            |
| Swap is available                                                                | Android only in listing copy | `src/lib/feature-flags.ts`; iOS is deliberately omitted from marketing copy even though current main enables the feature |
| Connect to Miden sites and review requests in a wallet-owned confirmation window | Chrome                       | `src/app/ConfirmPage.tsx`, extension connection code, and `public/manifest.json`                                         |
| Open the wallet in a browser side panel                                          | Chrome                       | `public/manifest.json`, `src/sidepanel.tsx`, and `src/lib/extension/side-panel-handoff.ts`                               |
| Password protection                                                              | Chrome                       | `README.md` and vault code under `src/lib/miden/back/`                                                                   |
| Local or delegated proving                                                       | Android and Chrome           | prover selection and fallback code under `src/lib/miden/`                                                                |

Do not use `leading`, `highest`, `state-of-the-art`, `all transaction types`,
`totally private`, or an equivalent absolute. Do not describe Miden as a
zkRollup. Do not imply that every transfer is private, that a Guardian can
recover a missing recovery phrase, or that a Guardian can spend alone.

The shared value line is:

> Self-custody and private-by-design payments for the Miden network.

## Working with the package

The generated files are checked in for direct review. Their JSON manifests,
copy, raw captures, and theme remain the inputs. Do not hand-edit generated
output.

The implementation commands and visual review tables are added here alongside
the generators. Every capture must use a deterministic test wallet and testnet
data. Never capture a personal address, seed phrase, private key, password,
production balance, unavailable feature, or error state.

Before publication:

1. Recheck the first-party store rules and their checked date.
2. Generate copy and assets from the committed manifests.
3. Validate copy limits, image dimensions, opacity, scene order, and alt text.
4. Build twice and compare hashes.
5. Inspect review copies capped at 1800 pixels on the long side.
6. Obtain explicit authorization for each store dashboard.
7. Upload only the reviewed generated files and paste only generated copy.
8. Reopen each public listing and compare it with the package.

## Build and validation

Use Node.js 22 for the repository commands below:

```sh
yarn store-listing:copy
yarn store-listing:capture:build
yarn store-listing:capture --retries=0
yarn store-listing:assets
yarn store-listing:validate
yarn test:store-listing
```

The capture run writes 20 raw product images: six App Store images at
1320 by 2868, seven Google Play images at 1080 by 1920, and seven Chrome
surfaces at 400 by 600. The compositor writes 23 upload assets:

- App Store: six opaque sRGB screenshots at 1320 by 2868.
- Google Play: seven opaque sRGB screenshots at 1080 by 1920, one opaque
  1024 by 500 feature graphic, and one 512 by 512 icon.
- Chrome Web Store: five opaque sRGB screenshots at 1280 by 800, one opaque
  440 by 280 small promo, one opaque 1400 by 560 marquee, and one 128 by 128
  icon.

For a deterministic rebuild, run the capture twice and compare sorted SHA-256
hashes of all 20 raw PNGs. Then record sorted hashes of every generated PNG,
run `yarn store-listing:assets` again from unchanged inputs, and compare a
second generated hash list with the first. No hash may change in either pair.

## Visual review baseline

The tables below record the 2026-09-16 pixel review. Every upload asset was
opened through a fresh montage capped at 1800 pixels on the long side. The
mobile raw captures were also paired with fresh screenshots from an iPhone 17
Pro Max simulator and an Android phone emulator running the built native apps.
System status bars and transient focus rings are outside the product surface;
the product layout, content, routes, controls, and platform wording must match.

The deterministic Guardian capture fixes the configured operators in their
reachable state so the image does not vary with a network probe. As a separate
currency check, every configured public Guardian `pubkey` endpoint returned
HTTP 200 on 2026-09-16. The raw images contain the same operator roster and
layout seen in both native apps.

### App Store

| Criterion (verbatim from the approved design)                                                                                                                                   | Pass / Fail | What the fresh review shows                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| Bread orange is the dominant background with the current white Bread mark.                                                                                                      | Pass        | All six screenshots use the same orange grid and current white mark.                                                     |
| Use the same grid texture, typography, corner radius, shadow, and headline placement across platforms.                                                                          | Pass        | The App Store frame matches the Google Play and Chrome frames without covering product controls.                         |
| Put actual current application pixels at the center. No invented balances, operators, availability, or transaction results.                                                     | Pass        | All six product surfaces come from the current mobile build and deterministic testnet fixture; no result state is shown. |
| Remove personal data and use deterministic test accounts and testnet labels.                                                                                                    | Pass        | The home, receive, and request scenes use one non-personal test wallet and visibly say Testnet.                          |
| Your wallet, your keys: account home and encrypted local ownership.                                                                                                             | Pass        | Scene 1 shows the current account home; the paired native screenshot matches its product layout and values.              |
| Send publicly or privately: send review with the privacy choice visible.                                                                                                        | Pass        | Scene 2 shows the current transaction request with `Note Type, Private`; the paired native dialog matches.               |
| Receive with confidence: receive address or QR flow.                                                                                                                            | Pass        | Scene 3 shows the current QR receive route and testnet warning; the paired native route matches.                         |
| Recover with a Guardian: operator selection or Guardian security overview.                                                                                                      | Pass        | Scene 4 shows the current configured operator picker in the same layout as the paired native route.                      |
| iOS: dApp browser and Face ID or passcode protection.                                                                                                                           | Pass        | Scenes 5 and 6 show the current dApp launcher and iOS-only `Face ID set up` wording; both match native screenshots.      |
| Keep taglines under 20 percent of the image and avoid rankings, prices, calls to action, or time-sensitive claims.                                                              | Pass        | Each headline stays in the reserved top band and contains none of the prohibited content.                                |
| short descriptions and keyword fields stay within their platform limits;                                                                                                        | Pass        | The validator accepts the name, subtitle, promotional text, keywords, and description limits.                            |
| Apple has 1-10 valid images for each supported display target;                                                                                                                  | Pass        | Six opaque sRGB screenshots are present at the accepted 1320 by 2868 size.                                               |
| These scenes use the same headline and order on all three stores, with an iPhone surface on iOS, Android surface on Google Play, and extension or side-panel surface on Chrome. | Pass        | Scenes 1-4 use the approved shared headlines and order, followed only by the two approved iOS scenes.                    |

### Google Play

| Criterion (verbatim from the approved design)                                                                                                                                   | Pass / Fail | What the fresh review shows                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Bread orange is the dominant background with the current white Bread mark.                                                                                                      | Pass        | All screenshots and the feature graphic use the shared orange grid and current white mark.                                       |
| Use the same grid texture, typography, corner radius, shadow, and headline placement across platforms.                                                                          | Pass        | The seven screenshot frames match App Store and Chrome while retaining an Android phone surface.                                 |
| Put actual current application pixels at the center. No invented balances, operators, availability, or transaction results.                                                     | Pass        | All seven product surfaces come from the current Android build and deterministic testnet fixture; no result state is shown.      |
| Remove personal data and use deterministic test accounts and testnet labels.                                                                                                    | Pass        | The home, receive, and request scenes use one non-personal test wallet and visibly say Testnet.                                  |
| Your wallet, your keys: account home and encrypted local ownership.                                                                                                             | Pass        | Scene 1 shows the current Android account home; the paired native screenshot matches its layout and account.                     |
| Send publicly or privately: send review with the privacy choice visible.                                                                                                        | Pass        | Scene 2 shows `Note Type, Private`; the paired native Android dialog matches and contains no hover tooltip.                      |
| Receive with confidence: receive address or QR flow.                                                                                                                            | Pass        | Scene 3 shows the current QR receive route; the paired native Android route matches.                                             |
| Recover with a Guardian: operator selection or Guardian security overview.                                                                                                      | Pass        | Scene 4 uses the current operator picker; its roster and layout match the paired native route.                                   |
| Android: dApp browser, local proving, and Android security settings.                                                                                                            | Pass        | Scenes 5-7 show the current dApp launcher, delegated proving switched off, and `Biometric set up`; all match native screenshots. |
| Keep taglines under 20 percent of the image and avoid rankings, prices, calls to action, or time-sensitive claims.                                                              | Pass        | Each headline stays in the reserved top band and contains none of the prohibited content.                                        |
| short descriptions and keyword fields stay within their platform limits;                                                                                                        | Pass        | The validator accepts the name, short description, and description limits.                                                       |
| Google Play has 2-8 phone images, at least four at 1080 resolution, a 1024 by 500 feature graphic, and a 512 by 512 icon;                                                       | Pass        | Seven 1080 by 1920 screenshots, the required opaque feature graphic, and the required icon are present.                          |
| These scenes use the same headline and order on all three stores, with an iPhone surface on iOS, Android surface on Google Play, and extension or side-panel surface on Chrome. | Pass        | Scenes 1-4 use the approved shared headlines and order, followed only by the three approved Android scenes.                      |

### Chrome Web Store

| Criterion (verbatim from the approved design)                                                                                                         | Pass / Fail | What the fresh review shows                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Bread orange is the dominant background with the current white Bread mark.                                                                            | Pass        | All screenshots and promo images use the shared orange grid and current white mark.                                             |
| Use the same grid texture, typography, corner radius, shadow, and headline placement across platforms.                                                | Pass        | The five screenshots and two promos match the mobile visual system without imitating a phone frame.                             |
| Put actual current application pixels at the center. No invented balances, operators, availability, or transaction results.                           | Pass        | Direct extension, confirmation-window, and side-panel captures show current product pixels and a deterministic testnet fixture. |
| Remove personal data and use deterministic test accounts and testnet labels.                                                                          | Pass        | The extension surfaces use one non-personal test wallet and contain no personal or production data.                             |
| Your wallet, your keys: account home and encrypted local ownership.                                                                                   | Pass        | Screenshot 1 shows the current side-panel account home.                                                                         |
| Send publicly or privately: send review with the privacy choice visible.                                                                              | Pass        | Screenshot 2 shows the current wallet-owned confirmation window with `Note Type, Private`.                                      |
| Receive with confidence: receive address or QR flow.                                                                                                  | Pass        | Screenshot 3 shows the current extension receive route.                                                                         |
| Recover with a Guardian: operator selection or Guardian security overview.                                                                            | Pass        | Screenshot 4 shows the current full-page operator picker.                                                                       |
| Chrome: connect to a site, inspect a confirmation request, and use the side panel.                                                                    | Pass        | Screenshot 5 shows the connection request, the small promo shows confirmation imagery, and the marquee shows the side panel.    |
| Keep taglines under 20 percent of the image and avoid rankings, prices, calls to action, or time-sensitive claims.                                    | Pass        | Screenshot and promo headlines stay in reserved bands and contain none of the prohibited content.                               |
| short descriptions and keyword fields stay within their platform limits;                                                                              | Pass        | The validator accepts the name and short-description limits.                                                                    |
| Chrome has at least one 1280 by 800 or 640 by 400 screenshot, a 440 by 280 small promo image, a 1400 by 560 marquee image, and the packaged 128 icon; | Pass        | Five opaque 1280 by 800 screenshots and all three required supporting asset sizes are present.                                  |
| Screenshots 1-4 are the shared scenes in the shared order.                                                                                            | Pass        | The first four files and headlines match the mobile listings exactly.                                                           |
| Screenshot 5 is **Connect to Miden sites**.                                                                                                           | Pass        | The fifth screenshot is the current connection request.                                                                         |
| The required 440 by 280 small promo uses **Review every request** confirmation-window imagery.                                                        | Pass        | The small promo uses the current wallet-owned transaction confirmation window.                                                  |
| The 1400 by 560 marquee uses **Your wallet, close by** side-panel imagery.                                                                            | Pass        | The marquee uses the current Chrome side-panel account home.                                                                    |
