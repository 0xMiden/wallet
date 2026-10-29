# Wallet API

This Worker stores the encrypted wallet backup. It has one D1 database and no Durable Objects. The wallet encrypts every entry on the device. The server never sees a key or a plaintext. It keeps the ciphertext, a revision per entry and a timestamp per write, and it computes the ETags that let a device skip a read when nothing changed.

The features are `accounts`, `contacts` and `history`. The architecture is in `WALLET-BACKEND-ARCHITECTURE-2026-10-27.md`, sections 5 to 7.

## Source layout

| File | Responsibility |
| --- | --- |
| `src/index.ts` | The entry: CORS gate, `createService`, the default `fetch` |
| `src/router.ts` | Typed route match, the method check and the dispatch |
| `src/routes/auth.ts` | Nonce and login, the signature check, the profile generation |
| `src/rate-limit.ts` | The auth rate limit per caller address and the storage rate limit per profile |
| `src/routes/profile.ts` | Salt set and profile delete |
| `src/routes/storage.ts` | Storage reads and writes |
| `src/routes/health.ts` | `/healthz` |
| `src/types.ts` | `Env`, `RequestContext`, `Feature`, `ErrorCode`, the wire shapes and the row types |
| `src/db.ts` | D1 statements, entry views, the batch upsert |
| `src/rows.ts` | Runtime checks that narrow D1 rows from `unknown` to the row types |
| `src/sql.ts` | SQL text of the upserts, the nonce spend and the salt set |
| `src/token.ts` | HS256 tokens, authentication, the profile id |
| `src/validate.ts` | Request validation: public key, entry, `kdfParams`, `since`, batch, auth and salt bodies |
| `src/etag.ts` | Feature and full-profile ETags |
| `src/http.ts` | Responses, body read with the 512 KiB cap, CORS, `If-None-Match` |
| `src/encoding.ts` | Hex, base64, base64url, SHA-256 |
| `src/errors.ts` | `ApiError` and its helpers |
| `src/constants.ts` | Limits and formats of the contract |

The source is TypeScript. Wrangler bundles it directly, with no build step. Request bodies and D1 rows enter as `unknown`, and runtime checks narrow them to the typed shapes. The code uses no `any` and no type assertion.

## Routes

| Route | Auth | Result |
| --- | --- | --- |
| `GET /healthz` | none | `200 {"ok":true,"revision":"<DEPLOYMENT_REVISION>"}`, or `503` with `ok: false` when a binding or the secret is missing |
| `POST /v1/auth/nonce` | none, rate limited | `{ "nonce", "expiresAt" }` for `{ "publicKey" }`. The nonce lives 5 minutes and is single use |
| `POST /v1/auth/login` | none, rate limited | `{ "accessToken", "expiresIn": 3600, "profileId", "salt" }` for `{ "publicKey", "message", "signature" }` |
| `PUT /v1/profile/salt` | Bearer, rate limited | `200 { "salt" }`, or `409 salt_already_set` with the stored salt |
| `DELETE /v1/profile` | Bearer, rate limited | `204`. Deletes the profile and every entry in one batch |
| `GET /v1/storage` | Bearer, rate limited | The full-profile ETag and the ETag of each feature. `304` on `If-None-Match` |
| `GET /v1/storage/{feature}[?since=<ms>][&after=<hashedKey>][&limit=<1..100>]` | Bearer, rate limited | One page of entries, `next`, and the ETag of the complete feature. `304` on `If-None-Match` |
| `GET /v1/storage/{feature}/{hashedKey}` | Bearer, rate limited | One entry, or `404 not_found` |
| `PUT /v1/storage/{feature}/{hashedKey}` | Bearer, rate limited | Upsert one entry. `{ "hashedKey", "revision", "updatedAt" }` |
| `PUT /v1/storage/{feature}` | Bearer, rate limited | Upsert 1 to 100 entries in one `db.batch()`, all or none |

The login message is `miden-sync:login:<nonce>:<publicKey>`. The signature is a 64-byte compact secp256k1 signature over the SHA-256 of the message bytes. The server spends the nonce before it checks the signature, so a bad signature also spends it. The profile id is a version 4 UUID that the server derives from the SHA-256 of the public key. A login after `DELETE /v1/profile` gets the same id and a NULL salt.

## Profile generation

A profile has a generation: 16 random bytes that the login writes when it creates the profile row. The access token carries it in the `gen` claim. Every authenticated route compares the token's generation with the profile's, and a write carries the comparison inside its SQL: the entry upsert's guard, the salt update's `WHERE`, and both delete statements. So a token issued before `DELETE /v1/profile` gets `401` on the profile a later login makes again, and it cannot write ciphertext of the old salt into the new backup or delete it. The check and the write are one database operation, so a delete that lands between the token check and the batch refuses the batch too.

## Rate limits

The nonce and login routes count per caller address (`AUTH_RATE_LIMIT`). Every authenticated route counts per profile (`STORAGE_RATE_LIMIT`), on the key `read:<profileId>` for a `GET` and `write:<profileId>` for a `PUT` or `DELETE`. A batch `PUT` costs one unit per started group of 10 entries. A refused request gets `429 rate_limited` with `Retry-After: 60`. Anyone can make a sync key and get a token, so the token alone bounds no load; the per-profile budget does.

## Pages

A feature read returns at most `limit` entries (100 when absent), ordered by `hashed_key`, and `next`: the last key of the page when more entries follow, else `null`. The next page passes that key as `after`. Every page carries the ETag of the complete feature, computed from the metadata of every entry. A client keeps the ETag of the FIRST page: a write between two pages moves the feature's ETag past it, so the next conditional read is a `200`. The last page's ETag could match the server after such a write and hide it behind a `304`. The client saves the ETag and the cursor only after it applied every page.

An entry on the wire is `{ "envelope": 1, "kdfParams": <int>, "blob": "<base64>" }`. The decoded blob is 28 bytes or more. Its cap is 25600 bytes for `history` and 4096 bytes for the other features. A feature holds at most 1000 entries. A request body is at most 512 KiB. A request over a cap gets `413` (`payload_too_large` or `entry_limit`). An entry write while the salt is NULL gets `409 salt_not_set`. An error body is `{ "error": "<code>", "message": "<text>" }`.

## ETags and the cursor

The feature ETag is the lowercase hex SHA-256 of the UTF-8 string `salt_hex + "\n" + lines.join("\n")`. Each line is `hashed_key_hex + ":" + revision`, and the lines are sorted by `hashed_key`. An empty feature hashes `salt_hex + "\n"`. While the salt is NULL, `salt_hex` is the empty string. The full-profile ETag uses the lines `feature + ":" + hashed_key_hex + ":" + revision`, sorted by feature, then by key. The `ETag` header carries the value in quotes, and a JSON body carries it without quotes. `If-None-Match` is accepted with or without quotes. The server decides a `304` from `hashed_key` and `revision` only and reads no blob.

Each write sets `updated_at` inside the D1 batch to the larger of the database clock in Unix ms and the largest `updated_at` of the profile. Thus `updated_at` never decreases for a profile, and equal values are possible. `?since=<ms>` returns the entries with `updated_at >= since`, so the client reads the boundary entries again and compares their revisions. A `since` response still carries the ETag of the complete feature. A new entry starts at revision 1, and each update adds 1. Writes are last write wins, with no `If-Match`.

## Local run

Use Wrangler 4.151.3. Wrangler bundles `@noble/curves` from `package.json` at deploy. Every package resolves from the repository root: `yarn install` at the root installs `@noble/curves`, `@cloudflare/workers-types` and TypeScript. Do not run `npm install` in this directory.

```sh
yarn install   # at the repository root, once
cd services/wallet-api
npx tsc --noEmit -p .
npx wrangler@4.151.3 d1 migrations apply miden-wallet-api --local
npx wrangler@4.151.3 dev --var JWT_SIGNING_KEY:<32 or more characters>
```

`tsc --noEmit` checks the types only. Wrangler does not check types when it bundles, so run `tsc` before a deploy.

Local runs work with the placeholder `database_id`. Local state goes to `.wrangler/`, which git ignores. You can also put `JWT_SIGNING_KEY=...` in a `.dev.vars` file, which git ignores too. With `ALLOWED_ORIGINS` set to `[]`, the Worker refuses every request that sends an `Origin` header. Requests without the header, such as `curl`, are accepted.

## Deployment inputs

| Input | Kind | Purpose |
| --- | --- | --- |
| `JWT_SIGNING_KEY` | Worker secret | HS256 key for the access tokens, 32 characters or more |
| `ALLOWED_ORIGINS` | Worker variable | JSON array of exact allowed origins, no wildcard |
| `DEPLOYMENT_REVISION` | Worker variable | The source commit that `/healthz` reports |
| `DB` | D1 binding | The `miden-wallet-api` database |
| `AUTH_RATE_LIMIT` | Rate limit binding | Approximate 30 auth requests per caller address per 60 seconds |
| `STORAGE_RATE_LIMIT` | Rate limit binding | Approximate 120 reads and 120 write units per profile per 60 seconds |

The committed `wrangler.jsonc` holds placeholders only: the `database_id` is zeros, `ALLOWED_ORIGINS` is `[]`, and `DEPLOYMENT_REVISION` is `unknown`. The deploy workflow renders a release copy with the real values and never commits them. Replace the placeholder `namespace_id` of `AUTH_RATE_LIMIT` and `STORAGE_RATE_LIMIT` with integers that no other rate limit binding in the account uses (the feature-eligibility Worker uses 189401 and 189402).

## Deployment

`.github/workflows/deploy-wallet-api.yml` deploys the Worker. A production deploy is always started by hand: the workflow has only a `workflow_dispatch` trigger, run from the Actions tab with a published release tag or with `deployment_source: main` from `main`, and the `wallet-api-production` environment's required reviewers approve each run. A published release or a merge into `main` deploys nothing. The job type-checks the Worker, renders the release config, applies the D1 migrations with `wrangler d1 migrations apply --remote`, deploys with `wrangler deploy --secrets-file`, then runs `check-deployment.mjs`: `/healthz` must answer `ok: true` with the deployed revision, a configured wallet origin must pass the CORS preflight, and an unknown origin must get 403.

A migration runs before the new Worker serves traffic, so every migration must keep working with the Worker that is live until the deploy lands.

### One-time setup, by hand

1. Create the database with a Cloudflare token that can edit D1, and keep the returned id:

   ```sh
   CLOUDFLARE_ACCOUNT_ID=<account> CLOUDFLARE_API_TOKEN=<token> npx wrangler@4.151.3 d1 create miden-wallet-api
   ```

2. Create the GitHub environment `wallet-api-production` with required reviewers, and set:

   | Name | Kind | Value |
   | --- | --- | --- |
   | `CLOUDFLARE_API_TOKEN` | secret | A token with Workers Scripts: Edit, D1: Edit and Account Settings: Read |
   | `CLOUDFLARE_ACCOUNT_ID` | secret | The Cloudflare account id |
   | `WALLET_API_JWT_SIGNING_KEY` | secret | 32 random bytes or more, for example `openssl rand -base64 48` |
   | `WALLET_API_D1_DATABASE_ID` | variable | The id from step 1 |
   | `WALLET_API_ALLOWED_ORIGINS` | variable | JSON array of exact wallet origins: the store extension origin `chrome-extension://<id>`, `capacitor://localhost`, `http://localhost` (Android), `tauri://localhost` |
   | `WALLET_API_URL` | variable | The public base URL, `https://miden-wallet-api.<account>.workers.dev` or a custom hostname, no trailing slash |

3. Run the workflow once by hand from `main` and check that the verify step passes.
4. Open a `0xMiden/wallet-config` change that sets `features.encryptedBackup: true` and `backup.baseUrl` to `WALLET_API_URL` for each network that turns the backup on. The wallet reads the URL from that document; nothing is baked into a build.

A new `WALLET_API_JWT_SIGNING_KEY` makes every issued token invalid, and each device logs in again on its next refresh. The database id and the origins change the rendered config only; `wrangler.jsonc` stays as committed.
