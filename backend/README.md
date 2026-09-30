# Miden Wallet backend

A small Node server for the wallet. It keeps secrets that the wallet must not hold. It has two jobs:

1. It creates Transak Buy widget sessions. The Transak Create Widget URL API needs a partner access token. The token
   needs the API secret, so the wallet cannot make the call itself.
2. It tracks each buy order, and it relays the bridge of the bought token to Miden. The relayer pays the Sepolia gas.
   The user signs an EIP-7702 Calibur batch (approve + Agglayer `bridgeAsset`), and the relayer sends it.
   The job stops when the relay transaction is mined (state `deposited`). The wallet reads the Agglayer indexer for
   the claim on Miden.

## Environment

Copy `.env.example` to `.env` and set the values. The server checks the values at start and stops if one is wrong.

| Key | Required | Default |
| --- | --- | --- |
| `TRANSAK_API_KEY` | yes | |
| `TRANSAK_API_SECRET` | yes | |
| `TRANSAK_ENV` | no | `staging`; `production` is rejected until a production bridge exists |
| `TRANSAK_REFERRER_DOMAIN` | no | `com.miden.bread` (the app bundle ID / package name) |
| `PORT` | no | `8787` |
| `ALLOWED_ORIGINS` | no | `*` (all origins) |
| `TRUSTED_PROXIES` | no | Empty; explicit proxy IP addresses or CIDR ranges, separated by commas |
| `MAX_FIAT_AMOUNT_USD` | no | `10000` |
| `RELAYER_PRIVATE_KEY` | yes | The Sepolia key that pays gas (`0x` + 64 hex) |
| `SEPOLIA_RPC_URL` | no | `https://ethereum-sepolia-rpc.publicnode.com` |
| `DB_PATH` | no | `./data/onramp.sqlite` |
| `WORKER_INTERVAL_MS` | no | `10000` |
| `TRANSAK_PUSHER_KEY` | no | `1d9ffac87de599c61283` (the Transak Pusher app) |
| `TRANSAK_PUSHER_CLUSTER` | no | `ap2` |
| `TRANSAK_POLL_INTERVAL_MS` | no | `60000` (minimum `10000`) |

Token addresses and decimals are fixed in `src/tokens.ts`, by chain ID. Ethereum mainnet uses USDC
with 6 decimals. The current Sepolia backend uses the Transak staging token (TRNSK) with 18 decimals.
The order API reads these values from the map; orders do not store them.
This schema requires a new database file. Startup does not migrate an old database.

The orders are in SQLite (`node:sqlite`, Node 22). Node prints an `ExperimentalWarning` for it at start. This is
expected.

## Run

```bash
cd backend
yarn install
cp .env.example .env   # then set the values
yarn dev               # watch mode
yarn build
yarn start
yarn typecheck && yarn test
curl localhost:8787/health
```

## Docker

Run these commands from `backend/`. Create `.env` from `.env.example` and set the Transak credentials and the
dedicated Sepolia relayer key before starting the service.

```bash
docker compose up -d --build
docker compose logs -f backend
curl http://localhost:8787/health
```

The image compiles TypeScript and runs JavaScript with Node 22.23.2 as the `node` user. Runtime dependencies are
installed from `yarn.lock`. The build context excludes environment files, local dependencies, tests and databases.
The root filesystem is read-only. `/tmp` is temporary writable storage. Secrets come from `.env` at runtime and
are not part of the image. Restrict access to this file on the host.

Compose sets `PORT=8787` and `DB_PATH=/data/onramp.sqlite`, even if `.env` contains other values. The named volume
`miden-wallet-backend_backend-data` mounts at `/data`. It stores the order database, its WAL files and the instance
lock file. Docker creates the volume on first use with permissions for the image's `node` user. Keep the Compose
project name unchanged so later deployments use the same volume. Existing host data in `backend/data/` is not
imported automatically. A volume with existing files must permit UID 1000 to read and write them.

`docker compose down`, restart, image rebuild and container replacement preserve this volume.
**`docker compose down -v` deletes the volume and all stored orders.** Do not use it for routine updates.

The HTTP port binds to host loopback only. Use an HTTPS reverse proxy for remote access. Set `TRUSTED_PROXIES` to
the actual proxy IP addresses or its dedicated network range. A proxy in another container is not a loopback peer.
The proxy must replace untrusted forwarded headers. Set `ALLOWED_ORIGINS` for the wallet surfaces that call the API.
For a physical phone during development, change the host bind address to a reachable interface and set the wallet's
`BACKEND_URL` to that address. The Android emulator can use `http://10.0.2.2:8787`.

The container needs outbound HTTPS for Transak, the Sepolia RPC and the staging public-IP lookup, plus secure
WebSocket access for Pusher. `/health` checks HTTP response only; it does not confirm worker progress or external
service availability. Compose restarts an exited process but does not restart a process only because it is unhealthy.

### Development

```bash
docker compose -f compose.yaml -f compose.dev.yaml up --build
```

This configuration mounts `src/` read-only and restarts Node when source files change. Dependencies stay inside
the image; rebuild after changing `package.json` or `yarn.lock`. It uses the same data volume as the base configuration.
Do not run both configurations at the same time.

To test the built image with dummy credentials and no external network access:

```bash
docker build -t miden-wallet-backend:local .
yarn test:docker
```

The test uses a separate temporary volume. It checks health, the runtime user, rejection of a second instance,
graceful shutdown, order persistence after container replacement, and recovery after a forced stop. It removes
only its own container and volume when it finishes.

### Updates and shutdown

Run one server per database and dedicate its relayer key to that database. Startup takes an exclusive SQLite lock
in `/data/onramp.sqlite.lock.sqlite` before opening the order database. A second server using the same database
path exits. This lock works across containers that share the directory on local storage. Do not use a network
filesystem, delete the lock file, or mount only the database file. Separate volumes cannot coordinate use of the
same relayer key.

On `SIGTERM` or `SIGINT`, the server stops accepting connections and feed events. It stops new worker operations,
waits for active HTTP requests and the active order operation, then closes SQLite and releases the instance lock.
Other queued orders resume after restart. Shutdown has a 30-second deadline; Compose allows 40 seconds before a
forced stop. A forced exit releases the operating-system lock. Stored relay bytes permit recovery after restart.
Unsigned checkout challenges and rate limits are held in memory; a restart clears them. A pending challenge must
be requested again.

For an update, build first, stop the old instance, then start the replacement:

```bash
docker compose build
docker compose stop backend
docker compose up -d --no-build
```

### Backup and restore

A volume preserves data across container replacement; it does not protect against host disk failure. Store backups
on a separate system with restricted access. The database can contain signed relay transactions.

For a consistent offline backup, stop the server and copy the whole data directory. Run from `backend/`:

```bash
docker compose stop backend
mkdir -p backups
docker compose run --rm --no-deps -T backend tar -C /data -czf - . > backups/onramp.tar.gz
docker compose up -d --no-build
```

Choose a new backup filename for each backup. To restore into an empty data volume, stop the server, then run:

```bash
docker compose run --rm --no-deps -T backend tar -C /data -xzf - < backups/onramp.tar.gz
docker compose up -d --no-build
```

Do not extract over an active or nonempty database directory. Check the backup and the target volume before restore.
An older backup can omit transactions sent after it was made. Reconcile those transactions and relayer nonces before
resuming the worker. Test recovery in an isolated environment without external network access first.

## Layout

```
src/
├── server.ts        # entry: builds the clients, the worker and the app
├── app.ts           # Express app: middleware, routers, 404, error handler
├── config.ts        # environment parse
├── log.ts           # JSON log lines
├── miden-account.ts # Miden account ID format
├── http/            # routers (transak-routes, order-routes), CORS, rate limit, errors, client IP
├── transak/         # Transak API client, Pusher feed, signed challenge, user IP (staging only)
├── chain-testnet/   # testnet only: Sepolia client, Calibur batch, Agglayer bridge calls, prepare, signature checks
├── orders/          # order states, SQLite store, Transak sync, state machine (advance), worker
└── test/            # test helpers
```

Each test file is next to its source file. `chain-testnet/` is testnet code: mainnet does not bridge through Agglayer
from Sepolia.

## Routes

All errors are JSON: `{ "error": string }`.

- `GET /health` returns `{ "ok": true }`.
- `POST /transak/challenge` with `{ evmAddress, fiatAmount, midenAccountHex }`.
  `fiatAmount` is a decimal string with at most 2 decimals, more than 0 and at most `MAX_FIAT_AMOUNT_USD`.
  `midenAccountHex` is `0x` and 30 hex characters. The server makes it lower case.
  Returns `{ nonce, expiresAt, message }`. `expiresAt` is unix seconds, 5 minutes from now.
  Bad input gives 400.
- `POST /transak/session` with `{ nonce, signature }`. `signature` is an EIP-191 signature of `message`
  by `evmAddress`. Returns `{ widgetUrl, widgetParams }`. A missing, used or expired nonce, or a bad
  signature, gives 401. A Transak failure gives 502.
  After Transak returns the URL, the server stores an order with ID = `nonce` (the Transak `partnerOrderId`) in
  state `checkout`. It first cancels the earlier open order of the address (`checkout`, `awaiting_signature` or
  `signed`). When the earlier order is in `relay_sent`, the route gives 409: try again when the relay is mined.
  Then the server subscribes to the Transak feed of the order and advances the order at once.
- `GET /orders/:id` returns the public status:
  `{ id, state, transakStatus, tokenAddress, tokenDecimals, tokenAmount, relayTxHash, error, prepare }`.
  `state` is one of `checkout`, `awaiting_signature`, `signed`, `relay_sent`, `deposited`, `failed`, `expired`,
  `cancelled`. `tokenAmount` is in base units. An unknown ID gives 404.
  In `deposited`, `relayTxHash` is the mined Sepolia transaction. The wallet finds the Agglayer deposit with it.
  `prepare` is not null only in `awaiting_signature`. The server reads it fresh from Sepolia on each call:
  `{ chainId, calibur, evmAddress, midenAccountHex, executor, batchNonce, salt, deadline, needsAuthorization,
  authorizationNonce, tokenAmount }`. `deadline` is now + 1 day. When the chain read fails, `prepare` is null and the
  wallet asks again on its next poll.
- `POST /orders/:id/signature` with
  `{ batchNonce, salt, deadline, tokenAmount, signature, authorization? }`. `authorization` is
  `{ address, chainId, nonce, r, s, yParity }`. The server rebuilds the batch from the stored order and the fresh
  prepare values. It never takes calldata. Returns `{ state: 'signed' }`.
  409 when the order is not in `awaiting_signature`. 400 when an echoed value is not the stored or fresh value, when
  the deadline is not in the next day, or when the batch signature or the authorization is not from `evmAddress`.
  Send an authorization only when `needsAuthorization` is true.

Each IP can send 10 requests per minute to each POST route, and 60 per minute (burst 30) to `GET /orders/:id`.
More requests get 429. Behind a reverse proxy, set `TRUSTED_PROXIES` to its IP addresses or CIDR ranges.
For example, a proxy on the same host can use `127.0.0.1,::1`. The proxy must set `X-Forwarded-For` from the
client connection and remove untrusted values. Express uses this configuration for both Transak sessions and
rate limits. Empty configuration trusts no forwarded headers. Blanket trust and zero-length CIDR prefixes are rejected.

Transak pins each widget session to the `x-user-ip` header. In staging only (`TRANSAK_ENV=staging`), when the caller
IP is private (loopback, LAN, CGNAT), for example a simulator that calls `localhost`, the server sends its own public
IP instead. It gets that IP once from `api.ipify.org`. On one machine or one network, the widget then loads from the
same IP. A public caller IP goes to Transak unchanged. The production IP resolver also passes the caller IP unchanged,
but this server rejects production mode because its bridge is testnet-only.

## Order states and the worker

The worker (`src/orders/worker.ts`) runs a tick each `WORKER_INTERVAL_MS`. A tick reads every order that is not
terminal and moves each one at most one step (`src/orders/advance.ts`). The orders go in sequence, so two relay sends never race for the
relayer nonce. A tick never waits for a receipt: it sends and stores the hash, and a later tick reads the receipt. An
error in one order is logged, and the next tick tries again. A tick does not start while the last tick or a trigger
runs.

| State | What the worker does |
| --- | --- |
| `checkout` | Reads the Transak order (`GET /partners/api/v2/orders?filter[partnerOrderId]=id`). `PROCESSING`, `PENDING_DELIVERY_FROM_TRANSAK` or `COMPLETED` with `cryptoAmount > 0` → `awaiting_signature`, with that amount. `FAILED`, `CANCELLED`, `EXPIRED` or `REFUNDED` → `failed`. No Transak order after 1 h → `expired`. |
| `awaiting_signature` | The wallet signs. The worker still reads Transak: a failure → `failed`. After 24 h → `expired`. |
| `signed` | Waits until the balance is at least the amount. Then it reads the chain again. A changed batch nonce, salt or authorization nonce, or a deadline in less than 60 s → back to `awaiting_signature`. Otherwise it estimates the gas with the authorization list, sends, and stores the hash → `relay_sent`. |
| `relay_sent` | Receipt success → `deposited`, and the signature and authorization are deleted. Reverted → back to `awaiting_signature` (a reverted batch does not use its nonce). After 3 reverted relays → `failed`. No receipt after 15 min → one warning in the log. |

Terminal states: `deposited`, `failed`, `expired`, `cancelled`. The backend does not read the Agglayer indexer. In
`deposited` the funds are in the bridge on Sepolia, and the wallet reads the indexer for the claim on Miden.

### Transak feed and slow poll

The Transak order feed is a public Pusher channel per order: `{TRANSAK_API_KEY}_{orderId}` (the order ID is the
Transak `partnerOrderId`). At the start of each tick, the worker subscribes to the channels of the orders in
`checkout`, `awaiting_signature` and `signed`, and unsubscribes from the other channels. `POST /transak/session`
subscribes to the channel of the new order at once.

The feed is only a trigger. The server never uses the event payload for the state or the amount. On an event
(`ORDER_CREATED`, `ORDER_PAYMENT_VERIFYING`, `ORDER_PROCESSING`, `ORDER_COMPLETED`, `ORDER_FAILED`, `ORDER_REFUNDED`,
and the other names that do not start with `pusher:`), the worker marks the order dirty and advances that order at
once. That step reads the Get Orders API as usual. A trigger shares the guard of the tick: when a tick runs, the
triggered order waits, and the tick advances it when it is done. Two advances never run at the same time.

The Get Orders call of an order runs only when one of these is true:

- The order is dirty (a feed event came after the last call).
- The order had no call since the server started. After a restart, the first tick reads each active order.
- The last call is `TRANSAK_POLL_INTERVAL_MS` old or more. This slow poll is the safety net when the feed is down.

In the other ticks the step uses the stored `transakStatus` and `transakCompletedAt` of the row. The chain steps
(balance, relay send, receipt) still run on each tick. A `checkout` order changes only on Transak data, so it waits
for the next call.

Underdelivery: when Transak says `COMPLETED` and the balance stays below the amount for 10 min, the order takes the
balance as the new amount. A `signed` order goes back to `awaiting_signature`, and the wallet signs the lower amount
at the same batch nonce.

Delegation: when the address has no code, or delegates to a different contract (for example MetaMask DeleGator), then
`needsAuthorization` is true. The wallet signs a new authorization to the pinned Calibur at the pending nonce, and the
relay is a type-4 transaction. When the address already delegates to Calibur, the relay is a normal transaction.

An address has at most one order in `checkout`, `awaiting_signature`, `signed` or `relay_sent` (a partial unique
index). This keeps the Calibur batch nonce serial.

## Logs

The server writes one JSON line per event to stdout: `{ ts, level, event, orderId?, ... }`.

| Event | Fields |
| --- | --- |
| `order_created` | `orderId`, `to` |
| `order_transition` | `orderId`, `from`, `to`, `reason` |
| `order_transition_skipped` | The row was not in `from` any more. |
| `transak_status` | `orderId`, `transakOrderId`, `from`, `to`, `cryptoAmount` |
| `transak_crypto_amount` | `orderId`, `transakOrderId`, `status`, `previousCryptoAmount`, `cryptoAmount`, `baseUnits`, `signedTokenAmount` (each new amount, also with no status change) |
| `order_token_amount` | `orderId`, `transakStatus`, `cryptoAmount`, `tokenAmount`, `tokenDecimals` (the amount that the wallet signs) |
| `relay_sent` | `orderId`, `hash`, `relayerNonce`, `type4`, `attempt` |
| `relay_receipt` | `orderId`, `hash`, `status` |
| `relay_receipt_missing` | `orderId`, `hash` (no receipt after 15 min) |
| `order_underdelivered`, `order_no_delivery` | `orderId`, `tokenAmount`, `balance` |
| `prepare_failed` | `orderId`, `error` |
| `order_created_hook_failed` | `orderId`, `error` (the feed subscribe or the first advance after `POST /transak/session`) |
| `pusher_connection` | `from`, `to` (each state change of the feed connection) |
| `pusher_subscribed`, `pusher_unsubscribed` | `orderId` |
| `pusher_event` | `orderId`, `eventName`, `status`, `cryptoAmount` (from the payload, for the log only) |
| `worker_started` | `relayer`, `intervalMs`, `transakPollIntervalMs` |
| `worker_error` | `orderId`, `state`, `error`, `detail` (the Transak response for a Transak error) |

## Security notes

- **Signed challenge.** The wallet signs a message that names the address, the amount and the Miden account. The
  server keeps all three with the nonce and uses only the stored values for Transak and the order. The client cannot
  change them after it signs. Each nonce is single use: the server deletes it before it checks the signature.
- **Message twin.** `buildChallengeMessage` in `src/transak/challenge.ts` has a byte-identical copy in the wallet
  (`src/lib/onramp/transak-message.ts`). The wallet rebuilds the text and refuses to sign a different text.
  Change both at the same time.
- **Batch twin.** `src/chain-testnet/calibur.ts` and `src/chain-testnet/agglayer.ts` have a twin in the wallet
  (`src/lib/onramp/buy-batch.ts`). Both tests assert the same golden digest. Change both at the same time.
- **No calldata from the client.** The relay batch is always rebuilt from the stored order: the token, the amount, the
  Miden account and the address. The wallet sends only signatures and the values that it signed, and the server
  compares each value with its own value.
- **Pinned Calibur.** Each chain read checks the runtime hash of the Calibur implementation and the signing domain.
- **Mirror.** `widgetParams` in the response is the exact object that went to Transak, without `apiKey`.
  The wallet compares it with its own values and does not open the widget when they differ.
  This catches bugs and bad configuration here. It does not stop a server that lies on purpose.
- **Event guard.** An attacker who controls this server can send a different address to Transak and a
  correct mirror to the wallet. For this reason the wallet also checks the Transak widget events in the
  in-app browser, and closes the widget when the order address is not the wallet address.
- The server does not log signatures, authorizations or request bodies. It logs Transak error details only on the
  server.

## Relay recovery and settlement

Run one backend worker per database and use a relayer key dedicated to this backend. The worker waits for
Transak `COMPLETED` before it relays an order. It updates the bridge amount from settlement and requests a new
signature if the signed amount changed. A provisional quote does not trigger a transfer from an existing balance.

The worker prepares and signs each relay locally. It then stores the signed bytes, hash, sender and nonce in SQLite
and changes the order to `relay_sent` before broadcast. This state includes a stored transaction that awaits its
first successful broadcast. A new checkout cannot cancel it. Nonces reserved in SQLite are not reused if the RPC
has not received those transactions yet.

After a restart or a lost RPC response, the worker checks the stored hash for a receipt. If there is no receipt,
it broadcasts the same signed bytes again. It does not sign a replacement or create a second transfer. Pending
transactions retain their original fees; automatic fee replacement is not included. The signed bytes stay private
to the backend and are removed when the receipt is processed. Existing databases receive the new columns at startup;
old `relay_sent` rows that have only a hash continue to use receipt polling.

Transak refresh, session and order requests have a 15-second timeout, including response-body reads. The local
public-IP lookup also has a 15-second timeout. A failed token refresh does not prevent the next request from retrying.
