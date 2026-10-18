# Bread Connect protocol, version 1

Bread Connect lets a native iOS or Android app use Bread as its wallet. The app switches to Bread with a request, the user approves it in Bread, and Bread switches back with the answer. There is no relay server: every message is end-to-end encrypted and carried in an https link that the operating system hands only to the app that owns its domain. This is the pattern of Phantom's deeplinks and of WalletConnect's Link Mode.

The requests and answers are the same objects the Miden wallet adapter exchanges with Bread's in-app browser (`MidenDAppRequest` and `MidenDAppResponse`), so Bread checks and approves them with the same rules and screens it uses for websites.

## Links

- **Bread's link** is `https://bread.miden.xyz/request`. Bread's iOS app (`LHU7B7J5WL.com.miden.bread`) and Android app (`com.miden.wallet`) are associated with `bread.miden.xyz`, so the system gives this link only to Bread.
- **The app's callback** is an https link on a domain the app owns, for example `https://wherelegendsgrow.com/bread`. The app's own association files (`apple-app-site-association` and `assetlinks.json` on that domain) give the link to the app. A callback is `https://`, a host and a path, at most 512 characters in all. The host is two or more dot-separated labels of lowercase letters, digits and hyphens (an internationalized name in its `xn--` form) whose last label is not a number (all digits, or `0x` and hex digits), and it is not `localhost` or under it. The path starts with `/` and holds only the RFC 3986 path characters `A-Z a-z 0-9 - . _ ~ ! $ & ' ( ) * + , ; = : @ /` and `%` followed by two hex digits, with no `.` or `..` segment, `%2e` spellings included. So a callback has no query, no fragment, no user info, no port and no IP address. The `callbacks` of the test vectors list callbacks every implementation accepts, with their origins, and ones each refuses.
- **The app's identity is its callback origin** (`https://wherelegendsgrow.com`). Bread shows it on every approval and keeps the app's permission under it, as it does for a website. The name the app sends is shown next to the origin, never instead of it.

## Message encoding

A message is a JSON object (an envelope) carried in the link's fragment, so a link that ends up in a browser never sends it to a server:

```
https://bread.miden.xyz/request#v=1&m=<base64url of the UTF-8 JSON envelope>
https://wherelegendsgrow.com/bread#v=1&m=<base64url of the UTF-8 JSON envelope>
```

- `v` is the protocol version, `1`. A receiver refuses any other version.
- base64url is RFC 4648 section 5 without padding, here and for every byte string inside an envelope.
- `m` is at most 524288 characters. A sender refuses to send anything longer, and a receiver drops it. When Bread's answer to a request would be longer, Bread answers a sealed `INTERNAL_ERROR` instead, and for a transaction its response with a `TRANSACTION_TIMEOUT` outcome, so the app still learns the transaction id.
- Request ids and session ids are 16 random bytes. Public keys are 32 bytes and nonces 12.

## Keys and encryption

The app makes a new X25519 key pair for each connection, and Bread makes a new X25519 key pair for each session.

1. `shared = X25519(own secret key, peer public key)`. An all-zero `shared` is refused.
2. `keys = HKDF-SHA256(ikm = shared, salt = "bread-connect/v1", info = "session" || appPublicKey || walletPublicKey, length = 64)`, where `||` joins the bytes and the strings are UTF-8.
3. The first 32 bytes are the app key, which seals what the app sends. The last 32 bytes are the wallet key, which seals what Bread sends.
4. A sealed payload is the UTF-8 JSON payload encrypted with AES-256-GCM under a random 12-byte nonce, with the UTF-8 string `bread-connect/v1|<type>|<session>|<id>` as additional data, where `<type>`, `<session>` and `<id>` are the envelope's fields. The envelope carries the nonce and the ciphertext with its 16-byte tag.

## Envelopes

### `connect`: app to Bread

Not sealed, because no keys exist yet, and nothing in it is secret.

```json
{
  "type": "connect",
  "id": "<request id>",
  "callback": "https://wherelegendsgrow.com/bread",
  "appPublicKey": "<32 bytes>",
  "request": { "type": "PERMISSION_REQUEST", "appMeta": { "name": "Where Legends Grow" }, "network": "testnet" }
}
```

`request` is the `MidenDAppPermissionRequest` the adapter sends to Bread's in-app browser.

### `connected`: Bread to app

Bread makes the session's key pair and session id, and answers a refused connection the same way, so the app can tell Bread's refusal from a forgery. Bread keeps a session only when the connection was approved.

```json
{ "type": "connected", "id": "<request id>", "session": "<session id>", "walletPublicKey": "<32 bytes>", "nonce": "<12 bytes>", "sealed": "<ciphertext>" }
```

The sealed payload is `{ "response": <MidenDAppPermissionResponse> }` or `{ "error": <error> }`.

### `request`: app to Bread

```json
{ "type": "request", "id": "<request id>", "session": "<session id>", "callback": "<the session's callback>", "nonce": "<12 bytes>", "sealed": "<ciphertext>" }
```

The sealed payload is `{ "request": <MidenDAppRequest>, "sentAt": <milliseconds since 1970> }`.

### `response`: Bread to app

```json
{ "type": "response", "id": "<request id>", "session": "<session id>", "nonce": "<12 bytes>", "sealed": "<ciphertext>" }
```

The sealed payload is `{ "response": <MidenDAppResponse> }` or `{ "error": <error> }`. The answer to a transaction request adds `"transaction": { "output": <TransactionOutput> }` or `"transaction": { "error": <error> }`, as described below.

### `error`: Bread to app, not sealed

Only when Bread holds no keys for the message: an unknown or expired session, an unsupported version or an envelope it cannot read.

```json
{ "type": "error", "id": "<request id, when readable>", "error": { "code": "SESSION_NOT_FOUND", "message": "..." } }
```

Anyone can open an app's callback link, so an app treats an unsealed error only as a reason to reconnect or to drop its pending request, never as Bread's answer to a request.

### Errors

An error is `{ "code": <code>, "message": <text for logs> }`. The codes are Bread's dApp error codes and the protocol's own:

| Code | Meaning |
| --- | --- |
| `NOT_GRANTED` | The user declined, or the app has no permission for the account. |
| `NOT_FOUND`, `INVALID_PARAMS`, `NETWORK_NOT_GRANTED` | As in Bread's in-app browser. |
| `UNSUPPORTED_METHOD` | The request type is not one of the methods below. |
| `INVALID_REQUEST` | The envelope or its payload is malformed. |
| `DUPLICATE_REQUEST` | The session already answered this request id. |
| `REQUEST_EXPIRED` | `sentAt` is more than 10 minutes old, or more than 1 minute ahead of Bread's clock. |
| `SESSION_NOT_FOUND` | Bread has no session with this id. Unsealed. |
| `UNSUPPORTED_VERSION` | `v` is not 1. Unsealed. |
| `TRANSACTION_FAILED`, `TRANSACTION_TIMEOUT` | Only in a transaction outcome. |
| `INTERNAL_ERROR` | Anything else. |

## Methods

A `request` envelope carries one of these `MidenDAppRequest` types: `SIGN_REQUEST`, `TRANSACTION_REQUEST`, `SEND_TRANSACTION_REQUEST`, `CONSUME_REQUEST`, `PRIVATE_NOTES_REQUEST`, `ASSETS_REQUEST`, `CONSUMABLE_NOTES_REQUEST`, `IMPORT_PRIVATE_NOTE_REQUEST` and `GUARDIAN_INFO_REQUEST`. `PERMISSION_REQUEST` travels only in `connect`. The app answers `GET_CURRENT_PERMISSION_REQUEST` from its session, and a disconnect only forgets the session in the app; the user removes the app's permission in Bread.

Bread finishes a transaction request (`TRANSACTION_REQUEST`, `SEND_TRANSACTION_REQUEST`, `CONSUME_REQUEST`) before it switches back: once the user approves, Bread proves and submits the transaction while it stays open, because a phone suspends a background app within seconds. The answer carries the transaction id and its outcome, which is what `waitForTransaction` returns, so the app answers `WAIT_FOR_TRANSACTION_REQUEST` for that transaction without switching to Bread again. `TRANSACTION_FAILED` means the transaction failed. An outcome Bread cannot return is `TRANSACTION_TIMEOUT`: one it did not learn within 5 minutes, and a transaction that landed without a result Bread can send. So an app never takes a transaction that may have landed for one that failed.

## What Bread does

- Refuses a version other than 1, and an envelope it cannot read or whose callback breaks the rules above.
- For `connect`: shows the callback origin and the app's name, and asks the user exactly as for a website's connection request.
- For `request`: answers an unknown session with an unsealed `SESSION_NOT_FOUND` to the envelope's callback. For a known session it answers only to the callback the session was made with, refuses a request id it has already answered (`DUPLICATE_REQUEST`) and a stale `sentAt` (`REQUEST_EXPIRED`), and asks the user exactly as for the same request from a website with the session's origin.
- Opens the callback with the answer only in an app the callback's domain verifies: on iOS with `universalLinksOnly`, and on Android by package, in an installed app that handles the link and whose signing certificate the callback domain's `assetlinks.json` names. Never a browser, a chooser, or an app the user picked as the domain's default. When no app takes the link, or the domain's `assetlinks.json` cannot be read, Bread tells the user and keeps nothing.
- Keeps a session until the user removes the app's permission in Bread or it goes unused for 30 days.

## What the app does

- Opens Bread's link through verified-link routing only: on iOS with `universalLinksOnly`, and on Android in the `com.miden.wallet` package whose signing certificate it checks.
- When Bread is not installed, opens Bread's page in the App Store (`https://apps.apple.com/app/id6789341854`) or in Google Play (`market://details?id=com.miden.wallet`, else `https://play.google.com/store/apps/details?id=com.miden.wallet`).
- Accepts an answer only for a request it sent and has not settled, and drops everything else.
- Waits 30 minutes for the answer to a request, because Bread may start answering up to 10 minutes after `sentAt` and then waits for the user's approval and, for a transaction, for its outcome.
- Keeps its session (session id, keys and the approved account) and any pending request in its private storage for that long, so an answer that relaunches the app after the system stopped it still lands.

## When Bread's link opens in a browser

`https://bread.miden.xyz/request` also serves a page, for a phone without Bread or an Android phone that has not verified Bread's link yet. On Android the page hands the same fragment to Bread through an intent link for `com.miden.wallet` that falls back to Google Play. On iOS it shows Bread's App Store page.

## Test vectors

`vectors/v1.json` fixes keys, nonces and ids, and lists the derived keys and the exact envelopes and links they produce, so Bread, the Capacitor adapter and the Swift and Kotlin SDKs all check the same bytes.
