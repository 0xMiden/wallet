import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { AgglayerDeposit } from '../../../../src/lib/agglayer/status';
import { expect, test } from '../../fixtures/two-wallets';
import { vaultBalance } from '../../helpers/balance-truth';
import { bridgeOutSlow } from '../../helpers/bridge';
import {
  agglayerNightMarkdown,
  claimPaysExit,
  EXIT_WAIT_MS,
  exitCursor,
  exitStep,
  fetchIndexedDeposits,
  tonightsExit,
  type AgglayerNight
} from '../../helpers/mainnet-agglayer-exit';
import {
  bridgeEthToMiden,
  claimAgglayerOnEthereum,
  isExitClaimedOnEthereum,
  readEthereumClaim
} from '../../helpers/mainnet-bridge-evm';
import { agglayerShortfall, bridgeLoops, midenFeeReserve } from '../../helpers/mainnet-bridge-plan';
import {
  AGGLAYER_BRIDGE,
  AGGLAYER_INDEXER,
  loadMainnetDocument,
  mainnetEvmKey,
  midenFeeProblem,
  openPlainAccount,
  readEthereumFunds
} from '../../helpers/mainnet-bridge-run';
import { AGGLAYER_LOOP_WEI, CEDAR_ROLLUP_ID, mainnetChain, mainnetRpc } from '../../helpers/mainnet-bridge-sources';

// One night: ETH from Ethereum to the plain Miden account over AggLayer, then back. The exit takes 40 to 45 minutes to
// become claimable, so this runs in its own job after the main one, which shares the account and the Ethereum key.
test.use({ injectFeeFaucet: false });
test.skip(process.env.E2E_NETWORK !== 'mainnet', 'mainnet bridge loops');
test.skip(!process.env.E2E_MAINNET_EVM_KEY, 'E2E_MAINNET_EVM_KEY is unset');

/** The deposit lands on Miden after the L1 bridge's finality: about 18 minutes on 2026-10-24. */
const LANDING_MS = 1_500_000;
const POLL_MS = 30_000;
/** The claim on Miden and the bridge-out. */
const MIDEN_TXS = 2n;
const SELF_CLAIM_ATTEMPTS = 2;
/** AGGLAYER_LOOP_WEI as the Send flow takes it: the same amount goes out as came in. */
const BRIDGE_OUT_ETH = '0.000001';
/**
 * Funding checks and note claims (12), the landing (25), the bridge-out (3), the full exit wait (120) and the claim
 * checks (5).
 * The job allows 185 minutes, which leaves 20 for setup on ubuntu-latest, a cold CLI build included.
 */
const TEST_MS = 165 * 60_000;
/** Time kept after the exit wait to verify a claim and write the summary before the test is cut off. */
const VERIFY_MS = 5 * 60_000;
const OUTPUT_DIR = process.env.E2E_PLAYWRIGHT_OUTPUT_DIR ?? 'test-results';

const night: AgglayerNight = {};

/** Each step is written as it happens, so a run that times out still says how far it got. */
function record(patch: Partial<AgglayerNight>): void {
  Object.assign(night, patch);
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(join(OUTPUT_DIR, 'agglayer-night.json'), `${JSON.stringify(night, null, 2)}\n`);
  writeFileSync(join(OUTPUT_DIR, 'agglayer-night.md'), agglayerNightMarkdown(night));
}

type ClaimRead = Awaited<ReturnType<typeof readEthereumClaim>>;

const iso = (ms: number = Date.now()): string => new Date(ms).toISOString();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('loops ETH from Ethereum to Miden and back over AggLayer', async ({ walletA }) => {
  const started = Date.now();
  test.setTimeout(TEST_MS);
  const doc = await loadMainnetDocument();
  const listed = bridgeLoops(Object.values(doc.supportedEvmChains)).some(loop => loop.kind === 'agglayer');
  test.skip(!listed, 'the mainnet config lists no AggLayer bridge on Ethereum');
  const signer = mainnetEvmKey();
  const evm = privateKeyToAccount(signer);
  const chain = mainnetChain(1);
  const { address } = await openPlainAccount(walletA);

  const problems: string[] = [];
  const fee = await midenFeeProblem(walletA, address, baseFee => midenFeeReserve(baseFee, 0n, MIDEN_TXS));
  if (fee) problems.push(fee);
  const funds = await readEthereumFunds(evm.address);
  const gas = agglayerShortfall({ address: evm.address, wei: funds.wei, maxFeePerGas: funds.maxFeePerGas });
  if (gas) problems.push(gas);
  if (problems.length > 0) {
    record({ outcome: 'refused to bridge: the accounts cannot cover two nights' });
    throw new Error(`refusing to bridge:\n${problems.join('\n')}`);
  }

  // An indexer that cannot be read now could not settle tonight's exit either, so nothing is sent.
  const target = { rollupId: CEDAR_ROLLUP_ID, address: evm.address };
  const firstCursor = exitCursor(await fetchIndexedDeposits(AGGLAYER_INDEXER, evm.address), target);
  const ethBefore = await vaultBalance(walletA.page, 'ETH');
  const depositTx = await bridgeEthToMiden({
    key: signer,
    chain,
    rpcUrl: mainnetRpc(1),
    bridge: AGGLAYER_BRIDGE,
    rollupId: CEDAR_ROLLUP_ID,
    midenAddress: address,
    wei: AGGLAYER_LOOP_WEI
  });
  record({ depositTx, depositAt: iso() });
  // Sync and claim until the balance rises above what the account held before this night's deposit.
  await expect
    .poll(
      async () => {
        await walletA.triggerSync(true);
        await walletA.claimAllNotes();
        return vaultBalance(walletA.page, 'ETH');
      },
      { timeout: LANDING_MS, intervals: [POLL_MS] }
    )
    .toBeGreaterThan(ethBefore);
  record({ landedAt: iso() });

  // Read again just before the bridge-out, so an exit filed during the landing is not mistaken for tonight's.
  const cursor = await fetchIndexedDeposits(AGGLAYER_INDEXER, evm.address).then(
    deposits => exitCursor(deposits, target),
    () => firstCursor
  );
  record({ bridgedText: BRIDGE_OUT_ETH, bridgedWei: AGGLAYER_LOOP_WEI.toString(), exitCursor: cursor });
  await bridgeOutSlow(walletA, {
    destAddress: evm.address,
    tokenSymbol: 'ETH',
    amount: BRIDGE_OUT_ETH,
    network: { id: 'ethereum', name: chain.name }
  });
  record({ bridgeOutAt: iso() });

  const readClaim = async (hash: Hex) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await readEthereumClaim({ chain, rpcUrl: mainnetRpc(1), hash });
      } catch (error) {
        if (attempt === 3) throw error;
        await sleep(10_000);
      }
    }
  };

  const settle = async (claimTxHash: string, exit: AgglayerDeposit, read?: ClaimRead): Promise<void> => {
    if (!isHex(claimTxHash)) throw new Error(`exit ${exit.deposit_cnt} has a claim hash that is not hex`);
    const claim = read ?? (await readClaim(claimTxHash));
    record({
      claimTx: claimTxHash,
      claimBlock: claim.blockNumber.toString(),
      claimAt: claim.at.toISOString(),
      claimer: claim.from,
      claimedBy: claim.from.toLowerCase() === evm.address.toLowerCase() ? 'this job' : 'another party'
    });
    const problem = claimPaysExit(claim.receipt, exit, { bridge: AGGLAYER_BRIDGE, destination: evm.address });
    if (problem) {
      record({ outcome: `claim did not pay the exit: ${problem}` });
      throw new Error(`claim ${claimTxHash}: ${problem}`);
    }
    record({ outcome: 'settled' });
  };

  // The exit wait ends before the test does, so a slow night fails with its own message and summary.
  const deadline = Math.min(Date.now() + EXIT_WAIT_MS, started + TEST_MS - VERIFY_MS);
  const waitStarted = Date.now();
  let readySince: number | undefined;
  let attempts = 0;
  let lastError = '';
  while (Date.now() < deadline) {
    let exit: AgglayerDeposit | undefined;
    try {
      exit = tonightsExit(await fetchIndexedDeposits(AGGLAYER_INDEXER, evm.address), {
        ...target,
        afterDepositCnt: cursor,
        wei: AGGLAYER_LOOP_WEI
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (exit && night.exitDepositCnt === undefined) {
      record({ exitDepositCnt: exit.deposit_cnt, exitMidenBlock: exit.block_num, exitSeenAt: iso() });
    }
    const step = exitStep(exit, readySince, Date.now());
    if (step.kind !== 'settled' && step.readySince !== undefined && readySince === undefined) {
      record({ readyAt: iso(step.readySince) });
    }
    if (step.kind !== 'settled') readySince = step.readySince;
    if (exit && step.kind === 'settled') return settle(step.claimTxHash, exit);
    if (exit && step.kind === 'claim' && attempts < SELF_CLAIM_ATTEMPTS) {
      // The indexer can trail the chain: a claim it has not filed yet is still a claim, and is never sent twice.
      const claimed = await isExitClaimedOnEthereum({
        chain,
        rpcUrl: mainnetRpc(1),
        bridge: AGGLAYER_BRIDGE,
        deposit: exit
      }).catch((error: unknown) => {
        lastError = error instanceof Error ? error.message : String(error);
        return undefined;
      });
      if (claimed === false) {
        attempts += 1;
        let hash: Hex | undefined;
        try {
          hash = await claimAgglayerOnEthereum({
            key: signer,
            chain,
            rpcUrl: mainnetRpc(1),
            bridge: AGGLAYER_BRIDGE,
            indexerUrl: AGGLAYER_INDEXER,
            deposit: exit
          });
        } catch (error) {
          // Most likely the auto-claimer got there first; the next poll reads its claim.
          lastError = error instanceof Error ? error.message : String(error);
        }
        if (hash !== undefined) {
          const own = await readClaim(hash);
          if (own.receipt.status === 'success') return settle(hash, exit, own);
          // A claim that lost the race to the auto-claimer reverts; the next poll reads the winner.
          lastError = `this job's claim ${hash} reverted`;
        }
      }
    }
    await sleep(POLL_MS);
  }
  const where =
    night.exitDepositCnt === undefined
      ? `no exit above ${cursor} carrying ${AGGLAYER_LOOP_WEI} wei was indexed`
      : `exit ${night.exitDepositCnt} was ${readySince === undefined ? 'never ready to claim' : 'never claimed'}`;
  record({ outcome: `timed out: ${where}` });
  throw new Error(
    `AggLayer exit to ${evm.address} not settled within ${Math.round((Date.now() - waitStarted) / 60_000)} minutes: ${where}` +
      (lastError ? ` (last error: ${lastError})` : '')
  );
});
