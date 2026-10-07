# Explore catalog from a config repo (#1361)

Approved by the issue body and its comments (author and org member WiktorStarczewski), and by the user's answers on 2026-10-07: a new repo `0xMiden/wallet-explore` (kept over folding into wallet-config), no review on merge, created from this session with wallet-config's settings.

## Goal

A merged edit to the Explore catalog reaches every wallet within the next poll, with no wallet release. Each network shows its own catalog: devnet gets the devnet faucet, testnet keeps today's two items.

## Non-goals

- Any trust signal: being listed grants nothing; connect and sign prompts stay identical for any origin.
- Featured art (`art`), carousels, or the never-rendered `FEATURED_DAPPS` entries.
- A service-worker path: Explore is not on the extension.
- Localnet or mainnet documents. A network with no published document shows no catalog items (Recents only, else the existing empty state).

## Part 1: the repo `0xMiden/wallet-explore`

Settings mirror wallet-config: public; squash merge only; delete branch on merge; issues on, wiki and projects off; collaborators WiktorStarczewski (admin), bobbinth (admin), Domi2000 (write, invited); ruleset `main` on `refs/heads/main` with `deletion`, `non_fast_forward` and a strict required status check `validate`, no bypass, no review rule.

Files:

- `testnet.json`: version 1, items `faucet` (https://faucet.testnet.miden.io/, `#778C72`, tagline "Get testnet tokens" in English only, as today) and `forkchoice-faucet` (https://faucets.forkchoice.xyz/, `#2563EB`, tagline "Get testnet tokens for swap" plus today's `exploreForkchoiceFaucetTagline` translations), sections `featured` (`["faucet"]`, title from `exploreFeatured`) and `helper-tools` (both items, title from `exploreHelperTools`), each title carrying today's translations for every locale.
- `devnet.json`: version 1, one item `faucet` (https://faucet.devnet.miden.io/, which answers 200, tagline "Get devnet tokens"), sections `featured` and `helper-tools` holding it.
- `icons/faucet.png`, `icons/forkchoice-faucet.png`: today's bundled PNGs from `src/app/misc/dapp-icons/`.
- `scripts/validate.mjs`: dependency-free Node 22 ESM, exported for tests, run as a CLI over every root `*.json`. Three layers:
  1. The wallet's parse rules, rule for rule with `src/lib/explore-config/schema.ts` (below), returning `{ catalog, errors, dropped }`. What a wallet ignores or leaves out (a key that is no wallet locale, an unknown category or kind) is reported as a note, not an error.
  2. Repo rules: `network` equals the file name; the document is at most 32 KiB, the most a wallet reads; `version` rises over the base (`git show $BASE_REF:<file>`, as wallet-config's `versionError`; a new file passes); every `icon` names a regular file under `icons/` with no link in its path, at most 32 KiB, a PNG (signature, 13-byte IHDR first) and square, at most 256x256.
  3. No smoke layer.
- `scripts/validate.test.mjs` with `scripts/fixtures/good/` and `scripts/fixtures/bad/` (each bad fixture names its exact expected error in `_expect`, as wallet-config does).
- `.github/workflows/validate.yml`: job `validate` on `pull_request` and push to `main`, Node 22, `fetch-depth: 0`, runs the tests then the validator with `BASE_REF` on pull requests.
- `README.md`: the fields, the rules above, pick-up timing (next hourly poll plus about 5 minutes of CDN cache), what being listed does not mean, the version bump, local commands.

## Part 2: the wallet

### Document rules (`src/lib/explore-config/schema.ts`)

`parseExploreConfig(body, network, { allowLocalHttp, baseUrl, bundledIcons }) -> ExploreCatalog | null`, strict on known fields and blind to unknown ones; a malformed known field returns `null` for the whole document.

- `network` equals the requested network; `version` is a positive safe integer.
- Text fields are objects of literal, non-blank strings: `en` required; any other key that is a wallet locale code (the 14 `public/_locales` directories, `en_GB` included) is kept, and any other key is ignored, so a document can add a language before every wallet ships it. No i18n keys.
- Ids (items and sections) are unique within their list and match `^[a-z0-9-]+$`; every `itemIds` entry names an item, and names it once. Section ids `recents` and `search-results` are reserved for the sections the code adds, so a document section taking one is malformed.
- Item: `id`, `name` (at most 40 characters per locale), `tagline` (at most 120), `url`, `category`, `icon` (optional, `^icons/[a-z0-9-]+\.png$`), `brandColor` (optional, `#RRGGBB`), `isExchange` (required boolean).
- `url`: https only; no userinfo; no IP-literal, `localhost` (or `*.localhost`) or punycode (`xn--`) host, a Unicode host counting as its punycode; query allowed; kept exactly as written (Recents dedupe on the exact string). Local http only under the E2E override.
- An unknown `category` drops that item, an unknown section `kind` drops that section; a dropped item also leaves every section's `itemIds`. Known kinds are `featured` and `list`. Categories are the code's `EXPLORE_FILTERS` (`tools`, `defi`, `games`, `nft`, `learn`). Section titles have no length cap.
- An icon resolves to `<base>/<icon>`, `<base>` being the document's own base URL, so an E2E-served document serves its own icons. The bundled snapshot is the exception: an icon path the build ships (`icons/faucet.png`, `icons/forkchoice-faucet.png`, kept as `src/app/misc/dapp-icons/faucet.png` and `forkchoice-faucet.png`) resolves to that bundled file, so a first run and an offline one draw real icons; any other path in it, and every icon of a fetched or stored copy, resolves against the base.

### Fetch, storage and cadence

The floor and acceptance logic moves out of `src/lib/remote-config/source.ts` into `src/lib/versioned-document/` (with its own tests), which both the bridge config (behaviour unchanged) and the Explore catalog use. `src/lib/explore-config/source.ts` supplies the Explore settings and reuses `lib/remote-json.ts` unchanged through it: published base `https://raw.githubusercontent.com/0xMiden/wallet-explore/main`, cache key `explore_config_v1:<network>` storing `{ fetchedAt, body }`, floor key `explore_config_floor_v1` (`{ [network]: version }`), `fetchBoundedJson` at 32 KiB and 10 s with `cache: 'no-store'`, writes through `putToStorage`, the same floor rules (refuse below the floor, refuse the same version with a different body, raise the floor before writing). The floor key joins `PRESERVED_STORAGE_KEYS` from the leaf `src/lib/explore-config/floor-key.ts`, which imports nothing, so the reset never bundles the catalog source, its snapshots or their icons.

`src/lib/explore-config/runtime.ts`, page realms only:

- Per network, the snapshot is the last accepted stored copy at any age when it is newer than the bundled snapshot for that network, else that bundled snapshot when it is at or above the network's floor (read on hydration), else no catalog. At the same version the bundled snapshot wins, since one version names one document and it draws the icons the build ships; a bundled snapshot of a higher version than the stored copy (an app update shipped a newer one) wins until the next fetch, and one below the floor is never shown, so a reset or an unreadable stored copy cannot bring a delisted app back. There is no loading state, so a fetch can never empty Explore.
- `initExploreConfig(network)` is idempotent and never waits for the network: it hydrates from storage, then starts a refresh if one is due.
- Cadence: hourly; a foreground refresh when the copy is older than 15 minutes; on failure, backoff from 60 s doubling to 15 minutes; the timer stops while the document is hidden.
- `registerStorageReread` re-reads after a storage wipe (mobile and desktop have no change event); `onStorageChanged` adopts another realm's newer copy.
- `getExploreCatalogSnapshot()` and `subscribeExploreCatalog(listener)` for `useSyncExternalStore`.

`src/lib/explore-config/snapshot.ts` imports `snapshot/testnet.json` and `snapshot/devnet.json`, byte copies of the published documents, and maps the icon paths they name to the bundled PNGs (`BUNDLED_EXPLORE_ICONS`).

### Launcher

- `useExploreCatalog()` reads the effective network (`getEffectiveNetworkName()`, Developer Settings override included), calls `initExploreConfig` on network change and returns the snapshot through `useSyncExternalStore`, so the launcher re-renders on arrival and on a network switch.
- `getExploreCatalog(catalog)` keeps the exchange gate: it drops `isExchange` items unless `isSwapEnabled()`. The document can only narrow platform gates.
- Text renders through `localizedText(text, locale)`: exact locale, then base language, then `en`. `locale` is i18next's `resolvedLanguage`, the language the rest of the UI renders in, with `zh-TW` read as `zh_TW`. Search matches the rendered (localized) name and tagline.
- Code keeps the category chips, the section kinds, Recents (always appended last, which the document cannot remove or move) and the search-results section.
- Icons render through `AppIcon`, which already falls back to the letter tile with no icon or on a load error. Snapshot items keep their bundled icons.

### Migration and dead code

- Removed: `EXPLORE_CATALOG`'s hardcoded items and sections, `featured-dapps.ts` (with `CAROUSEL_DAPPS` and its types), `category-data.ts`, their tests and barrel exports, the six never-rendered PNGs in `src/app/misc/dapp-icons/` (`lumina`, `miden`, `miden-name`, `playground`, `qash`, `zoro`) and `scripts/fetch-dapp-icons.mjs`. `faucet.png` and `forkchoice-faucet.png` stay as the snapshot's bundled icons.
- i18n keys removed from all 14 locale directories (13 languages plus `en_GB`; flat and `messages.json`): `exploreFeatured`, `exploreHelperTools`, `exploreForkchoiceFaucetTagline`, `categoryNft`, `categorySocial`. `exploreResults` stays.

### Platform and docs

- Tauri CSP `img-src` adds `https://raw.githubusercontent.com/0xMiden/wallet-explore/`.
- The privacy notice says GitHub sees which network's Explore document and icons the app requests, never an account, address or balance.
- CLAUDE.md gets a short "Explore catalog" paragraph beside "Remote bridge config".
- CHANGELOG: one line under the open `(TBD)` heading.
- This spec is committed beside `docs/superpowers/specs/2026-10-03-remote-bridge-config-design.md`.

### E2E

- `MIDEN_EXPLORE_CONFIG_URL`, honoured only when `MIDEN_E2E_TEST === 'true'`, forwarded in all 5 `vite.*.config.ts` files and declared in `src/react-app.d.ts` (writable, so tests can set it); the define-parity test also scans `src/lib/explore-config`.
- The dApp-browser E2E needs no fake: the bundled snapshot serves the curated grid offline, and an E2E build given no `MIDEN_EXPLORE_CONFIG_URL` never fetches the published repo. `launcher_renders_curated_grid` waits until the number of `dapp-grid-card` rows read from the bundled snapshot of `E2E_NETWORK` renders (`bundledGridCardCount`: the distinct items its list sections name, 2 on testnet and 1 on devnet) instead of reading the grid once.

### Store listing

The `ios-dapp-browser` and `android-dapp-browser` captures refuse the published repo, so the launcher draws the build's bundled snapshot, bundled icons included, and they wait for the `dapp-grid-card` rows instead of `dapp-hero-search`.

### Snapshot drift

`scripts/check-published-snapshots.mjs` fetches each published document (token list and Explore) and compares it byte for byte with the bundled snapshot, exiting 1 on a mismatch or on a published file it cannot fetch. `release-notes.yml` runs it as its own job on each of its triggers (a created release, a promoted prerelease, and a manual backfill, which checks the default branch), so drift shows red on the release; `yarn check:published-snapshots` runs it locally.

## Error handling

A fetch failure, a bad document, a lower version or a storage error keeps the current snapshot and backs off. A bad stored copy is ignored in favour of the bundled snapshot. Nothing on these paths throws to the UI.

## Testing

- Repo: fixtures for every rule (good and bad), version bump, document size, icon checks.
- Wallet: schema rules one by one, including drops, ignored locales, reserved section ids, URL rules, caps, icon resolution and text lookup; the shared versioned-document source (floor, acceptance, cache) with the bridge's own tests unchanged; the Explore source's settings; the bundled snapshot and its bundled icons; runtime cadence, backoff, hydrate, reread, network switch and the newer bundled snapshot winning; the launcher rendering from the snapshot, re-rendering on arrival, gating exchanges, and appending Recents; the reset preserving the floor; the define-parity scan; the Tauri CSP; the E2E grid wait and the store-listing capture plan; the snapshot equal to the published files (by the script, not jest).
