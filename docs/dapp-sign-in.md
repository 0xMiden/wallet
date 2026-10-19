# Sign-in sheet for dApps in Bread

Google and Apple sign-in refuse to run inside embedded web views, so a dApp in the native Bread mobile browser can't run them in its own page. `window.bread.auth.open(url)` runs the flow in a secure sign-in sheet instead: the system's sign-in sheet on iOS, and an Auth Tab on Android when the selected browser supports it, otherwise a Custom Tab. The flow starts at a URL on the page's own origin and ends at Bread's callback address with that origin in its query, and the page stays loaded throughout.

```js
if (window.bread?.auth) {
  const result = await window.bread.auth.open(url);
  if (!result.cancelled) {
    const params = new URL(result.url).searchParams;
    const handle = params.get('login');
    const loginError = params.get('login_error');
  }
}
```

`open(url)` resolves to a frozen `{ url: string }` when the flow reaches Bread's callback address naming the page's origin (see "The callback"), with `url` set to the callback URL untouched, or to a frozen `{ cancelled: true }` when the user closes the sheet. It has no timeout, since a sign-in can take minutes. Bread reads only the `origin` parameter of the callback's query, so every other parameter name is yours; this guide puts a login handle in `login` and an error code in `login_error`.

`window.bread.auth` is a frozen `{ version: 1, open(url) }` and exists only in the main document of a supported native Bread WebView on iOS or Android. Detect it by its presence: `window.bread.version` stays 1 with or without it.

## Errors

`open` rejects with an `Error` whose message is exactly one of seven codes. The page script first refuses a `url` that isn't a string or is longer than 4096 characters with `AUTH_INVALID_URL`, before any native check, so on a page that isn't https that error comes before `AUTH_INSECURE_PAGE`. Bread then checks in this order and rejects with the first code that applies:

1. `AUTH_NOT_MAIN_FRAME`: the call came from a frame, not the main document.
2. `AUTH_INSECURE_PAGE`: the page isn't https with a host. `http://localhost` is refused too.
3. `AUTH_INVALID_URL`: `url` breaks one of the URL rules below.
4. `AUTH_BUSY`: a sheet is already open in Bread, for this page or another dApp.
5. `AUTH_UNAVAILABLE`: Bread can't show a sheet now, because the browser is hidden, parked or closing, Bread isn't in the foreground, or the system couldn't start or present the sheet.
6. `AUTH_ORIGIN_MISMATCH`: the flow reached the callback address, but its query doesn't name this page's origin in exactly one `origin` parameter (see "The callback"). The page never receives that callback URL.
7. `AUTH_FAILED`: anything else, such as a callback address with a path (`com.miden.wallet.auth://callback/`).

## Page rules

Call `open` from the main document of an https page. `window.bread` isn't defined in frames, and a frame that posts to the native transport directly gets `AUTH_NOT_MAIN_FRAME`.

`url` must be an absolute https URL on the page's own origin:

- It has 1 to 4096 characters, each from the RFC 3986 set `A-Z a-z 0-9 - . _ ~ : / ? # [ ] @ ! $ & ' ( ) * + , ; = %`. Percent-encode anything else in the path, query or fragment, such as a space, a backslash or a non-ASCII character.
- It starts with exactly `https://`, in lowercase: `HTTPS://` is refused.
- Next comes the page's host, written as the page's origin reports it, apart from ASCII letter case. For an internationalized domain, that is the punycode (`xn--`) form.
- Then, only if the page uses a port other than 443, comes `:` and that port as the page's origin shows it, such as `:8443`. Writing `:443` on a page that uses 443 is also accepted.
- Nothing else comes between `https://` and the first `/`, `?` or `#`, or the end of the URL: no user name and no percent-encoding.
- In the path, query and fragment, `%` appears only as `%` plus two hex digits, so a literal `%` is written `%25`, and `[`, `]` and any `#` after the first are percent-encoded as `%5B`, `%5D` and `%23`. Bread re-encodes nothing: the sheet opens exactly the string the page passed, or refuses it.
- It isn't relative: Bread refuses a relative URL and never resolves it.

The rules cover only the URL you pass; inside the sheet, the flow can redirect to Google or Apple as usual. Building the URL from `location.origin` gets the origin right, and `URLSearchParams` keeps the query inside the allowed characters, as the example under "Binding the handle to the page" does.

Only one sheet can be open across the whole app: a second call while one is open, from any dApp, gets `AUTH_BUSY` at once. The page must be visible in Bread, not parked, hidden or closing, and Bread must be in the foreground; otherwise `open` rejects with `AUTH_UNAVAILABLE` and no sheet appears over the wallet. On Android this means Bread's screen is active, so behind another app's dialog (such as a permission prompt) or while Bread is leaving the screen, `open` also rejects with `AUTH_UNAVAILABLE`.

## The callback

A navigation inside the sheet to `com.miden.wallet.auth://callback` ends the flow, whether it comes from a redirect, a refresh or a link the user taps. The address may end there or continue with `?` or `#`, and it matches regardless of ASCII case; any path, such as `callback/`, fails with `AUTH_FAILED`. Bread resolves `{ url }` only while its own sheet is open, only for that address, and only when the URL names the page that opened the sheet; it forwards the URL untouched, reads nothing from it but the `origin` parameter, and stores and logs nothing from it.

The callback names the page in exactly one `origin` query parameter: the page's origin, percent-encoded as a query value, such as `com.miden.wallet.auth://callback?origin=https%3A%2F%2Fexample.org&login=<handle>` for a page on example.org. Bread decodes the value's percent escapes once, keeping a `+` as a `+`, and compares it with the page that called `open` as the URL rules above compare the start of a URL: `https://` in lowercase, the page's host apart from ASCII letter case, `:` and the port only if the page uses a port other than 443 (`:443` is also accepted on a page that uses 443), and nothing after that, not even a `/`. The query is the text after the first `?` that comes before the first `#`, so an `origin` in the fragment doesn't count; parameter names are compared exactly as written, and a parameter without `=` has an empty value. A callback with no `origin`, more than one, or one naming another origin rejects with `AUTH_ORIGIN_MISMATCH`, and the page never receives its URL.

End the flow with a small page, served with `Cache-Control: no-store`, that refreshes to `com.miden.wallet.auth://callback?origin=<origin>&login=<handle>` (or with `login_error=<code>` in place of `login`) and also shows a "Return to Bread" link to the same address. Chrome on Android may refuse a redirect to an app that no tap started, as after Apple's script-submitted form post, and the link lets the user finish with a tap:

```html
<!doctype html>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="refresh" content="0; url=com.miden.wallet.auth://callback?origin=https%3A%2F%2Fexample.org&amp;login=HANDLE" />
<title>Return to Bread</title>
<a href="com.miden.wallet.auth://callback?origin=https%3A%2F%2Fexample.org&amp;login=HANDLE">Return to Bread</a>
```

The server writes the handle in place of `HANDLE`, and in place of `https%3A%2F%2Fexample.org` the exact origin of its own pages, percent-encoded, as `location.origin` gives it on those pages: the punycode host for an internationalized domain, and the port if it isn't 443. It takes that origin from its own configuration, never from the request, the auth URL or anything else the flow carries, because the origin is what keeps the handle from another site's page (see "Binding the handle to the page"). Make the handle, and any `login_error` code, a URL-safe token such as hex or base64url: it goes into the URL and the HTML as it is, and `searchParams.get` turns `+` into a space and decodes `%xx` escapes, so a standard base64 handle containing `+` would not redeem.

## Binding the handle to the page

On Android, callback delivery is private to Bread's launching activity when the selected browser supports Auth Tab. Other browsers use the existing Custom Tab, whose custom-scheme callback can be intercepted or injected: any installed app can also register the scheme and receive the real callback instead of Bread, or send Bread the callback address while a sheet is open, which Bread can't tell from the real one.

On both paths, a handle alone must never sign anyone in. Before calling `open`, keep a secret in the page's memory and put only its hash in the auth URL, like a PKCE challenge. The server stores that challenge with the flow and redeems a handle only together with the secret whose hash started it; each handle is single use and short-lived. A handle sent by another app then belongs to a flow the page never started, and a handle another app received is useless without the secret, which goes only from the page to your server.

The secret doesn't help when another site's page in Bread starts your flow itself: it can open a URL on its own origin that redirects to your sign-in with a challenge of its own, and your server can't tell, because a navigation the sheet starts reports `Sec-Fetch-Site: none` through every redirect. The `origin` your server writes into the callback is what stops it: Bread answers that page `AUTH_ORIGIN_MISMATCH` and never hands it the callback URL.

```js
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const verifier = hex(crypto.getRandomValues(new Uint8Array(32)));
const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
const url = new URL('/auth/start', location.origin);
url.searchParams.set('challenge', hex(new Uint8Array(digest)));

const result = await window.bread.auth.open(url.href);
const handle = !result.cancelled && new URL(result.url).searchParams.get('login');
if (handle) {
  await fetch('/auth/redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle, verifier })
  });
}
```

The server accepts `/auth/redeem` only when the handle is unused and recent, and the hex SHA-256 of `verifier` equals the challenge its flow started with. The sheet shares no cookies with the page: on both platforms Bread's in-app browser keeps its own cookie store, so a session cookie set inside the sheet never reaches the page, which signs in only by redeeming the handle.

## Platforms

- **iOS:** the sheet is a non-ephemeral `ASWebAuthenticationSession`, so it shares Safari's cookies and reuses a Google or Apple sign-in the user already has in Safari. iOS first shows its own prompt, such as "'Bread' Wants to Use 'example.org' to Sign In" for a page on example.org. Cancel on that prompt or in the sheet gives `{ cancelled: true }`.
- **Android:** the URL opens in an Auth Tab if the resolved browser supports it, otherwise in the existing Custom Tab, in Bread's own task with no prompt and sharing that browser's cookies. When the flow reaches the callback address, the tab closes and Bread comes back with the page still loaded. Closing the tab with X or Back gives `{ cancelled: true }`. A phone with no Custom Tabs provider, or an Auth Tab host without an activity-result registry, gets `AUTH_UNAVAILABLE`. If a browser advertises Auth Tab support but launch fails, Bread returns the existing error (`AUTH_UNAVAILABLE` for a missing activity, otherwise `AUTH_FAILED`) without retrying in a Custom Tab. Requests stay in memory: if Android ends Bread's process or recreates its activity while the tab is open, the old request and callback are dropped, nothing resolves, and the user signs in again.
- **Desktop:** Bread's desktop app defines an empty, frozen `window.bread`, with no `auth`, so a site can tell it runs inside Bread; a page's own top-level `bread` replaces it.
- **Extension:** the browser extension defines no `window.bread`.

## Native integration

The provider's `breadPresentation` option also installs the `breadAuth` transport before the first navigation, and the page script defines `window.bread.auth` only when that transport exists. The native checks are the only authority: Android's listener accepts every origin (`*`) and so appears in every frame, iOS reply handlers are visible to frames, and a page can call either transport directly. Native therefore applies the check order above itself, reading the main-frame flag and the page origin from the message. iOS `WKSecurityOrigin.port == 0` and Android `Uri.getPort() == -1` mean the default port, 443.

On iOS, `breadAuth` is a `WKScriptMessageHandlerWithReply` in the page content world. The page calls `window.webkit.messageHandlers.breadAuth.postMessage({ url })`, which returns a Promise. Native replies exactly once: `replyHandler(["url": s], nil)`, `replyHandler(["cancelled": true], nil)` or `replyHandler(nil, "AUTH_...")`.

On Android, `breadAuth` is a web message listener. The page calls `window.breadAuth.postMessage(JSON.stringify({ id, url }))`. Native replies once, on that message's `JavaScriptReplyProxy`, with the JSON string `{"id":id,"url":s}`, `{"id":id,"cancelled":true}` or `{"id":id,"error":"AUTH_..."}`. `id` is `<document token>_auth_<n>`; native ignores a message without a string `id` of 1 to 128 characters, because it can't address a reply.

Native remembers the page's origin from the open message, checks the callback rule and the `origin` parameter on the URL as it arrives, and forwards it byte for byte: it reads nothing else from the query and never stores or logs the URL. On iOS the session catches the `com.miden.wallet.auth` scheme itself, and the app doesn't register it. On Android, Auth Tab accepts a callback only through the launching activity's activity result; returning to the foreground clears Bread's paused state without cancelling a pending Auth Tab. Scheme callbacks arrive at a receiver that leaves an Auth Tab in flight untouched and otherwise hands them to Bread as before. `MainActivity` strips auth-scheme data from VIEW intents before any Capacitor plugin sees it; such an intent cannot settle an Auth Tab. Only the Custom Tab fallback accepts an intent callback and replies `{ cancelled: true }` on returning to the foreground without one, even when the tab closed too quickly for Android to stop Bread. Closing the browser or destroying its activity frees its sheet and unregisters its Auth Tab result callback; a later callback for that sheet resolves nothing.
