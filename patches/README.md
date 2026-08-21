# Patches

Everything except `inspect-cli-cdp-fix.patch` is applied automatically by
`patch-package` from the `postinstall` script.

## @openzeppelin+miden-multisig-client+0.16.0.patch

Makes the P2ID proposal builder pick the vault slot that can actually fund the
transfer, rather than the first slot matching the faucet.

In Miden 0.15 an asset's callback flag is part of its vault key, so one faucet
occupies a separate slot per flag and an account can hold both. The builder
already derives the outgoing asset from the vault (which is correct, and is the
same rule the wallet applies in `resolveHeldFungibleAsset`), but selected with
`.find()` on faucet id alone — so which flag the note carries was decided by
vault order. When the first slot could not cover the amount, the note was built
against it regardless and the kernel rejected the transfer with a shortfall,
even though the other slot held enough. Only reachable on a Guardian send with
no recall window, which is the one send path that goes through this builder.

The patch mirrors the wallet's own selection: prefer a slot that funds the
amount, fall back to the largest so the resulting error names the real
shortfall. `dist/` and `src/` are both patched, so a rebuild of the package
inside `node_modules` keeps the fix.

**Upstream:** should be fixed in OpenZeppelin/guardian
(`packages/miden-multisig-client`); this patch is a stopgap and should be
dropped once a release carries the equivalent change.

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
