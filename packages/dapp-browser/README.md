# @miden/dapp-browser

Vendored Capacitor plugin powering the embedded dApp browser in the Miden
Wallet. Forked from [`@capgo/inappbrowser`](https://github.com/Cap-go/capacitor-inappbrowser)
**8.0.6** with the following Miden-specific changes:

- **iOS `PassThroughView.hitTest`**: explicitly forwards out-of-rect touches
  to `window.rootViewController?.view` so the wallet's React capsule, tabbar
  and bubble overlay remain interactive while a positioned dApp webview is
  open. iOS 17+ no longer falls through automatically when a modal view's
  `hitTest` returns nil.
- **iOS `WKWebViewController.takeSnapshotData(scale:quality:completion:)`** —
  new helper that wraps `WKSnapshotConfiguration + jpegData` and resolves
  to a base64 data URL.
- **iOS `InAppBrowserPlugin.snapshot(_:)`** — new `@objc` plugin method
  exposing the snapshot helper to JS. Used by the embedded dApp browser to
  freeze a preview onto each minimized bubble.
- **iOS `InAppBrowserPlugin.close(_:)`** — moved `call.resolve()` and the
  `webViewController = nil` clearing INTO the dismiss completion handler so
  callers awaiting close are guaranteed a fully torn-down state.
- **iOS `WKWebViewController` setup** — `webView.scrollView.delaysContentTouches = false`
  for snappier capsule + bubble taps.
- **Android `WebViewDialog.takeSnapshotData(scale, quality)`** — Bitmap +
  Canvas snapshot path mirroring the iOS one.
- **Android `InAppBrowserPlugin.snapshot(call)`** — `@PluginMethod` wrapper.

The plugin is consumed via:

```ts
import { InAppBrowser, ToolBarType } from '@miden/dapp-browser';
```

The JS plugin id remains `InAppBrowser` for runtime compatibility — no
JS-side rename was needed when forking. The npm package and SPM library
names are the only things that changed (`@capgo/inappbrowser` →
`@miden/dapp-browser`, `CapgoInappbrowser` → `MidenDappBrowser`).
