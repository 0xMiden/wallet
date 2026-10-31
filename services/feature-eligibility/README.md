# Wallet feature eligibility

This Worker keeps the MaxMind account and paid license key on the server and answers only whether wallet access, new Earn deposits and new Swap operations are allowed. A global wallet denial blocks withdrawals too; NY and UK rules only restrict new Earn deposits.

## Protocol

`GET /v1/eligibility?network=testnet` accepts exactly one supported network: `mainnet`, `testnet`, or `devnet`. It accepts no caller-supplied address, policy, or policy URL.

```json
{ "network": "testnet", "version": 13, "allowed": { "wallet": true, "earn": true, "swap": false } }
```

The wallet must match both `network` and `version` to its accepted wallet-config document and combine these decisions with its existing feature and route availability. Non-2xx responses mean eligibility is unavailable: the wallet opens and Earn and Swap stay off. All three decisions are strict booleans; a global denial forces the product decisions off. Responses contain no caller address, country, subdivision, or provider payload.

`GET /healthz` checks structural deployment readiness without spending a query. Success is `{"ready":true,"revision":"<deployment revision>"}`. Release verification also exercises the actual eligibility route and checks its policy version.

## Policy and request boundary

The service fetches the network document from `https://raw.githubusercontent.com/0xMiden/wallet-config/main/<network>.json`, with a 60-second cache and no expired-policy fallback. It validates the network, positive integer version, feature availability, and recognized geo rules. Unknown enabled phrases fail closed. The global `geo.wallet` map is required; omission fails closed. Its rules always apply, including when Earn and Swap are disabled. An explicit empty wallet map and no enabled feature restriction need no lookup. Swap requires a configured HTTPS solver or `features.nearIntents: true` with valid HTTPS 1Click configuration and Miden asset mappings. Earn retains its existing feature switch.

The published global policy blocks Cuba, Iran, North Korea, Russia, Belarus, Crimea, Sevastopol and the whole Donetsk, Luhansk, Kherson and Zaporizhzhia oblasts. The administrative subdivision policy deliberately covers whole oblasts. NY and UK remain Earn-only rules. Unknown Ukrainian subdivision information cannot establish permission when a Ukrainian region rule applies.

The caller address comes exclusively from Cloudflare's `CF-Connecting-IP` on an edge request with `request.cf` metadata. Forwarded headers are ignored. Worker subrequests are rejected because same-zone Workers can change the address that Cloudflare forwards. Keep Cloudflare Pseudo IPv4 disabled or in `Add Header` mode, never `Overwrite Headers`, and do not place another proxy or Worker in front of this endpoint. [Cloudflare documents these address semantics](https://developers.cloudflare.com/fundamentals/reference/http-headers/).

Origins are an exact JSON allowlist in `ALLOWED_ORIGINS`. The Worker checks an exact match and emits `Access-Control-Allow-Origin` only when a request includes an allowlisted `Origin`. The Chrome extension's Manifest V3 service-worker fetch sends no `Origin` header, so it remains accepted without a CORS response header; do not add the literal string `null` to represent an absent header. Android and iOS eligibility E2E requests were observed with `http://localhost` and `capacitor://localhost`, respectively. Tauri's documented default origins are `tauri://localhost` on macOS/Linux and `http://tauri.localhost` on Windows when `useHttpsScheme` is unset ([Tauri configuration](https://v2.tauri.app/reference/config/)); verify each shipped desktop target's runtime origin before deployment. No wildcard or credentials are supported. CORS limits browser access; it is not client authentication. Other clients can request their own wallet and feature decisions, but cannot choose another address or retrieve a general geolocation result.

All responses use `Cache-Control: private, no-store`. Observability logs and traces are disabled in the Worker configuration. No service code logs addresses or lookup payloads. Cloudflare and MaxMind still necessarily process the caller address to perform this lookup.

## Spending and capacity

`MAXMIND_DAILY_QUERY_LIMIT` is a required nonnegative integer, at most 1,000,000, shared across all supported networks and callers. Its checked-in default is `0`: deployment requires an explicitly selected positive budget. The persisted `global-v1` SQLite Durable Object grants 1-4 query leases to each colo cache object, and a cache object consumes one reservation before every attempted MaxMind lookup, including failed requests. Unused reservations after an object restart or UTC midnight still count against that day's cap; there are no refunded reservations or MaxMind retries. Exhaustion returns 503; cached decisions remain usable until they expire. The counter resets at UTC midnight. The old single-query `/reserve` API remains available during rollout.

The Worker calls Cloudflare's rate limit bindings before any Durable Object request: 60 requests per caller per 60 seconds and 5,000 requests per colo per 10 seconds. These are approximate local limits and can admit a short excess while counters synchronize. Caller keys use a server-secret HMAC of the address and UTC date. The colo object `cache:<colo>` persists only rotating caller keys and feature decisions, with no durable write on a warm decision. Raw addresses and geographic results are never persisted. Decision caches last five minutes and are scoped to caller, network, and exact parsed policy; concurrent requests share the lookup. Expired caller records are removed by bounded alarm batches. A policy document is memoized for 60 seconds per Worker isolate.

At [MaxMind's published City Plus price](https://www.maxmind.com/en/geoip-api-web-services) of $0.0003 per query, a deliberately chosen 10,000-query daily cap limits attempted lookup spend to $3/day, excluding hosting and tax. It supports 10,000 cold caller/network/cache windows per day, not a guaranteed number of users: restarts, network changes, and later sessions can require another query, while callers sharing a public address can share cached decisions. This example is not the configured budget.

Workers requests, Durable Object requests, storage, and CPU have separate hosting allowances. Colo cache objects spread the request path; only paid lookup leases visit the global budget object. Read the current [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), and [object limits](https://developers.cloudflare.com/durable-objects/platform/limits/) before selecting production capacity. No throughput benchmark is claimed.

Do not rename the `ELIGIBILITY_GUARD` namespace, its `EligibilityGuard` class, or singleton `global-v1` when deploying: creating a fresh namespace or identity would create a fresh budget counter. Ordinary code deployments reuse the existing storage and preserve the cap.

## Deployment inputs

Use Wrangler **4.151.3** with `services/feature-eligibility/wrangler.jsonc`. The SQLite Durable Object migration and binding are declared there. There are no runtime npm dependencies or install steps for unit tests.

| Input                        | Kind                   | Purpose                                                      |
| ---------------------------- | ---------------------- | ------------------------------------------------------------ |
| `MAXMIND_ACCOUNT_ID`         | Worker secret          | MaxMind account for City Plus                                |
| `MAXMIND_LICENSE_KEY`        | Worker secret          | Paid service credential                                      |
| `CALLER_HASH_SECRET`         | Worker secret          | At least 32 high-entropy characters for rotating caller keys |
| `ALLOWED_ORIGINS`            | Worker variable        | JSON array of exact permitted origins                        |
| `MAXMIND_DAILY_QUERY_LIMIT`  | Worker variable        | Explicit daily attempted-query cap, default `0`              |
| `DEPLOYMENT_REVISION`        | Worker variable        | Source commit verified by release readiness checks           |
| `CALLER_RATE_LIMIT`          | Rate limit binding     | Approximate per-caller 60 requests per 60 seconds             |
| `COLO_RATE_LIMIT`            | Rate limit binding     | Approximate per-colo 5,000 requests per 10 seconds            |
| `ELIGIBILITY_GUARD`          | Durable Object binding | Atomic persisted global spending                              |
| `CALLER_GUARD`               | Durable Object binding | Per-colo private decision cache                               |

The public wallet build receives only the full HTTPS `/v1/eligibility` URL. The wallet checks eligibility once at startup against its accepted network and policy version, then keeps the wallet, Earn and Swap decisions in memory until the page restarts. It does not refresh permissions during recovery, signing or transactions. MaxMind and caller-hashing secrets must never enter wallet build variables, artifacts, source maps, or public config.

## GitHub deployment

Publishing a wallet release runs `release-wallet.yml`. It calls `deploy-feature-eligibility.yml` on the same tag, uploads server secrets with the deployment, verifies `/healthz` at the release commit and both supported release-network responses, then starts Chrome, desktop and mobile builds. A deployment or readiness failure blocks those builds. The reusable `workflow_call` and manual `published-release` mode continue to require an already published release tag.

The manual dispatch also offers a `main` source. It is accepted only for `workflow_dispatch` runs on `refs/heads/main` and checks out the workflow's exact `github.sha`; it does not accept a caller-selected source ref. Both modes use the same protected `feature-eligibility-production` environment, server secrets, revision pin, readiness checks, concurrency group and cleanup. Manual platform builds only verify the existing service. This deployment does not change wallet feature policy: `nearIntents` remains disabled unless the published wallet-config document explicitly enables it.

Before adding deployment credentials, configure the `feature-eligibility-production` GitHub environment's selected deployment branches and tags to allow only protected `main` and the intended wallet release tags. Protect release-tag creation, changes and deletion so only trusted release operators can select deployable code. GitHub matches these environment rules against the workflow run's ref; the `release_tag` input only selects checked-out service code and does not restrict which workflow definition runs. See [GitHub's deployment branch and tag rules](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments#deployment-branches-and-tags).

Store `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `MAXMIND_ACCOUNT_ID`, `MAXMIND_LICENSE_KEY` and `FEATURE_ELIGIBILITY_CALLER_HASH_SECRET` only in this protected environment. Restrict the Cloudflare token to the intended account and Worker deployment permissions. Before the first deployment, remove any repository-wide copies of these production credentials so workflows outside the environment cannot access them. Configure these repository variables so the deployment and all platform builds share them:

- `FEATURE_ELIGIBILITY_URL`: full public HTTPS URL ending `/v1/eligibility`.
- `FEATURE_ELIGIBILITY_ALLOWED_ORIGINS`: JSON array of exact origins that need browser CORS access; absent-Origin extension requests need no entry.
- `MAXMIND_DAILY_QUERY_LIMIT`: explicitly selected positive daily attempted-query budget.

Create or select the Cloudflare account's Worker hostname before the first release and set the public URL above. Publish the geo policy in wallet-config before the first geo-enabled wallet release. Readiness always verifies the published policy version; it exercises MaxMind authentication only when an enabled feature actually needs a place check. It can spend up to two normal lookup reservations per deployment. The checked-in zero budget intentionally prevents an unconfigured production release.

## Verification and pinned sources

`node --test services/feature-eligibility/worker.test.mjs` exercises the request boundary, rule matching, deadlines, policy freshness, privacy, cache expiry, rate binding order, leases, and spending cap with external HTTP and storage boundaries controlled. The dedicated CI workflow runs the tests and Cloudflare bundling checks.

The deploy tool's [registry source archive](https://registry.npmjs.org/wrangler/-/wrangler-4.151.3.tgz) has the following registry-published SHA-512 integrity, verified before review source inspection:

```text
sha512-mzPQLmkAhZUV7CdiAhE+hiIAJlS9xPL6vZe1B8oQFuWxFu7nmQnvHAVjcAcabwSGkXFXH9uspzXwHOFrfbQmqQ==
```

Platform contracts use the [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), and [MaxMind City Plus REST API](https://dev.maxmind.com/geoip/docs/web-services/requests/). The pinned Wrangler archive contains the exact deployment config schema. No dependency compilation is needed to inspect these sources.
