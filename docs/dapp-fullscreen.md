# Fullscreen dApps in Bread

A dApp opened inside the native Bread mobile browser can request fullscreen presentation in its initial HTML head:

```html
<meta name="bread-display" content="fullscreen" />
<meta name="bread-ready" content="manual" />
<meta name="theme-color" content="#101010" />
```

Bread reads the head while it parses, applies the first valid presentation policy before a delayed application bundle finishes loading, and settles the metadata at `DOMContentLoaded`. Only the exact value `fullscreen` opts in. Without it, the ordinary browser layout remains. Without `bread-ready="manual"`, Bread sends readiness automatically at `DOMContentLoaded`.

For manual readiness, wait until the first correctly sized frame is ready before calling:

```js
if (window.bread?.version === 1) {
  await window.bread.presentation.ready();
}
```

`window.bread` and its `presentation` object are frozen. `ready()` and `close()` return `Promise<void>`, resolving only after native acknowledgement and rejecting on native refusal or a transport timeout. The API exists only in the main document of a supported native Bread WebView. A browser extension wallet object alone does not enable it.

Fullscreen opens in the current portrait or landscape orientation and follows device rotation. Bread keeps a translucent native logo capsule visible, labeled "Back to Bread", with an entry hint "Tap Bread to return". Tap it once to close the page and return to the retained dApp browser. Wallet confirmations, alerts, actions and locking temporarily suspend the page; dismissing the last overlay resumes the same session.

Native preparation allows 30 seconds of foreground time before offering Retry and Back to Bread. Background time does not consume that readiness budget. The API separately bounds unanswered transport requests to 30 seconds and 32 concurrent calls.

Closing allows five seconds of foreground preparation before showing Retry and Exit now. Retry starts a fresh close request; Exit now closes that page immediately if the prepared return cannot complete. Closing rejects that page's unanswered wallet confirmation and removes its saved session and preview; an already submitted transaction continues independently.

Older Android WebViews without the required navigation identity open the page in Bread's normal browser mode, with its ordinary toolbar.

Reserve room for the native control with Bread's live CSS pixel metric:

```css
.game-toolbar {
  padding-top: var(--bread-control-inset-top, 0px);
}
```

Native layout updates the metric after resizing and rotation. Preserve your ordinary responsive layout outside Bread and size the renderer from its actual container. Fullscreen content does not receive Bread's ordinary 96px browser toolbar padding.

An in-game exit can use the native close API:

```js
if (window.bread?.version === 1) {
  await window.bread.presentation.close();
}
```

## Native integration

The provider supplies `breadPresentation` only to mobile dApp opens, containing `script`, raw `logoSvg`, localized `backLabel`, `hintLabel`, `retryLabel`, `errorLabel`, and `readinessTimeoutMs: 30000`. Callers omitting this option retain the plugin's existing behavior.

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

Apply native-confirmed presentation with `window.__breadPresentationUpdate({token, display, controlInsetTop})`. Updates require the current token, a supported display, and a finite nonnegative inset. They update a frozen `window.__breadPresentationState` object and dispatch the document event `breadpresentationchange`, which refreshes the wallet injection's padding policy. Reinjection preserves the document token and public API.

Native handlers must validate main-frame provenance and compare `token` with `window.__breadPresentationToken`, then recheck their navigation generation after asynchronous evaluation. The current document may close its originating native session, including while hidden. Only foreground-eligible instances may reveal; hidden requests cannot change another session. Presentation does not pass through wallet or account permission dispatch.

Emit plugin event `presentationChanged` with `{id, display: 'browser' | 'fullscreen', policyResolved, policyRevision, managedHostCloseToken}`. The provider registers listeners before opening and records events against an existing session ID even before opening returns. Reject events from an old instance lifetime or a superseded policy revision. While policy is unresolved, keep the launcher mounted and the ordinary browser slot measurable but inactive. Before showing a resolved page, commit its host layout, await native bounds, and acknowledge that policy revision through the lifetime-bound `setVisible` call.

Every managed visibility command carries the instance lifetime and a monotonically increasing `visibilitySequence`; a show also acknowledges the current `policyRevision`. Reject stale commands so a delayed popup dismissal cannot reveal a replaced or closed instance. Native visibility and resize handlers preserve preparation, fullscreen layout, rotation, accessible controls, haptics, and reduced motion.

Managed close emits `hostCloseRequested` and accepts `completeManagedClose` only for the matching lifetime and request. Prepare the retained launcher or current legitimate destination, then complete from its committed host layout. Native paint fences precede normal dismissal. Reserve the session ID until both native terminal acknowledgement and its serialized storage cleanup finish; late callbacks cannot recreate it. These host fields are internal integration details, separate from the webpage API above.
