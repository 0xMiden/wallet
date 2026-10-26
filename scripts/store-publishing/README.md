# Bread store publishing

Build, upload and submit an exact stable version from an approved source commit. Standard submission requests automatic publication after store approval. The standard workflow finishes once review submission is accepted; no later release job or session is required. A successful upload or submission does not mean the version is public yet.

## Targets

| Platform | Network            | Required target                                 |
| -------- | ------------------ | ----------------------------------------------- |
| Chrome   | testnet            | Bread, `coajhopfooegmaifelglfboehacldcbo`       |
| Chrome   | devnet             | BreadDevnet, `eeghndabgeicdpkbcohgglidpfpiafnb` |
| iOS      | testnet or mainnet | App `6789341854`, bundle `com.miden.bread`      |
| Android  | testnet or mainnet | Package `com.miden.wallet`                      |

The current artifact builder supports native testnet builds and Chrome testnet/devnet builds. It refuses mainnet artifacts until the exact source's eligibility support is verified. The mobile CLI targets below can accept a future mainnet artifact only after that build guard is satisfied. Chrome mainnet has no approved mapping. Mobile devnet publishing is refused. The CLI enforces these targets and accepts no app identity override.

## Standard four-target route

Standard store builds and each explicit publication stage use this fixed order:

1. Chrome Testnet: Bread (`coajhopfooegmaifelglfboehacldcbo`).
2. iOS Testnet: `com.miden.bread`.
3. Android Testnet: `com.miden.wallet`.
4. Chrome Devnet: Bread Devnet (`eeghndabgeicdpkbcohgglidpfpiafnb`).

`build-store-artifacts.yml` with `platform=all`, `network=testnet` and an explicit native build suffix dispatches four separate single-target producer runs. Devnet starts last. The parent run's journal identifies the successful producer for each target; the parent itself is not artifact producer evidence. A later Devnet failure leaves earlier successful producers usable. Existing individual platform/network dispatches remain available. A GitHub rerun of the all-target parent stops before dispatch: inspect the original children and resume with the preserved private coordinator journal instead of starting fresh child requests.

`yarn build-all` also appends explicit Chrome Testnet and Devnet builds, preserves the existing platform outputs and leaves `dist/chrome-testnet.zip` and `dist/chrome-devnet.zip`. The default `chrome.zip` and unpacked Chrome output remain Testnet. These local build outputs do not replace signed store producer receipts.

For staged publication, keep a private release plan and a separate durable journal. Set the directory to mode `700` and both files to `600`. For example:

```json
{
  "schemaVersion": 1,
  "releaseTag": "vX.Y.Z",
  "sourceSha": "<exact 40-hex published release source>",
  "buildNumber": "<native suffix 1-999>",
  "targets": {
    "chrome-testnet": { "producerRunId": "<successful producer>", "stateRunId": "<latest state>" },
    "ios-testnet": { "producerRunId": "<successful producer>", "stateRunId": "<latest state>" },
    "android-testnet": {
      "producerRunId": "<successful producer>",
      "stateRunId": "<caller-owned edit state>",
      "editId": "<caller-owned edit>",
      "acknowledgement": "submit-pending-play-changes"
    },
    "chrome-devnet": { "producerRunId": "<successful producer>", "stateRunId": "<latest state>" }
  }
}
```

For iOS submission, omitted or empty notes default to the exact text `Various Fixes & Improvements`. An optional `releaseNotes` string in `targets.ios-testnet` overrides that default for a missing What's New field; existing nonempty store text is preserved. Notes are accepted only for iOS submit, never forwarded to Chrome, Android, builds or other actions. No generated release summary or manual text input is required.

Supply only evidence required by the selected stage. For `build`, use `targets: {}`. Upload needs producers and Android's prior edit state; submit needs the exact prior state for every target. Use `acknowledgement=none` for Android upload and retain `submit-pending-play-changes` only when submitting the inspected full pending set.

```sh
yarn store:build --plan "$PRIVATE_PLAN" --journal "$BUILD_JOURNAL"
yarn store:publish --stage upload --plan "$PRIVATE_PLAN" --journal "$UPLOAD_JOURNAL"
yarn store:publish --stage submit --plan "$PRIVATE_PLAN" --journal "$SUBMIT_JOURNAL"
```

Each command runs only its named stage, waits through `gh run watch --interval 30`, and preserves independent child run IDs. The existing trusted single-target workflows still validate exact source, receipts, identities, prior state and acknowledgements. Update the plan with those exact producer/state IDs before the next stage. Status can be requested with `--stage status`; it does not establish upload or public release proof.

A journal is bound to the exact stage, source and target intent. Resume the same command with the same journal after inspection; successful children are verified and skipped. An uncertain dispatch, failed operation, changed intent or conflicting correlation stops before another send. Never delete a journal to retry a mutation. Preserve its request token and inspect the exact child run/store state. The optional workflow request token correlates dispatches; it does not replace receipt verification.

`prepare` and `begin-edit` remain explicit individual-target operations, never all-store prerequisites created silently. Android still requires exclusive edit ownership and explicit acknowledgement of the inspected pending change set. The standard flow ends at accepted review submission, and all stores publish automatically after approval. The existing `release` action is for explicit recovery of older deferred/manual releases only. Store processing, review and verified public distribution remain distinct facts; submission does not claim all four items are public.

## Build and preserve evidence

Use Node 22 and Python 3. Local iOS upload also requires Xcode command line tools with `xcrun altool`.

Run the signed artifact workflow from the default branch after the stable release tag is published. Supply its exact 40-character source SHA. Mobile builds require an explicit build suffix from 1 through 999:

```sh
gh workflow run build-store-artifacts.yml --repo 0xMiden/wallet --ref main \
  -f release_tag="$RELEASE_TAG" -f source_sha="$SOURCE_SHA" \
  -f platform=ios -f network=testnet -f build_number="$BUILD_SUFFIX"
```

Record the resulting run ID and source SHA. Start `gh run watch "$RUN_ID" --repo 0xMiden/wallet --interval 30 --exit-status`, inspect failures, and download only artifacts from that successful producer run. Use the emitted receipt's exact build number or Android version code, rather than deriving a replacement by hand.

Each upload needs its artifact and matching JSON receipt. The receipt binds the artifact SHA256, platform, target identity, version, network, source SHA and native build number or version code. The archive must also contain `wallet-release.json` with the same version, network and source SHA, and `mode: "production"`. The marker is at the ZIP root for Chrome, `Payload/*.app/public/` for iOS, and `base/assets/public/` for Android. Older unmarked artifacts are refused.

The CLI checks the Chrome manifest name/version and, when present, its key-derived extension ID. The receipt binds unsigned ZIPs to the allowlisted item. It checks the IPA's bundle ID, version and build number. Play additionally verifies the uploaded Android version code and hash against the configured package. Keep the original artifact and receipt together across subsequent actions.

## Private configuration

The default config is `~/.config/wallet-publishing/config.json`. Use `--config` to choose another private file. Directories must be mode `700`; config, credentials, keys and state files must be mode `600`. Do not commit them.

```json
{
  "stateDir": "~/.config/wallet-publishing/state",
  "apple": {
    "appId": "6789341854",
    "bundleId": "com.miden.bread",
    "keyId": "<key ID>",
    "issuerId": "<issuer ID>",
    "keyPath": "<private p8 file>"
  },
  "chrome": {
    "publisherId": "<publisher ID>",
    "items": {
      "testnet": "coajhopfooegmaifelglfboehacldcbo",
      "devnet": "eeghndabgeicdpkbcohgglidpfpiafnb"
    },
    "oauthPath": "<private offline OAuth credentials JSON>"
  },
  "play": {
    "packageName": "com.miden.wallet",
    "developerId": "<developer ID>"
  }
}
```

Apple uses the App Manager publishing key. Chrome uses the explicitly authorized Chrome Web Store OAuth scope. Android CI uses GitHub OIDC Workload Identity Federation and a short-lived `WALLET_PLAY_ACCESS_TOKEN` for the authorized publisher service account. The organization blocks service-account JSON key creation; preserve that policy.

The state directory stores verified upload attestations, per-item Chrome upload journals and `android-edit.json`. Submit and release require the matching prior upload's identity, version, build or code, source SHA, network and hash. Existing store builds cannot be adopted merely because their version matches. Chrome submit rechecks the same ZIP and resumes its journaled upload. A legacy attestation without a journal starts one new journaled upload before submission.

Preserve the exact nonsecret attestation JSON, Chrome upload journal and Android edit JSON between workflow runs. Do not archive config, credentials, keys, `.mutation.lock`, or private `ios-upload-*.log` files. Restore state only from the corresponding trusted publishing run. A store-accepted operation followed by a local state-save failure needs store inspection before another action; do not blindly retry.

## Publishing workflow

Dispatch `publish-stores.yml` from `main` through the protected `wallet-store-publishing` environment. For example, upload Chrome Testnet from a successful signed artifact producer:

```sh
gh workflow run publish-stores.yml --repo 0xMiden/wallet --ref main \
  -f release_tag="$RELEASE_TAG" -f source_sha="$SOURCE_SHA" \
  -f platform=chrome -f action=upload -f network=testnet \
  -f producer_run_id="$PRODUCER_RUN_ID" -f acknowledgement=none
```

For `submit` or `release`, also supply `-f state_run_id="$PREVIOUS_PUBLISH_RUN_ID"` from the matching publishing run. A failed run is accepted only when its state artifact contains a validated, exact-producer Chrome upload journal; an unrelated failure cannot establish upload proof. Keep the same producer, version, network and source. The workflow validates and restores only the matching `WalletStoreState-<platform>-<version>-<network>-<runId>-<runAttempt>` artifact.

Android upload also requires restored state from its `begin-edit` run and an explicit `edit_id`. Android submit requires that same edit ID and `acknowledgement=submit-pending-play-changes`; `begin-edit` requires `acknowledgement=create-new-play-edit`. Other actions use `acknowledgement=none`. Status, iOS prepare and Android begin-edit do not require a producer run. Native mutations except iOS prepare require `build_number`, the same raw suffix from 1 through 999 supplied to the producer. The planner derives Android's version code and checks it against the receipt.

Watch the new publishing run immediately and inspect its result before dispatching the next action. Preserve the resulting state artifact for that next action.

## CLI procedure

Use explicit values throughout:

```sh
VERSION='<x.y.z>'
SOURCE_SHA='<40-character approved commit>'
NETWORK='testnet'
```

Every mutation requires `--version`, `--source-sha`, `--network` and `--confirm "$VERSION"`. Add `--dry-run` to validate the request and artifact without authentication or store writes. A dry run does not establish a verified upload attestation. Status is read-only:

```sh
node scripts/store-publishing/cli.mjs chrome status --network "$NETWORK" --version "$VERSION"
node scripts/store-publishing/cli.mjs ios status --version "$VERSION" --build-number "$BUILD_NUMBER"
node scripts/store-publishing/cli.mjs android status --version-code "$VERSION_CODE"
```

Android status returns up to 20 current, non-obsolete production releases. Inspect the requested code explicitly; this response is not complete release history.

### Chrome

```sh
node scripts/store-publishing/cli.mjs chrome upload \
  --version "$VERSION" --source-sha "$SOURCE_SHA" --network "$NETWORK" \
  --artifact "$ZIP" --receipt "$RECEIPT" --confirm "$VERSION"
node scripts/store-publishing/cli.mjs chrome submit \
  --version "$VERSION" --source-sha "$SOURCE_SHA" --network "$NETWORK" \
  --artifact "$ZIP" --receipt "$RECEIPT" --confirm "$VERSION"
# Legacy deferred-release recovery only:
node scripts/store-publishing/cli.mjs chrome release \
  --version "$VERSION" --source-sha "$SOURCE_SHA" --network "$NETWORK" --confirm "$VERSION"
```

An `IN_PROGRESS` upload saves its exact publisher/item, version, source SHA, network and artifact hash in `chrome-<itemId>-upload.json`. Resume with the same ZIP and receipt using `upload` or `submit`; for the workflow, supply that run's `state_run_id`. Resume polls at most six times with five-second gaps, and sends no new media POST. If processing remains pending, preserve the newest state and resume again. An async completion is labeled `accepted-async-journal`; it never claims the API returned a draft version or hash.

A later Chrome version can reuse the same state directory. Only a prior `submitted` journal can roll over, after a fresh status read proves that exact prior version is published on every channel with no active submission, policy warning or partial rollout. The next version must be strictly newer. The complete old journal is archived privately before the new request journal atomically replaces it; an archive or journal-write failure sends no media POST. Old attestations never prove the new artifact. A prior terminal journal may be older than 24 hours because publication is checked live. In the workflow, an optional `state_run_id` may identify the prior version's terminal state for this check; a fresh runner without prior state can start a new upload. If rollover fails before a new request starts, reuse the original prior state artifact.

Keep exclusive ownership of the item from the first upload until submission is verified: use the same private state directory or the latest workflow state artifact, and do not upload through the console, another client or another run without restoring that journal. The CLI lock and workflow concurrency serialize this publishing path. The Chrome API cannot detect another writer or correlate an async status with an operation ID, so this ownership is required for journal continuity.

Async status is available only for 24 hours. A missing, failed, expired, future-dated or conflicting status stops without another upload. The journal is written before the media POST; if its response is lost, `request-started` remains uncertain and requires store inspection and explicit recovery rather than retrying the upload. Likewise, an uncertain review request is never repeated automatically. Preserve the state artifact even when the workflow fails, and inspect the item before making further changes.

Submission requests review with automatic publication after approval and verifies the submitted revision's exact version through `fetchStatus` before reporting acceptance. No later Chrome release command is part of the standard flow. The legacy release action requires the exact approved deferred version and is reserved for recovery. Status must confirm the requested version is public before claiming publication.

### iOS

```sh
node scripts/store-publishing/cli.mjs ios prepare \
  --version "$VERSION" --source-sha "$SOURCE_SHA" --network "$NETWORK" --confirm "$VERSION"
node scripts/store-publishing/cli.mjs ios upload \
  --version "$VERSION" --source-sha "$SOURCE_SHA" --network "$NETWORK" \
  --build-number "$BUILD_NUMBER" --artifact "$IPA" --receipt "$RECEIPT" --confirm "$VERSION"
node scripts/store-publishing/cli.mjs ios submit \
  --version "$VERSION" --source-sha "$SOURCE_SHA" --network "$NETWORK" \
  --build-number "$BUILD_NUMBER" --confirm "$VERSION"
# Legacy recovery for an approved MANUAL-release version only:
node scripts/store-publishing/cli.mjs ios release \
  --version "$VERSION" --source-sha "$SOURCE_SHA" --network "$NETWORK" \
  --build-number "$BUILD_NUMBER" --confirm "$VERSION"
```

`prepare` reuses an existing matching version without editing its metadata. In particular, reuse the existing `1.17.7` draft and its screenshots untouched. For a future missing version, it creates an automatic-after-approval draft only if no other unreleased version conflicts. Complete and verify required screenshots, privacy, export compliance and review information before submission. Submission fills a missing What's New field with `Various Fixes & Improvements` or the explicit optional notes, preserving existing nonempty text.

Wait for the exact uploaded build to finish processing. Submit selects only that version and build and defaults to `--release-policy after-approval`. The existing `1.17.7` draft uses `AFTER_APPROVAL`, and future standard drafts use the same policy. Accepted review submission completes the standard command; Apple publishes after approval without a later release command. Public distribution is claimed only after a read-only store status confirms it.

iOS submit retains explicit `--release-policy manual` and `--release-policy preserve-existing` opt-ins for authorized legacy recovery. The standard workflow uses automatic publication after approval. Optional `--release-notes` (workflow `release_notes`) fills only an empty existing en-US What's New field; existing nonempty text is preserved. Omitted or empty notes use exactly `Various Fixes & Improvements` for iOS submit; other operations receive no notes default. A unique empty review draft may be resumed only after its app relationship, target build and exclusive contents are verified.

### Android

Inspect Play Console's full Publishing overview before starting an edit and again before submission. Coordinate exclusive ownership of the package's edit: creating a new edit invalidates the previous edit belonging to the same principal, and console changes can invalidate an API edit. There are no automatic replacement edits, cancellations or retries.

```sh
node scripts/store-publishing/cli.mjs android begin-edit \
  --version "$VERSION" --source-sha "$SOURCE_SHA" --network "$NETWORK" \
  --confirm-new-edit --confirm "$VERSION"
# Set EDIT_ID to the exact returned ID saved in android-edit.json.
node scripts/store-publishing/cli.mjs android upload \
  --version "$VERSION" --source-sha "$SOURCE_SHA" --network "$NETWORK" \
  --version-code "$VERSION_CODE" --edit-id "$EDIT_ID" \
  --artifact "$AAB" --receipt "$RECEIPT" --confirm "$VERSION"
node scripts/store-publishing/cli.mjs android submit \
  --version "$VERSION" --source-sha "$SOURCE_SHA" --network "$NETWORK" \
  --version-code "$VERSION_CODE" --edit-id "$EDIT_ID" \
  --allow-pending-changes --confirm "$VERSION"
# Legacy managed-release recovery only:
node scripts/store-publishing/cli.mjs android release \
  --version "$VERSION" --source-sha "$SOURCE_SHA" --network "$NETWORK" \
  --version-code "$VERSION_CODE" --confirm "$VERSION"
```

Upload leaves the exact code as an uncommitted production draft. Submit commits the edit and sends changes for review. **Commit can include all pending console changes**, not only the requested binary. `--allow-pending-changes` acknowledges that the complete pending set has been inspected and approved. An existing review causes an error rather than automatic cancellation.

Keep managed publishing OFF in Play Console for the standard automatic-after-approval flow. Submit commits the inspected pending set and sends it for review; Play publishes approved changes automatically. No later release command or console Publish changes step is part of the standard flow. The legacy release action is only for explicitly authorized recovery of an older managed release; the API cannot perform that console-only publication step. Do not promote a testing track as a substitute, and verify the production rollout and requested version code before claiming public availability.

## Monitor each transition

After each action, inspect its structured result and preserve the exact version, build or code, source SHA and run IDs. Standard submission finishes once the store accepts review; the store handles automatic publication after approval. Read-only status checks may track processing and review, but no later session is needed to execute a publication mutation. An error, expired edit, review rejection, missing attestation or ambiguous store state needs inspection before another mutation. Verify all four public target results independently before calling a cross-store release complete.

## Versioned screenshots

`store-listing/screenshots.json` and its ordered files are the screenshot source for future releases. The workflow loads them from the exact `source_sha` checkout. It checks the commit, package version, clean tracked assets, image hashes and store identity before any publishing mutation. Mobile submission also compares the remote ordered screenshots with that source. It stops on drift instead of submitting unrelated console edits.

Change screenshots through a PR: replace the intended image files, update their SHA256, size and technical metadata, and preserve the array order. Include the previous ordered remote checksums in `baselineSets` when authorizing replacements. Remove stale original-upload provenance when replacing an image. PR CI decodes the actual files and checks their format, dimensions, alpha, color depth, byte limits and counts against dated store rules. It cannot establish the stores' content-policy approval.

Use `action=sync-screenshots` before submission when a new iOS version has no screenshots or an approved screenshot PR changes them. iOS `prepare` reuses an existing draft or creates its skeleton; screenshot synchronization is a separate explicit step. Android synchronization requires the exact restored caller-owned edit and preserves its pending changes. It never creates or commits an edit implicitly. Reuse its returned state for subsequent upload and submission.

```sh
node scripts/store-publishing/cli.mjs ios sync-screenshots \
  --version "$VERSION" --source-sha "$SOURCE_SHA" --network "$NETWORK" \
  --screenshots-root "$RELEASE_SOURCE_CHECKOUT" --confirm "$VERSION"

node scripts/store-publishing/cli.mjs android sync-screenshots \
  --version "$VERSION" --source-sha "$SOURCE_SHA" --network "$NETWORK" \
  --screenshots-root "$RELEASE_SOURCE_CHECKOUT" --edit-id "$EDIT_ID" --confirm "$VERSION"
```

Matching images are kept. Apple replacement uploads must finish processing before old images are removed; a set without enough free slots stops for console handling. An uncertain or partial operation requires inventory and inspection before another attempt.

Chrome's public API supports package publishing but has no listing-image operation. `chrome sync-screenshots` returns the exact listing identity and approved local asset paths with `consoleRequired=true`. Use those files in the authenticated developer console, preserve localized versus global groups, and verify order before submission. This command does not claim to have synchronized Chrome images.

The manifest holds two iOS groups, the 5 Android draft phone images and the 5 English published screenshots from each active Chrome listing. The large iPhone group is the 5 approved composed designs; they replace the 9 images in the existing draft, and its `baselineSets` entry records those 9 remote checksums in order to authorize replacing them. Nine kept images plus five uploads exceed Apple's 10-image set limit, so `sync-screenshots` stops on that draft until the old images are removed in the console. The 5 smaller iPhone screenshots and the Android originals match their store downloads/checksums exactly. Chrome exports are from the published listings, not a byte-verified draft export: inspect both localized and global console groups before changing them. No retired Chrome item is included.

The already cut `1.17.7` source predates this manifest. Only that version has an explicit `--preserve-legacy-screenshots` exception for existing drafts; invalid manifests or missing image files never use the exception. Later release sources require canonical screenshots.
