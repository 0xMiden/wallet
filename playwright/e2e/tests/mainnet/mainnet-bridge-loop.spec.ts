import { createPublicClient, http, isHash, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { midenAccountHexToXReserveRecipient } from '../../../../src/lib/usdcx/recipient';
import { expect, test, type GuardianAwareWalletPage } from '../../fixtures/two-wallets';
import { ERC20_ABI } from '../../helpers/arc-usdcx';
import { fromBaseUnits, vaultBalance } from '../../helpers/balance-truth';
import { readBridgedSendRows } from '../../helpers/bridge';
import { depositXReserve } from '../../helpers/mainnet-bridge-evm';
import {
  bridgeLoops,
  LOOP_USDC,
  midenFeeReserve,
  usdcxShortfall,
  type UsdcxLoop
} from '../../helpers/mainnet-bridge-plan';
import {
  loadMainnetDocument,
  mainnetEvmKey,
  midenFeeProblem,
  openPlainAccount
} from '../../helpers/mainnet-bridge-run';
import { burnUsdcxToAddress, tokenIdBySymbol } from '../../helpers/mainnet-bridge-send';
import {
  executorSource,
  mainnetChain,
  mainnetRpc,
  xreserveSource,
  type MainnetUsdcxDocument
} from '../../helpers/mainnet-bridge-sources';
import { readMainnetGatewaySource, verifyMainnetPayout } from '../../helpers/mainnet-usdcx-payout';
import { quoteL2Deposit, readL2KeyFunds, submitL2Deposit } from '../../helpers/usdcx-l2-deposit';
import { recordPayoutFee } from '../../helpers/usdcx-payout-summary';

// The AggLayer route runs in its own job (mainnet-agglayer-loop.spec.ts): its exit takes longer than this whole test.
test.use({ injectFeeFaucet: false });
test.describe.configure({ mode: 'serial', timeout: 1_200_000 });
test.skip(process.env.E2E_NETWORK !== 'mainnet', 'mainnet bridge loops');
test.skip(!process.env.E2E_MAINNET_EVM_KEY, 'E2E_MAINNET_EVM_KEY is unset');

// One deadline for every burn's payout, counted from the last burn.
const PAYOUT_WAIT_MS = 1_800_000;
const PAYOUT_POLL_MS = 10_000;
const PAYOUT_SUMMARY = 'test-results/mainnet-usdcx-payouts.md';

/** A loop's burn: the wallet row that records it and the USDC Circle pays it in. */
interface MainnetBurn {
  loop: UsdcxLoop;
  rowId: string;
  usdc: `0x${string}`;
}

test('loops the minimum on every mainnet USDCx route', async ({ walletA }) => {
  test.setTimeout(3_600_000);
  const signer = mainnetEvmKey();
  const evm = privateKeyToAccount(signer);
  const doc = await loadMainnetDocument();
  const loops = bridgeLoops(Object.values(doc.supportedEvmChains)).filter(
    (loop): loop is UsdcxLoop => loop.kind === 'usdcx'
  );
  const { address, accountId } = await openPlainAccount(walletA);
  const problems: string[] = [];
  // Four USDCx burns, plus the four claims of what they minted.
  const fee = await midenFeeProblem(walletA, address, baseFee => midenFeeReserve(baseFee, 4n, 4n));
  if (fee) problems.push(fee);
  for (const loop of loops) {
    const problem = await usdcxProblem(doc, loop, evm.address, accountId);
    if (problem) problems.push(problem);
  }
  if (problems.length > 0) {
    throw new Error(`refusing to bridge:\n${problems.join('\n')}`);
  }

  const burns: MainnetBurn[] = [];
  for (const loop of loops) burns.push(await runUsdcx(doc, loop, signer, accountId, evm.address, walletA));
  await proveMainnetPayouts(doc, burns, evm.address, walletA);
});

/**
 * Waits for the wallet to record every burn's payout mint, then proves each on chain and logs Circle's fee. The fees of
 * the paid burns are logged before a burn left unpaid or unproven fails the test.
 */
async function proveMainnetPayouts(
  doc: MainnetUsdcxDocument,
  burns: readonly MainnetBurn[],
  recipient: `0x${string}`,
  wallet: GuardianAwareWalletPage
): Promise<void> {
  const gateway = await readMainnetGatewaySource(doc);
  const read = async () => {
    const rows = await readBridgedSendRows(wallet.page);
    return burns.map(burn => ({ burn, usdcxBurn: rows.find(row => row.id === burn.rowId)?.extraInputs?.usdcxBurn }));
  };
  const deadline = Date.now() + PAYOUT_WAIT_MS;
  let found = await read();
  while (found.some(({ usdcxBurn }) => !usdcxBurn?.payout) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, PAYOUT_POLL_MS));
    found = await read();
  }
  const failures: string[] = [];
  for (const { burn, usdcxBurn } of found) {
    const chain = mainnetChain(burn.loop.chainId).name;
    const payout = usdcxBurn?.payout;
    if (!usdcxBurn || !payout) {
      failures.push(
        `${chain}: burn ${usdcxBurn?.noteId ?? `row ${burn.rowId} with no note id`} unpaid after 30 minutes, ` +
          `the wallet's payout scan reached block ${usdcxBurn?.payoutScannedBlock ?? 'none'}`
      );
      continue;
    }
    if (!isHash(payout.transactionHash)) {
      failures.push(`${chain}: burn ${usdcxBurn.noteId} recorded mint ${payout.transactionHash}, not a hash`);
      continue;
    }
    try {
      const { value } = await verifyMainnetPayout({
        chainId: burn.loop.chainId,
        transactionHash: payout.transactionHash,
        recipient,
        usdc: burn.usdc,
        burnNoteId: usdcxBurn.noteId,
        burnUnits: LOOP_USDC,
        walletValue: BigInt(payout.value),
        gatewayMinter: gateway.gatewayMinter,
        depositor: gateway.depositor
      });
      recordPayoutFee(
        { suite: 'mainnet-bridge-loop', chain, burnUnits: LOOP_USDC, value, transactionHash: payout.transactionHash },
        PAYOUT_SUMMARY
      );
    } catch (error) {
      failures.push(`${chain}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(`mainnet USDCx payouts not proven:\n${failures.join('\n')}`);
}

async function usdcxProblem(
  doc: MainnetUsdcxDocument,
  loop: UsdcxLoop,
  address: `0x${string}`,
  accountId: string
): Promise<string | undefined> {
  if (loop.route === 'xreserve') {
    const source = xreserveSource(doc, loop);
    const client = createPublicClient({ chain: source.chain, transport: http(mainnetRpc(loop.chainId)) });
    const usdc = await client.readContract({
      address: source.usdc,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [address]
    });
    const native = await client.getBalance({ address });
    const fees = await client.estimateFeesPerGas();
    return usdcxShortfall({
      name: loop.name,
      address,
      usdc,
      quotedForwardFee: 0n,
      domain: loop.domain,
      native,
      maxFeePerGas: fees.maxFeePerGas
    });
  }
  const built = executorSource(doc, loop);
  const funds = await readL2KeyFunds(address, { endpoints: built.payout.rpcUrls, payoutChain: built.payout });
  const quote = await quoteL2Deposit(built, {
    units: LOOP_USDC,
    recipient: midenAccountHexToXReserveRecipient(accountId),
    depositor: address
  });
  return usdcxShortfall({
    name: loop.name,
    address,
    usdc: funds.usdc,
    quotedForwardFee: quote.feeTotalAmount,
    domain: loop.domain,
    native: funds.wei,
    maxFeePerGas: funds.maxFeePerGas
  });
}

async function runUsdcx(
  doc: MainnetUsdcxDocument,
  loop: UsdcxLoop,
  signer: Hex,
  accountId: string,
  evmAddress: `0x${string}`,
  wallet: GuardianAwareWalletPage
): Promise<MainnetBurn> {
  let usdc: `0x${string}`;
  if (loop.route === 'xreserve') {
    const source = xreserveSource(doc, loop);
    usdc = source.usdc;
    await depositXReserve({
      key: signer,
      chain: source.chain,
      rpcUrl: mainnetRpc(loop.chainId),
      usdc: source.usdc,
      xReserve: source.xReserve,
      units: LOOP_USDC,
      remoteDomain: source.midenDomain ?? doc['bridge-providers'].usdcx.midenDomain,
      accountHex: accountId
    });
  } else {
    const l2 = executorSource(doc, loop);
    usdc = l2.payout.usdc;
    await submitL2Deposit({
      privateKey: signer,
      l2,
      units: LOOP_USDC,
      recipientHex: accountId,
      arc: { endpoints: [mainnetRpc(5042)] }
    });
  }
  await wallet.triggerSync(true);
  await wallet.claimAllNotes();
  await expect
    .poll(async () => vaultBalance(wallet.page, 'USDCx'), { timeout: 900_000 })
    .toBeGreaterThanOrEqual(LOOP_USDC);
  const tokenId = await tokenIdBySymbol(wallet.page, 'USDCx');
  if (!tokenId) throw new Error(`${loop.name} minted no USDCx row to burn`);
  const before = new Set((await readBridgedSendRows(wallet.page)).map(row => row.id));
  await burnUsdcxToAddress(wallet, {
    tokenId,
    amount: fromBaseUnits(LOOP_USDC, 6),
    destination: evmAddress,
    networkId: loop.name === 'arc' ? 'arc' : loop.name,
    networkName: mainnetChain(loop.chainId).name
  });
  const fresh = (await readBridgedSendRows(wallet.page)).filter(
    row => row.extraInputs?.provider === 'usdcx' && !before.has(row.id)
  );
  const [row] = fresh;
  if (fresh.length !== 1 || !row)
    throw new Error(`${loop.name}: the burn left ${fresh.length} new USDCx rows, not one`);
  return { loop, rowId: row.id, usdc };
}
