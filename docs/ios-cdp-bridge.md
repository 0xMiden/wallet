# iOS WebView CDP Bridge

Debug the Capacitor WKWebView on an iOS simulator by evaluating JavaScript remotely — access DOM, computed styles, console output, network state, and in-page errors. More useful than screenshots when you need to understand _why_ pixels look wrong, or to inspect state the UI doesn't expose.

## When to use which tool

- **mobile-mcp / `xcrun simctl io booted screenshot`**: iOS-level view. What the user sees after final compositing, native a11y tree, multi-window state.
- **CDP bridge (this doc)**: WebView-level view. DOM, computed CSS, console, network, arbitrary JS evaluation against a single WebView.

They are not redundant. A surprising pixel gets a screenshot first, then a CDP `getComputedStyle` query on the element under the unexpected pixel.

## Prerequisites

One-time per machine:

1. `npm install -g @inspectdotdev/cli` — provides the `inspect` binary.
2. `inspect login` — OAuth, can't be automated. Without this, the bridge refuses to start.
3. Make sure the Capacitor host WebView is inspectable. It is by default in debug builds. dApp inappbrowser instances need `isInspectable: true` on their open call (see `packages/dapp-browser/.../DappBrowserProvider.openInternal`).

## Per-session bringup

```bash
# 1. Boot the simulator and launch the app (e.g. via yarn mobile:ios:run).

# 2. Kill any old bridge and free ports.
pkill -9 -f "^inspect" 2>/dev/null
lsof -ti:9221,9222 | xargs kill -9 2>/dev/null

# 3. Start the bridge.
nohup inspect --no-telemetry > /tmp/inspect.log 2>&1 &
sleep 5   # give it time to discover devices

# 4. Smoke test.
curl -s http://localhost:9222/json/version
```

`inspect` listens on:
- `:9221` — device list (`curl http://localhost:9221/json` enumerates inspectable WebViews)
- `:9222` — CDP endpoint for the first WebKit page

## Usage

Connect any CDP client (websocket to `ws://localhost:9222/devtools/page/<target-id>`) and send `Runtime.evaluate` calls.

### Set up an error trap before exercising flows

```javascript
window.__cdp_errors = [];
window.addEventListener('error', e => window.__cdp_errors.push(e.message));
window.addEventListener('unhandledrejection', e =>
  window.__cdp_errors.push('REJECTION: ' + (e.reason?.message || e.reason))
);
```

Then later read back `JSON.stringify(window.__cdp_errors)` to catch async failures that would otherwise disappear.

### Common queries

- `document.title`
- `getComputedStyle(document.querySelector('selector')).propertyName`
- `(window.__TEST_STORE__ || window.__TEST_INTERCOM__)` — wallet test hooks (only when built with `MIDEN_E2E_TEST=true`)
- `chrome.storage.local.get()` — not available; the mobile build has no SW. Query IndexedDB directly instead.

## Recovery

| Symptom | Fix |
|---|---|
| `inspect` refuses to start, says "login required" | `inspect login` (interactive, one-time) |
| `/json` returns `[]` on 9221 | App crashed or not inspectable. Relaunch the app; confirm `isInspectable: true` for custom WebViews. |
| WebView not listed after `yarn mobile:ios:run` | PID changed. Restart step 2–3 above. |
| Nothing works | Quit Simulator.app entirely (`osascript -e 'tell application "Simulator" to quit'`), cold-boot the device, restart from step 1. |

## Limits of CDP — what you still need native tooling for

CDP sees one WebView at a time and can't see anything above the web layer:

- **UIWindow z-order** — CDP can't see which window iOS hit-tests first. Use `xcrun simctl` and the native a11y tree.
- **CALayer transforms, masks, opacity** set from native iOS code.
- **UIWindow frame in screen coordinates** (e.g. the dApp browser host window).
- **Multi-WebView composition** — the bridge picks the first WebKit page it finds. If both the host and a dApp are open, you have to switch between them. Use `curl http://localhost:9221/json` to list all, then connect to the right target ID.
- **Touch routing through `PassThroughView` / `hitTest` overrides.**

## Known-good patched state

The `@inspectdotdev/cli@2.1.1` package historically had a single-use bug that broke the second-and-subsequent CDP sessions for the same target. If you observe "messages sent but device never responds" after a clean disconnect, that bug has returned (likely after an `npm install -g` overwrote local patches). See an engineer with access to the original patch notes, or file at https://github.com/inspectdev/inspect-issues.
