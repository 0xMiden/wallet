# Patches

Everything except `inspect-cli-cdp-fix.patch` is applied automatically by
`patch-package` from the `postinstall` script.

## @miden-sdk/miden-sdk 0.16.1

Treat the note transport's stored-note duplicate as a successful `SendNote`, so the
SDK removes the relay payload from its outbox. The transport sends it as headers
only: `grpc-status` 13 with `Failed to store note: ConstraintViolation("Unique
constraint violation: UNIQUE constraint failed: notes.id")`, or a future
`AlreadyExists` (6). This also drains entries already stranded by an earlier
duplicate rejection on the next sync. No response body is read, and every other
response passes through unchanged.

The patch covers both WASM fetch imports in all six single-threaded and
multithreaded bundles, including classic workers. The canonical helper is
`src/lib/miden/sdk/note-relay-fetch.mjs`; it is inlined because classic workers
cannot depend on a new module import. After editing it, regenerate with
`node scripts/generate-note-relay-patch.mjs`. Its `--check` flag verifies the
installed bundles, which postinstall built from the committed patch, and that the
patch lists only the six bundles; it never compares the patch text, because GNU and
BSD `diff` print the same edit differently. When `--check` reports a stale bundle after
a pull, reinstall the package (`rm -rf node_modules/@miden-sdk/miden-sdk && yarn install
--check-files`): patch-package cannot repair a bundle that already carries an older
relay patch. Updating the SDK requires checking these seams again.

A linked web-sdk build (`Web SDK PR: #N`, `scripts/dev-with-web-sdk-pr.sh`) installs a
`file:` source build the patch cannot apply to, so that build runs without the relay
fix. The CI action removes the patch before installing, since patch-package fails the
install under CI; locally patch-package only warns. `--check` and the tests that read
the installed bundles skip on a `file:` SDK dependency.

## inspect-cli-cdp-fix.patch

Fixes the "single-use" CDP bug in `@inspectdotdev/cli@2.1.1` where WebSocket
connections after the first one never get responses from webinspectord.

**Root causes fixed:**
1. URL-encoded pipe characters (`%7C`) in target IDs weren't decoded
2. Race condition: `unselectTarget()` tore down the session but didn't clear
   `activeTargetId`, so re-selection early-returned on a dead channel

**To apply** (after `npm install -g @inspectdotdev/cli`):
```bash
INSPECT_DIR=$(dirname $(which inspect))/../lib/node_modules/@inspectdotdev/cli
cd "$INSPECT_DIR" && patch -p0 < /path/to/patches/inspect-cli-cdp-fix.patch
```

**To verify:**
```bash
# Start inspect bridge and make multiple CDP calls
inspect --no-telemetry &
sleep 5
# These should ALL return 2 (before the patch, only the first would work)
for i in 1 2 3; do
  node -e "const ws=new(require('ws'))('ws://localhost:9222/devtools/page/...');ws.on('open',()=>ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:'1+1',returnByValue:true}})));ws.on('message',d=>{console.log(JSON.parse(d).result?.result?.value);ws.close()})"
done
```
