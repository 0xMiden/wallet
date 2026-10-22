import { createPublicClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { AgglayerDeposit } from '../../../../src/lib/agglayer/status';
import { midenAccountHexToXReserveRecipient } from '../../../../src/lib/usdcx/recipient';
import { expect, test, type GuardianAwareWalletPage } from '../../fixtures/two-wallets';
import { ERC20_ABI } from '../../helpers/arc-usdcx';
import {
  fromBaseUnits,
  vaultBalance,
  vaultBalanceByFaucetId,
  walletDiscoveredBaseFee,
  walletDiscoveredNativeFaucetId
} from '../../helpers/balance-truth';
import { bridgeOutSlow } from '../../helpers/bridge';
import { bridgeEthToMiden, claimAgglayerOnEthereum, depositXReserve } from '../../helpers/mainnet-bridge-evm';
import {
  agglayerShortfall,
  bridgeLoops,
  landedVaultSample,
  LOOP_USDC,
  midenFeeReserve,
  UNLANDED_VAULT_SAMPLE,
  usdcxShortfall,
  type UsdcxLoop
} from '../../helpers/mainnet-bridge-plan';
import { burnUsdcxToAddress, tokenIdBySymbol } from '../../helpers/mainnet-bridge-send';
import {
  AGGLAYER_LOOP_WEI,
  CEDAR_ROLLUP_ID,
  executorSource,
  mainnetChain,
  mainnetRpc,
  xreserveSource,
  type MainnetUsdcxDocument
} from '../../helpers/mainnet-bridge-sources';
import { quoteL2Deposit, readL2KeyFunds, submitL2Deposit } from '../../helpers/usdcx-l2-deposit';
import { accountHex } from '../../helpers/usdcx-miden';

const CONFIG_URL = 'https://raw.githubusercontent.com/0xMiden/wallet-config/main/mainnet.json';
const AGGLAYER_BRIDGE = '0x2a3dd3eb832af982ec71669e178424b10dca2ede';
const INDEXER = 'https://bridge-cedar-miden.eu-north-3.gateway.fm/api';

test.use({ injectFeeFaucet: false });
test.describe.configure({ mode: 'serial', timeout: 1_200_000 });
test.skip(process.env.E2E_NETWORK !== 'mainnet', 'mainnet bridge loops');
test.skip(!process.env.E2E_MAINNET_EVM_KEY, 'E2E_MAINNET_EVM_KEY is unset');

function key(): Hex {
  const raw = (process.env.E2E_MAINNET_EVM_KEY ?? '').trim();
  return (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex;
}

test('loops the minimum on every mainnet bridge route', async ({ walletA }) => {
  test.setTimeout(2_400_000);
  const seed = process.env.E2E_MAINNET_PLAIN_SEED;
  if (!seed) throw new Error('E2E_MAINNET_PLAIN_SEED is unset');
  const signer = key();
  const evm = privateKeyToAccount(signer);
  const doc = (await (await fetch(CONFIG_URL)).json()) as MainnetUsdcxDocument;
  const loops = bridgeLoops(Object.values(doc.supportedEvmChains));
  const imported = await walletA.importOnChainWallet(seed.trim().split(/\s+/));
  const accountId = await accountHex(imported.address);
  const problems: string[] = [];
  await walletA.triggerSync(true);
  // Same as the round trip: consume the plain account's notes before reading the vault. The
  // Guardian account is consumed in the round trip, which this job runs first.
  await walletA.claimAllNotes(600_000);
  const baseFee = await walletDiscoveredBaseFee(walletA.page);
  const nativeId = await walletDiscoveredNativeFaucetId(walletA.page);
  if (baseFee === null || baseFee < 1 || !nativeId) {
    problems.push('the Miden account has not discovered its fee');
  } else {
    // Four USDCx burns, plus four claims and the AggLayer claim and return.
    // Same in-flight balance read as the round trip: one refresh can still see the pre-claim vault.
    // A non-land resolves the sentinel so this poll continues.
    const need = midenFeeReserve(BigInt(baseFee), 4n, 6n);
    let held = 0n;
    let funded = false;
    try {
      await expect
        .poll(
          async () => {
            const sample = await landedVaultSample(
              () => walletA.refreshBalances(),
              () => vaultBalanceByFaucetId(walletA.page, nativeId)
            );
            if (sample !== UNLANDED_VAULT_SAMPLE) held = sample;
            return sample;
          },
          { timeout: 60_000 }
        )
        .toBeGreaterThanOrEqual(need);
      funded = true;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (held >= need || (!text.includes('Timeout') && !text.includes('toBeGreaterThanOrEqual'))) throw error;
    }
    if (!funded) {
      problems.push(
        `${imported.address} holds ${held} native base units, short of ${need} for two nights of bridge fees`
      );
    }
  }

  for (const loop of loops) {
    if (loop.kind === 'agglayer') {
      const funds = await readEth(evm.address);
      const problem = agglayerShortfall({ address: evm.address, wei: funds.wei, maxFeePerGas: funds.maxFeePerGas });
      if (problem) problems.push(problem);
      continue;
    }
    const problem = await usdcxProblem(doc, loop, evm.address, accountId);
    if (problem) problems.push(problem);
  }
  if (problems.length > 0) {
    throw new Error(`refusing to bridge:\n${problems.join('\n')}`);
  }

  for (const loop of loops) {
    if (loop.kind === 'usdcx') await runUsdcx(doc, loop, signer, accountId, evm.address, walletA);
    else await runAgglayer(signer, imported.address, evm.address, walletA);
  }
});

async function readEth(address: `0x${string}`): Promise<{ wei: bigint; maxFeePerGas: bigint }> {
  const chain = mainnetChain(1);
  const client = createPublicClient({ chain, transport: http(mainnetRpc(1)) });
  const fees = await client.estimateFeesPerGas();
  return { wei: await client.getBalance({ address }), maxFeePerGas: fees.maxFeePerGas };
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

async function runAgglayer(
  signer: Hex,
  midenAddress: string,
  evmAddress: `0x${string}`,
  wallet: GuardianAwareWalletPage
): Promise<void> {
  const chain = mainnetChain(1);
  await bridgeEthToMiden({
    key: signer,
    chain,
    rpcUrl: mainnetRpc(1),
    bridge: AGGLAYER_BRIDGE,
    rollupId: CEDAR_ROLLUP_ID,
    midenAddress,
    wei: AGGLAYER_LOOP_WEI
  });
  await wallet.triggerSync(true);
  await wallet.claimAllNotes();
  await bridgeOutSlow(wallet, {
    destAddress: evmAddress,
    tokenSymbol: 'ETH',
    amount: '0.000001',
    network: { id: 'ethereum', name: chain.name }
  });
  const deposit = await waitForMidenExit(evmAddress);
  await claimAgglayerOnEthereum({
    key: signer,
    chain,
    rpcUrl: mainnetRpc(1),
    bridge: AGGLAYER_BRIDGE,
    indexerUrl: INDEXER,
    deposit
  });
}

async function waitForMidenExit(address: string) {
  const deadline = Date.now() + 1_200_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${INDEXER}/bridges/${address}?limit=10&offset=0`);
    if (response.ok) {
      const body = (await response.json()) as {
        deposits?: Array<AgglayerDeposit & { global_index?: string | number }>;
      };
      const found = (body.deposits ?? []).find(
        deposit =>
          deposit.network_id === CEDAR_ROLLUP_ID &&
          (deposit.ready_for_claim || deposit.ready_to_claim) &&
          !deposit.claim_tx_hash
      );
      if (found) return found;
    }
    await new Promise(resolve => setTimeout(resolve, 8_000));
  }
  throw new Error(`no AggLayer exit to ${address} was ready to claim`);
}
