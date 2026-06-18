# Patches

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
