# Bread store publishing

Build, upload, submit for review, and release an exact stable version from an approved source commit. These are separate actions. A successful upload or submission does not mean the version is public.

## Targets

| Platform | Network            | Required target                                 |
| -------- | ------------------ | ----------------------------------------------- |
| Chrome   | testnet            | Bread, `coajhopfooegmaifelglfboehacldcbo`       |
| Chrome   | devnet             | BreadDevnet, `eeghndabgeicdpkbcohgglidpfpiafnb` |
| iOS      | testnet or mainnet | App `6789341854`, bundle `com.miden.bread`      |
| Android  | testnet or mainnet | Package `com.miden.wallet`                      |

Chrome mainnet has no approved mapping. Mobile devnet publishing is refused. The CLI enforces these targets and accepts no app identity override.

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

The state directory stores verified upload attestations and `android-edit.json`. Submit and release require the matching prior upload's identity, version, build or code, source SHA, network and hash. Existing store builds cannot be adopted merely because their version matches. Chrome submit rechecks and uploads the same ZIP and can establish its attestation.

Preserve the exact nonsecret attestation JSON and Android edit JSON between workflow runs. Do not archive config, credentials, keys, `.mutation.lock`, or private `ios-upload-*.log` files. Restore state only from the corresponding trusted publishing run. A store-accepted operation followed by a local state-save failure needs store inspection before another action; do not blindly retry.

## Publishing workflow

Dispatch `publish-stores.yml` from `main` through the protected `wallet-store-publishing` environment. For example, upload Chrome Testnet from a successful signed artifact producer:

```sh
gh workflow run publish-stores.yml --repo 0xMiden/wallet --ref main \
  -f release_tag="$RELEASE_TAG" -f source_sha="$SOURCE_SHA" \
  -f platform=chrome -f action=upload -f network=testnet \
  -f producer_run_id="$PRODUCER_RUN_ID" -f acknowledgement=none
```

For `submit` or `release`, also supply `-f state_run_id="$PREVIOUS_PUBLISH_RUN_ID"` from the matching successful publishing run. Keep the same producer, version, network and source. The workflow validates and restores only the matching `WalletStoreState-<platform>-<version>-<network>-<runId>-<runAttempt>` artifact.

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
node scripts/store-publishing/cli.mjs chrome release \
  --version "$VERSION" --source-sha "$SOURCE_SHA" --network "$NETWORK" --confirm "$VERSION"
```

Wait for upload processing before submission. Submission requests review with deferred publication. Release requires the exact approved staged version; status must confirm the requested version is published before declaring completion.

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
# For an approved MANUAL-release version only:
node scripts/store-publishing/cli.mjs ios release \
  --version "$VERSION" --source-sha "$SOURCE_SHA" --network "$NETWORK" \
  --build-number "$BUILD_NUMBER" --confirm "$VERSION"
```

`prepare` reuses an existing matching version without editing its metadata. In particular, reuse the existing `1.17.7` draft and its screenshots untouched. For a future missing version, it creates a manual-release draft skeleton only if no other unreleased version conflicts. Complete and verify required metadata, screenshots, privacy, export compliance and review information in App Store Connect before submission. Preparation does not copy or invent those fields.

Wait for the exact uploaded build to finish processing. Submit selects only that version and build and defaults to `--release-policy preserve-existing`. The existing `1.17.7` draft uses `AFTER_APPROVAL`, so submitting it preserves automatic publication after Apple's approval. It does not require a separate release command. Future skeletons created by `prepare` use `MANUAL`, so their approved versions require `release`. Continue monitoring until the store reports public distribution.

Only iOS submit accepts `--release-policy manual` or `--release-policy after-approval` to explicitly change that behavior. Do not override the existing draft policy unless that policy change is authorized. The publishing workflow uses the preserve-existing default.

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
node scripts/store-publishing/cli.mjs android release \
  --version "$VERSION" --source-sha "$SOURCE_SHA" --network "$NETWORK" \
  --version-code "$VERSION_CODE" --confirm "$VERSION"
```

Upload leaves the exact code as an uncommitted production draft. Submit commits the edit and sends changes for review. **Commit can include all pending console changes**, not only the requested binary. `--allow-pending-changes` acknowledges that the complete pending set has been inspected and approved. An existing review causes an error rather than automatic cancellation.

Enable and verify managed publishing in Play Console when review and public release must be separate. The API does not provide the final managed-publishing "Publish changes" action. When `release` reports that console action is required, the publishing agent opens Play Console's Publishing overview through browser automation, inspects the complete ready-to-publish change set, and executes "Publish changes" when its whole scope is authorized. This browser step completes the end-to-end release. Do not promote a testing track as a substitute. A published lifecycle alone does not prove a full rollout; verify the production rollout and requested version code in the console.

## Monitor each transition

After each action, inspect its structured result and repeat read-only status for the exact version and build or code. Keep an active monitor while processing or review is pending, with its owner, expected source SHA, run ID where applicable, and next check recorded. An error, expired edit, review rejection, missing attestation or ambiguous store state needs inspection before another mutation. Verify all three public store results independently before calling a cross-store release complete.
