# usdcx-burn-l2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new live `yarn e2e:real --suite usdcx-burn-l2` with two Guardian tests that burn 1 USDCx through Send to the harness key's address on Base Sepolia (84532, Circle domain 6) and on Arbitrum Sepolia (421614, domain 3), and pass only once Circle's payout lands there and the wallet itself reads Confirmed; E2E USDCx runs it as a fourth step after the Arc suites, even when one of them failed.

**Architecture:** One `PayoutChain` descriptor per payout chain (Arc, Base Sepolia, Arbitrum Sepolia) in `usdcx-constants.ts`, read from the wallet's own tables. It rides on `ArcReadDeps` as an optional `payoutChain`, and every leg (driver, burn check, payout gate, wallet confirmation, details page) takes it with Arc as the default, so every Arc caller runs exactly as before. The L2 tests live in a new spec file, so the Arc spec files stay byte-for-byte; the runner gets its own suite entry and an `l2-payout` preflight probe; the workflow gets a fourth step with `if: ${{ !cancelled() && steps.usdcx_in.outcome != 'skipped' }}` (after any Arc suite result, never after a failed setup step).

**Tech Stack:** TypeScript, Playwright (extension), viem 2.55.4, jest (`@swc/jest`, node env), Node 22 ESM runner (`scripts/e2e-real.mjs`), GitHub Actions.

**Spec:** `/Users/celrisen/miden/wt-usdcx-e2e/.superpowers/l2-burn/design.md` (option C), with the scout reports `scout-1-gate.md`, `scout-2-ui.md`, `scout-3-endpoints.md` in the same folder, and the user decisions of 2026-10-12 (below, in Global Constraints). Where the decisions differ from the design (both L2 tests are Guardian, not standard on Base), the decisions win.

**Anchors:** every quoted "Replace" text is from `a1f77abdc` (PR 2b's head, #1427). Read it with `git -C /Users/celrisen/miden/wt-usdcx-ios-burn-b show a1f77abdc:<path>`.

## Global Constraints

- A SEPARATE e2e:real suite `usdcx-burn-l2`: own grep `USDCx L2 burn`, own preflight probe `l2-payout`, own CI step `Run usdcx-burn-l2` and artifact `usdcx-burn-l2-e2e-<run id>`.
- TWO tests, both GUARDIAN wallets: Guardian -> Base Sepolia (84532, Circle domain 6) and Guardian -> Arbitrum Sepolia (421614, domain 3).
- Chrome extension only. No iOS file changes (`playwright/e2e/ios/**` untouched).
- `.github/workflows/e2e-usdcx.yml`: a fourth suite step after the round trip that runs even when an Arc suite failed, `if: ${{ !cancelled() && steps.usdcx_in.outcome != 'skipped' }}`, the one exception to the workflow test's "no if" rule, with the test stating why. The decided `!cancelled()` is narrowed by the `usdcx_in` clause so a failed setup step still skips it: after a failed key write the runner would create a fresh harness key whose L2 payouts leave with the runner (Plan critique log F2; the user's OK is pending, fallback there). Its own upload; the job ceiling raised to push 295, dispatch 325 (pinned in `playwright/e2e/harness/linked-pr-injection.test.ts` and `usdcx-workflow.test.ts`).
- Both L2 tests gate on Circle's payout on the L2 (delta mode on the harness key, same address) AND on the wallet's own Confirmed through the shared gate `waitForWalletPayoutConfirmation` in `usdcx-legs.ts`.
- An Arbitrum (or Base) snapshot refusal at review fails as infra naming the RPC host (`rpc.walletconnect.org`), never its project id. No retry.
- Ethereum Sepolia (11155111) stays out, refused by name, citing 0xMiden/miden-usdcx#308.
- The Arc tests (`usdcx`, `usdcx-in`, `usdcx-burn`) stay byte-for-byte: `usdcx-burn.spec.ts` and `usdcx-roundtrip.spec.ts` are not edited; every changed helper defaults to Arc with Arc's exact values and messages; an Arc run's evidence gains no key.
- The domain trap: the burn note's attachment and its row carry the DESTINATION domain (6 or 3); `AttestationUsed.sourceDomain` is the Gateway source, 26, for every destination. Never swap them.
- Harness L2 read endpoints, in order: Base `https://base-sepolia-rpc.publicnode.com`, `https://base-sepolia.gateway.tenderly.co`, `https://sepolia.base.org` (200-block log chunk); Arbitrum `https://sepolia-rollup.arbitrum.io/rpc`, `https://arbitrum-sepolia-rpc.publicnode.com`, `https://arbitrum-sepolia.gateway.tenderly.co`. No drpc on either. The harness never reads through `rpc.walletconnect.org` except in a failure message's comparison read and the preflight's one head read.
- No product change: no file under `src/` is edited. `E2E_EVM_RPC_URL` stays refused for every usdcx suite.
- Commits: one per task, single line, exactly the message given; no `Co-Authored-By`, no tool name anywhere (commits, PR, comments). No em or en dashes in any text.
- Comment density: match the files touched (arc-usdcx.ts 9%, usdcx-legs.ts 10%, usdcx-burn.spec.ts 8%, e2e-real.mjs 21%, tests 2-5%). Comments say why, never what.
- Local gates (load rule): only the changed test files, red first then green, with `npx jest --maxWorkers=2 --testTimeout=60000 <files>`; every test file in each changed helper's directory once per task; prettier on changed files; mutation checks. No local `tsc`, full jest, `lint:e2e`, `lint:i18n` or builds except the live runs in Delivery. Coverage is unaffected: `collectCoverageFrom` is `src/**` and this change edits no `src` file.

## Review Focus

1. Arbitrum's WalletConnect RPC refuses the pre-burn snapshot (`unsupported block number N`, about 0.8% of burns): the test must fail as infra naming `rpc.walletconnect.org`, and the review-error it quotes carries the request URL, so the project id must be redacted. Pinned in Task 2 (`burnSubmitFailure` tests).
2. An Arc suite goes red and leaves a late Arc payout or a pending deposit, then the L2 step runs anyway: the L2 key snapshot and payout proof must read only the L2, never Arc, for the key. Pinned in Task 3 (`harnessPayoutLeg` L2 test whose Arc client throws on any read).
3. The wallet confirms on Arbitrum a few blocks after the payout through a lagging WalletConnect backend, or the gate's comparison read fails: the shared gate must accept a confirmation at or after the log block, refuse one before it, and name the L2's block and the wallet RPC by host only, its project id redacted from a failed read's viem text too. Pinned in Task 3 (`waitForWalletPayoutConfirmation` L2 tests, `redacts the project id ...` among them).
4. publicnode and tenderly both fail and the gate falls back to `sepolia.base.org`, which refuses more than 200 blocks: the gate must scan it in 200-block windows from the block after the snapshot. Pinned in Task 1 (`scans Base Sepolia's own RPC in 200-block windows`).
5. The wallet's L2 RPC is down, or the build bakes an operator `WALLETCONNECT_PROJECT_ID`: the preflight must fail before any faucet grant and print the host only. Pinned in Task 4 (`fails both wallet RPC checks ...`, `names the wallet RPC by host only ...`).

---

## Task 0: Preconditions (no commit)

- [ ] **Step 1: Confirm #1427 merged and the anchors still hold on main**

```bash
gh pr view 1427 --repo 0xMiden/wallet --json state,mergeCommit --jq '"\(.state) \(.mergeCommit.oid)"'
git -C /Users/celrisen/miden/wt-usdcx-e2e fetch origin
git -C /Users/celrisen/miden/wt-usdcx-e2e diff --stat a1f77abdc origin/main -- \
  playwright/e2e/helpers/usdcx-constants.ts playwright/e2e/helpers/arc-usdcx.ts playwright/e2e/helpers/arc-usdcx.test.ts \
  playwright/e2e/helpers/usdcx-legs.ts playwright/e2e/helpers/bridge.ts playwright/e2e/helpers/bridge.test.ts \
  playwright/e2e/tests/usdcx scripts/e2e-real.mjs scripts/e2e-real.test.ts scripts/e2e-real.fetch-stub.mjs \
  .github/workflows/e2e-usdcx.yml playwright/e2e/harness/usdcx-workflow.test.ts \
  playwright/e2e/harness/linked-pr-injection.test.ts playwright/e2e/harness/spec-selection.test.ts \
  playwright/e2e/docs/e2e-architecture.md playwright.usdcx.config.ts
```

Expected: `MERGED <sha>`, and an empty diffstat. If any file differs, re-read it on `origin/main` and re-anchor that file's "Replace" blocks before its task; `linked-pr-injection.test.ts` and `CHANGELOG.md` are the likeliest to have moved.

- [ ] **Step 2: Branch and worktree off main**

```bash
git -C /Users/celrisen/miden/wt-usdcx-e2e worktree add -b wiktor/usdcx-burn-l2 /Users/celrisen/miden/wt-usdcx-burn-l2 origin/main
cd /Users/celrisen/miden/wt-usdcx-burn-l2 && source ~/.nvm/nvm.sh && nvm use 22 && yarn install --frozen-lockfile
```

Expected: a clean tree on `wiktor/usdcx-burn-l2`. Every path below is relative to `/Users/celrisen/miden/wt-usdcx-burn-l2`.

---

### Task 1: Payout chain descriptor and L2 reads

Size: about 110 source lines, 200 test lines, one captured vectors file.

**Files:**
- Modify: `playwright/e2e/helpers/usdcx-constants.ts` (imports at 5-10, insert after 73)
- Modify: `playwright/e2e/helpers/arc-usdcx.ts` (36-53, 98-100, 185-205, 220-252, 268-269, 415-421, 440-451, 462-539, 577-626, 836, 929)
- Create: `playwright/e2e/helpers/usdcx-l2.vectors.json` (captured by a one-off read-only script, not committed)
- Test: `playwright/e2e/helpers/arc-usdcx.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (usdcx-constants.ts):
  - `interface PayoutChain { chainId: number; chain: Chain; label: string; rpcUrls: readonly string[]; usdc: Address; burnDomain: number; attestationSourceDomain: number; logChunk(endpoint: string): number; chip: string; reviewNetwork: string; networkName: string; explorer: string; walletRpcUrl: string; walletRpcName: string }`
  - `ARC_PAYOUT`, `BASE_SEPOLIA_PAYOUT`, `ARBITRUM_SEPOLIA_PAYOUT: PayoutChain`
  - `payoutChainFor(chainId: number, reads: { rpcUrls: readonly string[]; logChunk(endpoint: string): number; label?: string; walletRpcName?: string }): PayoutChain`
  - `L2_LOG_CHUNK = 1000`, `BASE_OFFICIAL_LOG_CHUNK = 200`, `DEFAULT_BASE_SEPOLIA_RPCS`, `DEFAULT_ARBITRUM_SEPOLIA_RPCS: readonly string[]`
- Produces (arc-usdcx.ts): `ArcReadDeps.payoutChain?: PayoutChain` (absent is Arc; `readArcUsdc`, `readArcUsdcSnapshot`, `waitForGatewayPayout` honour it; `readXReserveDomainState`, `submitDepositToMiden`, `confirmDepositToMiden` refuse any other chain with `<what> runs on Arc only, not on <networkName>`); `L2_LATE_PAYOUT_NOTE: string`.

- [ ] **Step 1: Capture the probe's two L2 payouts as unit vectors (read-only)**

Write this script OUTSIDE the repository and run it; it reads two public receipts and transactions and writes the vectors file. It sends no transaction and reads no key.

```bash
mkdir -p "$TMPDIR/l2cap" && cat > "$TMPDIR/l2cap/capture-l2-vectors.mjs" <<'EOF'
// One-off, read-only: the destination probe's two L2 payouts (2026-10-11) as the payout gate's unit vectors.
import { writeFileSync } from 'node:fs';

const TOPIC = '0xbb312ce0cc311b2cb0746e09ccd2f91fdb9e2ac755d2f11c65300eb0d0fffd63';
const DEPOSITOR = '0x000000000000000000000000b21c91a0f4d4c03f4b6a0fc5214f06e431ff2b2d';
const RECIPIENT = '0x6af7413cbc1fc53454539da54aaeffe1114fdc66';
const LOG_KEYS = ['address', 'topics', 'data', 'blockNumber', 'transactionHash', 'transactionIndex', 'blockHash', 'logIndex', 'removed'];
const TX_KEYS = ['blockHash', 'blockNumber', 'from', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'hash', 'input', 'nonce', 'to', 'transactionIndex', 'value', 'type', 'chainId', 'v', 'r', 's'];
const PAYOUTS = [
  {
    chainId: 84532,
    rpc: 'https://base-sepolia-rpc.publicnode.com',
    hash: '0x5097e4f585b117c51b9a11e9e90e10227c470072f35bb90aea3bfe8e4c293769',
    burnNoteId: '0x9327f5d4c5fb4ca6f002a569f63b4627991b3579c0d5257ef6875369d7f2b382'
  },
  {
    chainId: 421614,
    rpc: 'https://arbitrum-sepolia-rpc.publicnode.com',
    hash: '0x7db65d9daffc0412fc6672f15c8cd94ee0c4de4c989f1f98825f0d7cd845d102',
    burnNoteId: '0x6fcc7c9f6ad9cb71c3cfd56fe05c8f5e8b482b4aefd091f500c12e79cd52b962'
  }
];

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const body = await res.json();
  if (body.error || body.result === null) throw new Error(`${method}: ${JSON.stringify(body.error ?? 'null')}`);
  return body.result;
}
const pick = (object, keys) => Object.fromEntries(keys.map(key => [key, object[key]]));

const payouts = [];
for (const { chainId, rpc: url, hash, burnNoteId } of PAYOUTS) {
  const receipt = await rpc(url, 'eth_getTransactionReceipt', [hash]);
  const transaction = await rpc(url, 'eth_getTransactionByHash', [hash]);
  const logs = receipt.logs.filter(log => log.topics[0] === TOPIC);
  if (logs.length !== 1) throw new Error(`${hash}: ${logs.length} AttestationUsed logs`);
  const [log] = logs;
  const words = log.data.slice(2).match(/.{64}/g);
  const value = BigInt(`0x${words[3]}`);
  if (BigInt(`0x${words[0]}`) !== 26n) throw new Error(`${hash}: sourceDomain ${BigInt(`0x${words[0]}`)}`);
  if (`0x${words[1]}` !== DEPOSITOR) throw new Error(`${hash}: depositor 0x${words[1]}`);
  if (log.topics[2] !== `0x${RECIPIENT.slice(2).padStart(64, '0')}`) throw new Error(`${hash}: recipient ${log.topics[2]}`);
  if (!transaction.input.includes(burnNoteId.slice(2))) throw new Error(`${hash}: calldata lacks ${burnNoteId}`);
  payouts.push({
    chainId,
    burnNoteId,
    burnUnits: '1000000',
    recipient: RECIPIENT,
    value: String(value),
    fee: String(1_000_000n - value),
    log: pick(log, LOG_KEYS),
    transaction: pick(transaction, TX_KEYS)
  });
}
const vectors = {
  source:
    'Base Sepolia (84532) and Arbitrum Sepolia (421614) via publicnode, the destination probe payouts of 2026-10-11, captured 2026-10-12; public chain data only',
  depositor: DEPOSITOR,
  payouts
};
writeFileSync(process.argv[2], `${JSON.stringify(vectors, null, 2)}\n`);
console.log(payouts.map(p => `${p.chainId} value ${p.value} fee ${p.fee} block ${BigInt(p.log.blockNumber)}`).join('\n'));
EOF
node "$TMPDIR/l2cap/capture-l2-vectors.mjs" playwright/e2e/helpers/usdcx-l2.vectors.json
```

Expected output (verified against the live chains on 2026-10-12):

```
84532 value 988901 fee 11099 block 47984750
421614 value 988901 fee 11099 block 318137659
```

The log and transaction objects keep exactly the keys the Arc vectors keep, so the test's captured-log type covers both.

- [ ] **Step 2: Write the failing tests**

In `playwright/e2e/helpers/arc-usdcx.test.ts`:

Replace (lines 29-48, the `./arc-usdcx` import):

```ts
import {
  arcEndpoints,
  arcHost,
  assertDepositIntent,
  confirmDepositToMiden,
  decodeDepositIntent,
  KEY_MOVED_NOTE,
  LATE_PAYOUT_NOTE,
```

With:

```ts
import {
  arcEndpoints,
  arcHost,
  assertDepositIntent,
  confirmDepositToMiden,
  decodeDepositIntent,
  KEY_MOVED_NOTE,
  L2_LATE_PAYOUT_NOTE,
  LATE_PAYOUT_NOTE,
```

Replace (lines 52-79, the `./usdcx-constants` and `./usdcx-legs` imports):

```ts
import {
  ARC_ATTESTATION_API,
  ARC_CHAIN_ID,
  ARC_CIRCLE_DOMAIN,
  ARC_DRPC_URL,
  ARC_KEY_LEDGER_DIR,
  ARC_PUBLIC_URL,
  ARC_QUICKNODE_URL,
  ARC_READ_STEP_BUDGET_MS,
  ARC_RPC_TIMEOUT_MS,
  ARC_USDC,
  ARC_XRESERVE,
  ATTESTATION_USED_TOPIC,
  BURN_UNITS,
  DEFAULT_ARC_RPCS,
  DEPOSIT_UNITS,
  FEE_RESERVE_MULTIPLE,
  GAS_RESERVE_UNITS,
  GATEWAY_MINTER,
  GRANT_MARGIN_UNITS,
  GRANT_UNITS,
  HARNESS_ARC_KEY_FILE,
  isWorthClaiming,
  minimumUsdcxPayout,
  PAYOUT_TIMEOUT_MS,
  WALLET_CONFIRM_TIMEOUT_MS
} from './usdcx-constants';
import { harnessPayoutLeg, payoutLeg, waitForWalletPayoutConfirmation } from './usdcx-legs';
```

With:

```ts
import {
  ARBITRUM_SEPOLIA_PAYOUT,
  ARC_ATTESTATION_API,
  ARC_CHAIN_ID,
  ARC_CIRCLE_DOMAIN,
  ARC_DRPC_URL,
  ARC_KEY_LEDGER_DIR,
  ARC_PAYOUT,
  ARC_PUBLIC_URL,
  ARC_QUICKNODE_URL,
  ARC_READ_STEP_BUDGET_MS,
  ARC_RPC_TIMEOUT_MS,
  ARC_USDC,
  ARC_XRESERVE,
  ATTESTATION_USED_TOPIC,
  BASE_OFFICIAL_LOG_CHUNK,
  BASE_SEPOLIA_PAYOUT,
  BURN_UNITS,
  DEFAULT_ARC_RPCS,
  DEPOSIT_UNITS,
  FEE_RESERVE_MULTIPLE,
  GAS_RESERVE_UNITS,
  GATEWAY_MINTER,
  GRANT_MARGIN_UNITS,
  GRANT_UNITS,
  HARNESS_ARC_KEY_FILE,
  isWorthClaiming,
  L2_LOG_CHUNK,
  minimumUsdcxPayout,
  PAYOUT_TIMEOUT_MS,
  payoutChainFor,
  WALLET_CONFIRM_TIMEOUT_MS
} from './usdcx-constants';
import l2Vectors from './usdcx-l2.vectors.json';
import { harnessPayoutLeg, payoutLeg, waitForWalletPayoutConfirmation } from './usdcx-legs';
```

Replace (line 84):

```ts
import { ARC_TESTNET } from '../../../src/lib/walletconnect/config';
```

With:

```ts
import { ARC_TESTNET, WC_PROJECT_ID } from '../../../src/lib/walletconnect/config';
```

Replace (lines 215-219):

```ts
function payoutAt(index: number): (typeof arcVectors.payouts)[number] {
  const payout = arcVectors.payouts[index];
  if (!payout) throw new Error(`arc-usdcx.vectors.json has no payout ${index}`);
  return payout;
}
```

With:

```ts
function payoutAt(index: number): (typeof arcVectors.payouts)[number] {
  const payout = arcVectors.payouts[index];
  if (!payout) throw new Error(`arc-usdcx.vectors.json has no payout ${index}`);
  return payout;
}

function l2PayoutOn(chainId: number): (typeof l2Vectors.payouts)[number] {
  const payout = l2Vectors.payouts.find(candidate => candidate.chainId === chainId);
  if (!payout) throw new Error(`usdcx-l2.vectors.json has no payout on chain ${chainId}`);
  return payout;
}
```

Replace (lines 429-431, inside `payoutChain`):

```ts
  const transactions = new Map<string, unknown>(
    arcVectors.payouts.map(payout => [payout.transaction.hash, payout.transaction])
  );
```

With:

```ts
  const transactions = new Map<string, unknown>(
    [...arcVectors.payouts, ...l2Vectors.payouts].map(payout => [payout.transaction.hash, payout.transaction])
  );
```

Insert after line 769 (the closing `});` of `describe('waitForGatewayPayout delta mode', ...)`, before the `paidTo` helper):

```ts
describe('payout chains (usdcx-constants.ts)', () => {
  it("keeps Arc's payout chain exactly the Arc values every Arc test read before the L2 suite", () => {
    expect(ARC_PAYOUT).toMatchObject({
      chainId: ARC_CHAIN_ID,
      chain: ARC_TESTNET,
      label: 'Arc',
      rpcUrls: DEFAULT_ARC_RPCS,
      usdc: ARC_USDC,
      burnDomain: ARC_CIRCLE_DOMAIN,
      attestationSourceDomain: ARC_CIRCLE_DOMAIN,
      chip: 'send-network-arc-testnet',
      reviewNetwork: 'arc-testnet',
      networkName: 'Arc Testnet',
      explorer: ARC_TESTNET.blockExplorers.default.url,
      walletRpcUrl: ARC_PUBLIC_URL,
      walletRpcName: 'arc.io'
    });
  });

  it("reads each L2 from the wallet's tables: the burn carries its own domain, every payout Arc's 26", () => {
    expect(BASE_SEPOLIA_PAYOUT).toMatchObject({
      chainId: 84532,
      label: 'Base Sepolia',
      rpcUrls: [
        'https://base-sepolia-rpc.publicnode.com',
        'https://base-sepolia.gateway.tenderly.co',
        'https://sepolia.base.org'
      ],
      usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      burnDomain: 6,
      attestationSourceDomain: 26,
      chip: 'send-network-base-sepolia',
      reviewNetwork: 'base-sepolia',
      networkName: 'Base Sepolia',
      explorer: 'https://sepolia.basescan.org',
      walletRpcName: 'rpc.walletconnect.org'
    });
    expect(ARBITRUM_SEPOLIA_PAYOUT).toMatchObject({
      chainId: 421614,
      label: 'Arbitrum Sepolia',
      rpcUrls: [
        'https://sepolia-rollup.arbitrum.io/rpc',
        'https://arbitrum-sepolia-rpc.publicnode.com',
        'https://arbitrum-sepolia.gateway.tenderly.co'
      ],
      usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
      burnDomain: 3,
      attestationSourceDomain: 26,
      chip: 'send-network-arbitrum-sepolia',
      reviewNetwork: 'arbitrum-sepolia',
      networkName: 'Arbitrum Sepolia',
      explorer: 'https://sepolia.arbiscan.io',
      walletRpcName: 'rpc.walletconnect.org'
    });
    for (const chain of [BASE_SEPOLIA_PAYOUT, ARBITRUM_SEPOLIA_PAYOUT]) {
      expect(chain.walletRpcUrl).toBe(
        `https://rpc.walletconnect.org/v1?chainId=eip155:${chain.chainId}&projectId=${WC_PROJECT_ID}`
      );
      // drpc fails near the head on both L2s, and the wallet's own RPC is what the tests check.
      expect(chain.rpcUrls.filter(url => /drpc|walletconnect/.test(url))).toEqual([]);
    }
  });

  it('refuses Ethereum Sepolia by name, since Circle never pays a burn out there, and a chain Send does not offer', () => {
    const reads = { rpcUrls: [], logChunk: () => L2_LOG_CHUNK };
    expect(() => payoutChainFor(11155111, reads)).toThrow(
      'Ethereum Sepolia (11155111) is no harness payout chain: Circle consumes a burn to it but never pays it out ' +
        '(0xMiden/miden-usdcx#308)'
    );
    expect(() => payoutChainFor(1, reads)).toThrow('chain 1 is not a Send destination');
  });

  it("scans Base Sepolia's own RPC in 200-block windows, Arc's drpc in 100 and every other endpoint in 1000", () => {
    expect([BASE_OFFICIAL_LOG_CHUNK, L2_LOG_CHUNK]).toEqual([200, 1000]);
    expect(BASE_SEPOLIA_PAYOUT.rpcUrls.map(url => BASE_SEPOLIA_PAYOUT.logChunk(url))).toEqual([1000, 1000, 200]);
    expect(ARBITRUM_SEPOLIA_PAYOUT.rpcUrls.map(url => ARBITRUM_SEPOLIA_PAYOUT.logChunk(url))).toEqual([
      1000, 1000, 1000
    ]);
    expect(DEFAULT_ARC_RPCS.map(url => ARC_PAYOUT.logChunk(url))).toEqual([100, 1000, 1000]);
  });

  it('gives an L2 read step the Arc read budget, which outlasts a stall on every L2 endpoint', () => {
    for (const chain of [BASE_SEPOLIA_PAYOUT, ARBITRUM_SEPOLIA_PAYOUT]) {
      expect(chain.rpcUrls.length * ARC_RPC_TIMEOUT_MS + 15_000).toBeLessThanOrEqual(ARC_READ_STEP_BUDGET_MS);
    }
  });
});

describe('reads on an L2 payout chain', () => {
  const RECIPIENT = addressOf(l2PayoutOn(84532).recipient);

  it("reads the L2's own USDC and names the L2 when no endpoint answers", async () => {
    const asked: string[] = [];
    const answering = stubClient((_method, params) => {
      const [request] = params;
      asked.push(String(request !== null && typeof request === 'object' ? Reflect.get(request, 'to') : ''));
      return encodeUint(988_901n);
    });
    const reads = {
      endpoints: ['https://base-sepolia-rpc.publicnode.com'],
      publicClient: () => answering,
      payoutChain: BASE_SEPOLIA_PAYOUT
    };
    await expect(readArcUsdc(RECIPIENT, reads)).resolves.toBe(988_901n);
    expect(asked.map(to => to.toLowerCase())).toEqual([BASE_SEPOLIA_PAYOUT.usdc.toLowerCase()]);
    const failing = stubClient(() => {
      throw rpcError(-32005, 'rate limit exceeded');
    });
    await expect(readArcUsdcSnapshot(RECIPIENT, { ...reads, publicClient: () => failing })).rejects.toThrow(
      /^Base Sepolia USDC snapshot of 0x[0-9a-fA-F]{40}: no Base Sepolia endpoint answered\n {2}base-sepolia-rpc\.publicnode\.com: /
    );
  });

  it('refuses an L2 deps object where only Arc applies: the xReserve state and both deposit legs, building no client', async () => {
    const built: string[] = [];
    const l2 = {
      endpoints: ['https://base-sepolia-rpc.publicnode.com'],
      payoutChain: BASE_SEPOLIA_PAYOUT,
      publicClient: (endpoint: string) => {
        built.push(endpoint);
        return stubClient(() => null);
      }
    };
    await expect(readXReserveDomainState(l2)).rejects.toThrow(
      'xReserve domain state runs on Arc only, not on Base Sepolia'
    );
    await expect(
      submitDepositToMiden(
        {
          privateKey: `0x${'11'.repeat(32)}`,
          units: DEPOSIT_UNITS,
          recipientHex: '0xf2f42cda8d010f417d1cad5dc4d52b',
          approve: 'exact'
        },
        l2
      )
    ).rejects.toThrow('the xReserve deposit runs on Arc only, not on Base Sepolia');
    await expect(
      confirmDepositToMiden(
        {
          endpoint: 'https://base-sepolia-rpc.publicnode.com',
          depositHash: hexOf(arcVectors.deposit.transactionHash),
          approved: false
        },
        l2
      )
    ).rejects.toThrow('the xReserve deposit receipt runs on Arc only, not on Base Sepolia');
    expect(built).toEqual([]);
  });
});

describe('waitForGatewayPayout on an L2', () => {
  const CONSUME_MS = 1_791_638_693_000;
  const BASE = l2PayoutOn(84532);
  const ENDPOINT = 'https://base-sepolia-rpc.publicnode.com';
  const args = {
    recipient: addressOf(BASE.recipient),
    burnNoteId: hexOf(BASE.burnNoteId),
    burnUnits: BigInt(BASE.burnUnits),
    fromBlock: 66483700n,
    consumeTsMs: CONSUME_MS,
    deadlineMs: CONSUME_MS + PAYOUT_TIMEOUT_MS,
    depositor: hexOf(l2Vectors.depositor),
    minimumValue: minimumUsdcxPayout(84532, BigInt(BASE.burnUnits))
  };
  const paid = movedTo(BASE.log, 66483812n);
  const baseReads = (world: Rpc, endpoint = ENDPOINT) => ({
    endpoints: [endpoint],
    publicClient: () => stubClient(world),
    clock: fakeClock(CONSUME_MS + 7_000),
    payoutChain: BASE_SEPOLIA_PAYOUT
  });

  it("proves the probe's Base Sepolia payout: Base's USDC in the token topic, Arc's domain 26 as the source", async () => {
    const payout = await waitForGatewayPayout(args, baseReads(payoutChain({ balances: [988_901n], logs: [paid] })));
    expect(payout).toMatchObject({
      endpoint: ENDPOINT,
      value: 988_901n,
      balance: 988_901n,
      logBlock: 66483812n,
      transactionHash: BASE.transaction.hash,
      sourceDomain: 26,
      sourceDepositor: l2Vectors.depositor,
      fee: 11_099n,
      latencyMs: 7_000
    });
  });

  it.each(l2Vectors.payouts.map(payout => [payout.chainId, payout]))(
    'correlates the probe payout on chain %s, Circle keeping 11099',
    async (chainId, payout) => {
      const chain = [BASE_SEPOLIA_PAYOUT, ARBITRUM_SEPOLIA_PAYOUT].find(candidate => candidate.chainId === chainId);
      if (!chain) throw new Error(`no payout chain ${chainId}`);
      const correlated = await waitForGatewayPayout(
        {
          ...args,
          recipient: addressOf(payout.recipient),
          burnNoteId: hexOf(payout.burnNoteId),
          minimumValue: minimumUsdcxPayout(chain.chainId, BigInt(payout.burnUnits))
        },
        {
          endpoints: [chain.rpcUrls[0] ?? ''],
          publicClient: () =>
            stubClient(payoutChain({ balances: [BigInt(payout.value)], logs: [movedTo(payout.log, 66483812n)] })),
          clock: fakeClock(CONSUME_MS),
          payoutChain: chain
        }
      );
      expect({ value: correlated.value, fee: correlated.fee }).toEqual({ value: 988_901n, fee: 11_099n });
    }
  );

  // The token topic is the paid chain's USDC: under Arc's, an L2 payout is invisible.
  it("finds no log for an L2 payout under Arc's token topic, so the gate must filter on the L2's USDC", async () => {
    const failure = waitForGatewayPayout(args, {
      endpoints: [ENDPOINT],
      publicClient: () => stubClient(payoutChain({ balances: [988_901n], logs: [paid] })),
      clock: fakeClock(CONSUME_MS)
    });
    await expect(failure).rejects.toMatchObject({ failure: 'uncorrelated' });
    await expect(failure).rejects.toThrow('found 0 AttestationUsed logs');
    await expect(failure).rejects.toThrow(LATE_PAYOUT_NOTE);
  });

  it("fails uncorrelated on a payout naming the burn's domain 6 as its source, ending with the L2 note", async () => {
    const asBurnDomain = { ...paid, data: `0x${(6).toString(16).padStart(64, '0')}${paid.data.slice(66)}` };
    const failure = waitForGatewayPayout(
      args,
      baseReads(payoutChain({ balances: [988_901n], logs: [asBurnDomain] }))
    );
    await expect(failure).rejects.toMatchObject({ failure: 'uncorrelated' });
    await expect(failure).rejects.toThrow('sourceDomain 6, expected 26');
    await expect(failure).rejects.toThrow(L2_LATE_PAYOUT_NOTE);
    await expect(failure).rejects.not.toThrow(LATE_PAYOUT_NOTE);
  });

  it("scans Base Sepolia's own RPC in 200-block windows from the block after the snapshot", async () => {
    const payout = await waitForGatewayPayout(
      { ...args, fromBlock: 66483400n },
      baseReads(payoutChain({ balances: [988_901n], logs: [paid] }), 'https://sepolia.base.org')
    );
    expect(payout.ranges.map(range => `${range.fromBlock}-${range.toBlock}`)).toEqual([
      '66483401-66483600',
      '66483601-66483800',
      '66483801-66483822'
    ]);
  });

  it('names the L2 when the gate has no endpoint', async () => {
    await expect(waitForGatewayPayout(args, { endpoints: [], payoutChain: BASE_SEPOLIA_PAYOUT })).rejects.toThrow(
      'waitForGatewayPayout: no Base Sepolia endpoints'
    );
  });
});
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/helpers/arc-usdcx.test.ts -t 'payout chains|on an L2'`

Expected: FAIL. Every new test fails (`TypeError: Cannot read properties of undefined (reading 'chainId')` or `'rpcUrls'` from the missing exports, `payoutChainFor is not a function`, a wrong message such as `no Arc endpoint answered`, or `found 0 AttestationUsed logs` where `sourceDomain 6` is expected), except `finds no log for an L2 payout under Arc's token topic`, which passes already: it pins the trap the change must keep. No test outside the three new describes fails.

- [ ] **Step 4: Write the implementation**

**4a. `playwright/e2e/helpers/usdcx-constants.ts`**

Replace (lines 1-10):

```ts
/**
 * The fixed numbers of the USDCx live suites (spec section 5) and the Arc Testnet addresses, read from the product's
 * own tables so the harness and the wallet cannot drift apart. Nothing here reads the environment.
 */
import os from 'os';
import path from 'path';
import type { Address, Hex } from 'viem';

import { getUsdcxXReserveSource } from '../../../src/lib/usdcx/constant';
import { ARC_TESTNET } from '../../../src/lib/walletconnect/config';
```

With:

```ts
/**
 * The fixed numbers of the USDCx live suites (spec section 5), the Arc Testnet addresses and the chains a burn's payout
 * is read on, read from the product's own tables so the harness and the wallet cannot drift apart. Nothing here reads
 * the environment; an L2's `walletRpcUrl` is the wallet module's, whose project id follows WALLETCONNECT_PROJECT_ID.
 */
import os from 'os';
import path from 'path';
import type { Address, Chain, Hex } from 'viem';

import { getUsdcxDestination, getUsdcxXReserveSource } from '../../../src/lib/usdcx/constant';
import { ARC_TESTNET, getChain } from '../../../src/lib/walletconnect/config';
import { getBridgeNetworkByChainId } from '../../../src/screens/send-flow/bridge-networks';
```

Replace (line 73):

```ts
export const GUARDIAN_ECDSA_SCHEME = 'ecdsa';
```

With:

```ts
export const GUARDIAN_ECDSA_SCHEME = 'ecdsa';

/** Every L2 endpoint below served 10_000-block eth_getLogs when probed (2026-10-11); 1000 keeps a scan to a few calls. */
export const L2_LOG_CHUNK = 1000;
/** Base Sepolia's own RPC refuses an eth_getLogs over more than 200 blocks (-32614 `limited to a 200 range`). */
export const BASE_OFFICIAL_LOG_CHUNK = 200;
const BASE_SEPOLIA_OFFICIAL_URL = 'https://sepolia.base.org';
/**
 * The harness's L2 read endpoints, in the order the payout gate tries them. drpc is left out: near the head it fails
 * even a 100-block log scan. Never the wallet's own RPC (rpc.walletconnect.org), whose reads the tests check.
 */
export const DEFAULT_BASE_SEPOLIA_RPCS: readonly string[] = [
  'https://base-sepolia-rpc.publicnode.com',
  'https://base-sepolia.gateway.tenderly.co',
  BASE_SEPOLIA_OFFICIAL_URL
];
export const DEFAULT_ARBITRUM_SEPOLIA_RPCS: readonly string[] = [
  'https://sepolia-rollup.arbitrum.io/rpc',
  'https://arbitrum-sepolia-rpc.publicnode.com',
  'https://arbitrum-sepolia.gateway.tenderly.co'
];
/** Ethereum Sepolia takes a burn, but Circle has never paid one out there (0xMiden/miden-usdcx#308). */
const ETHEREUM_SEPOLIA_CHAIN_ID = 11155111;

/**
 * A chain a burn's payout lands on: what the harness reads there, the domains the burn and the payout carry, and what
 * the Send flow and the details page show. Arc's values are exactly the ones its tests read before the L2 suite.
 */
export interface PayoutChain {
  chainId: number;
  /** The viem chain the harness's read clients are built on. */
  chain: Chain;
  /** How messages name the chain; Arc's `Arc` keeps every Arc message as it was. */
  label: string;
  rpcUrls: readonly string[];
  usdc: Address;
  /** The destination's Circle domain, which the burn note's attachment and its row carry: 26, 6 or 3. */
  burnDomain: number;
  /** `AttestationUsed.sourceDomain`, the Gateway source: Arc's 26 for every destination, never `burnDomain`. */
  attestationSourceDomain: number;
  logChunk(endpoint: string): number;
  /** The Send flow's chip test id, the review's `network=` and its Network row (bridge-networks.ts). */
  chip: string;
  reviewNetwork: string;
  networkName: string;
  /** The explorer the details page links (walletconnect/config.ts). */
  explorer: string;
  /** The wallet's own RPC for the chain, and the name a message gives it: never the URL, which carries a project id. */
  walletRpcUrl: string;
  walletRpcName: string;
}

const hostnameOf = (endpoint: string): string => {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return '';
  }
};

/** drpc refuses a 1000-block eth_getLogs on Arc with a misleading "ranges over 10000 blocks"; the rest take 1000. */
function arcLogChunk(endpoint: string): number {
  return hostnameOf(endpoint).includes('drpc') ? ARC_DRPC_LOG_CHUNK : ARC_LOG_CHUNK;
}

/**
 * The payout chain of `chainId`, its values read from the wallet's own tables; `reads` is the harness's side. Refuses
 * Ethereum Sepolia by name, and any chain the Send flow does not offer.
 */
export function payoutChainFor(
  chainId: number,
  reads: { rpcUrls: readonly string[]; logChunk(endpoint: string): number; label?: string; walletRpcName?: string }
): PayoutChain {
  if (chainId === ETHEREUM_SEPOLIA_CHAIN_ID) {
    throw new Error(
      'Ethereum Sepolia (11155111) is no harness payout chain: Circle consumes a burn to it but never pays it out ' +
        '(0xMiden/miden-usdcx#308)'
    );
  }
  const network = getBridgeNetworkByChainId(chainId);
  const evm = getChain(chainId);
  if (network === undefined || evm === undefined) throw new Error(`chain ${chainId} is not a Send destination`);
  const destination = getUsdcxDestination(chainId);
  return {
    chainId,
    chain: destination.chain,
    label: reads.label ?? network.name,
    rpcUrls: reads.rpcUrls,
    usdc: destination.usdc,
    burnDomain: destination.domain,
    attestationSourceDomain: ARC_CIRCLE_DOMAIN,
    logChunk: reads.logChunk,
    chip: `send-network-${network.id}`,
    reviewNetwork: network.id,
    networkName: network.name,
    explorer: evm.explorer,
    walletRpcUrl: evm.rpcUrl,
    walletRpcName: reads.walletRpcName ?? hostnameOf(evm.rpcUrl)
  };
}

export const ARC_PAYOUT: PayoutChain = payoutChainFor(ARC_CHAIN_ID, {
  rpcUrls: DEFAULT_ARC_RPCS,
  logChunk: arcLogChunk,
  label: 'Arc',
  walletRpcName: 'arc.io'
});
export const BASE_SEPOLIA_PAYOUT: PayoutChain = payoutChainFor(84532, {
  rpcUrls: DEFAULT_BASE_SEPOLIA_RPCS,
  logChunk: endpoint =>
    hostnameOf(endpoint) === hostnameOf(BASE_SEPOLIA_OFFICIAL_URL) ? BASE_OFFICIAL_LOG_CHUNK : L2_LOG_CHUNK
});
export const ARBITRUM_SEPOLIA_PAYOUT: PayoutChain = payoutChainFor(421614, {
  rpcUrls: DEFAULT_ARBITRUM_SEPOLIA_RPCS,
  logChunk: () => L2_LOG_CHUNK
});
```

**4b. `playwright/e2e/helpers/arc-usdcx.ts`**

Replace (lines 27-29 of the viem import):

```ts
  type Address,
  type Hash,
```

With:

```ts
  type Address,
  type Chain,
  type Hash,
```

Replace (lines 36-53):

```ts
import {
  ARC_CHAIN_ID,
  ARC_CIRCLE_DOMAIN,
  ARC_DRPC_LOG_CHUNK,
  ARC_LOG_CHUNK,
  ARC_RPC_TIMEOUT_MS,
  ARC_USDC,
  ARC_XRESERVE,
  ATTESTATION_USED_TOPIC,
  DEFAULT_ARC_RPCS,
  GATEWAY_MINTER,
  realArcClock,
  USDCX_REMOTE_DOMAIN,
  type ArcClock
} from './usdcx-constants';
import { fetchXReserveAttestations, type XReserveAttestation } from '../../../src/lib/usdcx/attestation';
import { midenAccountHexToXReserveRecipient } from '../../../src/lib/usdcx/recipient';
import { ARC_TESTNET } from '../../../src/lib/walletconnect/config';
```

With:

```ts
import {
  ARC_CHAIN_ID,
  ARC_PAYOUT,
  ARC_RPC_TIMEOUT_MS,
  ARC_USDC,
  ARC_XRESERVE,
  ATTESTATION_USED_TOPIC,
  DEFAULT_ARC_RPCS,
  GATEWAY_MINTER,
  realArcClock,
  USDCX_REMOTE_DOMAIN,
  type ArcClock,
  type PayoutChain
} from './usdcx-constants';
import { fetchXReserveAttestations, type XReserveAttestation } from '../../../src/lib/usdcx/attestation';
import { midenAccountHexToXReserveRecipient } from '../../../src/lib/usdcx/recipient';
```

Replace (lines 98-100):

```ts
export const LATE_PAYOUT_NOTE =
  'Arc payouts have arrived up to ~17 h late and one 1 USDCx burn of 2026-10-08 was still unpaid after 45 h; red means a user was not paid in time';
```

With:

```ts
export const LATE_PAYOUT_NOTE =
  'Arc payouts have arrived up to ~17 h late and one 1 USDCx burn of 2026-10-08 was still unpaid after 45 h; red means a user was not paid in time';
/** LATE_PAYOUT_NOTE's place on Base Sepolia and Arbitrum Sepolia, which have no history of late payouts yet. */
export const L2_LATE_PAYOUT_NOTE =
  'Base Sepolia and Arbitrum Sepolia payouts landed 6-8 s after the consume when probed on 2026-10-11; red means a user was not paid in time';
```

Replace (lines 185-205):

```ts
export interface ArcReadDeps {
  endpoints: readonly string[];
  publicClient?: ArcPublicClientFactory;
  clock?: ArcClock;
}

/** Writes sign locally with the key and send raw through the read client, so they need nothing more. */
export type ArcWriteDeps = ArcReadDeps;

function defaultPublicClient(endpoint: string): PublicClient {
  // cacheTime 0: viem caches eth_blockNumber for its polling interval, and every payout cycle needs a fresh head.
  return createPublicClient({
    chain: ARC_TESTNET,
    cacheTime: 0,
    transport: http(endpoint, { retryCount: 0, timeout: ARC_RPC_TIMEOUT_MS })
  });
}

function clientFor(deps: ArcReadDeps): ArcPublicClientFactory {
  return deps.publicClient ?? defaultPublicClient;
}
```

With:

```ts
export interface ArcReadDeps {
  endpoints: readonly string[];
  publicClient?: ArcPublicClientFactory;
  clock?: ArcClock;
  /** The chain the key's balance and payout are read on; absent is Arc. xReserve and the deposit refuse any other. */
  payoutChain?: PayoutChain;
}

/** Writes sign locally with the key and send raw through the read client, so they need nothing more. */
export type ArcWriteDeps = ArcReadDeps;

function defaultPublicClient(endpoint: string, chain: Chain): PublicClient {
  // cacheTime 0: viem caches eth_blockNumber for its polling interval, and every payout cycle needs a fresh head.
  return createPublicClient({
    chain,
    cacheTime: 0,
    transport: http(endpoint, { retryCount: 0, timeout: ARC_RPC_TIMEOUT_MS })
  });
}

function chainOf(deps: ArcReadDeps): PayoutChain {
  return deps.payoutChain ?? ARC_PAYOUT;
}

/** xReserve and the deposit exist on Arc alone, and a deposit signs with Arc's chain id: an L2 endpoint is refused. */
function arcOnly(deps: ArcReadDeps, what: string): void {
  const chain = chainOf(deps);
  if (chain.chainId !== ARC_CHAIN_ID) throw new Error(`${what} runs on Arc only, not on ${chain.networkName}`);
}

function clientFor(deps: ArcReadDeps): ArcPublicClientFactory {
  return deps.publicClient ?? (endpoint => defaultPublicClient(endpoint, chainOf(deps).chain));
}
```

Replace (line 220):

```ts
  throw new Error(`${what}: no Arc endpoint answered\n  ${failures.join('\n  ') || 'no endpoints'}`);
```

With:

```ts
  throw new Error(`${what}: no ${chainOf(deps).label} endpoint answered\n  ${failures.join('\n  ') || 'no endpoints'}`);
```

Replace (lines 223-228):

```ts
/** USDC balance of `address` at `blockNumber` (default latest), from the first endpoint that answers. */
export async function readArcUsdc(address: Address, deps: ArcReadDeps, blockNumber?: bigint): Promise<bigint> {
  return onFirstEndpoint(deps, `Arc USDC balance of ${address}`, client =>
    client.readContract({ address: ARC_USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [address], blockNumber })
  );
}
```

With:

```ts
/** USDC balance of `address` at `blockNumber` (default latest), from the first endpoint that answers. */
export async function readArcUsdc(address: Address, deps: ArcReadDeps, blockNumber?: bigint): Promise<bigint> {
  const { label, usdc } = chainOf(deps);
  return onFirstEndpoint(deps, `${label} USDC balance of ${address}`, client =>
    client.readContract({ address: usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [address], blockNumber })
  );
}
```

Replace (inside `readArcUsdcSnapshot`):

```ts
export async function readArcUsdcSnapshot(address: Address, deps: ArcReadDeps): Promise<ArcUsdcSnapshot> {
  return onFirstEndpoint(deps, `Arc USDC snapshot of ${address}`, async (client, endpoint) => {
    const blockNumber = await client.getBlockNumber();
    const balance = await client.readContract({
      address: ARC_USDC,
```

With:

```ts
export async function readArcUsdcSnapshot(address: Address, deps: ArcReadDeps): Promise<ArcUsdcSnapshot> {
  const { label, usdc } = chainOf(deps);
  return onFirstEndpoint(deps, `${label} USDC snapshot of ${address}`, async (client, endpoint) => {
    const blockNumber = await client.getBlockNumber();
    const balance = await client.readContract({
      address: usdc,
```

Replace (lines 267-269):

```ts
/** Miden's domain on Arc's xReserve, all reads on one endpoint. */
export async function readXReserveDomainState(deps: ArcReadDeps): Promise<XReserveDomainState> {
  return onFirstEndpoint(deps, 'xReserve domain state', async (client, endpoint) => {
```

With:

```ts
/** Miden's domain on Arc's xReserve, all reads on one endpoint. */
export async function readXReserveDomainState(deps: ArcReadDeps): Promise<XReserveDomainState> {
  arcOnly(deps, 'xReserve domain state');
  return onFirstEndpoint(deps, 'xReserve domain state', async (client, endpoint) => {
```

Replace (lines 415-421):

```ts
function logChunkFor(endpoint: string): number {
  try {
    return new URL(endpoint).hostname.includes('drpc') ? ARC_DRPC_LOG_CHUNK : ARC_LOG_CHUNK;
  } catch {
    return ARC_LOG_CHUNK;
  }
}
```

With:

```ts
function lateNote(chain: PayoutChain): string {
  return chain.chainId === ARC_CHAIN_ID ? LATE_PAYOUT_NOTE : L2_LATE_PAYOUT_NOTE;
}
```

Replace (line 440):

```ts
  /** The Arc block `balanceBefore` was read at, before the burn was queued; only logs after it count. */
```

With:

```ts
  /** The payout chain's block `balanceBefore` was read at, before the burn was queued; only logs after it count. */
```

Replace (line 450):

```ts
  /** `minimumUsdcxPayout(ARC_CHAIN_ID, burnUnits)`, the floor the wallet's own confirmation uses. */
```

With:

```ts
  /** `minimumUsdcxPayout(<payout chain id>, burnUnits)`, the floor the wallet's own confirmation uses. */
```

Replace (lines 462-477):

```ts
async function payoutCycle(
  client: PublicClient,
  endpoint: string,
  args: GatewayPayoutArgs,
  clock: ArcClock,
  state: PayoutState,
  base: Record<string, string>
): Promise<GatewayPayout | undefined> {
  const balanceBlock = await client.getBlockNumber();
  const balance = await client.readContract({
    address: ARC_USDC,
```

With:

```ts
async function payoutCycle(
  client: PublicClient,
  endpoint: string,
  args: GatewayPayoutArgs,
  chain: PayoutChain,
  clock: ArcClock,
  state: PayoutState,
  base: Record<string, string>
): Promise<GatewayPayout | undefined> {
  const balanceBlock = await client.getBlockNumber();
  const balance = await client.readContract({
    address: chain.usdc,
```

Replace (lines 498-505):

```ts
  const scan = await scanArcLogs(client, endpoint, {
    address: GATEWAY_MINTER,
    topics: [ATTESTATION_USED_TOPIC, lowerHex(pad(ARC_USDC)), lowerHex(pad(args.recipient))],
    // balanceOf at fromBlock already counts a log in that block, so the window starts after it.
    fromBlock: args.fromBlock + 1n,
    toBlock: balanceBlock,
    chunk: logChunkFor(endpoint)
  });
```

With:

```ts
  const scan = await scanArcLogs(client, endpoint, {
    address: GATEWAY_MINTER,
    // The token topic is the paid chain's USDC: under Arc's, an L2 payout finds no log.
    topics: [ATTESTATION_USED_TOPIC, lowerHex(pad(chain.usdc)), lowerHex(pad(args.recipient))],
    // balanceOf at fromBlock already counts a log in that block, so the window starts after it.
    fromBlock: args.fromBlock + 1n,
    toBlock: balanceBlock,
    chunk: chain.logChunk(endpoint)
  });
```

Replace (lines 517-522):

```ts
  const uncorrelated = (reason: string) =>
    new PayoutGateError(
      'uncorrelated',
      `payout received but not correlated: ${correlationReason(reason, before)}`,
      where
    );
```

With:

```ts
  const uncorrelated = (reason: string) =>
    new PayoutGateError(
      'uncorrelated',
      `payout received but not correlated: ${correlationReason(reason, before)}`,
      where,
      lateNote(chain)
    );
```

Replace (lines 538-539):

```ts
  if (sourceDomain !== ARC_CIRCLE_DOMAIN)
    throw uncorrelated(`sourceDomain ${sourceDomain}, expected ${ARC_CIRCLE_DOMAIN}`);
```

With:

```ts
  // The Gateway source (26) on every chain, never the destination domain the burn carried.
  if (sourceDomain !== chain.attestationSourceDomain)
    throw uncorrelated(`sourceDomain ${sourceDomain}, expected ${chain.attestationSourceDomain}`);
```

Replace (lines 577-579):

```ts
export async function waitForGatewayPayout(args: GatewayPayoutArgs, deps: ArcReadDeps): Promise<GatewayPayout> {
  if (deps.endpoints.length === 0) throw new Error('waitForGatewayPayout: no Arc endpoints');
  const clock = deps.clock ?? realArcClock;
```

With:

```ts
export async function waitForGatewayPayout(args: GatewayPayoutArgs, deps: ArcReadDeps): Promise<GatewayPayout> {
  const chain = chainOf(deps);
  if (deps.endpoints.length === 0) throw new Error(`waitForGatewayPayout: no ${chain.label} endpoints`);
  const clock = deps.clock ?? realArcClock;
```

Replace (line 594):

```ts
      const payout = await payoutCycle(clientFor(deps)(endpoint), endpoint, args, clock, state, base);
```

With:

```ts
      const payout = await payoutCycle(clientFor(deps)(endpoint), endpoint, args, chain, clock, state, base);
```

Replace (lines 618-625):

```ts
  if (state.firstPaidMs !== undefined && state.lastMiss !== undefined) {
    const reason = correlationReason(state.lastMiss, before);
    throw new PayoutGateError('uncorrelated', `payout received but not correlated: ${reason}`, details);
  }
  if (state.firstPaidMs !== undefined || !state.readOk) {
    throw new PayoutGateError('scan-gaps', `unknown: scan gaps ${describeRanges(state.ranges)}`, details);
  }
  throw new PayoutGateError('no-mint', `no destination mint for this key by ${base.deadline}`, details);
```

With:

```ts
  if (state.firstPaidMs !== undefined && state.lastMiss !== undefined) {
    const reason = correlationReason(state.lastMiss, before);
    throw new PayoutGateError(
      'uncorrelated',
      `payout received but not correlated: ${reason}`,
      details,
      lateNote(chain)
    );
  }
  if (state.firstPaidMs !== undefined || !state.readOk) {
    throw new PayoutGateError(
      'scan-gaps',
      `unknown: scan gaps ${describeRanges(state.ranges)}`,
      details,
      lateNote(chain)
    );
  }
  throw new PayoutGateError('no-mint', `no destination mint for this key by ${base.deadline}`, details, lateNote(chain));
```

Replace (lines 835-836, the start of `submitDepositToMiden`'s body):

```ts
): Promise<DepositSubmission> {
  const account = privateKeyToAccount(args.privateKey);
```

With:

```ts
): Promise<DepositSubmission> {
  arcOnly(deps, 'the xReserve deposit');
  const account = privateKeyToAccount(args.privateKey);
```

Replace (lines 928-929, the start of `confirmDepositToMiden`'s body):

```ts
): Promise<{ approveBlock?: bigint; depositBlock: bigint; event: DepositedToRemoteEvent; gasCostWei: bigint }> {
  const reads = startingAt(deps.endpoints, submission.endpoint);
```

With:

```ts
): Promise<{ approveBlock?: bigint; depositBlock: bigint; event: DepositedToRemoteEvent; gasCostWei: bigint }> {
  arcOnly(deps, 'the xReserve deposit receipt');
  const reads = startingAt(deps.endpoints, submission.endpoint);
```

Then confirm nothing in arc-usdcx.ts still names the removed imports:

```bash
grep -n -E 'ARC_CIRCLE_DOMAIN|ARC_DRPC_LOG_CHUNK|ARC_LOG_CHUNK|ARC_TESTNET|logChunkFor' playwright/e2e/helpers/arc-usdcx.ts
```

Expected: no output.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/helpers/arc-usdcx.test.ts`

Expected: PASS, every test in the file, the six captured Arc payout vectors and the Arc delta-mode tests included (Arc behaves as before).

Then the directory sweep: `npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/helpers`

Expected: PASS (39 suites).

- [ ] **Step 6: Mutation checks (each must turn the named test red; restore after each)**

```bash
F=playwright/e2e/helpers/arc-usdcx.ts; B="$TMPDIR/arc-usdcx.ts.bak"
cp "$F" "$B" && perl -pi -e 's/sourceDomain !== chain\.attestationSourceDomain/sourceDomain !== chain.burnDomain/' "$F" && grep -q 'chain.burnDomain' "$F" && npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/helpers/arc-usdcx.test.ts -t 'on an L2'; cp "$B" "$F"
cp "$F" "$B" && perl -pi -e 's/lowerHex\(pad\(chain\.usdc\)\)/lowerHex(pad(ARC_USDC))/' "$F" && grep -q 'pad(ARC_USDC)' "$F" && npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/helpers/arc-usdcx.test.ts -t 'on an L2'; cp "$B" "$F"
cp "$F" "$B" && perl -pi -e "s/^  arcOnly\(deps, 'xReserve domain state'\);\n//" "$F" && ! grep -q "arcOnly(deps, 'xReserve domain state')" "$F" && npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/helpers/arc-usdcx.test.ts -t 'refuses an L2 deps'; cp "$B" "$F"
cp "$F" "$B" && perl -pi -e 's/\? LATE_PAYOUT_NOTE : L2_LATE_PAYOUT_NOTE/? LATE_PAYOUT_NOTE : LATE_PAYOUT_NOTE/' "$F" && npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/helpers/arc-usdcx.test.ts -t 'domain 6'; cp "$B" "$F"
git diff --stat
```

Predictions:
1. `chain.burnDomain` in the source check: `proves the probe's Base Sepolia payout` and both `correlates the probe payout` cases fail (`sourceDomain 26, expected 6`).
2. Arc's token topic: the same three fail with `found 0 AttestationUsed logs`, and `scans Base Sepolia's own RPC` fails.
3. No `arcOnly` in `readXReserveDomainState`: `refuses an L2 deps object ...` fails (`built` is not empty).
4. Arc's note everywhere: `fails uncorrelated on a payout naming the burn's domain 6` fails on `not.toThrow(LATE_PAYOUT_NOTE)`.

The final `git diff --stat` must show only this task's intended changes.

- [ ] **Step 7: Format and commit**

```bash
npx prettier --write playwright/e2e/helpers/usdcx-constants.ts playwright/e2e/helpers/arc-usdcx.ts playwright/e2e/helpers/arc-usdcx.test.ts playwright/e2e/helpers/usdcx-l2.vectors.json
git add playwright/e2e/helpers/usdcx-constants.ts playwright/e2e/helpers/arc-usdcx.ts playwright/e2e/helpers/arc-usdcx.test.ts playwright/e2e/helpers/usdcx-l2.vectors.json
git commit -m "test(e2e): the payout gate reads Base Sepolia and Arbitrum Sepolia through a payout chain descriptor"
```

---

### Task 2: The Send driver burns to a chosen destination

Size: about 38 source lines, 60 test lines.

**Files:**
- Modify: `playwright/e2e/helpers/usdcx-constants.ts` (insert after Task 1's `ARBITRUM_SEPOLIA_PAYOUT`)
- Modify: `playwright/e2e/helpers/bridge.ts:10, 707-710, 800-812, 819-917`
- Test: `playwright/e2e/helpers/bridge.test.ts`

**Interfaces:**
- Consumes (Task 1): `PayoutChain`, `ARC_PAYOUT`, `BASE_SEPOLIA_PAYOUT`, `ARBITRUM_SEPOLIA_PAYOUT`.
- Produces: `BridgeOutUsdcxOptions.payoutChain?: PayoutChain` (default Arc); `burnSubmitFailure(payoutChain: PayoutChain, reviewError: string, newUsdcxRows: number): string`; `redactProjectId(text: string): string` in usdcx-constants.ts (Task 3 uses it too). `isArcSnapshotFailure`, `usdcxPayoutRowsText` and `expectArcPreselected` keep their signatures (the iOS page object imports them).

- [ ] **Step 1: Write the failing tests**

In `playwright/e2e/helpers/bridge.test.ts`:

Replace (lines 11-24):

```ts
import {
  bridgedSendRowOf,
  bridgeOutUsdcx,
  enText,
  expectArcPreselected,
  isArcSnapshotFailure,
  parseBridgeReceiveState,
  readNativeDisplaySymbol,
  reviewQueryParam,
  usdcxChipsProblem,
  usdcxPayoutRowsText,
  waitForReviewSubmitEnabled
} from './bridge';
import { ARC_CHAIN_ID, BURN_UNITS, USDCX_DECIMALS } from './usdcx-constants';
```

With:

```ts
import {
  bridgedSendRowOf,
  bridgeOutUsdcx,
  burnSubmitFailure,
  enText,
  expectArcPreselected,
  isArcSnapshotFailure,
  parseBridgeReceiveState,
  readNativeDisplaySymbol,
  reviewQueryParam,
  usdcxChipsProblem,
  usdcxPayoutRowsText,
  waitForReviewSubmitEnabled
} from './bridge';
import {
  ARBITRUM_SEPOLIA_PAYOUT,
  ARC_CHAIN_ID,
  ARC_PAYOUT,
  BASE_SEPOLIA_PAYOUT,
  BURN_UNITS,
  USDCX_DECIMALS
} from './usdcx-constants';
```

Insert after line 222 (the closing `});` of `describe('isArcSnapshotFailure', ...)`):

```ts
describe('burnSubmitFailure', () => {
  // What viem's error.message, which the review shows, reads on Arbitrum's WalletConnect backend a few blocks behind.
  const WALLET_RPC_ERROR =
    'Missing or invalid parameters.\n\nURL: https://rpc.walletconnect.org/v1?chainId=eip155:421614&projectId=operator-project\n' +
    'Details: unsupported block number 318137572';

  it("keeps Arc's snapshot message as it was", () => {
    expect(burnSubmitFailure(ARC_PAYOUT, 'HTTP request failed. Status: 429', 0)).toBe(
      "Arc RPC unavailable for the wallet's balance snapshot (burn.ts:103), infra: review-error " +
        '"HTTP request failed. Status: 429"'
    );
  });

  it("fails an L2 snapshot refusal as infra naming the wallet RPC's host, never its project id", () => {
    const message = burnSubmitFailure(ARBITRUM_SEPOLIA_PAYOUT, WALLET_RPC_ERROR, 0);
    expect(message).toMatch(
      /^Arbitrum Sepolia RPC rpc\.walletconnect\.org unavailable for the wallet's balance snapshot \(burn\.ts:103\), infra: review-error "/
    );
    expect(message).toContain('projectId=<redacted>');
    expect(message).toContain('unsupported block number 318137572');
    expect(message).not.toContain('operator-project');
  });

  it('calls anything else, or an RPC error once a row was queued, a refusal, still without the project id', () => {
    expect(burnSubmitFailure(BASE_SEPOLIA_PAYOUT, 'The amount is below the minimum burn.', 0)).toBe(
      'the review refused the burn: review-error "The amount is below the minimum burn.", 0 new usdcx rows'
    );
    const queued = burnSubmitFailure(BASE_SEPOLIA_PAYOUT, WALLET_RPC_ERROR, 1);
    expect(queued).toMatch(/^the review refused the burn: review-error "/);
    expect(queued).not.toContain('operator-project');
  });
});
```

Insert after line 269 (the closing `});` of the `refuses an amount the allowance takes whole` test, inside `describe('usdcxPayoutRowsText', ...)`):

```ts

  // A pin, green before and after: the payout rows carry no chain, so the L2 burns show Arc's text.
  it("quotes the same rows on Base Sepolia and Arbitrum Sepolia, whose allowance is Arc's", () => {
    for (const chain of [BASE_SEPOLIA_PAYOUT, ARBITRUM_SEPOLIA_PAYOUT]) {
      expect(usdcxPayoutRowsText(chain.chainId, '1')).toEqual({ fee: 'Up to 0.1 USDC', net: 'At least 0.9 USDC' });
    }
  });
```

Insert after line 295 (the closing `});` of the existing `bridgeOutUsdcx` test, inside `describe('bridgeOutUsdcx', ...)`):

```ts

  it("refuses an amount the destination's allowance takes whole, naming that destination, before it touches the page", async () => {
    const touched: string[] = [];
    const page = new Proxy(
      {},
      {
        get: (_target, property) => {
          touched.push(String(property));
          return () => Promise.reject(new Error('the page was driven'));
        }
      }
    );
    const wallet = { page, extensionId: 'abc' } as unknown as ChromeWalletPageApi;
    await expect(
      bridgeOutUsdcx(wallet, {
        destAddress: '0x405b05F75F8D299FCd413a3d77F89EDDCBa78026',
        amount: '0.1',
        nativeTokenId: 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0_qr7qqq9wr6w',
        nativeSymbol: 'USDCX',
        screenshotDir: path.join(os.tmpdir(), 'bridge-out-usdcx-refused-l2'),
        payoutChain: BASE_SEPOLIA_PAYOUT
      })
    ).rejects.toThrow('0.1 USDCx does not exceed the 0.1 USDC payout fee allowance on Base Sepolia');
    expect(touched).toEqual([]);
  });
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/helpers/bridge.test.ts -t 'burnSubmitFailure|naming that destination|same rows'`

Expected: FAIL. The three `burnSubmitFailure` tests fail with `TypeError: (0 , _bridge.burnSubmitFailure) is not a function`; `refuses an amount the destination's allowance ...` fails because the message names `Arc Testnet`; `quotes the same rows ...` passes (a pin).

- [ ] **Step 3: Write the implementation**

In `playwright/e2e/helpers/usdcx-constants.ts`, insert after the `ARBITRUM_SEPOLIA_PAYOUT` declaration (Task 1):

```ts

/** viem's error text quotes the request URL, whose WalletConnect project id an operator's build may set. */
export function redactProjectId(text: string): string {
  return text.replace(/(projectId=)[^&\s"']+/g, '$1<redacted>');
}
```

In `playwright/e2e/helpers/bridge.ts`:

Replace (line 10):

```ts
import { ARC_CHAIN_ID, minimumUsdcxPayout, USDCX_DECIMALS, USDCX_DESTINATIONS } from './usdcx-constants';
```

With:

```ts
import {
  ARC_PAYOUT,
  minimumUsdcxPayout,
  redactProjectId,
  USDCX_DECIMALS,
  USDCX_DESTINATIONS,
  type PayoutChain
} from './usdcx-constants';
```

Replace (lines 707-710):

```ts
/** A review-error that names an RPC failure, with no burn row queued: the wallet's Arc snapshot read failed (Q14). */
export function isArcSnapshotFailure(reviewError: string, newUsdcxRows: number): boolean {
  return newUsdcxRows === 0 && RPC_FAILURE.test(reviewError);
}
```

With:

```ts
/** A review-error that names an RPC failure, with no burn row queued: the wallet's Arc snapshot read failed (Q14). */
export function isArcSnapshotFailure(reviewError: string, newUsdcxRows: number): boolean {
  return newUsdcxRows === 0 && RPC_FAILURE.test(reviewError);
}

/**
 * Why a submit that never reached the generating screen failed. An RPC-shaped review-error with no burn row queued is
 * the wallet's destination snapshot read (burn.ts:103) failing on that chain's RPC: infra, never retried, the RPC
 * named by host.
 */
export function burnSubmitFailure(payoutChain: PayoutChain, reviewError: string, newUsdcxRows: number): string {
  const shown = redactProjectId(reviewError);
  if (!isArcSnapshotFailure(reviewError, newUsdcxRows)) {
    return `the review refused the burn: review-error "${shown}", ${newUsdcxRows} new usdcx rows`;
  }
  // Arc's message predates the L2 destinations and stays as it was.
  const rpc =
    payoutChain.chainId === ARC_PAYOUT.chainId
      ? 'Arc RPC'
      : `${payoutChain.networkName} RPC ${payoutChain.walletRpcName}`;
  return `${rpc} unavailable for the wallet's balance snapshot (burn.ts:103), infra: review-error "${shown}"`;
}
```

Replace (lines 810-812):

```ts
  /** Where usdcx-route.png, usdcx-review-light.png and usdcx-review-dark.png go. */
  screenshotDir: string;
}
```

With:

```ts
  /** Where usdcx-route.png, usdcx-review-light.png and usdcx-review-dark.png go. */
  screenshotDir: string;
  /** Where Circle pays the burn (default Arc Testnet): the chip clicked, the review's network and the payout rows. */
  payoutChain?: PayoutChain;
}
```

Replace (lines 819-831):

```ts
/**
 * Burn the native USDCx to an Arc Testnet address through the real Send UI (spec section 5 step 6), ending on the
 * generating-transaction screen. Checks on the way: exactly the four USDCx destination chips with Arc pressed, the
 * route subtitle and fee row naming the native symbol, the payout rows and the burn notice on route and review, and
 * the review's network.
 */
export async function bridgeOutUsdcx(wallet: Wallet, opts: BridgeOutUsdcxOptions): Promise<BridgeOutUsdcxResult> {
  const { page, extensionId } = wallet;
  const step = opts.stepTimeoutMs ?? STEP_TIMEOUT_MS;
  if (opts.nativeSymbol.trim() === '' || opts.nativeSymbol.trim().toUpperCase() === 'MIDEN') {
    throw new Error(`bridgeOutUsdcx: "${opts.nativeSymbol}" cannot name USDCx, the asset a USDCx burn spends`);
  }
  const payout = usdcxPayoutRowsText(ARC_CHAIN_ID, opts.amount);
```

With:

```ts
/**
 * Burn the native USDCx to an address on `opts.payoutChain` (default Arc Testnet) through the real Send UI (spec
 * section 5 step 6), ending on the generating-transaction screen. Checks on the way: exactly the four USDCx
 * destination chips with Arc pressed by default and then the destination's alone, the route subtitle and fee row
 * naming the native symbol, the payout rows and the burn notice on route and review, and the review's network.
 */
export async function bridgeOutUsdcx(wallet: Wallet, opts: BridgeOutUsdcxOptions): Promise<BridgeOutUsdcxResult> {
  const { page, extensionId } = wallet;
  const step = opts.stepTimeoutMs ?? STEP_TIMEOUT_MS;
  const payoutChain = opts.payoutChain ?? ARC_PAYOUT;
  if (opts.nativeSymbol.trim() === '' || opts.nativeSymbol.trim().toUpperCase() === 'MIDEN') {
    throw new Error(`bridgeOutUsdcx: "${opts.nativeSymbol}" cannot name USDCx, the asset a USDCx burn spends`);
  }
  const payout = usdcxPayoutRowsText(payoutChain.chainId, opts.amount);
```

Replace (lines 844-848):

```ts
  await expectArcPreselected(page, step);
  await page.getByTestId(ARC_CHIP).click({ timeout: step });
  await expect
    .poll(async () => usdcxChipsProblem(await readNetworkChips(page), ARC_CHIP) ?? 'ok', { timeout: step })
    .toBe('ok');
```

With:

```ts
  await expectArcPreselected(page, step);
  await page.getByTestId(payoutChain.chip).click({ timeout: step });
  await expect
    .poll(async () => usdcxChipsProblem(await readNetworkChips(page), payoutChain.chip) ?? 'ok', { timeout: step })
    .toBe('ok');
```

Replace (lines 874-875):

```ts
  expect(reviewQueryParam(reviewUrl, 'network'), 'the review is for Arc Testnet').toBe('arc-testnet');
  await expect(detailRowValue(page, enText('network'))).toHaveText('Arc Testnet', { timeout: step });
```

With:

```ts
  expect(reviewQueryParam(reviewUrl, 'network'), `the review is for ${payoutChain.networkName}`).toBe(
    payoutChain.reviewNetwork
  );
  await expect(detailRowValue(page, enText('network'))).toHaveText(payoutChain.networkName, { timeout: step });
```

Replace (lines 912-916):

```ts
    throw new Error(
      isArcSnapshotFailure(reviewError, fresh.length)
        ? `Arc RPC unavailable for the wallet's balance snapshot (burn.ts:103), infra: review-error "${reviewError}"`
        : `the review refused the burn: review-error "${reviewError}", ${fresh.length} new usdcx rows`
    );
```

With:

```ts
    throw new Error(burnSubmitFailure(payoutChain, reviewError, fresh.length));
```

Check: `grep -n 'ARC_CHAIN_ID' playwright/e2e/helpers/bridge.ts` prints nothing.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/helpers/bridge.test.ts playwright/e2e/ios/helpers/ios-wallet-page.test.ts`

Expected: PASS, both files (the iOS page object imports `isArcSnapshotFailure` and `usdcxPayoutRowsText`, which are unchanged).

Then: `npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/helpers`. Expected: PASS.

- [ ] **Step 5: Mutation checks**

```bash
F=playwright/e2e/helpers/bridge.ts; B="$TMPDIR/bridge.ts.bak"
cp "$F" "$B" && perl -pi -e 's/usdcxPayoutRowsText\(payoutChain\.chainId, opts\.amount\)/usdcxPayoutRowsText(ARC_PAYOUT.chainId, opts.amount)/' "$F" && grep -q 'usdcxPayoutRowsText(ARC_PAYOUT.chainId' "$F" && npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/helpers/bridge.test.ts -t 'naming that destination'; cp "$B" "$F"
cp "$F" "$B" && perl -pi -e 's/redactProjectId\(reviewError\)/reviewError/' "$F" && ! grep -q 'redactProjectId(reviewError)' "$F" && npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/helpers/bridge.test.ts -t 'burnSubmitFailure'; cp "$B" "$F"
cp "$F" "$B" && perl -pi -e 's/\$\{payoutChain\.networkName\} RPC \$\{payoutChain\.walletRpcName\}/Arc RPC/' "$F" && npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/helpers/bridge.test.ts -t 'burnSubmitFailure'; cp "$B" "$F"
git diff --stat
```

Predictions: (1) `refuses an amount the destination's allowance ...` fails (names Arc Testnet). (2) `fails an L2 snapshot refusal ...` and `calls anything else ...` fail on `operator-project`. (3) `fails an L2 snapshot refusal ...` fails on the `^Arbitrum Sepolia RPC rpc.walletconnect.org` match. The chip click and the review's network are proven only by the live run (Delivery), since the driver needs a real page; that is by design.

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write playwright/e2e/helpers/usdcx-constants.ts playwright/e2e/helpers/bridge.ts playwright/e2e/helpers/bridge.test.ts
git add playwright/e2e/helpers/usdcx-constants.ts playwright/e2e/helpers/bridge.ts playwright/e2e/helpers/bridge.test.ts
git commit -m "test(e2e): the USDCx Send driver burns to a chosen destination chain"
```

---

### Task 3: Burn, payout and wallet-confirmation legs per chain

Size: about 60 source lines, 155 test lines.

**Files:**
- Modify: `playwright/e2e/helpers/usdcx-legs.ts:33-45, 78-89, 82-86, 324-344, 346-368, 420-556, 563-578, 600-681, 683-739, 741-777`
- Test: `playwright/e2e/helpers/arc-usdcx.test.ts` (the legs' tests live here, in the describes named `(usdcx-legs.ts)`)

**Interfaces:**
- Consumes (Task 1): `PayoutChain`, `ARC_PAYOUT`, `BASE_SEPOLIA_PAYOUT`, `ARBITRUM_SEPOLIA_PAYOUT`, `ArcReadDeps.payoutChain`. (Task 2): `BridgeOutUsdcxOptions.payoutChain`, `redactProjectId`.
- Produces:
  - `burnTarget(chain: PayoutChain, destination: Address): { destination: string; network: number; domain: number }`
  - `submitBurn(wallet, ids, opts: { destination: Address; units: bigint; screenshotDir: string; payoutChain?: PayoutChain })`
  - `ConfirmBurnOptions.payoutChain?: PayoutChain`
  - `payoutLeg(step, opts: { takeKey; arc: ArcReadDeps; payoutReads?: ArcReadDeps; budget; evidence; secrets })` and the same `payoutReads?` on `harnessPayoutLeg`; an L2 run writes `evidence.ids.payoutChainId`.
  - `waitForWalletPayoutConfirmation(opts)`: unchanged signature; `opts.arc.payoutChain` (Arc when absent) names the chain and the wallet's RPC.
  - `assertBurnDetails(wallet, rowId, destination, chain: PayoutChain = ARC_PAYOUT)`, `receivingTxHash(page, timeoutMs, chain: PayoutChain = ARC_PAYOUT)`.

- [ ] **Step 1: Write the failing tests**

In `playwright/e2e/helpers/arc-usdcx.test.ts`:

Replace (the Task 1 import line):

```ts
import { harnessPayoutLeg, payoutLeg, waitForWalletPayoutConfirmation } from './usdcx-legs';
```

With:

```ts
import { burnTarget, harnessPayoutLeg, payoutLeg, waitForWalletPayoutConfirmation } from './usdcx-legs';
```

Replace (inside the first `harnessPayoutLeg (usdcx-legs.ts)` test, lines 837-842):

```ts
    expect(evidence).toMatchObject({
      ids: { arcKey: KEY, arcKeyRole: 'harness', arcBalanceBefore: String(HELD), arcSnapshotBlock: '66483822' },
      hashes: { payout: ONE_USDCX.transaction.hash },
      fees: [{ name: 'circle payout fee', amount: 16_400n, kind: 'exact' }],
      latenciesMs: { consumeToPayout: 12_000 }
    });
  });
```

With:

```ts
    expect(evidence).toMatchObject({
      ids: { arcKey: KEY, arcKeyRole: 'harness', arcBalanceBefore: String(HELD), arcSnapshotBlock: '66483822' },
      hashes: { payout: ONE_USDCX.transaction.hash },
      fees: [{ name: 'circle payout fee', amount: 16_400n, kind: 'exact' }],
      latenciesMs: { consumeToPayout: 12_000 }
    });
    // An Arc run's evidence keeps exactly the keys it had before the L2 suite.
    expect(evidence.ids).not.toHaveProperty('payoutChainId');
  });

  it('reads and proves an L2 payout on the L2 alone, reading Arc for nothing about the key', async () => {
    const { step, taken } = recordingSteps();
    const evidence = newRunEvidence('usdcx-burn-l2 base-sepolia');
    const secrets: string[] = [];
    const base = l2PayoutOn(84532);
    const arcReads: string[] = [];
    const arc = {
      endpoints: [ARC_DRPC_URL],
      publicClient: () =>
        stubClient(method => {
          arcReads.push(method);
          throw new Error('the L2 leg read Arc');
        })
    };
    const l2 = payoutChain({ balances: [HELD, HELD + 988_901n], logs: [paidTo(base.log, KEY, 66483823n)] });
    const payoutReads = {
      endpoints: [BASE_SEPOLIA_PAYOUT.rpcUrls[0] ?? ''],
      publicClient: () => stubClient(l2),
      clock: fakeClock(CONSUME_MS + 7_000),
      payoutChain: BASE_SEPOLIA_PAYOUT
    };

    const leg = await harnessPayoutLeg(step, { env: { ...ENV }, arc, payoutReads, budget: BUDGET, evidence, secrets });
    expect(leg.snapshot).toEqual({
      endpoint: 'https://base-sepolia-rpc.publicnode.com',
      blockNumber: 66483822n,
      balance: HELD
    });
    const payout = await leg.waitForPayout(
      { burnNoteId: hexOf(base.burnNoteId), oracle: { consumeTimestampSec: CONSUME_MS / 1_000, consumeBlock: 412_345 } },
      hexOf(l2Vectors.depositor)
    );

    expect(payout).toMatchObject({
      value: 988_901n,
      fee: 11_099n,
      sourceDomain: 26,
      transactionHash: base.transaction.hash,
      latencyMs: 7_000
    });
    expect(arcReads).toEqual([]);
    expect(taken).toEqual([
      ['key_snapshot', BUDGET.keySnapshot],
      ['payout', BUDGET.payout]
    ]);
    expect(evidence).toMatchObject({
      ids: {
        arcKey: KEY,
        arcKeyRole: 'harness',
        arcBalanceBefore: String(HELD),
        arcSnapshotBlock: '66483822',
        payoutChainId: '84532'
      },
      hashes: { payout: base.transaction.hash },
      fees: [{ name: 'circle payout fee', amount: 11_099n, kind: 'exact' }]
    });
  });

  it("fails an L2 payout step naming the key's read on that L2 and xReserve's flags read on Arc", async () => {
    const { step } = recordingSteps();
    const evidence = newRunEvidence('usdcx-burn-l2 base-sepolia');
    const flags: Record<string, Hex> = {
      isRemoteDomainRegistered: encodeBool(true),
      paused: encodeBool(false),
      domainDepositsPaused: encodeBool(false),
      domainWithdrawalsPaused: encodeBool(true),
      getRemoteToken: `0x${'00'.repeat(32)}`,
      getRemoteDomainDepositor: encodeAbiParameters([{ type: 'address' }], ['0xb21c91a0f4d4c03f4b6a0fc5214f06e431ff2b2d']),
      gatewayMinter: encodeAbiParameters([{ type: 'address' }], [GATEWAY_MINTER])
    };
    const arc = {
      endpoints: [ARC_DRPC_URL],
      publicClient: () => stubClient((_method, params) => flags[callOf(params).functionName])
    };
    const payoutReads = {
      endpoints: [BASE_SEPOLIA_PAYOUT.rpcUrls[0] ?? ''],
      publicClient: () => stubClient(payoutChain({ balances: [HELD], logs: [] })),
      clock: fakeClock(CONSUME_MS),
      payoutChain: BASE_SEPOLIA_PAYOUT
    };

    const leg = await harnessPayoutLeg(step, {
      env: { ...ENV },
      arc,
      payoutReads,
      budget: BUDGET,
      evidence,
      secrets: []
    });
    const failure = leg.waitForPayout(burn, depositor);

    await expect(failure).rejects.toThrow(
      `harness key ${KEY} (${HARNESS_ARC_KEY_FILE}) held ${HELD} at Base Sepolia block 66483822 (read on ` +
        'base-sepolia-rpc.publicnode.com); '
    );
    await expect(failure).rejects.toThrow('xReserve paused false, deposits paused false, withdrawals paused true');
  });
```

Insert inside `describe('waitForWalletPayoutConfirmation (usdcx-legs.ts)', ...)`, after the test that ends at line 1013:

```ts

  it("names the L2's wallet RPC by host, never its project id, when the wallet never confirms", async () => {
    const reads = {
      endpoints: [BASE_SEPOLIA_PAYOUT.rpcUrls[0] ?? ''],
      payoutChain: BASE_SEPOLIA_PAYOUT,
      // The wallet's WalletConnect backend lags the harness's endpoint, which already reads the payout.
      publicClient: (endpoint: string) =>
        stubClient(
          payoutChain({ balances: [endpoint === BASE_SEPOLIA_PAYOUT.walletRpcUrl ? HELD : payout.balance], logs: [] })
        ),
      clock: fakeClock()
    };

    const failure = waitForWalletPayoutConfirmation({
      readRows: rowReads([[burnRow('burn')]]),
      rowId: 'burn',
      arcFromBlock: 66483822n,
      payout,
      key: { address: KEY },
      arc: reads,
      where,
      evidence: newRunEvidence('usdcx-burn-l2 base-sepolia')
    });

    await expect(failure).rejects.toThrow(
      `key balance now ${payout.balance}, rpc.walletconnect.org reads ${HELD}; route #/ (visible)`
    );
    await expect(failure).rejects.not.toThrow('projectId=');
  });

  // viem's error text quotes the request URL, so a failed read through the wallet's RPC would print its project id.
  it('redacts the project id when the read through the L2 wallet RPC itself fails', async () => {
    const reads = {
      endpoints: [BASE_SEPOLIA_PAYOUT.rpcUrls[0] ?? ''],
      payoutChain: BASE_SEPOLIA_PAYOUT,
      publicClient: (endpoint: string) =>
        endpoint === BASE_SEPOLIA_PAYOUT.walletRpcUrl
          ? stubClient(() => {
              throw new Error(
                'HTTP request failed.\n\nURL: https://rpc.walletconnect.org/v1?chainId=eip155:84532&projectId=operator-project'
              );
            })
          : stubClient(payoutChain({ balances: [payout.balance], logs: [] })),
      clock: fakeClock()
    };

    const failure = waitForWalletPayoutConfirmation({
      readRows: rowReads([[burnRow('burn')]]),
      rowId: 'burn',
      arcFromBlock: 66483822n,
      payout,
      key: { address: KEY },
      arc: reads,
      where,
      evidence: newRunEvidence('usdcx-burn-l2 base-sepolia')
    });

    await expect(failure).rejects.toThrow(
      `key balance now ${payout.balance}, rpc.walletconnect.org failed: Base Sepolia USDC balance of ${KEY}`
    );
    await expect(failure).rejects.toThrow('projectId=<redacted>');
    await expect(failure).rejects.not.toThrow('operator-project');
  });

  it("fails an L2 confirmation read before the payout's log, naming the L2's block", async () => {
    const failure = waitForWalletPayoutConfirmation({
      readRows: rowReads([[burnRow('burn', { balance: String(payout.balance), blockNumber: '66483822' })]]),
      rowId: 'burn',
      arcFromBlock: 66483821n,
      payout,
      key: { address: KEY },
      arc: { endpoints: [BASE_SEPOLIA_PAYOUT.rpcUrls[0] ?? ''], payoutChain: BASE_SEPOLIA_PAYOUT, clock: fakeClock() },
      where,
      evidence: newRunEvidence('usdcx-burn-l2 base-sepolia')
    });

    await expect(failure).rejects.toThrow(
      `confirmation at Base Sepolia block 66483822, snapshot 66483821, payout log 66483823, ${HELD} on the key ` +
        'before the burn'
    );
  });
```

Insert after the closing `});` of `describe('waitForWalletPayoutConfirmation (usdcx-legs.ts)', ...)`:

```ts
describe('burnTarget (usdcx-legs.ts)', () => {
  const KEY = addressOf('0x6aF7413CbC1FC53454539Da54aAefFE1114FDC66');

  it("carries the destination's own domain on the burn and its row, never the payout's source domain", () => {
    expect([ARC_PAYOUT, BASE_SEPOLIA_PAYOUT, ARBITRUM_SEPOLIA_PAYOUT].map(chain => burnTarget(chain, KEY))).toEqual([
      { destination: KEY.toLowerCase(), network: 5042002, domain: 26 },
      { destination: KEY.toLowerCase(), network: 84532, domain: 6 },
      { destination: KEY.toLowerCase(), network: 421614, domain: 3 }
    ]);
    expect(
      [BASE_SEPOLIA_PAYOUT, ARBITRUM_SEPOLIA_PAYOUT].map(
        chain => burnTarget(chain, KEY).domain === chain.attestationSourceDomain
      )
    ).toEqual([false, false]);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/helpers/arc-usdcx.test.ts -t 'usdcx-legs'`

Expected: FAIL. `burnTarget` fails with `(0 , _usdcxLegs.burnTarget) is not a function`; `reads and proves an L2 payout ...` fails (`key_snapshot: ... the L2 leg read Arc`); `fails an L2 payout step ...` fails (the context says `at Arc block` and `read on rpc.drpc.testnet.arc.io`); `names the L2's wallet RPC ...` fails (`arc.io reads`); `redacts the project id when the read through the L2 wallet RPC itself fails` fails (`arc.io reads`, no `rpc.walletconnect.org failed`); `fails an L2 confirmation ...` fails (`at Arc block`). The existing Arc legs tests, the new `not.toHaveProperty('payoutChainId')` line included, pass.

- [ ] **Step 3: Write the implementation**

In `playwright/e2e/helpers/usdcx-legs.ts`:

Replace (lines 33-45):

```ts
import {
  ARC_CHAIN_ID,
  ARC_CIRCLE_DOMAIN,
  ARC_PUBLIC_URL,
  BURN_UNITS,
  GRANT_MARGIN_UNITS,
  GRANT_UNITS,
  HARNESS_ARC_KEY_FILE,
  minimumUsdcxPayout,
  PAYOUT_TIMEOUT_MS,
  USDCX_BURN_TAG,
  WALLET_CONFIRM_TIMEOUT_MS
} from './usdcx-constants';
```

With:

```ts
import {
  ARC_PAYOUT,
  BURN_UNITS,
  GRANT_MARGIN_UNITS,
  GRANT_UNITS,
  HARNESS_ARC_KEY_FILE,
  minimumUsdcxPayout,
  PAYOUT_TIMEOUT_MS,
  redactProjectId,
  USDCX_BURN_TAG,
  WALLET_CONFIRM_TIMEOUT_MS,
  type PayoutChain
} from './usdcx-constants';
```

Replace (lines 78-89):

```ts
import { USDCX_DECIMALS } from '../../../src/lib/usdcx/constant';
import { ARC_TESTNET } from '../../../src/lib/walletconnect/config';
import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';

/**
 * The legs the live USDCx specs share: a Guardian or standard wallet funded by one public faucet grant, and a burn
 * through Send to an Arc key. Their pure decisions live in usdcx-run.ts, which has the unit tests; this file is the
 * live wiring, run by `yarn e2e:real --suite usdcx|usdcx-in|usdcx-burn`.
 */

const VAULT_TIMEOUT_MS = 120_000;
const ARC_EXPLORER = ARC_TESTNET.blockExplorers.default.url;
```

With:

```ts
import { USDCX_DECIMALS } from '../../../src/lib/usdcx/constant';
import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';

/**
 * The legs the live USDCx specs share: a Guardian or standard wallet funded by one public faucet grant, and a burn
 * through Send to a key on Arc or an L2 (`PayoutChain`, Arc by default). Their pure decisions live in usdcx-run.ts,
 * which has the unit tests; this file is the live wiring, run by
 * `yarn e2e:real --suite usdcx|usdcx-in|usdcx-burn|usdcx-burn-l2`.
 */

const VAULT_TIMEOUT_MS = 120_000;
```

Replace (lines 324-340):

```ts
/** Spec 5 step 6: the burn through Send; resolves with the bridged-send rows that existed before it. */
export async function submitBurn(
  wallet: GuardianAwareWalletPage,
  ids: UsdcxWalletIds,
  opts: { destination: Address; units: bigint; screenshotDir: string }
): Promise<ReadonlySet<string>> {
  // A Guardian burn is not requeued on a pending-delta 409 (REQUEUEABLE_ON_PENDING_CONFLICT in transaction/index.ts
  // leaves out bridged-send), so nothing may be in flight.
  assertNoGuardianOpInFlight(await readTransactionRows(wallet.page), ids.address);
  const prior = new Set((await readBridgedSendRows(wallet.page)).map(row => row.id));
  await bridgeOutUsdcx(wallet, {
    destAddress: opts.destination,
    amount: fromBaseUnits(opts.units, USDCX_DECIMALS),
    nativeTokenId: ids.native,
    nativeSymbol: await readNativeDisplaySymbol(wallet.page, ids.native),
    screenshotDir: opts.screenshotDir
  });
```

With:

```ts
/** Spec 5 step 6: the burn through Send; resolves with the bridged-send rows that existed before it. */
export async function submitBurn(
  wallet: GuardianAwareWalletPage,
  ids: UsdcxWalletIds,
  opts: { destination: Address; units: bigint; screenshotDir: string; payoutChain?: PayoutChain }
): Promise<ReadonlySet<string>> {
  // A Guardian burn is not requeued on a pending-delta 409 (REQUEUEABLE_ON_PENDING_CONFLICT in transaction/index.ts
  // leaves out bridged-send), so nothing may be in flight.
  assertNoGuardianOpInFlight(await readTransactionRows(wallet.page), ids.address);
  const prior = new Set((await readBridgedSendRows(wallet.page)).map(row => row.id));
  await bridgeOutUsdcx(wallet, {
    destAddress: opts.destination,
    amount: fromBaseUnits(opts.units, USDCX_DECIMALS),
    nativeTokenId: ids.native,
    nativeSymbol: await readNativeDisplaySymbol(wallet.page, ids.native),
    screenshotDir: opts.screenshotDir,
    payoutChain: opts.payoutChain
  });
```

Replace (lines 353-368):

```ts
  arcFromBlock: bigint;
  phases: PhaseTimeline;
}

export interface ConfirmBurnOptions {
  priorRowIds: ReadonlySet<string>;
  destination: Address;
  /** The harness's read of the key right before the burn (R21); the wallet's saved balance must equal it. */
  keySnapshot?: { balance: bigint; blockNumber: bigint };
  units: bigint;
  vaultBefore: bigint;
  rpcUrl: string;
  guardian: boolean;
  timeoutMs: number;
  where: StepContext;
}
```

With:

```ts
  /** The payout chain's block of the balance the wallet saved before the burn. */
  arcFromBlock: bigint;
  phases: PhaseTimeline;
}

export interface ConfirmBurnOptions {
  priorRowIds: ReadonlySet<string>;
  destination: Address;
  /** The harness's read of the key right before the burn (R21); the wallet's saved balance must equal it. */
  keySnapshot?: { balance: bigint; blockNumber: bigint };
  units: bigint;
  vaultBefore: bigint;
  rpcUrl: string;
  guardian: boolean;
  timeoutMs: number;
  where: StepContext;
  /** Where Circle pays the burn (default Arc): the chain and domain the node and the row must carry. */
  payoutChain?: PayoutChain;
}

/**
 * What a burn to `destination` on `chain` carries, on the node and on its row: the recipient, the chain id and the
 * destination's Circle domain (26, 6 or 3). The payout names Arc's domain instead, so the two are never compared.
 */
export function burnTarget(
  chain: PayoutChain,
  destination: Address
): { destination: string; network: number; domain: number } {
  return { destination: destination.toLowerCase(), network: chain.chainId, domain: chain.burnDomain };
}
```

Replace (lines 460-489):

```ts
  const burnNoteId = burn.noteId;
  if (!isHash(burnNoteId)) throw new Error(`burn row ${row.id} names note ${burnNoteId}, not 32 bytes of hex`);

  // The node, not the row, proves the burn: its amount, tag, scheme-5 target and sender, and the faucet's consume.
  const oracle = await burnEvidence(opts.rpcUrl, {
    faucetBech32: ids.nativeBare,
    noteId: burnNoteId,
    senderBech32: ids.bare,
    domain: ARC_CIRCLE_DOMAIN,
    recipient: opts.destination,
    amount: opts.units
  });
```

With:

```ts
  const burnNoteId = burn.noteId;
  if (!isHash(burnNoteId)) throw new Error(`burn row ${row.id} names note ${burnNoteId}, not 32 bytes of hex`);
  const chain = opts.payoutChain ?? ARC_PAYOUT;
  const target = burnTarget(chain, opts.destination);

  // The node, not the row, proves the burn: its amount, tag, scheme-5 target and sender, and the faucet's consume.
  const oracle = await burnEvidence(opts.rpcUrl, {
    faucetBech32: ids.nativeBare,
    noteId: burnNoteId,
    senderBech32: ids.bare,
    domain: target.domain,
    recipient: opts.destination,
    amount: opts.units
  });
```

Replace (lines 482-489):

```ts
  ).toEqual({
    amount: opts.units,
    tag: USDCX_BURN_TAG,
    sender: ids.accountHex.toLowerCase(),
    domain: ARC_CIRCLE_DOMAIN,
    recipient: opts.destination.toLowerCase(),
    nullifierCommitted: true
  });
```

With:

```ts
  ).toEqual({
    amount: opts.units,
    tag: USDCX_BURN_TAG,
    sender: ids.accountHex.toLowerCase(),
    domain: target.domain,
    recipient: target.destination,
    nullifierCommitted: true
  });
```

Replace (lines 530-531):

```ts
      `the wallet saved ${before?.balance} for the key at Arc block ${before?.blockNumber}, but the harness read ` +
```

With:

```ts
      `the wallet saved ${before?.balance} for the key at ${chain.label} block ${before?.blockNumber}, but the harness read ` +
```

Replace (lines 538-542):

```ts
  expect({
    destination: row.extraInputs?.destinationAddress?.toLowerCase(),
    network: row.extraInputs?.destinationNetwork,
    domain: burn.destinationDomain
  }).toEqual({ destination: opts.destination.toLowerCase(), network: ARC_CHAIN_ID, domain: ARC_CIRCLE_DOMAIN });
```

With:

```ts
  expect({
    destination: row.extraInputs?.destinationAddress?.toLowerCase(),
    network: row.extraInputs?.destinationNetwork,
    domain: burn.destinationDomain
  }).toEqual(target);
```

Replace (lines 563-578):

```ts
/** Spec 5 step 8 failure body: the payout key and its pre-burn read, the burn's consume and xReserve's pause flags. */
function payoutContext(arc: ArcReadDeps, label: string, snapshot: ArcUsdcSnapshot, burn: ConsumedBurn): StepContext {
  return async () => {
    const flags = await readXReserveDomainState(arc).then(
      state =>
        `paused ${state.paused}, deposits paused ${state.depositsPaused}, withdrawals paused ${state.withdrawalsPaused}`,
      (error: unknown) => `pause flags unreadable (${errorText(error)})`
    );
    const consumedAt = new Date(burn.oracle.consumeTimestampSec * 1_000).toISOString();
    return (
      `${label} held ${snapshot.balance} at Arc block ` +
      `${snapshot.blockNumber} (read on ${arcHost(snapshot.endpoint)}); burn note ${burn.burnNoteId} consumed in ` +
      `Miden block ${burn.oracle.consumeBlock} at ${consumedAt}; xReserve ${flags}`
    );
  };
}
```

With:

```ts
/** Spec 5 step 8 failure body: the payout key and its pre-burn read, the burn's consume and xReserve's pause flags. */
function payoutContext(
  arc: ArcReadDeps,
  chain: PayoutChain,
  label: string,
  snapshot: ArcUsdcSnapshot,
  burn: ConsumedBurn
): StepContext {
  return async () => {
    const flags = await readXReserveDomainState(arc).then(
      state =>
        `paused ${state.paused}, deposits paused ${state.depositsPaused}, withdrawals paused ${state.withdrawalsPaused}`,
      (error: unknown) => `pause flags unreadable (${errorText(error)})`
    );
    const consumedAt = new Date(burn.oracle.consumeTimestampSec * 1_000).toISOString();
    return (
      `${label} held ${snapshot.balance} at ${chain.label} block ` +
      `${snapshot.blockNumber} (read on ${arcHost(snapshot.endpoint)}); burn note ${burn.burnNoteId} consumed in ` +
      `Miden block ${burn.oracle.consumeBlock} at ${consumedAt}; xReserve ${flags}`
    );
  };
}
```

Replace (lines 605-625):

```ts
export async function payoutLeg(
  step: NamedStep,
  opts: {
    takeKey: () => PayoutKey;
    arc: ArcReadDeps;
    budget: { keySnapshot: number; payout: number };
    evidence: RunEvidence;
    secrets: string[];
  }
): Promise<PayoutLeg> {
  const { arc, evidence } = opts;
  const { taken, snapshot } = await step('key_snapshot', opts.budget.keySnapshot, async () => {
    const taken = opts.takeKey();
    opts.secrets.push(taken.key.privateKey);
    return { taken, snapshot: await readArcUsdcSnapshot(taken.key.address, arc) };
  });
  const { key } = taken;
  evidence.ids.arcKey = key.address;
  evidence.ids.arcKeyRole = taken.role;
  evidence.ids.arcBalanceBefore = String(snapshot.balance);
  evidence.ids.arcSnapshotBlock = String(snapshot.blockNumber);
```

With:

```ts
export async function payoutLeg(
  step: NamedStep,
  opts: {
    takeKey: () => PayoutKey;
    arc: ArcReadDeps;
    /** The payout chain's reads (`payoutChain` set); absent, the payout is on Arc and read through `arc`. */
    payoutReads?: ArcReadDeps;
    budget: { keySnapshot: number; payout: number };
    evidence: RunEvidence;
    secrets: string[];
  }
): Promise<PayoutLeg> {
  const { arc, evidence } = opts;
  // xReserve's pause flags are Arc's for every destination; the key is read and its payout proven where Circle pays.
  const reads = opts.payoutReads ?? arc;
  const chain = reads.payoutChain ?? ARC_PAYOUT;
  const { taken, snapshot } = await step('key_snapshot', opts.budget.keySnapshot, async () => {
    const taken = opts.takeKey();
    opts.secrets.push(taken.key.privateKey);
    return { taken, snapshot: await readArcUsdcSnapshot(taken.key.address, reads) };
  });
  const { key } = taken;
  evidence.ids.arcKey = key.address;
  evidence.ids.arcKeyRole = taken.role;
  evidence.ids.arcBalanceBefore = String(snapshot.balance);
  evidence.ids.arcSnapshotBlock = String(snapshot.blockNumber);
  // An Arc run's evidence keeps exactly the keys it always had.
  if (chain.chainId !== ARC_PAYOUT.chainId) evidence.ids.payoutChainId = String(chain.chainId);
```

Replace (lines 642-652):

```ts
            depositor,
            minimumValue: minimumUsdcxPayout(ARC_CHAIN_ID, BURN_UNITS)
          },
          arc
        ),
      payoutContext(arc, taken.label, snapshot, burn)
    );
    expect({ domain: payout.sourceDomain, total: payout.value + payout.fee }).toEqual({
      domain: ARC_CIRCLE_DOMAIN,
      total: BURN_UNITS
    });
```

With:

```ts
            depositor,
            minimumValue: minimumUsdcxPayout(chain.chainId, BURN_UNITS)
          },
          reads
        ),
      payoutContext(arc, chain, taken.label, snapshot, burn)
    );
    expect({ domain: payout.sourceDomain, total: payout.value + payout.fee }).toEqual({
      domain: chain.attestationSourceDomain,
      total: BURN_UNITS
    });
```

Replace (lines 662-671):

```ts
export async function harnessPayoutLeg(
  step: NamedStep,
  opts: {
    env: Record<string, string | undefined>;
    arc: ArcReadDeps;
    budget: { keySnapshot: number; payout: number };
```

With:

```ts
export async function harnessPayoutLeg(
  step: NamedStep,
  opts: {
    env: Record<string, string | undefined>;
    arc: ArcReadDeps;
    payoutReads?: ArcReadDeps;
    budget: { keySnapshot: number; payout: number };
```

Replace (lines 688-701):

```ts
export async function waitForWalletPayoutConfirmation(opts: {
  /** The wallet's bridged-send rows, read the platform's way. */
  readRows: () => Promise<BridgedSendRow[]>;
  rowId: string;
  /** The Arc block of the balance the wallet saved before the burn. */
  arcFromBlock: bigint;
  payout: Pick<GatewayPayout, 'value' | 'balance' | 'logBlock'>;
  key: Pick<ArcKey, 'address'>;
  arc: ArcReadDeps;
  where: StepContext;
  evidence: RunEvidence;
}): Promise<number> {
  const { payout, key, arc } = opts;
  const clock = arc.clock ?? realArcClock;
```

With:

```ts
export async function waitForWalletPayoutConfirmation(opts: {
  /** The wallet's bridged-send rows, read the platform's way. */
  readRows: () => Promise<BridgedSendRow[]>;
  rowId: string;
  /** The payout chain's block of the balance the wallet saved before the burn. */
  arcFromBlock: bigint;
  payout: Pick<GatewayPayout, 'value' | 'balance' | 'logBlock'>;
  key: Pick<ArcKey, 'address'>;
  /** The payout chain's reads; their `payoutChain` (Arc when absent) names the wallet's own RPC there. */
  arc: ArcReadDeps;
  where: StepContext;
  evidence: RunEvidence;
}): Promise<number> {
  const { payout, key, arc } = opts;
  const chain = arc.payoutChain ?? ARC_PAYOUT;
  const clock = arc.clock ?? realArcClock;
```

Replace (lines 712-721):

```ts
        const keyNow = await readArcUsdc(key.address, arc).then(String, errorText);
        const arcIo = await readArcUsdc(key.address, { ...arc, endpoints: [ARC_PUBLIC_URL] }).then(
          balance => `arc.io reads ${balance}`,
          (error: unknown) => `arc.io failed: ${errorText(error)}`
        );
        const before = JSON.stringify(last?.extraInputs?.usdcxBurn?.destinationBalanceBefore);
        return (
          `Circle paid this burn (harness proof) but the wallet never confirmed it; destinationBalanceBefore ` +
          `${before}, key balance now ${keyNow}, ${arcIo}; ${await opts.where()}`
        );
```

With:

```ts
        const keyNow = await readArcUsdc(key.address, arc).then(String, errorText);
        const walletRpc = await readArcUsdc(key.address, { ...arc, endpoints: [chain.walletRpcUrl] }).then(
          balance => `${chain.walletRpcName} reads ${balance}`,
          // viem's error text quotes the URL; arc.io's carries no project id, so Arc's message is unchanged.
          (error: unknown) => `${chain.walletRpcName} failed: ${redactProjectId(errorText(error))}`
        );
        const before = JSON.stringify(last?.extraInputs?.usdcxBurn?.destinationBalanceBefore);
        return (
          `Circle paid this burn (harness proof) but the wallet never confirmed it; destinationBalanceBefore ` +
          `${before}, key balance now ${keyNow}, ${walletRpc}; ${await opts.where()}`
        );
```

Replace (line 734):

```ts
    `confirmation at Arc block ${confirmedBlock}, snapshot ${opts.arcFromBlock}, payout log ${payout.logBlock}, ` +
```

With:

```ts
    `confirmation at ${chain.label} block ${confirmedBlock}, snapshot ${opts.arcFromBlock}, ` +
      `payout log ${payout.logBlock}, ` +
```

Replace (lines 741-754):

```ts
/** Spec 5 step 7: the burn's details read Burn confirmed (or Confirmed once paid), name Arc Testnet and link the key. */
export async function assertBurnDetails(
  wallet: GuardianAwareWalletPage,
  rowId: string,
  destination: Address
): Promise<void> {
  await openHistoryDetails(wallet, rowId);
  const page = wallet.page;
  await expect(page.getByTestId('history-status-pill')).toHaveText(
    anyOf([enText('usdcxBurnConfirmed'), enText('confirmed')])
  );
  await expect(page.locator(`a[href="${ARC_EXPLORER}/address/${destination}" i]`)).toBeVisible();
  await expect(page.getByText(ARC_TESTNET.name, { exact: true }).first()).toBeVisible();
}
```

With:

```ts
/** Spec 5 step 7: the burn's details read Burn confirmed (or Confirmed once paid), name the chain and link the key. */
export async function assertBurnDetails(
  wallet: GuardianAwareWalletPage,
  rowId: string,
  destination: Address,
  chain: PayoutChain = ARC_PAYOUT
): Promise<void> {
  await openHistoryDetails(wallet, rowId);
  const page = wallet.page;
  await expect(page.getByTestId('history-status-pill')).toHaveText(
    anyOf([enText('usdcxBurnConfirmed'), enText('confirmed')])
  );
  await expect(page.locator(`a[href="${chain.explorer}/address/${destination}" i]`)).toBeVisible();
  await expect(page.getByText(chain.networkName, { exact: true }).first()).toBeVisible();
}
```

Replace (lines 768-769):

```ts
export async function receivingTxHash(page: Page, timeoutMs: number): Promise<string | null> {
  const link = page.locator(`a[href^="${ARC_EXPLORER}/tx/"]`).first();
```

With:

```ts
export async function receivingTxHash(
  page: Page,
  timeoutMs: number,
  chain: PayoutChain = ARC_PAYOUT
): Promise<string | null> {
  const link = page.locator(`a[href^="${chain.explorer}/tx/"]`).first();
```

Check: `grep -n -E 'ARC_CHAIN_ID|ARC_CIRCLE_DOMAIN|ARC_PUBLIC_URL|ARC_TESTNET|ARC_EXPLORER' playwright/e2e/helpers/usdcx-legs.ts` prints nothing.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/helpers/arc-usdcx.test.ts`

Expected: PASS, every test, the Arc `harnessPayoutLeg` and `waitForWalletPayoutConfirmation` messages unchanged (`at Arc block`, `arc.io reads`).

Then: `npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/helpers playwright/e2e/harness/usdcx-live-spec.test.ts playwright/e2e/harness/spec-selection.test.ts`

Expected: PASS (the iOS spec and the Arc specs compile against the widened legs; `spec-selection.test.ts` still lists the four Arc tests).

- [ ] **Step 5: Mutation checks**

```bash
F=playwright/e2e/helpers/usdcx-legs.ts; B="$TMPDIR/usdcx-legs.ts.bak"
cp "$F" "$B" && perl -pi -e 's/domain: chain\.burnDomain \}/domain: chain.attestationSourceDomain }/' "$F" && grep -q 'domain: chain.attestationSourceDomain }' "$F" && npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/helpers/arc-usdcx.test.ts -t 'burnTarget'; cp "$B" "$F"
cp "$F" "$B" && perl -pi -e 's/readArcUsdcSnapshot\(taken\.key\.address, reads\)/readArcUsdcSnapshot(taken.key.address, arc)/' "$F" && grep -q 'readArcUsdcSnapshot(taken.key.address, arc)' "$F" && npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/helpers/arc-usdcx.test.ts -t 'L2 alone'; cp "$B" "$F"
cp "$F" "$B" && perl -pi -e 's/domain: chain\.attestationSourceDomain,\n/domain: chain.burnDomain,\n/' "$F" && grep -q 'domain: chain.burnDomain,' "$F" && npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/helpers/arc-usdcx.test.ts -t 'L2 alone'; cp "$B" "$F"
cp "$F" "$B" && perl -pi -e 's/if \(chain\.chainId !== ARC_PAYOUT\.chainId\) evidence/evidence/' "$F" && npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/helpers/arc-usdcx.test.ts -t 'harness key before the burn'; cp "$B" "$F"
cp "$F" "$B" && perl -pi -e 's/\$\{chain\.walletRpcName\} reads/\${chain.walletRpcUrl} reads/' "$F" && npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/helpers/arc-usdcx.test.ts -t 'project id'; cp "$B" "$F"
cp "$F" "$B" && perl -pi -e 's/redactProjectId\(errorText\(error\)\)/errorText(error)/' "$F" && ! grep -q 'redactProjectId(errorText(error))' "$F" && npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/helpers/arc-usdcx.test.ts -t 'redacts the project id'; cp "$B" "$F"
git diff --stat
```

Predictions: (1) `burnTarget` fails (domains 26, 26, 26). (2) `reads and proves an L2 payout on the L2 alone` fails (`the L2 leg read Arc`). (3) the same test fails (`payout` step: expected domain 6, received 26). (4) `reads the harness key before the burn, proves Circle paid exactly that burn and records both` fails on `not.toHaveProperty('payoutChainId')`. (5) `names the L2's wallet RPC by host, never its project id` fails on `projectId=`. (6) `redacts the project id when the read through the L2 wallet RPC itself fails` fails at `toThrow('projectId=<redacted>')`, the message printing `projectId=operator-project` (viem keeps a stub transport's error text, verified against viem 2.55.4).

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write playwright/e2e/helpers/usdcx-legs.ts playwright/e2e/helpers/arc-usdcx.test.ts
git add playwright/e2e/helpers/usdcx-legs.ts playwright/e2e/helpers/arc-usdcx.test.ts
git commit -m "test(e2e): the burn, payout and wallet-confirmation legs take the payout chain"
```

---

### Task 4: The usdcx-burn-l2 suite and its l2-payout preflight

Size: about 175 spec lines, 80 runner lines, 35 stub lines, 150 test lines.

**Files:**
- Create: `playwright/e2e/tests/usdcx/usdcx-burn-l2.spec.ts`
- Modify: `scripts/e2e-real.mjs:95, 174-184, 224-228, 1286-1297, 1871`
- Modify: `scripts/e2e-real.fetch-stub.mjs:17-53, 97-113`
- Modify: `playwright.usdcx.config.ts:6`
- Test: `scripts/e2e-real.test.ts`, `playwright/e2e/harness/spec-selection.test.ts`

**Interfaces:**
- Consumes (Tasks 1-3): `BASE_SEPOLIA_PAYOUT`, `ARBITRUM_SEPOLIA_PAYOUT`, `PayoutChain`, `harnessPayoutLeg({ ..., payoutReads })`, `submitBurn({ ..., payoutChain })`, `confirmBurn({ ..., payoutChain })`, `assertBurnDetails(wallet, rowId, destination, chain)`, `receivingTxHash(page, ms, chain)`, `waitForWalletPayoutConfirmation`.
- Produces: `SUITES['usdcx-burn-l2']` (grep `USDCx L2 burn`, probes `usdcx`, `usdcx-guardian`, `grant`, `arc-payout`, `l2-payout`); `L2_PAYOUT_CHAINS: { name: string; chainId: number; usdc: string; rpcs: string[] }[]`; `walletL2RpcUrl(chainId: number, env = process.env): string`; preflight checks `<chain> RPC`, `<chain> contracts`, `<chain> wallet RPC` for `Base Sepolia` and `Arbitrum Sepolia`; the describe `USDCx L2 burn through the Send UI after a public faucet grant` with tests `Guardian wallet burns to <Base Sepolia|Arbitrum Sepolia>, the faucet consumes it, Circle pays it out and the wallet confirms it`; evidence attachment `usdcx-burn-l2-evidence.json`.

- [ ] **Step 1: Write the failing tests**

**1a. `playwright/e2e/harness/spec-selection.test.ts`**

Replace (lines 72-90):

```ts
const BURN_TESTS = [
  'usdcx-burn.spec.ts › USDCx burn through the Send UI after a public faucet grant › ' +
    'standard wallet publishes a burn, the faucet consumes it and Circle pays it out',
  'usdcx-burn.spec.ts › USDCx burn through the Send UI after a public faucet grant › ' +
    'Guardian wallet publishes a burn, the faucet consumes it and Circle pays it out'
];
/** Every test `playwright.usdcx.config.ts` must list, and nothing else. */
const USDCX_LIVE_TESTS = [ROUND_TRIP_TEST, BRIDGE_IN_TEST, ...BURN_TESTS];
/** Each runner suite's grep, compiled case-insensitive as scripts/e2e-real.mjs does, and the tests it must select. */
const USDCX_RUNNER_GREPS: Array<[grep: string, tests: string[]]> = [
  ['USDCx round trip', [ROUND_TRIP_TEST]],
  ['funded Arc key', [BRIDGE_IN_TEST]],
  ['USDCx burn through the Send UI', BURN_TESTS]
];
/** Each live spec file and how many describes it guards. */
const USDCX_LIVE_SPECS: Array<[file: string, describes: number]> = [
  ['usdcx-roundtrip.spec.ts', 2],
  ['usdcx-burn.spec.ts', 1]
];
```

With:

```ts
const BURN_TESTS = [
  'usdcx-burn.spec.ts › USDCx burn through the Send UI after a public faucet grant › ' +
    'standard wallet publishes a burn, the faucet consumes it and Circle pays it out',
  'usdcx-burn.spec.ts › USDCx burn through the Send UI after a public faucet grant › ' +
    'Guardian wallet publishes a burn, the faucet consumes it and Circle pays it out'
];
const L2_BURN_TESTS = ['Base Sepolia', 'Arbitrum Sepolia'].map(
  chain =>
    'usdcx-burn-l2.spec.ts › USDCx L2 burn through the Send UI after a public faucet grant › ' +
    `Guardian wallet burns to ${chain}, the faucet consumes it, Circle pays it out and the wallet confirms it`
);
/** Every test `playwright.usdcx.config.ts` must list, and nothing else. */
const USDCX_LIVE_TESTS = [ROUND_TRIP_TEST, BRIDGE_IN_TEST, ...BURN_TESTS, ...L2_BURN_TESTS];
/** Each runner suite's grep, compiled case-insensitive as scripts/e2e-real.mjs does, and the tests it must select. */
const USDCX_RUNNER_GREPS: Array<[grep: string, tests: string[]]> = [
  ['USDCx round trip', [ROUND_TRIP_TEST]],
  ['funded Arc key', [BRIDGE_IN_TEST]],
  ['USDCx burn through the Send UI', BURN_TESTS],
  ['USDCx L2 burn', L2_BURN_TESTS]
];
/** Each live spec file and how many describes it guards. */
const USDCX_LIVE_SPECS: Array<[file: string, describes: number]> = [
  ['usdcx-roundtrip.spec.ts', 2],
  ['usdcx-burn.spec.ts', 1],
  ['usdcx-burn-l2.spec.ts', 1]
];
```

Replace (line 109):

```ts
const USDCX_LIVE_SPEC = /usdcx-roundtrip\.spec\.ts|usdcx-burn\.spec\.ts|bridge-out-usdcx\.spec\.ts/;
```

With:

```ts
const USDCX_LIVE_SPEC = /usdcx-roundtrip\.spec\.ts|usdcx-burn\.spec\.ts|usdcx-burn-l2\.spec\.ts|bridge-out-usdcx\.spec\.ts/;
```

Replace (lines 154-167):

```ts
  it.each(['usdcx-roundtrip.spec.ts', 'usdcx-burn.spec.ts'])(
    "%s waits for each burn's own payout, proven against the key read right before the burn",
    file => {
      const source = configSource(`${USDCX_TESTS_DIR}/${file}`);
      for (const wiring of USDCX_PAYOUT_WIRING) expect(source).toMatch(wiring);
    }
  );

  it.each(['usdcx-roundtrip.spec.ts', 'usdcx-burn.spec.ts'])(
```

With:

```ts
  it.each(['usdcx-roundtrip.spec.ts', 'usdcx-burn.spec.ts', 'usdcx-burn-l2.spec.ts'])(
    "%s waits for each burn's own payout, proven against the key read right before the burn",
    file => {
      const source = configSource(`${USDCX_TESTS_DIR}/${file}`);
      for (const wiring of USDCX_PAYOUT_WIRING) expect(source).toMatch(wiring);
    }
  );

  it.each(['usdcx-roundtrip.spec.ts', 'usdcx-burn.spec.ts', 'usdcx-burn-l2.spec.ts'])(
```

**1b. `scripts/e2e-real.test.ts`**

Replace (lines 39-40 of the `./e2e-real.mjs` import):

```ts
  HARNESS_ARC_KEY_FILE,
  SUITES,
```

With:

```ts
  HARNESS_ARC_KEY_FILE,
  L2_PAYOUT_CHAINS,
  SUITES,
```

and, in the same import, replace:

```ts
  usdcxGrantProblem
} from './e2e-real.mjs';
```

With:

```ts
  usdcxGrantProblem,
  walletL2RpcUrl
} from './e2e-real.mjs';
```

Replace (lines 94-95 in `cleanEnv`):

```ts
    'E2E_REAL_EPOCH',
    'E2E_REAL_USDCX'
  ]) {
```

With:

```ts
    'E2E_REAL_EPOCH',
    'E2E_REAL_USDCX',
    'WALLETCONNECT_PROJECT_ID'
  ]) {
```

Replace (line 991):

```ts
  it.each(['usdcx', 'usdcx-in', 'usdcx-burn'])(
    'refuses --network devnet for --suite %s',
```

With:

```ts
  it.each(['usdcx', 'usdcx-in', 'usdcx-burn', 'usdcx-burn-l2'])(
    'refuses --network devnet for --suite %s',
```

Replace (line 1002):

```ts
  it.each(['usdcx', 'usdcx-in', 'usdcx-burn'])(
    'refuses --skip-build for --suite %s',
```

With:

```ts
  it.each(['usdcx', 'usdcx-in', 'usdcx-burn', 'usdcx-burn-l2'])(
    'refuses --skip-build for --suite %s',
```

Insert after line 1032 (the closing `);` of `refuses an exported %s by name, never by value`):

```ts

  it('refuses an exported E2E_EVM_RPC_URL on usdcx-burn-l2, whose wallet would read both L2s through it', () => {
    const res = runCli(
      { E2E_EVM_RPC_URL: 'https://refused-evm-rpc.example' },
      '--suite',
      'usdcx-burn-l2',
      '--preflight-only'
    );
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('E2E_EVM_RPC_URL is set, and --suite usdcx-burn-l2 refuses it');
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);
```

Replace (lines 1131-1133):

```ts
    ['usdcx', {}],
    ['usdcx-burn', {}],
    ['usdcx-in', {}],
```

With:

```ts
    ['usdcx', {}],
    ['usdcx-burn', {}],
    ['usdcx-burn-l2', {}],
    ['usdcx-in', {}],
```

Replace (lines 1213-1232):

```ts
  const OWN: Record<string, string> = {
    usdcx: 'USDCx round trip: burn to the harness Arc key, Circle payout, deposit back',
    'usdcx-in': 'USDCx bridge-in from a funded Arc key',
    'usdcx-burn': 'USDCx burn through the Send UI after a public faucet grant'
  };
  let listed: ReturnType<typeof listUsdcxTests>;

  beforeAll(() => {
    listed = listUsdcxTests();
  }, 60_000);

  it('find the three describes and four tests the contract names under playwright.usdcx.config.ts', () => {
    expect(listed.errors).toEqual([]);
    expect([...new Set(listed.tests.map(test => test.split(' > ')[0]))].sort()).toEqual(Object.values(OWN).sort());
    expect(listed.tests).toHaveLength(4);
    expect(listed.tests.filter(test => test.startsWith(`${OWN['usdcx-burn']} > `))).toEqual([
      `${OWN['usdcx-burn']} > Guardian wallet publishes a burn, the faucet consumes it and Circle pays it out`,
      `${OWN['usdcx-burn']} > standard wallet publishes a burn, the faucet consumes it and Circle pays it out`
    ]);
  });
```

With:

```ts
  const OWN: Record<string, string> = {
    usdcx: 'USDCx round trip: burn to the harness Arc key, Circle payout, deposit back',
    'usdcx-in': 'USDCx bridge-in from a funded Arc key',
    'usdcx-burn': 'USDCx burn through the Send UI after a public faucet grant',
    'usdcx-burn-l2': 'USDCx L2 burn through the Send UI after a public faucet grant'
  };
  let listed: ReturnType<typeof listUsdcxTests>;

  beforeAll(() => {
    listed = listUsdcxTests();
  }, 60_000);

  it('find the four describes and six tests the contract names under playwright.usdcx.config.ts', () => {
    expect(listed.errors).toEqual([]);
    expect([...new Set(listed.tests.map(test => test.split(' > ')[0]))].sort()).toEqual(Object.values(OWN).sort());
    expect(listed.tests).toHaveLength(6);
    expect(listed.tests.filter(test => test.startsWith(`${OWN['usdcx-burn']} > `))).toEqual([
      `${OWN['usdcx-burn']} > Guardian wallet publishes a burn, the faucet consumes it and Circle pays it out`,
      `${OWN['usdcx-burn']} > standard wallet publishes a burn, the faucet consumes it and Circle pays it out`
    ]);
    expect(listed.tests.filter(test => test.startsWith(`${OWN['usdcx-burn-l2']} > `))).toEqual([
      `${OWN['usdcx-burn-l2']} > Guardian wallet burns to Arbitrum Sepolia, the faucet consumes it, Circle pays it out and the wallet confirms it`,
      `${OWN['usdcx-burn-l2']} > Guardian wallet burns to Base Sepolia, the faucet consumes it, Circle pays it out and the wallet confirms it`
    ]);
  });
```

Insert after line 1460 (the closing `});` of `describe('the usdcx constants are the ones the harness and the wallet use', ...)`):

```ts

describe('the usdcx-burn-l2 copies are the ones the harness and the wallet use', () => {
  const harnessChains = [harness.BASE_SEPOLIA_PAYOUT, harness.ARBITRUM_SEPOLIA_PAYOUT];

  it('copies exactly the two L2s, in the order the harness lists them', () => {
    expect(L2_PAYOUT_CHAINS.map(chain => chain.chainId)).toEqual(harnessChains.map(chain => chain.chainId));
  });

  it.each(harnessChains.map(chain => [chain.networkName, chain]))(
    '%s: the name, the USDC and the endpoints the harness reads, and the RPC the wallet reads',
    (name, chain) => {
      const copy = L2_PAYOUT_CHAINS.find(candidate => candidate.chainId === chain.chainId);
      expect(copy).toEqual({ name, chainId: chain.chainId, usdc: chain.usdc, rpcs: [...chain.rpcUrls] });
      expect(wallet.CIRCLE_USDC_ADDRESS.get(chain.chainId)).toBe(chain.usdc);
      expect(walletL2RpcUrl(chain.chainId, process.env)).toBe(chain.walletRpcUrl);
    }
  );
});
```

Insert inside `describe('the usdcx preflight', ...)`, after the test ending at line 1559 (`asks usdcx-burn the payout questions and no funded-key question`):

```ts

  it("asks usdcx-burn-l2 the payout questions, then on each L2 the chain, both contracts and the wallet RPC's head", () => {
    const res = preflight('usdcx-burn-l2');
    expect(res.output).toContain('✓ preflight passed (17 checks)');
    expect(res.status).toBe(0);
    expect(
      missing(res.requests, [
        XRESERVE_CALLS.withdrawalsPaused,
        XRESERVE_CALLS.gatewayMinter,
        ...L2_PAYOUT_CHAINS.flatMap(chain => [
          `${chain.rpcs[0]} eth_chainId []`,
          `${chain.rpcs[0]} eth_getCode ["${GATEWAY_MINTER}","latest"]`,
          `${chain.rpcs[0]} eth_getCode ["${chain.usdc}","latest"]`,
          `${walletL2RpcUrl(chain.chainId, {})} eth_blockNumber []`
        ])
      ])
    ).toEqual([]);
    expect(res.output).toContain('Arbitrum Sepolia wallet RPC');
    expect(res.output).toContain('rpc.walletconnect.org #2');
  }, 35_000);

  it('names the wallet RPC by host only, whatever project id the build bakes in', () => {
    const res = preflight('usdcx-burn-l2', DOCUMENT, { WALLETCONNECT_PROJECT_ID: 'operator-project-id' });
    expect(res.requests).toContain('projectId=operator-project-id');
    expect(res.output).not.toContain('operator-project-id');
    expect(res.status).toBe(0);
  }, 35_000);

  it.each([
    [
      'Base Sepolia RPC',
      { l2WrongChain: ['base-sepolia-rpc.publicnode.com', 'base-sepolia.gateway.tenderly.co', 'sepolia.base.org'] }
    ],
    ['Arbitrum Sepolia contracts', { l2NoCode: ['0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d'] }]
  ])(
    'fails %s alone on --suite usdcx-burn-l2 when its answer is wrong',
    (label, answers) => {
      const res = preflight('usdcx-burn-l2', DOCUMENT, {}, answers);
      expect(failedChecks(res.output)).toEqual([label]);
      expect(res.status).toBe(1);
      expect(res.requests).not.toContain('SPAWN');
    },
    35_000
  );

  it('fails both wallet RPC checks when rpc.walletconnect.org is down, before any build', () => {
    const res = preflight('usdcx-burn-l2', DOCUMENT, {}, { l2Down: ['rpc.walletconnect.org'] });
    expect(failedChecks(res.output)).toEqual(['Base Sepolia wallet RPC', 'Arbitrum Sepolia wallet RPC']);
    expect(res.status).toBe(1);
    expect(res.requests).not.toContain('SPAWN');
  }, 35_000);

  it("passes with Base Sepolia's first endpoint down, asking the next one the contract questions", () => {
    const res = preflight('usdcx-burn-l2', DOCUMENT, {}, { l2Down: ['base-sepolia-rpc.publicnode.com'] });
    expect(res.status).toBe(0);
    expect(res.requests).toContain(
      'https://base-sepolia.gateway.tenderly.co eth_getCode ["0x036CbD53842c5426634e7929541eC2318f3dCF7e","latest"]'
    );
  }, 35_000);

  it('asks usdcx-burn no L2 question: the Arc suites preflight as they did', () => {
    const res = preflight('usdcx-burn');
    expect(res.requests).not.toContain('rpc.walletconnect.org');
    expect(res.requests).not.toContain('base-sepolia');
    expect(res.requests).not.toContain('arbitrum');
  }, 35_000);
```

Insert inside `describe('a usdcx run', ...)`, after the test `takes an exported MIDEN_CLIENT_BIN and installs nothing` (ends line 1883):

```ts

  it('runs usdcx-burn-l2 under its own grep with the harness key, headless', () => {
    const res = stubbed(['--suite', 'usdcx-burn-l2'], DOCUMENT, { MIDEN_CLIENT_BIN: '/operator/bin/miden-client' });
    const children = spawned(res.requests);
    expect(children[1]?.args).toEqual(testArgs('USDCx L2 burn'));
    expect(children[1]?.env).toMatchObject({ E2E_REAL_USDCX: 'true', E2E_ARC_KEY_ROLE: 'harness', E2E_HEADLESS: '1' });
    expect(res.status).toBe(0);
  }, 35_000);
```

Replace (line 2152, in `describe('the usage', ...)`):

```ts
    expect(res.stdout).toContain('usdcx and usdcx-burn burn to one harness Arc');
```

With:

```ts
    expect(res.stdout).toContain('usdcx and usdcx-burn burn to one harness Arc');
    expect(res.stdout).toContain("usdcx-burn-l2 burns to that key's address on Base Sepolia and Arbitrum Sepolia");
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx jest --maxWorkers=2 --testTimeout=60000 scripts/e2e-real.test.ts -t 'usdcx-burn-l2|four describes|wallet RPC|first endpoint down|L2 question|usage'`

(`wallet RPC` and `first endpoint down` select the three preflight tests whose titles do not name the suite; no existing test matches either.)

Expected: FAIL. The `usdcx-burn-l2` refusals fail (`unknown suite usdcx-burn-l2` in stderr), the listing test fails (4 tests listed, not 6), the copies tests fail (`L2_PAYOUT_CHAINS` undefined), the preflight tests fail (`names the wallet RPC by host only ...`, `fails both wallet RPC checks ...` and `passes with Base Sepolia's first endpoint down ...` among them), the usage test fails. `asks usdcx-burn no L2 question` passes (a pin).

Run: `npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/harness/spec-selection.test.ts -t 'USDCx'`

Expected: FAIL: `lists exactly the live USDCx tests` (two tests missing), the `USDCx L2 burn` grep row, and the three `usdcx-burn-l2.spec.ts` rows (`ENOENT ... usdcx-burn-l2.spec.ts`).

- [ ] **Step 3: Write the spec**

Create `playwright/e2e/tests/usdcx/usdcx-burn-l2.spec.ts`:

```ts
import { expect, test, type GuardianAwareWalletPage } from '../../fixtures/two-wallets';
import {
  arcEndpoints,
  arcHost,
  readXReserveDomainState,
  type ArcKey,
  type ArcReadDeps,
  type GatewayPayout
} from '../../helpers/arc-usdcx';
import { enText, readBridgedSendRows } from '../../helpers/bridge';
import { openHistoryDetails } from '../../helpers/history';
import {
  ARBITRUM_SEPOLIA_PAYOUT,
  ARC_READ_STEP_BUDGET_MS,
  BASE_SEPOLIA_PAYOUT,
  BURN_UNITS,
  PAYOUT_TIMEOUT_MS,
  USDCX_REMOTE_DOMAIN,
  WALLET_CONFIRM_TIMEOUT_MS,
  type PayoutChain
} from '../../helpers/usdcx-constants';
import { guardianFailureContext, guardianIdentity } from '../../helpers/usdcx-guardian';
import {
  assertBurnDetails,
  attachEvidence,
  confirmBurn,
  createGuardianUsdcxWallet,
  fundFromPublicFaucet,
  harnessPayoutLeg,
  pageWhere,
  receivingTxHash,
  resolveUsdcxIds,
  settleGuardian,
  submitBurn,
  waitForWalletPayoutConfirmation,
  type BurnLeg
} from '../../helpers/usdcx-legs';
import {
  assertUsdcxLiveRun,
  namedSteps,
  newRunEvidence,
  takeRunArcKey,
  type RunEvidence,
  type StepContext
} from '../../helpers/usdcx-run';

/** Step budgets of spec section 5, steps 1 to 8b, as usdcx-burn.spec.ts and the round trip set them. */
const BUDGET = {
  wallet: 180_000,
  // Each read step outlasts a stall on every endpoint before the last one answers, on Arc and on each L2.
  arcState: ARC_READ_STEP_BUDGET_MS,
  fund: 180_000,
  settle: 240_000,
  keySnapshot: ARC_READ_STEP_BUDGET_MS,
  burnViaUi: 180_000,
  burnRowPoll: 180_000,
  burnConfirmed: 300_000,
  payout: PAYOUT_TIMEOUT_MS + 120_000,
  walletPayoutConfirmed: WALLET_CONFIRM_TIMEOUT_MS + 60_000
} as const;

const SETTLE_WAIT_MS = 120_000;
const RECEIVING_TX_LINK_MS = 15_000;
/** Ethereum Sepolia stays out: Circle never pays a burn out there, and payoutChainFor refuses it. */
const DESTINATIONS: readonly PayoutChain[] = [BASE_SEPOLIA_PAYOUT, ARBITRUM_SEPOLIA_PAYOUT];

/**
 * Spec 5 step 8b on an L2: the wallet's own destination check, which reads the L2 through the WalletConnect RPC no Arc
 * test exercises, confirms the payout the harness proved, and the receiving-tx link, when it renders, names it.
 */
async function walletConfirmsPayout(
  wallet: GuardianAwareWalletPage,
  burn: BurnLeg,
  payout: GatewayPayout,
  key: ArcKey,
  reads: ArcReadDeps,
  chain: PayoutChain,
  where: StepContext,
  evidence: RunEvidence
): Promise<number> {
  await wallet.navigateHome();
  const confirmedAt = await waitForWalletPayoutConfirmation({
    readRows: () => readBridgedSendRows(wallet.page),
    rowId: burn.row.id,
    arcFromBlock: burn.arcFromBlock,
    payout,
    key,
    arc: reads,
    where,
    evidence
  });
  await openHistoryDetails(wallet, burn.row.id);
  await expect(wallet.page.getByTestId('history-status-pill')).toHaveText(enText('confirmed'));
  // The lookup covers 2000 blocks, about 8.6 min on Arbitrum, an accepted limit, so a missing link is only recorded.
  const linkHash = await receivingTxHash(wallet.page, RECEIVING_TX_LINK_MS, chain);
  if (linkHash !== null && linkHash !== payout.transactionHash.toLowerCase()) {
    throw new Error(
      `the receiving-tx link names ${linkHash}; the AttestationUsed transaction is ${payout.transactionHash}`
    );
  }
  evidence.notes.push(
    linkHash === null
      ? 'receiving-tx link did not render within 15 s'
      : 'receiving-tx link is the AttestationUsed transaction'
  );
  await wallet.navigateHome();
  return confirmedAt;
}

/**
 * A burn through Send from a fresh Guardian wallet to the harness key's address on Base Sepolia, and one on Arbitrum
 * Sepolia, each funded by one public faucet grant. Run only through `yarn e2e:real --suite usdcx-burn-l2`. Each test
 * ends only once Circle has paid its own burn on that L2 (R22) and the wallet itself reads Confirmed.
 */
test.describe('USDCx L2 burn through the Send UI after a public faucet grant', () => {
  // The injected fee faucet masks the wallet's own native-asset discovery (two-wallets.ts:840).
  test.use({ injectFeeFaucet: false });
  // ~2 min setup + 35.5 min of step budgets (15.5 to the submit, 5 to confirm the burn, the 10 min gate and its 2 min
  // closing read, 3 for the wallet's confirmation) <= 38 min.
  test.describe.configure({ timeout: 2_280_000 });
  test.beforeAll(() => {
    assertUsdcxLiveRun(process.env);
    takeRunArcKey(process.env);
  });

  for (const chain of DESTINATIONS) {
    test(`Guardian wallet burns to ${chain.networkName}, the faucet consumes it, Circle pays it out and the wallet confirms it`, async ({
      walletA,
      envConfig,
      steps
    }) => {
      const step = namedSteps(steps);
      const arc: ArcReadDeps = { endpoints: arcEndpoints(process.env.E2E_ARC_RPC_URL) };
      const reads: ArcReadDeps = { endpoints: chain.rpcUrls, payoutChain: chain };
      const where = pageWhere(walletA);
      const evidence = newRunEvidence(`usdcx-burn-l2 ${chain.reviewNetwork}`);
      const secrets: string[] = [];
      let passed = false;
      try {
        const { identity, ids } = await step(
          'wallet',
          BUDGET.wallet,
          async () => {
            const identity = await guardianIdentity(envConfig.guardianUrl);
            const address = await createGuardianUsdcxWallet(walletA, envConfig.guardianUrl);
            return { identity, ids: await resolveUsdcxIds(walletA.page, address) };
          },
          async () => `guardian ${envConfig.guardianUrl}`
        );
        const onGuardian: StepContext = () => guardianFailureContext(identity);
        evidence.ids.address = ids.address;
        evidence.ids.native = ids.native;

        // On Arc for every destination: Miden's xReserve domain is what pays any burn out, and the depositor it names is
        // the source every L2 payout carries.
        const xreserve = await step('arc_state', BUDGET.arcState, async () => {
          const state = await readXReserveDomainState(arc);
          expect(
            { registered: state.registered, paused: state.paused, withdrawalsPaused: state.withdrawalsPaused },
            `xReserve domain ${USDCX_REMOTE_DOMAIN} read on ${arcHost(state.endpoint)}`
          ).toEqual({ registered: true, paused: false, withdrawalsPaused: false });
          return state;
        });

        const funding = await step(
          'fund',
          BUDGET.fund,
          () => fundFromPublicFaucet(walletA.page, ids, envConfig.rpcUrl, where),
          onGuardian
        );
        evidence.fees.push(funding.f0);
        evidence.ids.grantNote = funding.grantNoteId;
        // A Guardian burn is not requeued on a pending-delta 409 (transaction/index.ts:196-202): the grant settles first.
        evidence.settleMs.grant = await step(
          'settle_grant',
          BUDGET.settle,
          () => settleGuardian(walletA, SETTLE_WAIT_MS),
          onGuardian
        );

        // R21, R22 on the L2: the harness key's address there, read right before the burn on the harness's endpoints.
        const { key, snapshot, waitForPayout } = await harnessPayoutLeg(step, {
          env: process.env,
          arc,
          payoutReads: reads,
          budget: BUDGET,
          evidence,
          secrets
        });

        const priorBurns = await step(
          'burn_via_ui',
          BUDGET.burnViaUi,
          () =>
            submitBurn(walletA, ids, {
              destination: key.address,
              units: BURN_UNITS,
              screenshotDir: test.info().outputDir,
              payoutChain: chain
            }),
          onGuardian
        );
        const burn = await step(
          'burn_confirmed',
          BUDGET.burnConfirmed,
          async () => {
            const burn = await confirmBurn(walletA, ids, {
              priorRowIds: priorBurns,
              destination: key.address,
              keySnapshot: snapshot,
              units: BURN_UNITS,
              vaultBefore: funding.vault,
              rpcUrl: envConfig.rpcUrl,
              guardian: true,
              timeoutMs: BUDGET.burnRowPoll,
              where,
              payoutChain: chain
            });
            await assertBurnDetails(walletA, burn.row.id, key.address, chain);
            await walletA.page.screenshot({ path: test.info().outputPath('usdcx-burn-confirmed.png') });
            await walletA.navigateHome();
            return burn;
          },
          onGuardian
        );
        evidence.ids.burnRow = burn.row.id;
        evidence.ids.burnNote = burn.burnNoteId;
        evidence.hashes.burnTransaction = burn.row.transactionId ?? 'none';
        evidence.fees.push(burn.fee, { name: 's', amount: burn.sponsorship, kind: 'exact' });
        evidence.phases.burn = burn.phases.samples();

        const payout = await waitForPayout(burn, xreserve.depositor);
        const walletConfirmedAt = await step('wallet_payout_confirmed', BUDGET.walletPayoutConfirmed, () =>
          walletConfirmsPayout(walletA, burn, payout, key, reads, chain, where, evidence)
        );
        evidence.latenciesMs.payoutToWalletConfirmation =
          walletConfirmedAt - (burn.oracle.consumeTimestampSec * 1_000 + payout.latencyMs);
        passed = true;
      } finally {
        await attachEvidence(test.info(), 'usdcx-burn-l2-evidence.json', evidence, secrets).catch((error: unknown) => {
          if (passed) throw error;
        });
      }
    });
  }
});
```

Replace (line 6 of `playwright.usdcx.config.ts`):

```ts
// `yarn e2e:real --suite usdcx|usdcx-in|usdcx-burn` is its only caller, by hand and in E2E USDCx (e2e-usdcx.yml). An
```

With:

```ts
// `yarn e2e:real --suite usdcx|usdcx-in|usdcx-burn|usdcx-burn-l2` is its only caller, by hand and in E2E USDCx (e2e-usdcx.yml). An
```

- [ ] **Step 4: Write the runner suite, its copies and its probe**

In `scripts/e2e-real.mjs`:

Replace (line 95):

```js
export const USDCX_RUN_LOCK = path.join(os.homedir(), '.miden-e2e', 'usdcx-run.lock');
```

With:

```js
export const USDCX_RUN_LOCK = path.join(os.homedir(), '.miden-e2e', 'usdcx-run.lock');
/**
 * The L2s usdcx-burn-l2 burns to: each chain's USDC and the endpoints the harness reads it through, in the order its
 * payout gate tries them (BASE_SEPOLIA_PAYOUT and ARBITRUM_SEPOLIA_PAYOUT in usdcx-constants.ts); e2e-real.test.ts
 * pins each copy to the harness and the wallet.
 */
export const L2_PAYOUT_CHAINS = [
  {
    name: 'Base Sepolia',
    chainId: 84532,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    rpcs: [
      'https://base-sepolia-rpc.publicnode.com',
      'https://base-sepolia.gateway.tenderly.co',
      'https://sepolia.base.org'
    ]
  },
  {
    name: 'Arbitrum Sepolia',
    chainId: 421614,
    usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    rpcs: [
      'https://sepolia-rollup.arbitrum.io/rpc',
      'https://arbitrum-sepolia-rpc.publicnode.com',
      'https://arbitrum-sepolia.gateway.tenderly.co'
    ]
  }
];
/** The Reown project id an E2E build bakes in unless WALLETCONNECT_PROJECT_ID is set (src/lib/walletconnect/config.ts). */
const DEFAULT_WC_PROJECT_ID = 'd18d112eb50cbe764f03e51a90210611';

/** The wallet's own RPC for an L2, built as walletconnect/config.ts builds it. Only its host is ever printed. */
export function walletL2RpcUrl(chainId, env = process.env) {
  const projectId = (env.WALLETCONNECT_PROJECT_ID ?? '').trim() || DEFAULT_WC_PROJECT_ID;
  return `https://rpc.walletconnect.org/v1?chainId=eip155:${chainId}&projectId=${projectId}`;
}
```

Replace (lines 181-184):

```js
    describe: 'standard and Guardian wallets: faucet grant, UI burn to the harness Arc key, Circle payout'
  }
};
```

With:

```js
    describe: 'standard and Guardian wallets: faucet grant, UI burn to the harness Arc key, Circle payout'
  },
  // Its own suite, so an L2 RPC outage stops no Arc suite, and E2E USDCx can run it after a red one: its payout windows
  // are on Base Sepolia and Arbitrum Sepolia, where nothing an Arc suite leaves pending lands.
  'usdcx-burn-l2': {
    config: 'playwright.usdcx.config.ts',
    grep: 'USDCx L2 burn',
    probes: ['usdcx', 'usdcx-guardian', 'grant', 'arc-payout', 'l2-payout'],
    networks: ['testnet'],
    usdcx: true,
    headlessByDefault: true,
    retries: 0,
    describe: 'Guardian wallets: faucet grant, UI burn to the harness key on Base Sepolia and Arbitrum Sepolia, payout, confirmation'
  }
};
```

Replace (lines 227-228 of USAGE):

```
it, so no run needs Circle's faucet. usdcx-in needs the key to hold 0.021 USDC,
or an exported E2E_ARC_PRIVATE_KEY that does.
```

With:

```
it, so no run needs Circle's faucet. usdcx-in needs the key to hold 0.021 USDC,
or an exported E2E_ARC_PRIVATE_KEY that does. usdcx-burn-l2 burns to that key's address on Base Sepolia and Arbitrum Sepolia,
where Circle's payouts stay: the key holds no ETH there and never spends.
```

Replace (lines 1294-1297, the end of `probeUsdcx`):

```js
  if (remoteToken === undefined) return;
  await probeCircleXReserveApi(remoteToken);
  await probeUsdcxNativeAsset(opts.network, remoteToken);
}
```

With:

```js
  if (remoteToken === undefined) return;
  await probeCircleXReserveApi(remoteToken);
  await probeUsdcxNativeAsset(opts.network, remoteToken);
}

/**
 * One L2 usdcx-burn-l2 pays out on, read as its spec reads it: a harness endpoint serving the chain (the first healthy
 * one is asked the rest), the GatewayMinter and the USDC with code there, and a head from the wallet's own RPC, whose
 * pre-burn snapshot read otherwise fails the burn before any row exists. That RPC is printed by host only: its URL
 * carries the build's project id.
 */
async function probeL2Payout(chain) {
  const states = [];
  let healthy;
  for (const url of chain.rpcs) {
    const host = endpointHost(url);
    try {
      const chainId = Number(await arcRpc(url, 'eth_chainId', []));
      if (chainId !== chain.chainId) {
        states.push(`${host} reports chain ${chainId}`);
        continue;
      }
      states.push(`${host} #${Number(await arcRpc(url, 'eth_blockNumber', []))}`);
      if (healthy === undefined) healthy = url;
    } catch (err) {
      states.push(`${host} ${err.message}`);
    }
  }
  record(
    healthy !== undefined,
    `${chain.name} RPC`,
    healthy === undefined ? `no endpoint serves chain ${chain.chainId}: ${states.join('; ')}` : states.join('; ')
  );
  if (healthy !== undefined) {
    try {
      const empty = [];
      for (const [name, address] of [
        ['GatewayMinter', GATEWAY_MINTER],
        ['USDC', chain.usdc]
      ]) {
        if (codeBytes(await arcRpc(healthy, 'eth_getCode', [address, 'latest'])) === 0) empty.push(`${name} ${address}`);
      }
      record(
        empty.length === 0,
        `${chain.name} contracts`,
        empty.length === 0 ? `GatewayMinter and USDC ${chain.usdc} have code` : `${empty.join(' and ')} has no code`
      );
    } catch (err) {
      record(false, `${chain.name} contracts`, `${endpointHost(healthy)}: ${err.message}`);
    }
  }
  const walletRpc = walletL2RpcUrl(chain.chainId);
  try {
    const head = Number(await arcRpc(walletRpc, 'eth_blockNumber', []));
    record(true, `${chain.name} wallet RPC`, `${endpointHost(walletRpc)} #${head}`);
  } catch (err) {
    record(false, `${chain.name} wallet RPC`, `${endpointHost(walletRpc)}: ${err.message}`);
  }
}
```

Replace (line 1871):

```js
  if (needs.includes('usdcx')) await probeUsdcx(opts, needs, arcKey);
```

With:

```js
  if (needs.includes('usdcx')) await probeUsdcx(opts, needs, arcKey);
  if (needs.includes('l2-payout')) {
    for (const chain of L2_PAYOUT_CHAINS) await probeL2Payout(chain);
  }
```

In `scripts/e2e-real.fetch-stub.mjs`:

Replace (lines 51-53):

```js
  cliInstall: { status: 0, stdout: 'Installed package `miden-client-cli`\n/stub/cli/bin/miden-client\n' },
  exitCodes: { build: 0, test: 0 }
};
```

With:

```js
  cliInstall: { status: 0, stdout: 'Installed package `miden-client-cli`\n/stub/cli/bin/miden-client\n' },
  exitCodes: { build: 0, test: 0 },
  // L2 hosts (rpc.walletconnect.org included) whose every request fails as a network error, hosts that report
  // Sepolia's chain, and lowercase addresses with no code on either L2.
  l2Down: [],
  l2WrongChain: [],
  l2NoCode: []
};
```

Replace (line 97):

```js
const isArc = host => host.endsWith('.arc.io') || host.startsWith('arc-rpc.');
```

With:

```js
const isArc = host => host.endsWith('.arc.io') || host.startsWith('arc-rpc.');

// The harness's L2 endpoints by host; the wallet's own RPC names its chain in the query.
const L2_HOSTS = {
  'base-sepolia-rpc.publicnode.com': 84532,
  'base-sepolia.gateway.tenderly.co': 84532,
  'sepolia.base.org': 84532,
  'sepolia-rollup.arbitrum.io': 421614,
  'arbitrum-sepolia-rpc.publicnode.com': 421614,
  'arbitrum-sepolia.gateway.tenderly.co': 421614
};
function l2ChainOf({ host, searchParams }) {
  if (host === 'rpc.walletconnect.org') return Number((searchParams.get('chainId') ?? '').replace('eip155:', ''));
  return L2_HOSTS[host];
}

function l2Answer(chainId, { method, params }) {
  switch (method) {
    case 'eth_chainId':
      return { result: `0x${chainId.toString(16)}` };
    case 'eth_blockNumber':
      return { result: '0x2' };
    case 'eth_getCode':
      return { result: answers.l2NoCode.includes(String(params[0]).toLowerCase()) ? '0x' : '0x6080' };
    default:
      return { error: { code: -32601, message: `the method ${method} does not exist/is not available` } };
  }
}
```

Replace (lines 112-113):

```js
    return json({ jsonrpc: '2.0', id: call.id, ...arcAnswer(call) });
  }
  if (call) return json({ jsonrpc: '2.0', id: call.id, result: RPC_RESULTS[call.method] });
```

With:

```js
    return json({ jsonrpc: '2.0', id: call.id, ...arcAnswer(call) });
  }
  const l2 = call ? l2ChainOf(new URL(url)) : undefined;
  if (l2 !== undefined) {
    if (answers.l2Down.includes(host)) throw new TypeError('fetch failed');
    const chainId = answers.l2WrongChain.includes(host) ? 11155111 : l2;
    return json({ jsonrpc: '2.0', id: call.id, ...l2Answer(chainId, call) });
  }
  if (call) return json({ jsonrpc: '2.0', id: call.id, result: RPC_RESULTS[call.method] });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest --maxWorkers=2 --testTimeout=60000 scripts/e2e-real.test.ts playwright/e2e/harness/spec-selection.test.ts`

Expected: PASS, both files, the Arc suites' pins (11 checks on `usdcx-burn`, 4 Arc tests, their greps) unchanged.

Run the new spec through the harness rules, which CI's `lint:e2e` applies to every playwright file (a new file has no baseline, so any hit fails CI):

```bash
npx eslint --no-eslintrc -c .eslintrc.harness.json --rulesdir playwright/e2e/eslint-rules --ext .ts playwright/e2e/tests/usdcx/usdcx-burn-l2.spec.ts
```

Expected: no output.

Then the directory sweep: `npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/harness playwright/e2e/helpers`. Expected: PASS.

- [ ] **Step 6: Mutation checks**

```bash
F=scripts/e2e-real.mjs; B="$TMPDIR/e2e-real.mjs.bak"
cp "$F" "$B" && perl -0pi -e "s/  if \(needs\.includes\('l2-payout'\)\) \{\n    for \(const chain of L2_PAYOUT_CHAINS\) await probeL2Payout\(chain\);\n  \}\n//" "$F" && ! grep -q "await probeL2Payout(chain)" "$F" && npx jest --maxWorkers=2 --testTimeout=60000 scripts/e2e-real.test.ts -t 'usdcx-burn-l2'; cp "$B" "$F"
cp "$F" "$B" && perl -pi -e 's/\$\{endpointHost\(walletRpc\)\}: \$\{err\.message\}/\${walletRpc}: \${err.message}/; s/\$\{endpointHost\(walletRpc\)\} #\$\{head\}/\${walletRpc} #\${head}/' "$F" && npx jest --maxWorkers=2 --testTimeout=60000 scripts/e2e-real.test.ts -t 'host only'; cp "$B" "$F"
cp "$F" "$B" && perl -pi -e "s/grep: 'USDCx L2 burn'/grep: 'burn'/" "$F" && npx jest --maxWorkers=2 --testTimeout=60000 scripts/e2e-real.test.ts -t 'greps exactly'; cp "$B" "$F"
git diff --stat
```

Predictions: (1) the `usdcx-burn-l2` preflight tests fail (`passed (11 checks)`, no L2 requests). (2) `names the wallet RPC by host only ...` fails on `operator-project-id`. (3) `--suite usdcx-burn-l2 greps exactly the tests of its own describe` fails (it selects the two Arc burn tests too).

- [ ] **Step 7: Format and commit**

```bash
npx prettier --write playwright/e2e/tests/usdcx/usdcx-burn-l2.spec.ts scripts/e2e-real.mjs scripts/e2e-real.fetch-stub.mjs scripts/e2e-real.test.ts playwright/e2e/harness/spec-selection.test.ts playwright.usdcx.config.ts
git add playwright/e2e/tests/usdcx/usdcx-burn-l2.spec.ts scripts/e2e-real.mjs scripts/e2e-real.fetch-stub.mjs scripts/e2e-real.test.ts playwright/e2e/harness/spec-selection.test.ts playwright.usdcx.config.ts
git commit -m "test(e2e): usdcx-burn-l2 burns from Guardian wallets to Base Sepolia and Arbitrum Sepolia"
```

---

### Task 5: CI step, ceiling, docs and changelog

Size: about 25 workflow lines, 20 test lines, 25 doc lines, one changelog line.

**Files:**
- Modify: `.github/workflows/e2e-usdcx.yml:3-15, 41-45, 110-113, 143-151`
- Modify: `playwright/e2e/harness/usdcx-workflow.test.ts:149-171`
- Modify: `playwright/e2e/harness/linked-pr-injection.test.ts:357`
- Modify: `playwright/e2e/docs/e2e-architecture.md:186, 372, 378, 382, 385, 395, 409`
- Modify: `CHANGELOG.md` (one line under the open `(TBD)` section)

**Interfaces:**
- Consumes (Task 4): `node scripts/e2e-real.mjs --suite usdcx-burn-l2`.
- Produces: step `Run usdcx-burn-l2` (id `usdcx_burn_l2`, `if: ${{ !cancelled() && steps.usdcx_in.outcome != 'skipped' }}`), step `Upload usdcx-burn-l2 results` (artifact `usdcx-burn-l2-e2e-${{ github.run_id }}`), `timeout-minutes: ${{ github.event_name == 'workflow_dispatch' && 325 || 295 }}`.

- [ ] **Step 1: Write the failing tests**

In `playwright/e2e/harness/usdcx-workflow.test.ts`:

Replace (lines 149-171):

```ts
  it('runs the three suites through the runner in turn, with no key flag, no env, no if and no continue-on-error', () => {
    const suites = steps.filter(isSuite);
    expect(suites.map(runOf)).toEqual([
      `${RUNNER} --suite usdcx-in`,
      `${RUNNER} --suite usdcx-burn`,
      `${RUNNER} --suite usdcx`
    ]);
    // A red suite can leave a payout or a deposit landing on the key inside the next one's payout window.
    for (const step of suites) expect(step).not.toMatch(/^ {8}(env|if|continue-on-error):/m);
  });

  it('uploads test-results after each suite that ran, whatever it did, failing no step after it, and never the key or the lock', () => {
    const uploads = steps.filter(step => step.includes('uses: actions/upload-artifact@'));
    expect(uploads).toHaveLength(3);
```

With:

```ts
  it('runs the four suites through the runner in turn, the three on Arc with no key flag, no env, no if and no continue-on-error', () => {
    const suites = steps.filter(isSuite);
    expect(suites.map(runOf)).toEqual([
      `${RUNNER} --suite usdcx-in`,
      `${RUNNER} --suite usdcx-burn`,
      `${RUNNER} --suite usdcx`,
      `${RUNNER} --suite usdcx-burn-l2`
    ]);
    // A red suite can leave a payout or a deposit landing on the key inside the next one's payout window.
    for (const step of suites.slice(0, 3)) expect(step).not.toMatch(/^ {8}(env|if|continue-on-error):/m);
  });

  // The one exception to "no if": usdcx-burn-l2's payout windows read Base Sepolia and Arbitrum Sepolia, where no payout
  // or deposit an Arc suite leaves pending can land, so it runs after a red Arc suite. Never in a cancelled run, never
  // once a setup step failed (usdcx-in, which has no condition, is skipped exactly then; after a failed key write the
  // runner would create a fresh key whose payouts leave with the runner), and last, so no Arc suite waits on it.
  it('runs usdcx-burn-l2 last, after a red Arc suite too but never after a failed setup step, with no env and no continue-on-error', () => {
    const suites = steps.filter(isSuite);
    const l2 = suites.at(-1) ?? '';
    expect(runOf(l2)).toBe(`${RUNNER} --suite usdcx-burn-l2`);
    expect(l2.match(/^ {8}(env|if|continue-on-error):.*$/gm)).toEqual([
      "        if: ${{ !cancelled() && steps.usdcx_in.outcome != 'skipped' }}"
    ]);
    expect(suites[0]).toMatch(/^ {8}id: usdcx_in$/m);
  });

  it('uploads test-results after each suite that ran, whatever it did, failing no step after it, and never the key or the lock', () => {
    const uploads = steps.filter(step => step.includes('uses: actions/upload-artifact@'));
    expect(uploads).toHaveLength(4);
```

In `playwright/e2e/harness/linked-pr-injection.test.ts`:

Replace (line 357):

```ts
      'e2e-usdcx.yml chrome-usdcx-testnet: push 210, dispatch 240',
```

With:

```ts
      'e2e-usdcx.yml chrome-usdcx-testnet: push 295, dispatch 325',
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/harness/usdcx-workflow.test.ts playwright/e2e/harness/linked-pr-injection.test.ts`

Expected: FAIL: `runs the four suites ...` (three listed), `runs usdcx-burn-l2 last ...` (the last suite is `usdcx`), `uploads test-results ...` (3, not 4), and the ceiling list (`push 210, dispatch 240`).

- [ ] **Step 3: Edit the workflow**

In `.github/workflows/e2e-usdcx.yml`:

Replace (lines 3-15):

```yaml
# Runs the live USDCx suites on the extension after every push to main, through the runner `yarn e2e:real` uses
# (scripts/e2e-real.mjs): usdcx-in (a deposit from the CI Arc key into a fresh Guardian wallet), usdcx-burn (a Send
# burn to that key from a fresh standard and a fresh Guardian wallet, each waiting for Circle's payout) and usdcx (the
# round trip: burn, payout, deposit back). Nothing is a double: public Miden testnet and its faucet, the hosted
# Guardian, Arc Testnet and Circle's xReserve, attestation service and Gateway. A red payout step can be Circle's
# doing rather than the wallet's, and its message says so. The runner probes every service before it builds, builds
# the extension itself for each suite and runs the browser headless.
#
# The suites burn to and deposit from ONE Arc key, so each burn's payout refills what the deposits spend; a green run
# leaves the key about 2.9 USDC richer. CI has its own, the repository secret USDCX_HARNESS_ARC_KEY: never a
# developer's harness key and never the iOS job's. Only the step that writes it to the runner's key file reads the
# secret; the suites read the file through the runner, and no cache or upload includes it.
```

With:

```yaml
# Runs the live USDCx suites on the extension after every push to main, through the runner `yarn e2e:real` uses
# (scripts/e2e-real.mjs): usdcx-in (a deposit from the CI Arc key into a fresh Guardian wallet), usdcx-burn (a Send
# burn to that key from a fresh standard and a fresh Guardian wallet, each waiting for Circle's payout), usdcx (the
# round trip: burn, payout, deposit back) and usdcx-burn-l2 (Send burns from two fresh Guardian wallets to the same
# key's address on Base Sepolia and on Arbitrum Sepolia, each waiting for Circle's payout there and the wallet's own
# confirmation). Nothing is a double: public Miden testnet and its faucet, the hosted Guardian, Arc Testnet, Base
# Sepolia, Arbitrum Sepolia and Circle's xReserve, attestation service and Gateway. A red payout step can be Circle's
# doing rather than the wallet's, and its message says so. The runner probes every service before it builds, builds
# the extension itself for each suite and runs the browser headless.
#
# The suites burn to and deposit from ONE Arc key, so each burn's payout refills what the deposits spend; a green run
# leaves the key about 2.9 USDC richer on Arc and about 0.99 USDC richer on each L2, where it never spends. CI has its
# own, the repository secret USDCX_HARNESS_ARC_KEY: never a developer's harness key and never the iOS job's. Only the
# step that writes it to the runner's key file reads the secret; the suites read the file through the runner, and no
# cache or upload includes it.
```

Replace (lines 41-45):

```yaml
    # The suites' own budgets come to 160 min: usdcx 60 (playwright.usdcx.config.ts), usdcx-in 30 and usdcx-burn two
    # tests of 35 (their describes). Each suite's preflight and build add about 5, and a cold setup about 30 (the CLI
    # compile, the Playwright browsers' 12 and apt's 6), so 205, rounded up to 210.
    # A dispatch may first build a linked web-sdk PR from source, and its CLI cold, on this runner (30 more).
    timeout-minutes: ${{ github.event_name == 'workflow_dispatch' && 240 || 210 }}
```

With:

```yaml
    # The suites' own budgets come to 236 min: usdcx 60 (playwright.usdcx.config.ts), usdcx-in 30, usdcx-burn two
    # tests of 35 and usdcx-burn-l2 two of 38 (their describes). Each suite's preflight and build add about 5, and a
    # cold setup about 30 (the CLI compile, the Playwright browsers' 12 and apt's 6), so 286; with the same headroom as
    # before, 295.
    # A dispatch may first build a linked web-sdk PR from source, and its CLI cold, on this runner (30 more).
    timeout-minutes: ${{ github.event_name == 'workflow_dispatch' && 325 || 295 }}
```

Replace (lines 110-113, which the new step would otherwise contradict):

```yaml
      # In turn, narrowest first, and each only once the one before passed: a red suite can leave a payout or a
      # deposit still landing on the key, inside the next suite's payout window. Each Playwright run empties
      # test-results/, so each suite's results upload before the next suite starts. An upload may fail without failing
      # the job: the suites after it run only when every step before them passed, and its failure is never the wallet's.
```

With:

```yaml
      # The Arc suites in turn, narrowest first, and each only once the one before passed: a red suite can leave a
      # payout or a deposit still landing on the key, inside the next suite's payout window (usdcx-burn-l2, last, is
      # paid on other chains and runs whatever they did). Each Playwright run empties test-results/, so each suite's
      # results upload before the next suite starts. An upload may fail without failing the job: the Arc suites after
      # it run only when every step before them passed, and its failure is never the wallet's.
```

Replace (lines 143-151, the end of the file):

```yaml
      - name: Upload usdcx results
        if: always() && steps.usdcx_round_trip.outcome != 'skipped'
        continue-on-error: true
        uses: actions/upload-artifact@v4
        with:
          name: usdcx-round-trip-e2e-${{ github.run_id }}
          path: test-results/
          retention-days: 7
          if-no-files-found: ignore
```

With:

```yaml
      - name: Upload usdcx results
        if: always() && steps.usdcx_round_trip.outcome != 'skipped'
        continue-on-error: true
        uses: actions/upload-artifact@v4
        with:
          name: usdcx-round-trip-e2e-${{ github.run_id }}
          path: test-results/
          retention-days: 7
          if-no-files-found: ignore

      # Last, and after the Arc suites whatever they did: its payout windows read Base Sepolia and Arbitrum Sepolia,
      # where no payout or deposit an Arc suite leaves pending can land. But only once every setup step passed, which
      # usdcx-in not being skipped shows: after a failed key write the runner would create a fresh key whose payouts
      # leave with the runner. The one suite step with a condition; the workflow's test says why.
      - name: Run usdcx-burn-l2
        id: usdcx_burn_l2
        if: ${{ !cancelled() && steps.usdcx_in.outcome != 'skipped' }}
        run: node scripts/e2e-real.mjs --suite usdcx-burn-l2
      - name: Upload usdcx-burn-l2 results
        if: always() && steps.usdcx_burn_l2.outcome != 'skipped'
        continue-on-error: true
        uses: actions/upload-artifact@v4
        with:
          name: usdcx-burn-l2-e2e-${{ github.run_id }}
          path: test-results/
          retention-days: 7
          if-no-files-found: ignore
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/harness/usdcx-workflow.test.ts playwright/e2e/harness/linked-pr-injection.test.ts`

Expected: PASS, both files (the key-file path checks, the one-secret check and the injection rule included).

Then: `npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/harness`. Expected: PASS (16 suites).

- [ ] **Step 5: Docs and changelog**

In `playwright/e2e/docs/e2e-architecture.md` (no `{{` anywhere: the docs site's Liquid cannot parse it):

Replace (line 186):

```markdown
- **After every push to main, and on demand (`yarn e2e:real --suite usdcx-burn`, and with the deposit back `--suite usdcx`):** a USDCx burn to Arc Testnet through Circle's Gateway and Circle's payout of it, on live testnet; see [section 8](#8--usdcx-on-live-testnet---out-to-arc-and-back).
```

With:

```markdown
- **After every push to main, and on demand (`yarn e2e:real --suite usdcx-burn`, and with the deposit back `--suite usdcx`):** a USDCx burn to Arc Testnet through Circle's Gateway and Circle's payout of it, on live testnet; `--suite usdcx-burn-l2` does the same from Guardian wallets to Base Sepolia and Arbitrum Sepolia and also waits for the wallet's own Confirmed there; see [section 8](#8--usdcx-on-live-testnet---out-to-arc-and-back).
```

Replace (line 372):

```markdown
| `usdcx-burn` | `yarn e2e:real --suite usdcx-burn` | One 10 USDCx faucet grant and a 1 USDCx burn through Send to the harness Arc key, on a fresh standard wallet and on a fresh Guardian wallet; each test waits for Circle's payout of its own burn. Up to 70 min. |
```

With:

```markdown
| `usdcx-burn` | `yarn e2e:real --suite usdcx-burn` | One 10 USDCx faucet grant and a 1 USDCx burn through Send to the harness Arc key, on a fresh standard wallet and on a fresh Guardian wallet; each test waits for Circle's payout of its own burn. Up to 70 min. |
| `usdcx-burn-l2` | `yarn e2e:real --suite usdcx-burn-l2` | One 10 USDCx faucet grant and a 1 USDCx burn through Send from a fresh Guardian wallet to the harness key's address on Base Sepolia, and the same on Arbitrum Sepolia; each test waits for Circle's payout there and for the wallet's own Confirmed, which reads those chains through the WalletConnect RPC no Arc test uses. Ethereum Sepolia is left out: Circle never pays a burn there (0xMiden/miden-usdcx#308). Up to 76 min. |
```

Replace (line 378):

```markdown
| `usdcx-in`, `usdcx-burn`, `usdcx` (extension) | E2E USDCx (`e2e-usdcx.yml`) after every push to main, in that order, each only once the one before passed, and on a branch by dispatch; by hand, `yarn e2e:real --suite <name>` | In CI, its own key ([below](#the-ci-key)); by hand, the harness key |
```

With:

```markdown
| `usdcx-in`, `usdcx-burn`, `usdcx` (extension) | E2E USDCx (`e2e-usdcx.yml`) after every push to main, in that order, each only once the one before passed, and on a branch by dispatch; by hand, `yarn e2e:real --suite <name>` | In CI, its own key ([below](#the-ci-key)); by hand, the harness key |
| `usdcx-burn-l2` (extension) | E2E USDCx after the three above, whatever they did, once every setup step passed (its payout windows are on other chains, so a red Arc suite cannot break its proof), and on a branch by dispatch; by hand, `yarn e2e:real --suite usdcx-burn-l2` | The same key as the Arc suites, at its address on each L2 |
```

Replace (in line 382):

```markdown
> The round trip and both `usdcx-burn` tests fail when Circle has not paid the burn to the key within 10 minutes of the faucet consuming it. The proof is one Gateway `AttestationUsed` log on Arc whose mint carries the burn note id,
```

With:

```markdown
> The round trip and the `usdcx-burn` and `usdcx-burn-l2` tests fail when Circle has not paid the burn to the key within 10 minutes of the faucet consuming it. The proof is one Gateway `AttestationUsed` log on the chain paid (Arc, Base Sepolia or Arbitrum Sepolia, its source domain Arc's 26 on all three, while the burn itself names the destination's domain, 26, 6 or 3) whose mint carries the burn note id,
```

Replace (in line 382):

```markdown
Circle has paid Arc burns 10-12 s after the consume, but also 1 h 45 min and about 17 h late, and one burn was still unpaid days later.
```

With:

```markdown
Circle has paid Arc burns 10-12 s after the consume, but also 1 h 45 min and about 17 h late, and one burn was still unpaid days later; Base Sepolia and Arbitrum Sepolia paid 6-8 s after the consume when probed.
```

Replace (in line 385):

```markdown
(`usdcx-round-trip-evidence.json`, `usdcx-in-evidence.json`, `usdcx-burn-evidence.json`)
```

With:

```markdown
(`usdcx-round-trip-evidence.json`, `usdcx-in-evidence.json`, `usdcx-burn-evidence.json`, `usdcx-burn-l2-evidence.json`, which also names the chain as `payoutChainId`)
```

Replace (in line 395):

```markdown
`usdcx-in` needs 0.021 USDC on the key: the 0.001 USDC deposit and a 0.02 USDC gas reserve.
```

With:

```markdown
`usdcx-in` needs 0.021 USDC on the key: the 0.001 USDC deposit and a 0.02 USDC gas reserve. Each `usdcx-burn-l2` run adds about 0.99 USDC to the key's address on Base Sepolia and on Arbitrum Sepolia, where it holds no ETH and never spends; the payout proof reads only the rise, so what gathers there does not matter.
```

Replace (in line 409):

```markdown
The key started with 20 USDC, and a green run leaves it about 2.9 USDC richer (the three runs above: about +0.98, +1.97 and -0.007), so it needs no refill while main is green.
```

With:

```markdown
The key started with 20 USDC, and a green run leaves it about 2.9 USDC richer on Arc (the three Arc runs above: about +0.98, +1.97 and -0.007) and about 0.99 USDC richer on each L2, so it needs no refill while main is green.
```

In `CHANGELOG.md`: first find the open section.

```bash
git fetch --tags origin && git tag --list 'v*' --sort=-v:refname | grep -v -- '-rc' | head -1
```

If that prints `v1.17.1` (as on 2026-10-12), the entry goes under `## 1.17.2 (TBD)` / `### Fixes`; if a higher tag exists, under the lowest `(TBD)` section strictly above it (add one if none exists). Insert this line right after the line that ends `playwright/e2e/docs/e2e-architecture.md says how to read and move its USDC.`:

```markdown
- [FIX][ci] A fourth live USDCx suite, `usdcx-burn-l2`, burns 1 USDCx through Send from a fresh Guardian wallet to the harness key on Base Sepolia and on Arbitrum Sepolia, and passes only once Circle has paid each burn there and the wallet itself reads Confirmed; its preflight checks both chains and the wallet's RPC for them, and E2E USDCx runs it after the Arc suites, even when one of them failed.
```

Check the text for dashes before committing:

```bash
git diff -U0 | LC_ALL=C grep -c -e $'^+.*\xe2\x80\x94' -e $'^+.*\xe2\x80\x93'
printf 'a\xe2\x80\x94b\n' | LC_ALL=C grep -c $'\xe2\x80\x94'
```

Expected: `0` added lines with an em or en dash, and `1` for the positive control (byte patterns, because BSD grep has no `-P` and a failing `-P` would read as "no dashes").

- [ ] **Step 6: Mutation check**

```bash
F=.github/workflows/e2e-usdcx.yml; B="$TMPDIR/e2e-usdcx.yml.bak"
cp "$F" "$B" && perl -pi -e 's/^        if: \$\{\{ !cancelled\(\).*\n//' "$F" && ! grep -q 'cancelled()' "$F" && npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/harness/usdcx-workflow.test.ts -t 'last'; cp "$B" "$F"
cp "$F" "$B" && perl -pi -e "s/ && steps\.usdcx_in\.outcome != 'skipped' \}\}/ }}/" "$F" && grep -q 'if: \${{ !cancelled() }}' "$F" && npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/harness/usdcx-workflow.test.ts -t 'last'; cp "$B" "$F"
cp "$F" "$B" && perl -pi -e "s/&& 325 \|\| 295/\&\& 325 || 300/" "$F" && npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/harness/linked-pr-injection.test.ts -t 'ceiling'; cp "$B" "$F"
git diff --stat
```

Predictions: (1) `runs usdcx-burn-l2 last ...` fails (no `if:`). (2) the same test fails on the bare `if: ${{ !cancelled() }}`, which would start the suite after a failed key write. (3) the ceiling test fails (`push 300, dispatch 325`, and the rule names a dispatch under the 330 it needs).

- [ ] **Step 7: Format and commit**

```bash
npx prettier --write .github/workflows/e2e-usdcx.yml playwright/e2e/harness/usdcx-workflow.test.ts playwright/e2e/harness/linked-pr-injection.test.ts
git add .github/workflows/e2e-usdcx.yml playwright/e2e/harness/usdcx-workflow.test.ts playwright/e2e/harness/linked-pr-injection.test.ts playwright/e2e/docs/e2e-architecture.md CHANGELOG.md
git commit -m "ci(e2e): E2E USDCx runs usdcx-burn-l2 after the Arc suites, even when one failed"
```

---

## Delivery

- [ ] **D1: Local gates (load rule)**

```bash
cd /Users/celrisen/miden/wt-usdcx-burn-l2
npx jest --maxWorkers=2 --testTimeout=60000 playwright/e2e/helpers playwright/e2e/harness playwright/e2e/ios/helpers scripts/e2e-real.test.ts
npx prettier --check $(git diff --name-only origin/main...HEAD -- '*.ts' '*.mjs' '*.json' '*.yml')
G=$(grep -rl -e 'readdirSync' -e 'readFileSync(file' src --include='*.test.ts' --include='*.test.tsx'); npx jest --maxWorkers=2 --testTimeout=60000 ${=G}
git log --format='%an <%ae>%n%B' origin/main..HEAD | grep -i -E 'co-authored|generated with|claude|anthropic|cursor|codex' || echo "no attribution"
git diff origin/main...HEAD | LC_ALL=C grep -c -e $'^+.*\xe2\x80\x94' -e $'^+.*\xe2\x80\x93'; printf 'a\xe2\x80\x94b\n' | LC_ALL=C grep -c $'\xe2\x80\x94'
```

Expected: all jest suites PASS; prettier reports every changed code, JSON and workflow file formatted (`CHANGELOG.md` and `playwright/e2e/docs/e2e-architecture.md` are left out: neither is prettier-clean on main, so never run `prettier --write` on them; Task 5 edits them by hand); the src guard suites PASS (this change edits no `src` file); `no attribution`; `0` added lines with an em or en dash, and `1` for the control. No local `tsc`, `lint:e2e` or full jest: CI runs them (`yarn ts` type-checks `playwright/**/*.ts`; `lint:e2e` checks the new spec).

- [ ] **D2: Live run, Arc unchanged**

No other usdcx run may hold `~/.miden-e2e/usdcx-run.lock`. The runner runs these suites headless (it sets `E2E_HEADLESS=1`); do not pass `--headed`.

```bash
yarn e2e:real --suite usdcx-burn --preflight-only && yarn e2e:real --suite usdcx-burn
```

Expected: `✓ preflight passed (11 checks)`, then both tests pass. In `test-results/`, each test's `checkpoints.json` lists exactly the steps of the CI proof run 38177153478 (`wallet`, `arc_state`, `fund`, `settle_grant` on Guardian only, `key_snapshot`, `burn_via_ui`, `burn_confirmed`, `payout`) under the same budgets, and each `usdcx-burn-evidence.json` has the same `ids` keys as that run's (no `payoutChainId`) and a `circle payout fee` of 16400. Copy `test-results/` to `$TMPDIR/usdcx-burn-local/` before the next run empties it.

- [ ] **D3: Live run, the L2 suite**

```bash
yarn e2e:real --suite usdcx-burn-l2 --preflight-only && yarn e2e:real --suite usdcx-burn-l2
```

Expected: `✓ preflight passed (17 checks)` with `Base Sepolia RPC`, `Base Sepolia contracts`, `Base Sepolia wallet RPC rpc.walletconnect.org #<head>` and the Arbitrum three, no project id printed; then both tests pass, each with the steps above plus `wallet_payout_confirmed`. Each `usdcx-burn-l2-evidence.json` has `payoutChainId` `84532` or `421614`, `walletConfirmedBalance` equal to `arcBalanceBefore` plus the payout value, a `circle payout fee` near 11099, and a note on the receiving-tx link. A red `burn_via_ui` reading `Arbitrum Sepolia RPC rpc.walletconnect.org unavailable for the wallet's balance snapshot` is the accepted infra flake (about 0.8%); rerun once and say so in the PR. Copy `test-results/` to `$TMPDIR/usdcx-burn-l2-local/`.

- [ ] **D4: Push and open the PR**

```bash
git push -u origin wiktor/usdcx-burn-l2
gh pr create --repo 0xMiden/wallet --base main --head wiktor/usdcx-burn-l2 \
  --title "Live USDCx burn E2E pays out on Base Sepolia and Arbitrum Sepolia" --body-file "$TMPDIR/usdcx-burn-l2-pr.md"
```

`$TMPDIR/usdcx-burn-l2-pr.md` (fill the run numbers in; no tool names; check it for dashes like D1):

```markdown
A new live suite, `usdcx-burn-l2`, burns 1 USDCx through Send from fresh Guardian wallets to Base Sepolia and Arbitrum Sepolia, and passes only once Circle's payout lands there and the wallet itself reads Confirmed.

- `yarn e2e:real --suite usdcx-burn-l2`: two tests, one per L2, paying the harness key at the same address; the preflight checks each L2's chain, GatewayMinter and USDC, and the wallet's WalletConnect RPC (host only).
- The payout gate reads an L2 through one `PayoutChain` descriptor: the L2's USDC in the token topic, Arc's domain 26 as `sourceDomain`, and the destination's domain (6 or 3) on the burn note and its row.
- E2E USDCx runs it last, even after a red Arc suite, though never after a failed setup step (`if: ${{ !cancelled() && steps.usdcx_in.outcome != 'skipped' }}`): its payout windows are on other chains. Ceiling 295 min, 325 on a dispatch.
- The Arc suites run as before: their spec files are unchanged and every leg defaults to Arc.
- Ethereum Sepolia stays out: Circle never pays a burn there (0xMiden/miden-usdcx#308).

<details><summary>Evidence</summary>

- Local: `usdcx-burn` green (Arc steps, budgets and evidence keys as in run 38177153478); `usdcx-burn-l2` green, both chains, wallet Confirmed.
- CI: E2E USDCx dispatched on this head, run <id>: all four suites green; the CI key started at 0 USDC on both L2s.
- 5 commits, one per task; about 30 new unit tests across arc-usdcx, bridge, e2e-real and the workflow guards.
</details>

**Reviewers:** the domain split (burn domain 6 or 3 against the attestation's source 26) in `payoutCycle`, `burnTarget` and `payoutLeg` is the part worth your time.
```

- [ ] **D5: CI by head SHA**

```bash
SHA=$(git rev-parse HEAD)
gh api "repos/0xMiden/wallet/actions/runs?head_sha=$SHA" --jq '.total_count, (.workflow_runs[] | "\(.name) \(.status) \(.conclusion)")'
```

Expected: `total_count` above 0 (if 0 after about 5 minutes, see the agentic-kb note on pushes that create no runs: merge main in or push again). Wait for PR Tests (lint, `yarn ts`, unit tests, `lint:e2e`, mock-e2e) and the changelog check to go green; report each failure as it happens and fix it on the branch.

- [ ] **D6: Dispatch E2E USDCx on the PR head**

```bash
gh run list --repo 0xMiden/wallet --workflow e2e-usdcx.yml --json databaseId,status,headBranch --jq '.[] | select(.status != "completed")'
gh workflow run e2e-usdcx.yml --repo 0xMiden/wallet --ref wiktor/usdcx-burn-l2
sleep 20; gh run list --repo 0xMiden/wallet --workflow e2e-usdcx.yml --event workflow_dispatch --branch wiktor/usdcx-burn-l2 --json databaseId,headSha,status --limit 1
```

Confirm the run's `headSha` is `$SHA`. The run queues on `usdcx-harness-arc-key`; a newer main push that queues behind it cancels it before it starts, so if it ends `cancelled` without starting, dispatch again. Then:

```bash
gh run watch <id> --repo 0xMiden/wallet --exit-status
gh run view <id> --repo 0xMiden/wallet --json jobs --jq '.jobs[0].steps[] | "\(.name) \(.conclusion)"'
gh run download <id> --repo 0xMiden/wallet --name usdcx-burn-l2-e2e-<id> --dir "$TMPDIR/usdcx-burn-l2-ci"
```

Expected: all four suite steps `success`; the L2 evidence shows `arcBalanceBefore` `0` on both chains (the CI key's first L2 payouts: the strongest delta proof), `walletConfirmedBalance` equal to the payout value, and `payoutChainId` per test. Put the run number into the PR body's evidence block (`gh pr edit --body-file`).

- [ ] **D7: Admin squash-merge**

```bash
gh pr merge <PR> --repo 0xMiden/wallet --squash --admin \
  --subject "Live USDCx burn E2E pays out on Base Sepolia and Arbitrum Sepolia (#<PR>)" \
  --body "usdcx-burn-l2: Guardian burns to Base Sepolia and Arbitrum Sepolia, gated on Circle's payout there and the wallet's Confirmed; E2E USDCx runs it after the Arc suites."
```

Then check main by SHA as in D5: the push run of E2E USDCx on the merge commit must exist and go green on all four suites.

---

## Self-Review

1. **Spec coverage:** descriptor and L2 reads (Task 1); domain trap (Tasks 1 and 3); `sepolia.base.org` 200-block chunk (Task 1); no drpc, no wallet RPC for the harness (Task 1 test); driver destination and snapshot refusal naming the host (Task 2); legs per chain, wallet Confirmed gate through `waitForWalletPayoutConfirmation` (Tasks 3 and 4); separate suite, grep, probes, artifact (Tasks 4 and 5); the `!cancelled()` exception, narrowed to skip after a failed setup step, with the reason in the test (Task 5); ceiling 295/325 in both pins (Task 5); Ethereum Sepolia refused by name (Task 1); Arc byte-for-byte (spec files untouched, Arc values and messages pinned in Tasks 1-3, Arc evidence without `payoutChainId`, Arc preflight unchanged in Task 4, live run D2); Chrome only (no iOS file). The design's "body moves into a function inside usdcx-burn.spec.ts" is replaced by a separate spec file so the Arc spec stays byte-for-byte; the design's standard-on-Base pairing is replaced by the user's Guardian-on-both decision.
2. **Placeholders:** none in code; `<id>` and `<PR>` in Delivery are run and PR numbers known only then.
3. **Type consistency:** `payoutChain` is the option name on `ArcReadDeps`, `BridgeOutUsdcxOptions`, `submitBurn` and `ConfirmBurnOptions`; `payoutReads` on `payoutLeg` and `harnessPayoutLeg`; `chain` the parameter of `burnTarget`, `assertBurnDetails`, `receivingTxHash`. `PayoutChain` fields are used as defined in Task 1.
4. **Review Focus:** each of the five lines has its test in the owning task.

## Plan critique log

- F1 (important, applied): the new test's title says "naming that destination", so `-t 'names that destination'` selected nothing and mutation (1) passed vacuously; Task 2 Step 2 and mutation (1) now filter on `naming that destination`.
- F2 (important, applied, user OK pending): at a1f77abdc `resolveArcKey` calls `harnessArcKey(..., { create: !suite.arcKey && !opts.preflightOnly })` and usdcx-burn-l2 has no `arcKey`, so a bare `!cancelled()` after a failed "Write the CI harness Arc key" creates a fresh key whose L2 payouts leave with the runner (e2e-usdcx.yml:103-104). The step, its comment, the workflow test (which also pins `usdcx_in` as the first suite), the mutations, Architecture, Global Constraints, Produces, docs row, PR body and Self-Review now use `!cancelled() && steps.usdcx_in.outcome != 'skipped'`; usdcx-in has no condition, so it is skipped exactly when a setup step failed, and the L2 suite still runs after any Arc suite result. Fallback if the literal `!cancelled()` must stay: the runner refuses to create a harness key when GITHUB_ACTIONS is set (a few lines plus a test in e2e-real.test.ts).
- F1, second entry (important, duplicate of F2, applied with F2): the same defect, plus a failed "Install miden-client-cli" leaving MIDEN_CLIENT_BIN unset so the runner would cold-install its own CLI (e2e-real.mjs:1896); the narrowed condition skips that too.
- F3 (important, applied): viem 2.55.4's `getUrl` strips only basic-auth credentials, and its error messages quote `URL: <full url>`, so the gate's failed wallet RPC read printed the project id (checked locally against a refused port and a stub transport). `redactProjectId` now lives in usdcx-constants.ts (Task 2), `burnSubmitFailure` and the gate's failure branch both use it (a no-op on arc.io, so Arc's text is unchanged), and Task 3 adds `redacts the project id when the read through the L2 wallet RPC itself fails` with mutation (6).
- F4 (important, applied): at a1f77abdc `CHANGELOG.md` and `playwright/e2e/docs/e2e-architecture.md` are not prettier-clean (checked through `--stdin-filepath`); D1 now checks only `*.ts`, `*.mjs`, `*.json` and `*.yml`, says never to `--write` the two .md files, and Task 5 Step 7 formats the workflow it edits.
- X1 (found while checking F1, applied): Task 4 Step 2's red run skipped three new preflight tests whose titles do not name the suite; the filter adds `wallet RPC|first endpoint down`, which match no existing test.
- X2 (found while checking F2, applied): e2e-usdcx.yml:110-113 says every suite runs only once the one before passed; Task 5 now rewrites it to scope that to the Arc suites and name usdcx-burn-l2 as the exception. The L2 step's new comment avoids every path the upload guard refuses, since the test's step splitter files it under the round-trip upload step.
