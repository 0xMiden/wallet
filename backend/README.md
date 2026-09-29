# Miden Wallet backend

A small Node server for the wallet. It keeps secrets that the wallet must not hold.
Now it has one job: it creates Transak Buy widget sessions.

The Transak Create Widget URL API needs a partner access token. The token needs the API secret,
so the wallet cannot make the call itself.

## Environment

Copy `.env.example` to `.env` and set the values. The server checks the values at start and stops if one is wrong.

| Key | Required | Default |
| --- | --- | --- |
| `TRANSAK_API_KEY` | yes | |
| `TRANSAK_API_SECRET` | yes | |
| `TRANSAK_ENV` | no | `staging` (or `production`) |
| `TRANSAK_REFERRER_DOMAIN` | no | `com.miden.bread` (the app bundle ID / package name) |
| `PORT` | no | `8787` |
| `ALLOWED_ORIGINS` | no | `*` (all origins) |
| `MAX_FIAT_AMOUNT_USD` | no | `10000` |

## Run

```bash
cd backend
yarn install
cp .env.example .env   # then set the values
yarn dev               # watch mode
yarn start
yarn typecheck && yarn test
curl localhost:8787/health
```

## Routes

All errors are JSON: `{ "error": string }`.

- `GET /health` returns `{ "ok": true }`.
- `POST /transak/challenge` with `{ evmAddress, fiatAmount }`.
  `fiatAmount` is a decimal string with at most 2 decimals, more than 0 and at most `MAX_FIAT_AMOUNT_USD`.
  Returns `{ nonce, expiresAt, message }`. `expiresAt` is unix seconds, 5 minutes from now.
  Bad input gives 400.
- `POST /transak/session` with `{ nonce, signature }`. `signature` is an EIP-191 signature of `message`
  by `evmAddress`. Returns `{ widgetUrl, widgetParams }`. A missing, used or expired nonce, or a bad
  signature, gives 401. A Transak failure gives 502.

Each IP can send 10 requests per minute to each POST route. More requests get 429.
Behind a reverse proxy, `req.ip` is the proxy address. Set Express `trust proxy` before you deploy like that.

Transak pins each widget session to the `x-user-ip` header. When the caller IP is private (loopback, LAN, CGNAT), for
example a simulator that calls `localhost`, the server sends its own public IP instead. It gets that IP once from
`api.ipify.org`. On one machine or one network, the widget then loads from the same IP. A public caller IP goes to
Transak unchanged.

## Security notes

- **Signed challenge.** The wallet signs a message that names the address and the amount. The server
  keeps both with the nonce and uses only the stored values for Transak. The client cannot change them
  after it signs. Each nonce is single use: the server deletes it before it checks the signature.
- **Message twin.** `buildChallengeMessage` in `src/challenge.ts` has a byte-identical copy in the wallet
  (`src/lib/onramp/transak-message.ts`). The wallet rebuilds the text and refuses to sign a different text.
  Change both at the same time.
- **Mirror.** `widgetParams` in the response is the exact object that went to Transak, without `apiKey`.
  The wallet compares it with its own values and does not open the widget when they differ.
  This catches bugs and bad configuration here. It does not stop a server that lies on purpose.
- **Event guard.** An attacker who controls this server can send a different address to Transak and a
  correct mirror to the wallet. For this reason the wallet also checks the Transak widget events in the
  in-app browser, and closes the widget when the order address is not the wallet address.
- The server does not log signatures or request bodies. It logs Transak error details only on the server.
