# Local test of the deposit-address relay

This runbook tells you how to test the deposit-address flow by hand: the Chrome extension on the Miden testnet, a
relay Worker (`services/evm-relay`) that runs on your machine, and Sepolia as the EVM chain.

The wallet reads the relay settings from the remote config document of its network (`testnet.json` of
`0xMiden/wallet-config`). The published document has no `relay` section yet. Thus this setup:

1. runs the Worker with `wrangler dev` on `http://127.0.0.1:8788`;
2. serves a copy of the published `testnet.json` with `features.relayDeposit: true` and a `relay` section on
   `http://127.0.0.1:8551` (`serve-config.mjs`);
3. builds the extension with `MIDEN_E2E_TEST=true`, because only such a build reads the document from
   `MIDEN_REMOTE_CONFIG_URL`, and with `MIDEN_EVM_RELAY_URL=http://127.0.0.1:8788`, because the document's
   `relay.baseUrl` must be `https:` and the loopback build define goes first (`src/lib/evm-relay/base-url.ts`).

## Files in this folder

| File | Purpose |
| --- | --- |
| `probe-chains.mjs` | Read-only. Lists the chains, routes and tokens of a document, and checks Calibur and EIP-7702 on each chain with a public RPC |
| `relayer-key.mjs` | `new`: makes the relayer key in `services/evm-relay/.dev.vars`. `address`: prints the relayer address. It never prints the key |
| `serve-config.mjs` | Serves the document with the relay on. It copies the chains and the Calibur pin from `RELAY_CONFIG` of `.dev.vars`, and the executor from the key, and checks the result with the wallet's own parser |
| `smoke.mjs` | Checks the Worker and the document together. It sends no relay |
| `lib.mjs` | Shared helpers |

## Why Sepolia

The published `testnet.json` (version 17 on 2026-11-26) names four EVM chains. Only Sepolia has a relay route:

| Chain | Routes | Agglayer tokens | Epoch tokens |
| --- | --- | --- | --- |
| `sepolia` (11155111) | usdcx, epoch, agglayer | USDC `0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69` (and native ETH when the Agglayer token registry lists it) | USDC `0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69` |
| `arc-testnet` (5042002) | usdcx | none | none |
| `base-sepolia` (84532) | usdcx | none | none |
| `arbitrum-sepolia` (421614) | usdcx | none | none |

The relay takes Agglayer and Epoch only; Circle (usdcx) is not offered for a relay source. `probe-chains.mjs` gave
these results:

| Chain | EIP-7702 (type-4 transaction from an address with no funds) | Uniswap Calibur `0x000000009B1D0aF20D8C6d0A44e162d11F9b8f00` | Prototype Calibur `0x00000cAbFc76478C1537dd418aB00967cBbE4AE6` |
| --- | --- | --- | --- |
| Sepolia | Accepted, refused for funds | 24504 bytes, hash `0x7fa1bd2e…f4f57a4`, domain `Calibur` `1.0.0` | 22150 bytes, hash `0xd8f21571…2deea1eb` (the hash in `src/lib/evm-relay/batch/testing.ts`), domain `Calibur` `1.0.0` |
| Base Sepolia | Accepted, refused for funds | Same code and hash | No code |
| Arbitrum Sepolia | Accepted, refused for funds | Same code and hash | No code |
| Arc testnet | Not probed | No code | No code |

This setup pins the Uniswap Calibur (`0x000000009b1d0af20d8c6d0a44e162d11f9b8f00`, runtime hash
`0x7fa1bd2edb51499cb83a324acd9d0f35b31774cf8894e26fc13ac0474f4f57a4`). It has the same code on the three chains, and
it is the address of the relay unit tests. Run the probe again before you change the pin:

```sh
node scripts/dev/relay-local/probe-chains.mjs
```

## What you need

- Node 22.13 or later and the repository dependencies (`yarn install` at the repository root).
- Wrangler 4.151.3. `npx` installs it on the first run.
- Chrome.
- A new relayer key for this test only, funded with about 0.05 Sepolia ETH. The relayer pays the gas of every relay.
- A Sepolia JSON-RPC URL for the Worker. A free public one can work (`https://ethereum-sepolia-rpc.publicnode.com`
  worked for the account read). A provider URL is better: the Worker sends JSON-RPC batches, `eth_call` with a state
  override, `eth_feeHistory` and `eth_estimateGas` with an authorization list.
- Test funds to send to the deposit address:
  - Sepolia ETH from a faucet, for the Agglayer test with native ETH and for the gas of the mint below.
  - The Sepolia test USDC `0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69` (18 decimals). Its `mint(address,uint256)` is
    open to any caller (an `eth_call` from an address with no funds succeeds). Mint from a second wallet that has
    Sepolia ETH, for example with Foundry:
    `cast send 0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69 "mint(address,uint256)" <deposit address> 5000000000000000000 --rpc-url <Sepolia RPC> --account <your keystore account>`.

## 1. Make and fund the relayer key

```sh
node scripts/dev/relay-local/relayer-key.mjs new
```

The script copies `services/evm-relay/.dev.vars.example` to `services/evm-relay/.dev.vars` (mode 0600), writes a new
random `RELAYER_PRIVATE_KEY` into it and prints only the address. That address is the executor. Git ignores
`.dev.vars`. Do not copy the key to another place, and do not use this key for anything else.

To read the address again:

```sh
node scripts/dev/relay-local/relayer-key.mjs address
```

Send about 0.05 Sepolia ETH to the address.

## 2. Start the Worker

Edit `services/evm-relay/.dev.vars`:

- `RPC_URL_11155111`: your Sepolia JSON-RPC URL.
- `ALLOWED_ORIGINS`: keep the placeholder for now. You get the extension id in step 4.
- `GAS_MODE=sponsor` and `RELAY_CONFIG`: keep them as they are. `RELAY_CONFIG` names Sepolia with the Calibur pin
  above and no `allowedTargets`, so the relayer pays the gas of any batch that a relay address signs. To limit it,
  add `"allowedTargets":[...]` to the chain with every contract that the batches call: the Agglayer bridge
  `0x528e26b25a34a4a5d0dbda1d57d318153d2ed582`, the test USDC `0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69` (for
  `approve`) and the Epoch contracts (The Compact on Sepolia is `0x00000000000000171ede64904551eedf3c6c9788`, from
  `GET https://testnet-dev.epochprotocol.xyz/health`). A call to another address then fails with `target_not_allowed`.

Start the Worker:

```sh
cd services/evm-relay
npx wrangler@4.151.3 dev --ip 127.0.0.1 --port 8788 --compatibility-date 2026-10-26
```

`--compatibility-date 2026-10-26` is necessary: `wrangler.jsonc` sets `2026-11-20`, and the runtime of Wrangler
4.151.3 refuses it ("This Worker requires compatibility date "2026-11-20", but the newest date supported by this
server binary is "2026-10-26""). For the same reason `yarn dev` fails.

Wrangler shows each variable as `(hidden)` and prints `Ready on http://127.0.0.1:8788`. Keep this terminal open: it
shows one line for each request and the log lines of the Worker. The Durable Object state (the relay jobs and the
relayer nonce) goes to `services/evm-relay/.wrangler/state`.

## 3. Start the config server

In a second terminal, at the repository root:

```sh
node scripts/dev/relay-local/serve-config.mjs
```

It reads `services/evm-relay/.dev.vars`, fetches the published `testnet.json`, adds the relay and prints the relay
chain, the executor and the pin. It stops with a message when the wallet's parser refuses the document. Options:
`--port`, `--executor`, `--version`, `--network`, `--dev-vars`, `--check` (check and print, then stop). The document's
`relay.baseUrl` is `https://evm-relay.invalid`: the wallet must take the Worker from `MIDEN_EVM_RELAY_URL`, and a
build without it fails at that host and never calls a real one.

The wallet accepts only one document for one version. When you change the executor (a new key) or the pin after the
wallet read the document, start the server with a higher version, for example `--version 18`, or remove and load the
extension again (step 4).

## 4. Build and load the extension

At the repository root:

```sh
MIDEN_E2E_TEST=true MIDEN_NETWORK=testnet \
MIDEN_REMOTE_CONFIG_URL=http://127.0.0.1:8551 \
MIDEN_EVM_RELAY_URL=http://127.0.0.1:8788 \
yarn build:extension
```

(fish 3.1 and later reads the same line; else use `npx cross-env VAR=value ... yarn build:extension`.)

The build removes `dist/` and writes `dist/chrome_unpacked`. Then:

1. Open `chrome://extensions`, set Developer mode and click "Load unpacked". Select `dist/chrome_unpacked`.
2. Copy the id of the extension. Chrome makes it from the folder path, so it stays the same when you reload the same
   folder.
3. Set `ALLOWED_ORIGINS='["chrome-extension://<id>"]'` in `services/evm-relay/.dev.vars`. Stop the Worker (Ctrl-C)
   and start it again.
4. Run the smoke check (next step).
5. Open the extension and create a new testnet wallet. Do not import a wallet that holds real funds: this build has
   the test hooks (see "What this build changes").

### What this build changes

`MIDEN_E2E_TEST=true` is the only switch that lets the wallet read `MIDEN_REMOTE_CONFIG_URL`. It also:

- puts the test hooks on `globalThis` in every realm: `__TEST_STORE__` (the Zustand store), `__TEST_INTERCOM__`,
  `__TEST_BALANCE_READ_STATE__`, and in the service worker the swap, bridge-in and Agglayer faucet test hooks;
- lets `fullpage.html?__test_skip_onboarding=1&seed=<words>&password=<text>` make or import a wallet with no
  onboarding screens;
- accepts loopback `http:` service URLs in the served document (`allowLocalHttp`) and a loopback feature-eligibility
  endpoint;
- adds the E2E update-check adapter, the prove-timing markers and the offscreen fetch-fault restore;
- treats the token symbols `TST`, `SWPA` and `SWPB` as priced at 1 USD;
- keeps the test-authorization message path of the offscreen document;
- turns off `MIDEN_ELIGIBILITY_OPEN`. `FEATURE_ELIGIBILITY_URL` is empty in this build, so the startup eligibility
  check fails and the geo-gated features (Earn and Swap) stay off. Bridge-in and the deposit flow do not use that
  check. Set `FEATURE_ELIGIBILITY_URL` in the build line if you need them.

These variables keep their default, so the real behaviour stays on: `MIDEN_E2E_DISABLE_SIDEPANEL` (the side panel
hand-off works), `MIDEN_E2E_DISABLE_ENDPOINT_OVERRIDES` (Developer Settings overrides work), `E2E_EVM_RPC_URL` (the
EVM reads go to the normal RPCs). The defines are in `vite.background.config.ts`, `vite.extension.config.ts` and
`vite.contentScripts.config.ts`. `vite.contentScripts.config.ts` has no `MIDEN_EVM_RELAY_URL` define; the content
scripts do not use the relay.

## 5. Smoke check

With the Worker and the config server running:

```sh
node scripts/dev/relay-local/smoke.mjs --origin chrome-extension://<id>
```

Each line starts with `PASS` or `FAIL`. The script checks `/healthz`, the extension origin, the document (with the
wallet's parser) and `GET /v1/account` on Sepolia for a throwaway address. The executor of the Worker must be the
executor of the document, and the mode must be `sponsor`. Add `--address <deposit address>` to read your deposit
address: it prints `needsAuthorization` (true before the first relay of the address), `authorizationNonce`,
`sequence` (one more after each executed batch) and the balances of native ETH and the test USDC.

Result of the proof run (throwaway key, public RPC, 2026-11-26): all checks passed; a second origin got `403`.

## 6. Test an Agglayer deposit

1. Unlock the wallet. Keep it open during the test: the wallet signs the relay batch when the funds arrive, and the
   Worker keeps no deposit intent.
2. On Home, select "Deposit". Select native ETH on Sepolia (or USDC with the Agglayer route) and type a small amount,
   for example 0.001 ETH. The receipt shows "Network gas: Paid by Bread" (sponsor mode).
3. Review, then "Slide to show deposit address". The address screen shows the deposit address (`relayEvmAddress`), the
   same on every EVM chain, with no expiry, and "Waiting for your deposit".
4. From a second wallet or a faucet, send exactly the reviewed amount of Sepolia ETH to the deposit address.
5. When the balance reaches the reviewed amount, the wallet signs and relays with no tap: Processing shows "Deposit
   detected", then "Bridging to Miden", then "Arrived in Bread", then Success. Activity shows a bridged-receive row.
6. A smaller amount shows "Received X of Y" and an action to deposit X.

## 7. Test an Epoch deposit

Do the steps of the Agglayer test with the test USDC and the Epoch (fast) route: on the amount screen select USDC on
Sepolia and, at Route, the Epoch route. Type for example 5 USDC. Mint exactly that amount to the deposit address (see
"What you need"). The first relay of an address carries the EIP-7702 authorization; after it, the smoke check shows
`needsAuthorization false`.

## When it fails

- The Worker terminal. One line for each request with its status. The Worker log lines:
  - `evm-relay: the relayer account cannot pay the gas on chain 11155111.`: fund the relayer address.
  - `evm-relay: replaced the fee of nonce <n> on chain 11155111, attempt <k>.` and
    `evm-relay: cancelled nonce <n> on chain 11155111 after its deadline, attempt <k>.`: the Sender timer.
  - `evm-relay: a Sender tick failed on chain 11155111.`: a receipt read failed (often the RPC).
  - A line from `GET /v1/account` when the chain does not hold the pinned Calibur code or the domain is wrong: the pin
    in `RELAY_CONFIG` is not the chain's code. Run `probe-chains.mjs`.
- The job. The id of a relay is the `id` of the `POST /v1/relay` answer. Find it in the Network panel of the realm that
  sent it (`chrome://extensions`, the extension, "service worker", or the DevTools of the wallet page). Then:
  `curl "http://127.0.0.1:8788/v1/relay/<id>?chainId=11155111"`. `state` is `pending`, `succeeded`, `reverted` or
  `expired`; open `txHash` on `https://sepolia.etherscan.io/tx/<txHash>`.
- The error codes (`services/evm-relay/README.md`, "API contract"):
  - `403 origin_not_allowed`: the extension id is not in `ALLOWED_ORIGINS`.
  - `503 service_unavailable` or `/healthz` 503: a variable of `.dev.vars` does not parse, or the key or the RPC URL is
    not valid.
  - `503 relayer_unfunded`: fund the relayer.
  - `409 simulation_failed`: the batch reverts, for example the balance is below the amount or the bridge call fails.
  - `400 target_not_allowed`: a call goes to a contract that `allowedTargets` does not name.
  - `502 rpc_unavailable`: the RPC refused a batch or timed out. Use a provider URL.
- The wallet refuses the Worker's account (`RelayMismatchError`): the document's executor is not the Worker's key.
  Start `serve-config.mjs` again (it reads the key) with a higher `--version`.
- The deposit flow does not show: the wallet has no relay config. Check that `serve-config.mjs` printed
  `GET /testnet.json 200`, and look in the service worker console for `[remote-config]` warnings. "differs from the
  accepted document" means a changed document at the same version: use a higher `--version`.

## Clean up

1. Stop the Worker and the config server (Ctrl-C in each terminal).
2. Move the remaining Sepolia ETH out of the relayer address if you want it back.
3. Remove the key: delete `services/evm-relay/.dev.vars` (or its `RELAYER_PRIVATE_KEY` line). Delete
   `services/evm-relay/.wrangler/` (the local jobs and nonces) and `node_modules/.cache/relay-local/`.
4. Remove the unpacked extension in `chrome://extensions`. Its storage holds the test wallet and the document version
   that it accepted.
5. `rm -rf dist/chrome_unpacked`, and build again without the variables before other work. Never give an E2E build
   to another person.

## Known limits

- Only Sepolia has a relay route on testnet. The other test chains have only the Circle route.
- The Worker needs `--compatibility-date 2026-10-26` with Wrangler 4.151.3 (see step 2).
- The document's `relay.baseUrl` must be `https:`. A loopback Worker works only through `MIDEN_EVM_RELAY_URL`, so
  only the build define points the wallet at the local Worker.
- Without `allowedTargets`, the relayer pays the gas of any batch that a relay address signs. Use this only with a
  test key that holds little ETH.
- The wallet must be open and unlocked when the funds arrive.
- A public RPC can limit the request rate or the batch size. The Sender reads all receipts of one tick in one batch.
- The test USDC has 18 decimals, unlike Circle USDC.
- The wallet accepts a changed document only at a higher version.
- This is an E2E build: it has test hooks and no feature-eligibility endpoint.
- Deleting `.wrangler/state` makes the Worker forget its jobs: `GET /v1/relay/{id}` then answers `404`. The relayer
  nonce comes from the chain again.
