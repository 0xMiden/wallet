---
title: Fullscreen dApps in Bread
permalink: /developers/fullscreen/
---

# Fullscreen dApps in Bread

Part of the [Bread developer guide](../). This page is the detailed reference, including the native integration.

A dApp opened inside the native Bread mobile browser can request fullscreen presentation in its initial HTML head:

```html
<meta name="bread-display" content="fullscreen" />
<meta name="bread-ready" content="manual" />
<meta name="theme-color" content="#101010" />
```

Bread reads the head while it parses, applies the first valid presentation policy before a delayed application bundle finishes loading, and settles the metadata at `DOMContentLoaded`. Only the exact value `fullscreen` opts in. Without it, the ordinary browser layout remains. Without `bread-ready="manual"`, Bread sends readiness automatically at `DOMContentLoaded`.

For manual readiness, wait until the first correctly sized frame is ready before calling:

```js
if (window.bread?.presentation) {
  await window.bread.presentation.ready();
}
```

`window.bread` and its `presentation` object are frozen. `ready()` and `close()` return `Promise<void>`, resolving only after native acknowledgement and rejecting on native refusal or a transport timeout. The API exists only in the main document of a supported native Bread WebView. A browser extension wallet object alone does not enable it. Bread's desktop app defines an empty, frozen `window.bread`, so detect each capability by its presence. On mobile, `window.bread.auth` opens a secure sign-in sheet; see [the sign-in sheet guide](dapp-sign-in.md). Inside Bread on mobile, `window.bread` is a non-configurable property of the page's global object: a classic (non-module) script must not declare a top-level `bread` with `let`, `const`, `class`, `function` or `var`, a bundle must not expose a library global named `bread`, and assigning `window.bread` does nothing, or throws in strict mode. A `bread` declared in a module script, or inside the function a bundler wraps code in, is unaffected. On desktop the marker is writable and configurable, so a page's own top-level `bread` replaces it.

Fullscreen opens in the current portrait or landscape orientation and follows device rotation. Bread keeps a translucent native logo capsule visible, labeled "Back to Bread". Tap it once to minimize the page into Bread's standard parked-app view. Selecting that app again restores the same fullscreen document and session without a reload. Closing uses the same existing parked-app actions and switcher controls as every other app; no additional game-specific close control is introduced. Wallet confirmations, alerts, actions and locking temporarily suspend the page; dismissing the last overlay resumes the same session.

Native preparation allows 30 seconds of foreground time before offering Retry and Back to Bread. Background time does not consume that readiness budget. The API separately bounds unanswered transport requests to 30 seconds and 32 concurrent calls.

Closing allows five seconds of foreground preparation before showing Retry and Exit now. Retry starts a fresh close request; Exit now closes that page immediately if the prepared return cannot complete. Closing rejects that page's unanswered wallet confirmation and removes its saved session and preview; an already submitted transaction continues independently.

Older Android WebViews without the required navigation identity open the page in Bread's normal browser mode, with its ordinary toolbar.

Older hosts expose a scalar CSS pixel metric that reserves a complete row:

```css
.game-toolbar {
  padding-top: var(--bread-control-inset-top, 0px);
}
```

Current hosts also publish an optional occupied rectangle and safe-area insets in CSS pixels. Use the rectangle to place your header alongside Bread rather than reserving a full-width row. Backgrounds may extend to the display edge; interactive controls must respect the safe-area insets.

```ts
window.__breadPresentationState.controlBounds; // {left, top, width, height}
window.__breadPresentationState.safeAreaInsets; // {top, left, right, bottom}
```

The root has `data-bread-control-bounds="true"` only when the rectangle is valid. CSS receives `--bread-control-left`, `--bread-control-top`, `--bread-control-width`, `--bread-control-height`, and `--bread-safe-area-top`, `--bread-safe-area-left`, `--bread-safe-area-right`, `--bread-safe-area-bottom`. Keep the scalar fallback when the rectangle is unavailable. The persistent accessible Bread capsule remains the return affordance; there is no temporary hint covering the shared header.

Native layout updates the metrics after resizing, viewport scaling, safe-area changes and rotation. Preserve your ordinary responsive layout outside Bread and size the renderer from its actual container. Fullscreen content does not receive Bread's ordinary 96px browser toolbar padding.

Programmatic closure retains the native close API:

```js
if (window.bread?.presentation) {
  await window.bread.presentation.close();
}
```

## Native integration

The provider supplies `breadPresentation` only to mobile dApp opens, containing `script`, raw `logoSvg`, localized `backLabel`, `hintLabel`, `retryLabel`, `errorLabel`, and `readinessTimeoutMs: 30000`. The same option also installs the `breadAuth` transport behind `window.bread.auth`, described in [the sign-in sheet guide](dapp-sign-in.md#native-integration). Callers omitting this option retain the plugin's existing behavior.

Install `script` at document start for the main document. The dedicated `breadPresentation` transport receives a JSON string from both iOS `window.webkit.messageHandlers.breadPresentation.postMessage` and Android `window.breadPresentation.postMessage`:

```ts
interface PresentationMessage {
  token: string;
  type: 'configure' | 'ready' | 'close';
  requestId?: string;
  display?: 'browser' | 'fullscreen';
  manualReady?: boolean;
  themeColor?: string;
}
```

`configure` has no request ID. API calls, including automatic readiness, carry an ID. Reply by evaluating `window.__breadPresentationRespond({token, requestId, ok, error?})`. A wrong document token, unknown request ID, or malformed acknowledgement is ignored.

Apply native-confirmed presentation with `window.__breadPresentationUpdate({token, display, controlInsetTop, controlBounds?, safeAreaInsets?})`. Every optional field must be a finite nonnegative number; malformed optional objects are omitted without rejecting a valid legacy inset. The state and its geometry objects are independently frozen snapshots. Browser mode and legacy-only updates clear additive CSS metrics and the rectangle attribute. The public API remains version 1. Updates require the current token, a supported display, and a finite nonnegative inset. They update a frozen `window.__breadPresentationState` object and dispatch the document event `breadpresentationchange`, which refreshes the wallet injection's padding policy. Reinjection preserves the document token and public API.

Native handlers must validate main-frame provenance and compare `token` with `window.__breadPresentationToken`, then recheck their navigation generation after asynchronous evaluation. The current document may close its originating native session, including while hidden. iOS retains an eligible fullscreen key window with its privacy cover opaque when resigning active, preserving its system snapshot ownership, then refreshes it during `willEnterForeground`; Android retains an eligible covered fullscreen dialog across pause. Eligibility requires the same ready, previously revealed document, current policy acknowledgement and host desired visibility. Host overlays, parked pages, navigation replacement and closure never inherit retained ownership. Active resume still invalidates layout and waits for fresh page paint before removing the cover. Only foreground-eligible instances may reveal; hidden requests cannot change another session. Presentation does not pass through wallet or account permission dispatch.

Emit plugin event `presentationChanged` with `{id, display: 'browser' | 'fullscreen', policyResolved, policyRevision, managedHostCloseToken}`. The provider registers listeners before opening and records events against an existing session ID even before opening returns. Reject events from an old instance lifetime or a superseded policy revision. While policy is unresolved, keep the launcher mounted and the ordinary browser slot measurable but inactive. Before showing a resolved page, commit its host layout, await native bounds, and acknowledge that policy revision through the lifetime-bound `setVisible` call.

Every managed visibility command carries the instance lifetime and a monotonically increasing `visibilitySequence`; a show also acknowledges the current `policyRevision`. Reject stale commands so a delayed popup dismissal cannot reveal a replaced or closed instance. Native visibility and resize handlers preserve preparation, fullscreen layout, rotation, accessible controls, haptics, and reduced motion.

Managed close emits `hostCloseRequested` and accepts `completeManagedClose` only for the matching lifetime and request. Prepare the retained launcher or current legitimate destination, then complete from its committed host layout. Native paint fences precede normal dismissal. Reserve the session ID until both native terminal acknowledgement and its serialized storage cleanup finish; late callbacks cannot recreate it. These host fields are internal integration details, separate from the webpage API above.

Native Bread capsule taps emit `presentationMinimizeRequested` with the current instance ID, policy revision, acknowledged visibility sequence and managed instance lifetime. The provider validates the current visible stay and routes the request through its standard `park()` path. Deferred snapshot completion cannot minimize a newer restore or a session whose confirmation, lock or overlay has since taken ownership. Each awaited side effect rechecks that authority; an old event cannot park the same document after it has been restored. It retains the native instance, document token, presentation policy and saved session. Selecting an existing app uses the existing restore/dedup path and fresh native paint fences. The capsule does not close the document or independently hide its window. `presentation.close()` and existing standard parked-app close controls keep terminal close semantics.
