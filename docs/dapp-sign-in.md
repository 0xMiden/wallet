# Sign-in sheet for dApps in Bread

Google and Apple sign-in refuse to run inside embedded web views, so a dApp in the native Bread mobile browser can't run them in its own page. `window.bread.auth.open(url)` runs the flow in a secure sign-in sheet instead: the system's sign-in sheet on iOS, and a Custom Tab on Android. The flow starts at a URL on the page's own origin and ends at Bread's callback address, and the page stays loaded throughout.

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

`open(url)` resolves to a frozen `{ url: string }` when the flow reaches Bread's callback address, with `url` set to the callback URL untouched, or to a frozen `{ cancelled: true }` when the user closes the sheet. It has no timeout, since a sign-in can take minutes. Bread never reads the callback's query, so its parameter names are yours; this guide puts a login handle in `login` and an error code in `login_error`.

`window.bread.auth` is frozen and exists only in the main document of a supported native Bread WebView on iOS or Android. Detect it by its presence: `window.bread.version` stays 1 with or without it.

## Errors

`open` rejects with an `Error` whose message is exactly one of six codes. The page script first refuses a `url` that isn't a string or is longer than 4096 characters with `AUTH_INVALID_URL`, before any native check, so on a page that isn't https that error comes before `AUTH_INSECURE_PAGE`. Bread then checks in this order and rejects with the first code that applies:

1. `AUTH_NOT_MAIN_FRAME`: the call came from a frame, not the main document.
2. `AUTH_INSECURE_PAGE`: the page isn't https with a host. `http://localhost` is refused too.
3. `AUTH_INVALID_URL`: `url` breaks one of the URL rules below.
4. `AUTH_BUSY`: a sheet is already open in Bread, for this page or another dApp.
5. `AUTH_UNAVAILABLE`: Bread can't show a sheet now, because the browser is hidden, parked or closing, Bread isn't in the foreground, or the system couldn't start or present the sheet.
6. `AUTH_FAILED`: anything else, such as a callback address with a path (`com.miden.wallet.auth://callback/`).

## Page rules

Call `open` from the main document of an https page. `window.bread` isn't defined in frames, and a frame that posts to the native transport directly gets `AUTH_NOT_MAIN_FRAME`.

`url` must be an absolute https URL on the page's own origin:

- It has 1 to 4096 characters, each from the RFC 3986 set `A-Z a-z 0-9 - . _ ~ : / ? # [ ] @ ! $ & ' ( ) * + , ; = %`. Percent-encode anything else, such as a space, a backslash or a non-ASCII character.
- Its scheme is exactly lowercase `https`: `HTTPS://` is refused.
- Its host is written exactly as the page's own host, apart from ASCII letter case. A percent-encoded host never matches, and a site on an internationalized domain writes the punycode (`xn--`) form, which is what its page origin reports.
- Its port is the page's port, where an absent port means 443.
- It has no userinfo, such as `user@`, before the host.
- It isn't relative: Bread refuses a relative URL and never resolves it.

The rules cover only the URL you pass; inside the sheet, the flow can redirect to Google or Apple as usual. Building the URL from `location.origin` gets the origin right, and `URLSearchParams` keeps the query inside the allowed characters, as the example under "Binding the handle to the page" does.

Only one sheet can be open across the whole app: a second call while one is open, from any dApp, gets `AUTH_BUSY` at once. The page must be visible in Bread, not parked, hidden or closing, and Bread must be in the foreground; otherwise `open` rejects with `AUTH_UNAVAILABLE` and no sheet appears over the wallet.

## The callback

A navigation inside the sheet to `com.miden.wallet.auth://callback` ends the flow, whether it comes from a redirect, a refresh or a link the user taps. The address may end there or continue with `?` or `#`, and it matches regardless of ASCII case; any path, such as `callback/`, fails with `AUTH_FAILED`. Bread resolves `{ url }` only while its own sheet is open and only for that address, forwards the URL untouched, and reads, stores and logs nothing from it.

End the flow with a small page, served with `Cache-Control: no-store`, that refreshes to `com.miden.wallet.auth://callback?login=<handle>` (or `?login_error=<code>`) and also shows a "Return to Bread" link to the same address. Chrome on Android may refuse a redirect to an app that no tap started, as after Apple's script-submitted form post, and the link lets the user finish with a tap:

```html
<!doctype html>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="refresh" content="0; url=com.miden.wallet.auth://callback?login=HANDLE" />
<title>Return to Bread</title>
<a href="com.miden.wallet.auth://callback?login=HANDLE">Return to Bread</a>
```

The server writes the handle in place of `HANDLE`.

## Binding the handle to the page

On Android, any installed app can send Bread the callback address while a sheet is open, and Bread can't tell it from the real one. So a handle alone must never sign anyone in. Before calling `open`, keep a secret in the page's memory and put only its hash in the auth URL, like a PKCE challenge. The server stores that challenge with the flow and redeems a handle only together with the secret whose hash started it; each handle is single use and short-lived. A handle sent by another app then belongs to a flow the page never started, and a leaked handle is useless without the secret, which goes only from the page to your server.

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

The server accepts `/auth/redeem` only when the handle is unused and recent, and the hex SHA-256 of `verifier` equals the challenge its flow started with.

## Platforms

- **iOS:** the sheet is a non-ephemeral `ASWebAuthenticationSession`, so it shares Safari's cookies and reuses a Google or Apple sign-in the user already has in Safari. iOS first shows its own prompt, such as "'Bread' Wants to Use 'example.org' to Sign In" for a page on example.org. Cancel on that prompt or in the sheet gives `{ cancelled: true }`.
- **Android:** the URL opens in a Custom Tab in Bread's own task, with no prompt, sharing the browser's cookies. When the flow reaches the callback address, the tab closes and Bread comes back in the same task with the page still loaded. Closing the tab with X or Back gives `{ cancelled: true }`. A phone with no browser that supports Custom Tabs gets `AUTH_UNAVAILABLE`. If Android ends Bread's process while the tab is open, Bread drops the callback when it restarts, nothing resolves, and the user signs in again.
- **Desktop:** Bread's desktop app defines an empty, frozen `window.bread`, with no `auth`, so a site can tell it runs inside Bread.
- **Extension:** the browser extension defines no `window.bread`.

## Native integration

The provider's `breadPresentation` option also installs the `breadAuth` transport before the first navigation, and the page script defines `window.bread.auth` only when that transport exists. The native checks are the only authority: Android's listener accepts every origin (`*`) and so appears in every frame, iOS reply handlers are visible to frames, and a page can call either transport directly. Native therefore applies the check order above itself, reading the main-frame flag and the page origin from the message. iOS `WKSecurityOrigin.port == 0` and Android `Uri.getPort() == -1` mean the default port, 443.

On iOS, `breadAuth` is a `WKScriptMessageHandlerWithReply` in the page content world. The page calls `window.webkit.messageHandlers.breadAuth.postMessage({ url })`, which returns a Promise. Native replies exactly once: `replyHandler(["url": s], nil)`, `replyHandler(["cancelled": true], nil)` or `replyHandler(nil, "AUTH_...")`.

On Android, `breadAuth` is a web message listener. The page calls `window.breadAuth.postMessage(JSON.stringify({ id, url }))`. Native replies once, on that message's `JavaScriptReplyProxy`, with the JSON string `{"id":id,"url":s}`, `{"id":id,"cancelled":true}` or `{"id":id,"error":"AUTH_..."}`. `id` is `<document token>_auth_<n>`; native ignores a message without a string `id` of 1 to 128 characters, because it can't address a reply.

Native checks the callback rule on the URL as it arrives and forwards it byte for byte: it never parses its query, stores it or logs it. On iOS the session catches the `com.miden.wallet.auth` scheme itself, and the app doesn't register it. On Android, `MainActivity` takes the callback out of the intent before any Capacitor plugin sees it; a stop then a resume without a callback replies `{ cancelled: true }`, and a pause alone never does. Closing the browser frees its sheet, and a later callback for that sheet resolves nothing.
