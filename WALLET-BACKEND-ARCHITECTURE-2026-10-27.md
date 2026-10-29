# Wallet Backend Architecture

Date: 2026-10-27
Status: proposal
Companion to: [wallet#850](https://github.com/0xMiden/wallet/issues/850)
Prices: Cloudflare list prices, Workers Paid plan, read on 2026-10-27

## 1. Scope

This document sets the runtime and the storage model for the wallet backend. It covers:

- The two Workers that run today: `feature-eligibility` and `one-click`.
- The new service from #850: login and encrypted backup.
- The three backup features: accounts, contacts and transaction history.
- Refresh across devices.
- Cost at 10k, 100k and 1M users.

This document defines the runtime and storage model. It also proposes changes to the salt, entry envelope and sync API in #850. Section 9 lists those changes.

The on-ramp routes in #850 are out of scope. They come in a later document. Nothing here blocks them: they share the login and the D1 binding when they arrive.

## 2. Decision

Run three Workers on one Cloudflare account.

| Worker | Status | Function |
|---|---|---|
| `feature-eligibility` | exists | Geo policy. Durable Objects with SQLite. MaxMind. |
| `one-click` | exists | Stateless proxy. Holds the 1Click partner key. |
| `wallet-api` | new | #850. Auth and encrypted storage. |

`wallet-api` stores every table in one D1 database. One `entries` table holds the encrypted entries of every profile, keyed by `profile_id`. The service does not use Durable Objects or R2. One database holds about 430k average profiles with history. The store splits across databases by `profile_id` when it nears that point, not before. See section 5.4.

Do not merge `feature-eligibility` or `one-click` into `wallet-api`. They are finished, release-gated and privacy-tuned. A bug in the new service must not stop wallet access or swaps.

## 3. Vocabulary

- **Worker.** A bundle of JavaScript that Cloudflare runs in its network. There is no machine, process or port to manage. Deploy with `wrangler deploy` from a `wrangler.jsonc`.
- **Durable Object.** A named object with one live instance worldwide and its own SQLite database of up to 10 GB. Requests to the same name run one at a time. Billed per request and per active millisecond.
- **D1.** A hosted SQLite database with SQL migrations and batch transactions. One database holds up to 10 GB. Billed per row read and per row written.
- **R2.** An object store. `put(key, bytes)` and `get(key)`. Cheap per byte. Expensive per operation. No SQL.
- **Edge.** Not a service. The place where a Worker runs. This document does not use the word again.

## 4. Options that were rejected

### 4.1 One Worker per function

Auth and storage share one JWT layer, one profile table and one D1 binding. Two Workers write that layer twice and need two deploy pipelines for one specification. Cost is the same as three Workers: the plan minimum and every allowance are per account, not per Worker.

### 4.2 One self-hosted server with SQLite

A single Node process with a SQLite file can run all four functions. It can also run the eligibility check: read the peer address directly, or allow inbound traffic only from Cloudflare's ranges and read `CF-Connecting-IP`. This is a hosting choice, not a security constraint.

The server costs 15 to 80 EUR a month for the box. It does not include tested backups, deploys without downtime, disk growth or the hours spent on the box. The stale `backend/` directory already grew an instance lock and a shutdown handler.

If the team chooses a server, move every function onto it. Do not run a server and Workers side by side.

### 4.3 One Durable Object per profile for the entries

A Durable Object per `profileId` gives per-profile isolation, serialised writes and a 10 GB limit per profile without code. The price is one Durable Object request per API call, about 180 USD a month at 1M users, and a second storage model next to D1. The team chose D1 for one schema, plain SQL migrations and the lower cost. The cost of that choice is the shard step in section 5.4, which is not needed before about 400k users.

### 4.4 R2 for the entries

R2 charges 4.50 USD per million writes. History writes hundreds of bytes on every completed transaction. At 1M users R2 saves about 6 USD of storage and charges about 300 USD of operations. R2 wins only when one object is larger than about 25 KB and is written once. No entry in this design is that large.

R2 does not remove the 10 GB cap of D1. The server must still answer a feature read with every entry and its `updatedAt`, and a write by `hashedKey`. That needs an index row per entry in D1. The index row is about 150 bytes, so R2 gives about four times the headroom at eight times the cost, with one R2 object per feature per profile, and every write then rewrites the whole feature object.

## 5. Components of wallet-api

### 5.1 Routes

| Route group | Backing store | Notes |
|---|---|---|
| `POST /v1/auth/nonce`, `POST /v1/auth/login` | D1 `auth_nonces`, `profiles` | As in #850 section 3. The login response carries the profile's `salt`, or null for a new profile. |
| `PUT /v1/profile/salt` | D1 `profiles` | Sets the 16-byte salt once. Refused when one is set. See 5.2. |
| `GET /v1/storage` | D1 `entries`, `profiles` | New. Returns every feature with its ETag. See 7.1. |
| `/v1/storage/{feature}` and `/{hashedKey}` | D1 `entries`, `profiles` | GET and PUT routes from #850 section 4; entry and feature deletion routes are removed. `GET /v1/storage/{feature}?since=<updated_at>` returns only entries written at or after the value. See 6.4. |
| `DELETE /v1/profile` | D1 | Deletes the profile's rows in one batch. |

### 5.2 Schema

Every query carries the `profile_id` from the JWT. The client cannot address another profile.

```sql
CREATE TABLE profiles (
  profile_id      TEXT PRIMARY KEY,
  sync_public_key BLOB NOT NULL,
  salt            BLOB,
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL
);

CREATE TABLE entries (
  profile_id TEXT NOT NULL,
  feature    TEXT NOT NULL,
  hashed_key BLOB NOT NULL,
  revision   INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  envelope   INTEGER NOT NULL,
  kdf_params INTEGER NOT NULL,
  blob       BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, feature, hashed_key)
);
CREATE INDEX entries_cursor ON entries (profile_id, feature, updated_at);

CREATE TABLE auth_nonces (
  public_key BLOB NOT NULL,
  nonce      BLOB NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (public_key, nonce)
);
```

**The salt.** One salt per profile, on the `profiles` row, in place of the fixed constant in #850.

- The first device to log in to a new profile generates 16 bytes with a cryptographically secure random generator and stores them with `PUT /v1/profile/salt`. The server accepts that write only while the column is NULL, so the salt is set once.
- If two devices try to set the salt, the server accepts only one value through an atomic conditional write. The other device reads the stored salt before deriving a key or encrypting an entry. Entry writes are refused while the salt is NULL. A device must not use its proposed salt until the server confirms it as the stored value.
- The salt is public, not a secret. The login response carries it, so every device has it before its first read or write.
- It is stable for the life of that encryption-key generation. Every device uses the same salt and the same scrypt parameters, so every device derives the same key. A new salt means a new key generation and a re-encrypt of every entry; that is a migration, not a routine write.
- A device derives the key once per unlock and keeps it for the session. scrypt at 2^17 runs once, not per entry.
- Every encryption, a chunk rewrite included, uses a fresh random 12-byte AES-GCM nonce. A nonce is never reused under one key.

The salt needs length and randomness, not strength. It does not stand in for the secret input, which is `storageKey`.

**The envelope.** `blob` is `nonce || ciphertext || tag`, with a 12-byte nonce and a 16-byte authentication tag. The six parameter columns of #850 (`kdf`, `N`, `r`, `p`, `dkLen`, `saltLen`) collapse into `kdf_params`, one integer with this layout, least significant bit first:

| Bits | Field | Stored value | #850 value |
|---|---|---|---|
| 0 to 3 | KDF id | 0 = scrypt | 0 |
| 4 to 8 | N | log₂(N) | 17 |
| 9 to 12 | r | r − 1 | 7 |
| 13 to 14 | p | p − 1 | 0 |
| 15 | dkLen | 0 = 16, 1 = 32 | 1 |
| 16 to 20 | saltLen | saltLen − 16 | 0 |
| 21 to 31 | reserved | must be 0 | 0 |

The reserved bits are the most significant, so every value is under 2^21, 3 bytes in SQLite, and never sets bit 31 in JavaScript. The server rejects a value with a reserved bit set, unpacks, and applies the #850 range checks: N 2^14 to 2^20, r 1 to 16, p 1 to 4. A later KDF with other parameters takes a new KDF id and its own layout of bits 4 to 20. The `envelope` column, #850's `version`, stays the version of the envelope as a whole. It is renamed so it is not read as the ETag.

### 5.3 ETag and transactions

Each entry has a `revision` counter. A new entry starts at 1. An update increases the existing counter by one in the same SQL upsert that replaces the entry. Use `ON CONFLICT DO UPDATE`, not `INSERT OR REPLACE`, so an update does not reset the counter. The client cannot set this value. GET and PUT responses include each entry's `revision` and `updatedAt`. The `envelope` field identifies the encryption format and does not change when only the entry contents change.

Revisions are local to an entry. Revision 20 on one chunk cannot be compared with revision 3 on another chunk. A revision is not a feature-wide delta cursor. Writes remain last write wins: the counter identifies a newer stored entry but does not reject stale writes.

The feature ETag is a SHA-256 hash of a canonical list of `(hashed_key, revision)` pairs sorted by `hashed_key`. The full-profile ETag hashes `(feature, hashed_key, revision)` sorted by feature and key. Include the profile salt in both hashes to distinguish a new encryption-key generation after a profile reset. Specify one canonical encoding for these lists in the API contract. An empty list also has an ETag. ETags are opaque strings: compare equality, never numeric order.

A conditional GET reads the entry keys and revisions to compute the ETag. It can return 304 without reading blobs when the ETag matches. This reads metadata for the feature's entries; it is not a one-row or one-index-seek check. On a 200 response, read the metadata and requested entries in one database snapshot. A delta response carries the ETag of the complete feature, not just the returned subset. The full GET also returns each feature's ETag.

`updated_at` remains the delta cursor. Assign it inside the database write, not in the Worker before the write. Within the atomic batch, each write uses the greater of database time in Unix ms and the largest stored `updated_at` for that profile. Thus a later committed write cannot have a smaller timestamp, including if the clock moves back. Equal timestamps are allowed. The `since` comparison is inclusive, so entries at the boundary are read again; their revisions identify any changes. This timestamp rule must be tested with concurrent batches before deployment.

Nothing deletes a single entry. Accounts hide through the `dt` tombstone inside the entry, contacts is one rewritten entry, and history retains its chunks. Remove all single-entry, batch-entry and feature DELETE routes from #850. `DELETE /v1/profile` is the only physical deletion route and deletes the profile and its entries in one batch. After a profile reset, a client clears its sync cursors and performs a full read with the new profile salt before it resumes uploads.

A batch PUT is scoped to one feature and runs as one `db.batch()` of entry upserts. Each upsert increments its entry's revision and sets its timestamp atomically. No `If-Match` and no conflict response are used. Serialize uploads from a device so a delayed retry cannot overwrite a newer local upload. Retry the latest pending entry contents under the same key.

A conditional write was considered and rejected. History streams are per device. Contacts and account records can have competing writes. Since contacts is one list, edits to different contacts can also overwrite each other: one device adding Alice and another adding Bob can lose one addition. A stale list can restore a deleted contact. These are accepted limits of last-write-wins storage, including when a device returns after being offline.

The client compares revisions only for the same entry key and encryption-key generation. It applies a returned entry only if it is absent locally or has a larger revision. It keeps pending local edits separate from the last acknowledged server entry. Serialize sync reads for each profile, including full and targeted reads, so an older response cannot replace a newer feature ETag or cursor. Advance the read cursor and ETag only after all returned changes have been applied successfully.

A nonce is spent by deletion, not by a flag. The login handler runs one statement:

```sql
DELETE FROM auth_nonces
WHERE public_key = ? AND nonce = ? AND expires_at > ?
RETURNING nonce;
```

One D1 statement is atomic, so two logins that race on one nonce get one row between them. The handler verifies the signature after the delete. A bad signature spends the nonce and the client asks for a new one.

The nonce handler adds `DELETE FROM auth_nonces WHERE expires_at < ?` to its batch, so a nonce that was issued and never used leaves within one lifetime. No cron trigger is needed.

### 5.4 The 10 GB cap

One D1 database holds 10 GB.

| Profile | Stored | Profiles per database |
|---|---|---|
| #850 as written, no history | ~9 KiB | ~1.1M |
| Average, 50 transactions | ~23 KiB | ~430k |
| Maximum, 100 transactions | ~70 KiB | ~140k |

The service starts with one database and no shard logic. Watch stored size. When it passes about 3 GB, add a shard step: a function from `profile_id` to a D1 binding, new profiles routed by the first hex digit of the id, and existing rows copied by `profile_id` prefix. The primary key already begins with `profile_id`, so the copy is one range per profile. `auth_nonces` stays in the first database, because the login runs before a profile is known.

### 5.5 Secrets and variables

| Name | Kind |
|---|---|
| `JWT_SIGNING_KEY` | secret |
| `ALLOWED_ORIGINS` | variable |
| `DEPLOYMENT_REVISION` | variable |

### 5.6 Deployment

Extract the pattern in `deploy-feature-eligibility.yml` into one reusable `workflow_call` workflow. The template pins the Wrangler version, reads secrets from a named GitHub environment, pins the revision, deploys and probes `/healthz`. Call it once per Worker. Delete the stale `backend/` directory when `wallet-api` is deployed.

## 6. Features, and transaction history as one of them

The service has three features. The `preferences` feature in #850 is dropped for now.

| Feature | Entries | Entry key before hashing | Plaintext |
|---|---|---|---|
| `accounts` | one per account | `"<type>:<hdIndex>"`, as in #850 | the #850 account object: index, type, name, name last updated, auth scheme, Guardian endpoint, deleted at |
| `contacts` | one for the whole list | `"contacts"` | a JSON array of `[name, address, network]` triples; network is a one-letter code |
| `history` | one per chunk | `history:<deviceId>:<n>` | this section |

`contacts` is one entry rather than one per contact as #850 has it. Twenty contacts are under 1 KiB and the 4 KiB cap holds about 90. An edit rewrites the one entry, last write wins. The per-contact timestamps and tombstones in #850 are not needed.

History is the feature that can make the store large. This section bounds it.

### 6.1 Projection

The synced entry is a projection of the wallet's `ITransaction` row. It is not the row.

Fields that the projection drops:

- `resultBytes`. Only the dApp API's `waitForTransaction` reads it, right after the transaction lands. The wallet releases it after 10 minutes in `trim-result-bytes.ts`.
- `requestBytes`. Manual retry and the Agglayer exit-hash derivation read it. A retry on another device is wrong. The exit hash is derived once at completion and stored as a field.
- Retry counters, relay state, stage stamps, diagnostics and the guardian candidate. These are the working state of the originating device.

Rule: every derived value is computed on the originating device and carried as a plain field. Raw bytes never leave the device.

### 6.2 Restored rows are read-only

A restored history row permits no retry, no `waitForTransaction` and no replay. The wallet already has `restoredFromBackup`, and `retry.ts` already excludes imported rows from replay. The specification must state that restored rows take that path.

### 6.3 Entry format

Feature name: `history`. One entry is one chunk: a JSON array of transaction rows. Entry key before hashing: `history:<deviceId>:<n>`, where `deviceId` is a random id that each install generates once and keeps locally, and `n` counts that device's chunks from 0.

```json
[
  { "v": 1, "id": "…", "t": "send", "s": 2, "ic": "SEND", "a": "<account>", "sa": "<counterparty>", "f": "<faucet>", "am": "1000000", "fa": "100", "tx": "0x…", "n": ["0x…"], "ia": 1757400000000, "ca": 1757400004000, "m": "…" },
  { "v": 1, "id": "…", "t": "bridged-send", "s": 2, "ic": "BRIDGE", "a": "<account>", "f": "<faucet>", "am": "1000000", "fa": "100", "tx": "0x…", "n": ["0x…"], "ia": 1757400000000, "ca": 1757400004000, "x": { "pv": "agglayer", "da": "0x…", "dn": 1, "cs": "claimed", "ct": "0x…", "xh": "0x…" } },
  { "…": "next row" }
]
```

One row of the array:

| Field | Long name |
|---|---|
| `v` | schema version |
| `id` | transaction row id |
| `t` | `ITransactionType` |
| `s` | `ITransactionStatus` |
| `ic` | display icon |
| `a` | account id |
| `sa` | secondary account id |
| `f` | faucet id |
| `am` | amount, decimal string |
| `fa` | fee amount, decimal string |
| `tx` | on-chain transaction id |
| `n` | note ids, at most 16 |
| `ia` | initiated at, unix ms |
| `ca` | completed at, unix ms |
| `m` | display message |
| `x` | type-specific fields, see below |

The server does not read the row. It enforces the feature name and the caps in 6.4, nothing else. `v` versions the row shape, so the client can add fields without a server change.

`x` holds the projection of `extraInputs` for row types that have one. The rule is the one in 6.1: keep what identifies the transaction on each chain and what the receipt shows, drop the working state of the originating device.

| Row type | Kept in `x` | Dropped |
|---|---|---|
| `bridged-send` | provider, destination address and network, source faucet, claim status, claim tx hash, Agglayer exit hash, EVM tx hash | route config, `depositReady`, deposit count, the unfiled and unavailable flags, recall blocks |
| `bridged-receive` | provider, source chain id, source address, source amount and symbol, EVM tx hash, intent nonce, Miden note id, output amount and symbol, phase at write time | allocator URL, route config, CCTP leg, error, `readyAt` |
| `earn-deposit`, `earn-withdraw` | market uid, EVM recipient, intent nonce, EVM tx hash, epoch status, protocol, chain id | allocator URL, recall blocks |
| `swap` | requested faucet and amount, order note id, settlement kind | retry and tracking state |
| `consume` | note sender, GC purchase quote when present | swap-settle linkage |

A bridged row is about twice a send, near 800 B plaintext. A 25 KiB chunk then holds about 30 of them in place of 50. The cap in 6.4 is by size, so the chunk rule needs no change.

### 6.4 Chunks

The client appends each completed transaction to its open chunk and rewrites that one entry. When the next row would take the chunk's decoded blob past 25 KiB, the client starts chunk `n + 1`. The limit is bytes, not rows: a chunk holds about 50 sends or about 38 heavier rows.

A device writes only its own stream. Two devices with the same mnemonic never share an open chunk, so there is no merge rule. A reader fetches every history entry, decrypts every chunk, concatenates the rows and sorts by `ia`. History is append-only, so there are no tombstones. Queued, Generating and Unconfirmed rows stay local. Append a row only when it reaches Completed. Later receipt changes, such as a destination transaction hash, received amount or claim status, update that row in its original chunk. Store the chunk assignment locally and serialize chunk updates. Temporary progress and retry state do not trigger uploads.

| Cap | Value |
|---|---|
| `history` entry, decoded blob | 25 KiB |
| Other features, decoded blob | 4 KiB, as in #850 |
| Note ids per row | 16 |
| Entries per feature | 1000, as in #850 |

1000 chunks of 25 KiB is 25 MB per profile, about 50,000 transactions. The cap is not reached in practice. The wire size of a full chunk is about 33 KB in base64, under the 512 KiB request body limit.

The cost per transaction is one D1 row write, the same as one entry per transaction. The change is on read. `GET /v1/storage/history` returns every chunk when the feature's ETag changes, so without more a cross-device transaction brings down the whole history. The `since` parameter bounds that: `GET /v1/storage/history?since=<updated_at>` returns only the chunks whose server `updated_at` is at or after the value, served by the `entries_cursor` index, and the client dedupes by key because a chunk write replaces the entry. The client sends the largest `updated_at` from its last successfully applied feature read. A PUT response does not advance this cursor. The feature ETag is checked from the complete entry metadata, so an update at the same timestamp still changes the ETag through its entry revision. A refresh returns changed chunks and any chunks at the inclusive timestamp boundary. One returned chunk is up to 33 KB on the wire; the response does not usually contain the whole feature.

### 6.5 Measured size

Measured with Node's `crypto`: scrypt with the #850 parameters, AES-256-GCM, one send row with bech32m addresses of a 15-byte account id and 0x-prefixed 64-hex ids. Script: `entry-size.mjs` in the session scratchpad.

| Stage, one send | Bytes |
|---|---|
| plaintext JSON | 437 |
| encrypted blob | 481, a fixed 44 of salt, nonce and tag |
| D1 row, one send per entry | 547, 20 % overhead |
| wire JSON with base64 | 729 |

Encryption adds a fixed 44 bytes. It never adds a proportional amount. The rest of the overhead is the envelope columns, the hashed key, the timestamp and the row framing, and a chunk pays it once. The figures are for the #850 envelope. The envelope in 5.2, no salt in the blob and one `kdf_params` integer, takes about 28 bytes off each row, which is noise on a chunk and is not restated below.

| Layout | D1 bytes per send | Overhead |
|---|---|---|
| 1 send per entry | 547 | 20.1 % |
| 10 sends per entry | 449 | 2.4 % |
| 50 sends per entry | 440 | 0.5 % |

50 sends in one chunk: 21.9 KB plaintext, 22.0 KB stored, 29.3 KB on the wire. 278 of the 437 bytes of a send are the three bech32 addresses and the two hex ids. A binary encoding (CBOR) with raw bytes for ids takes a send to about 220 bytes and halves every figure here. It is a client-side change that touches no server column, and this document does not require it.

### 6.6 Size of a profile and of the fleet

| Profile | Chunks | Stored |
|---|---|---|
| Average: 3 accounts, 50 transactions | 1 | ~23 KiB |
| Maximum: 10 accounts, 100 transactions, all heavy | 2 | ~70 KiB |

| Fleet | Average profiles | Every profile at maximum |
|---|---|---|
| 100k users | ~2.3 GB, inside the 5 GB included | ~7 GB, ~2 USD a month |
| 1M users | ~23 GB, ~14 USD a month | ~70 GB, ~49 USD a month |

Storage is 0.75 USD per GB-month in D1 past the 5 GB included.

## 7. Cost controls

### 7.1 One read per unlock

#850 counts one `GET` per feature per unlock, 30 a day per user. Most answer 304. Each 304 is still one Worker request and a read of the entry metadata needed for the ETag.

`GET /v1/storage` returns every feature with its ETag. The client calls it once per unlock and foreground, the one moment when any feature may have moved. Every other refresh is targeted: `GET /v1/storage/contacts` when the address book opens, `GET /v1/storage/history` when the Guardian sync adopts a newer state. A targeted read never brings down a feature the client does not need. This cuts the unlock read to one request.

### 7.2 Batch PUT carries only changed entries

D1 rows written cost 1 USD per million past 50M a month. A batch that rewrites all 60 entries on every tenth unlock writes about 1.8B rows a month at 1M users, about 1,800 USD. A batch that carries only entries whose plaintext timestamp changed writes a few million rows, about 10 USD.

This is a requirement in section 4.4 of #850, not a client option.

### 7.3 Refresh across devices has no timer

A second device must see the history that the first device wrote. A timer that asks the backend "did anything change?" is the wrong tool. Each ask is one Worker request, and the count scales with time on screen, not with activity.

| Strategy at 1M users, 2 devices each, 2 hours on screen a day | Requests a month | Cost a month |
|---|---|---|
| Timer every 60 s | ~7.2B | ~2,160 USD |
| Timer every 5 min | ~1.4B | ~430 USD |
| Events only, about 10 a day per user | ~300M | ~90 USD |

The client sends a conditional `GET` only on these events, and only for the feature the event is about:

| Event | Request |
|---|---|
| Unlock and foreground | `GET /v1/storage`, every feature. Catches every change made while the wallet was closed, including a change with no effect on chain, such as a contact. |
| Address book opens | `GET /v1/storage/contacts` |
| Pull to refresh on the Activity tab | `GET /v1/storage/history` |
| The Guardian sync adopts a newer state | `GET /v1/storage/history` |

The Guardian event: the Guardian sync tick (`runSync` in `src/lib/miden/guardian/index.ts`) calls `multisig.syncState()` every lap. That call reads the account commitment on chain, compares it with the local copy, and on a mismatch reads the Guardian's `/state` and overwrites the local account. A transaction from another device is the only cause of that overwrite in normal operation. So the moment the tick adopts the Guardian's state is the moment to fetch history and merge the new chunks. The signal costs no backend request. It comes from the chain and Guardian reads the wallet makes anyway.

A feature request carries `If-None-Match` with that feature's last fully read ETag; the full GET uses the full-profile ETag. A request that finds nothing new returns 304 after reading the entry metadata. The page renders the local copy at once and re-renders if the response brings a newer one. A history read after the Guardian event carries `since`, see 6.4.

**The gap after the Guardian event.** Device-2 adopts the new state on its next 3-second lap. Device-1 uploads its chunk after the row reaches Completed. The first history read on device-2 can come back 304 because device-1's upload has not landed. Two rules close most of it. Device-1 flushes history at once when a row completes, with no quiet period for that case. Device-2, when the trigger was the Guardian event and the read came back 304, reads again after 10, 30 and 60 seconds, then stops. Three bounded requests per cross-device transaction. If all three miss, the row arrives at the next unlock, foreground or pull to refresh, and that is accepted.

A PUT response acknowledges only the entries it wrote. Record their revisions and timestamps, but do not advance a feature read cursor or ETag from this response. Another device may have written entries that this device has not fetched. The next scheduled refresh uses the last successfully applied read cursor and ETag; an immediate GET after every PUT is not required.

Push from the backend is not built. A Durable Object WebSocket per profile would bring Durable Objects back for one feature, and a mobile app in the background drops the socket. Background push needs APNs and FCM, a separate service, and history is read only while the app is open.

## 8. Cost by scale

Traffic model from #850 section 6: 10 unlocks a day. The refresh events in 7.3 fit inside that count. MaxMind is separate and capped by `MAXMIND_DAILY_QUERY_LIMIT`.

| Users | Requests a month | As specified | With 7.1 and 7.2 | One server |
|---|---|---|---|---|
| 10k | ~12M | ~6 USD | ~5 USD | ~15 EUR |
| 100k | ~120M | ~38 USD | ~15 USD | ~15 EUR |
| 1M | ~1.2B | ~380 USD | ~140 USD | 40 to 80 EUR plus failover and time |

At 1M users as specified: Worker requests about 357 USD, D1 storage about 14 USD, D1 rows read and written inside the included tiers with rule 7.2 in force. The Durable Object design in 4.3 adds about 180 USD to each D1 figure.

Topology A and topology C cost the same. The 5 USD minimum and every allowance are per account.

## 9. Changes to propose on #850

1. Name the runtime in section 2.6: one Worker and one D1 database, the schema in 5.2, the shard step in 5.4 deferred until stored size nears 3 GB. Section 7 of #850 assumes Durable Objects; replace that line.
2. Add `history` as a feature: chunked entries keyed per device as in 6.3, the 25 KiB history entry cap and the chunk rule in 6.4, and the read-only rule in 6.2. Section 2.7 of #850 then carries two entry caps.
3. Drop `preferences` from the feature allowlist for now.
4. Make `contacts` one entry keyed `"contacts"` holding the whole list, in place of one entry per contact. Remove the per-contact `lu` and `dt` fields.
5. Add `GET /v1/storage` returning every feature with its ETag, and make it the unlock-time read. Add a server-owned revision counter per entry. Compute ETags from the profile salt and sorted entry keys and revisions; use database-assigned nondecreasing `updated_at` values for inclusive delta reads. Writes are last write wins, no `If-Match`. Remove single-entry, batch-entry and feature DELETE routes; retain profile deletion. PUT acknowledgements never advance a feature read cursor.
6. Make "batch PUT carries only changed entries" a requirement in section 4.4.
7. Name the refresh events in 7.3 as the only times the client reads the backend, with the Guardian sync adoption as the cross-device trigger. No timer.
8. Move the thread's answer on removed recovery phrases into the body: the sync key is derived at wallet creation and stored, so backup continues after the phrase leaves the device.
9. Split the work into wallet-side issues that each name a contract: the sync-key derivation branch and login signature; the encrypted-entry client against a deployed endpoint; the refresh hook in the Guardian sync tick.
10. Move the on-ramp routes out of #850 into their own issue.
11. Change the envelope in section 2.4 and 3.3: one random 16-byte salt per profile, set once with `PUT /v1/profile/salt` and returned by login, in place of the fixed constant; `blob` is `nonce || ciphertext || tag`, with a 12-byte nonce and a 16-byte authentication tag; the parameter fields collapse into the `kdf_params` integer with the bit layout in 5.2.

## 10. Open points

- Imported accounts with `hdIndex: -1`. The entry must carry the secret key inside the ciphertext under a new type, or the feature excludes them. The client team decides.
- Whether the Guardian sync adoption is observable to the client code outside `multisig.syncState()`. If the SDK does not report "I overwrote local", the hook compares the account commitment before and after the call.

## 11. Sources

- Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Durable Objects pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/
- D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- R2 pricing: https://developers.cloudflare.com/r2/pricing/
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Durable Object WebSockets: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
