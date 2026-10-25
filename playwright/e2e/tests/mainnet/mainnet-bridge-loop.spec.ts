import { createPublicClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { midenAccountHexToXReserveRecipient } from '../../../../src/lib/usdcx/recipient';
import { expect, test, type GuardianAwareWalletPage } from '../../fixtures/two-wallets';
import { ERC20_ABI } from '../../helpers/arc-usdcx';
import { fromBaseUnits, vaultBalance } from '../../helpers/balance-truth';
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
import { quoteL2Deposit, readL2KeyFunds, submitL2Deposit } from '../../helpers/usdcx-l2-deposit';

// The AggLayer route runs in its own job (mainnet-agglayer-loop.spec.ts): its exit takes longer than this whole test.
test.use({ injectFeeFaucet: false });
test.describe.configure({ mode: 'serial', timeout: 1_200_000 });
test.skip(process.env.E2E_NETWORK !== 'mainnet', 'mainnet bridge loops');
test.skip(!process.env.E2E_MAINNET_EVM_KEY, 'E2E_MAINNET_EVM_KEY is unset');

test('loops the minimum on every mainnet USDCx route', async ({ walletA }) => {
  test.setTimeout(2_400_000);
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

  for (const loop of loops) await runUsdcx(doc, loop, signer, accountId, evm.address, walletA);
});

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
): Promise<void> {
  if (loop.route === 'xreserve') {
    const source = xreserveSource(doc, loop);
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
    await submitL2Deposit({
      privateKey: signer,
      l2: executorSource(doc, loop),
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
  await burnUsdcxToAddress(wallet, {
    tokenId,
    amount: fromBaseUnits(LOOP_USDC, 6),
    destination: evmAddress,
    networkId: loop.name === 'arc' ? 'arc' : loop.name,
    networkName: mainnetChain(loop.chainId).name
  });
}
