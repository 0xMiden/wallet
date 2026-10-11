# Fullscreen dApps in Bread

A dApp opened inside the native Bread mobile browser can request fullscreen presentation in its initial HTML head:

```html
<meta name="bread-display" content="fullscreen" />
<meta name="bread-ready" content="manual" />
<meta name="theme-color" content="#101010" />
```

Bread reads the head while it parses, then settles the metadata at `DOMContentLoaded`. Only the exact value `fullscreen` opts in. Without it, the ordinary browser layout remains. Without `bread-ready="manual"`, Bread sends readiness automatically at `DOMContentLoaded`.

For manual readiness, wait until the first correctly sized frame is ready before calling:

```js
if (window.bread?.version === 1) {
  await window.bread.presentation.ready();
}
```

`window.bread` and its `presentation` object are frozen. `ready()` and `close()` return `Promise<void>`, resolving only after native acknowledgement and rejecting on native refusal or a transport timeout. The API exists only in the main document of a supported native Bread WebView. A browser extension wallet object alone does not enable it.

Bread keeps a native logo capsule visible, labeled "Back to Bread", with an entry hint "Tap Bread to return". Native preparation allows 30 seconds of foreground time before offering Retry and Back to Bread. Background time does not consume that readiness budget. The API separately bounds unanswered transport requests to 30 seconds and 32 concurrent calls.

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

Emit plugin event `presentationChanged` with `{id, display: 'browser' | 'fullscreen'}`. The provider registers listeners before opening and records events against an existing session ID even before opening returns. Native visibility and resize handlers must preserve preparation, fullscreen layout, rotation, accessible controls, haptics, and reduced motion. The common script and provider do not implement those native capabilities.
