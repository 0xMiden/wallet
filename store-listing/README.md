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
