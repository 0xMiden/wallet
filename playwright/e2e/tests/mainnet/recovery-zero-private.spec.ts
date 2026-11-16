import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, erc20Abi, getAddress, http } from 'viem';
import { arbitrum, mainnet } from 'viem/chains';
import { test } from '../../fixtures/two-wallets';
import { vaultBalanceByFaucetId } from '../../helpers/balance-truth';
import { loadMainnetEpochCheckpoint } from '../../helpers/mainnet-epoch-checkpoint';
import { restoreMainnetLoopGuardian } from '../../helpers/mainnet-loop-wallet';
import { loadMainnetNearCheckpoint } from '../../helpers/mainnet-near-checkpoint';
import { verifyUnstartedNearForward } from '../../helpers/mainnet-near-runtime';
import { fetchOneClickStatus, parseOneClickQuoteResponse } from '../../../../src/lib/one-click/client';
import { hashOneClickQuote, verifyOneClickQuoteSignature } from '../../../../src/lib/one-click/signature';
import { isRecord } from '../../../../src/lib/update/guards';
import { createMainnetOneClickOriginFetcher } from '../../helpers/mainnet-one-click-origin';
import { loadMainnetSwapCheckpoint } from '../../helpers/mainnet-swap-checkpoint';

const paths = ['test-results/fresh/roundtrip.json', 'test-results/final/roundtrip.json', 'test-results/near/roundtrip.json', 'test-results/original-near/roundtrip.json'];
const hashes = () => paths.map(path => createHash('sha256').update(readFileSync(path)).digest('hex'));
test.use({ injectFeeFaucet: false });
test.afterEach(async ({}, info) => {
  writeFileSync('test-results/recovery-zero-private-status.json', JSON.stringify({
    status: info.status,
    errorSha256: info.error ? createHash('sha256').update(info.error.message ?? 'unknown').digest('hex') : undefined,
    errorSite: info.error?.stack?.match(/recovery-zero-private\.spec\.ts:\d+:\d+/)?.[0]
  }));
});

test('read-only diagnosis of the original unsigned NEAR live verification', async ({walletB}) => {
  test.setTimeout(600_000);
  const before=hashes();
  assert.equal(before[3],'d2283bdd2372696ebe109c6b31ce5190ac7b29be07901e2ede142ba8c1f18524');
  const original=loadMainnetNearCheckpoint(paths[3]!); assert.ok(original?.forwardQuote);
  await restoreMainnetLoopGuardian(walletB,process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR ?? '');
  const report: Record<string,unknown>={purpose:'read-only original source verification diagnosis, no new grant/sign/broadcast/checkpoint mutation',sameGuardian:(await walletB.getAccountAddress())===original.account};
  try {await verifyUnstartedNearForward(walletB,original);report.originalVerifierPassed=true;}
  catch(error) {
    report.originalVerifierPassed=false;
    if(error instanceof Error) {report.errorClass=error.name;report.errorSha256=createHash('sha256').update(error.message).digest('hex');report.errorSite=error.stack?.match(/(?:mainnet-near-runtime|client|mainnet-one-click-origin)\.ts:\d+:\d+/)?.[0];}
  }
  writeFileSync('test-results/recovery-readonly-diagnostic.json',JSON.stringify(report));
  report.privateNativeBeforeSync=(await vaultBalanceByFaucetId(walletB.page,original.native.faucetId)).toString();
  await walletB.triggerSync(true);await walletB.refreshBalancesLanded(90_000);
  report.privateNativeAfterSync=(await vaultBalanceByFaucetId(walletB.page,original.native.faucetId)).toString();
  report.originalNativeExpected=original.native.balance;
  try {
    const status=await fetchOneClickStatus({serviceUrl:original.serviceUrl,appFees:original.appFees,feePolicy:original.feePolicy,midenAssets:[{assetId:original.nativeAssetId,faucetId:original.native.hex,decimals:6}]},original.forwardQuote.depositAddress,undefined,undefined,createMainnetOneClickOriginFetcher(original.serviceUrl,walletB.extensionId));
    report.providerStatus=status.status;report.canonicalQuoteHashMatched=hashOneClickQuote(status.quoteResponse)===original.forwardQuote.quoteHash;
    report.correlationMatched=status.quoteResponse.correlationId===original.forwardQuote.correlationId;
    report.depositReferenceMatched=status.quoteResponse.quote.depositAddress===original.forwardQuote.depositAddress;
    report.depositMemoPresent=status.quoteResponse.quote.depositMemo!==undefined;
    report.intentCount=status.swapDetails.intentHashes.length;report.originTxCount=status.swapDetails.originChainTxHashes.length;report.destinationTxCount=status.swapDetails.destinationChainTxHashes.length;report.nearTxCount=status.swapDetails.nearTxHashes.length;report.depositedAmount=status.swapDetails.depositedAmount;
  } catch(error) {if(error instanceof Error){report.providerErrorClass=error.name;report.providerErrorSha256=createHash('sha256').update(error.message).digest('hex');report.providerErrorSite=error.stack?.match(/(?:mainnet-near-runtime|client|mainnet-one-click-origin)\.ts:\d+:\d+/)?.[0];}}
  try {
    const fetcher=createMainnetOneClickOriginFetcher(original.serviceUrl,walletB.extensionId);
    const response=await fetcher(`${original.serviceUrl}/v0/status?${new URLSearchParams({depositAddress:original.forwardQuote.depositAddress})}`);
    assert.ok(response.ok);const text=await response.text();assert.ok(text.length<=64000);const raw:unknown=JSON.parse(text);
    assert.ok(isRecord(raw)&&isRecord(raw.quoteResponse));
    report.rawProviderStatus=raw.status;report.rawRootCorrelationMatchesOriginal=raw.correlationId===original.forwardQuote.correlationId;
    report.rawNestedCorrelationPresent=raw.quoteResponse.correlationId!==undefined;
    const parsed=parseOneClickQuoteResponse({...raw.quoteResponse,correlationId:raw.quoteResponse.correlationId??original.forwardQuote.correlationId});
    report.originalSignedPayloadHashMatched=hashOneClickQuote(parsed)===original.forwardQuote.quoteHash;
    report.managerSignatureValid=verifyOneClickQuoteSignature(parsed);
    report.signedDepositReferenceMatched=parsed.quote.depositAddress===original.forwardQuote.depositAddress;
    report.signedAmountInMatched=parsed.quote.amountIn===original.forwardQuote.amountIn;
    report.signedMinimumOutputMatched=parsed.quote.minAmountOut===original.forwardQuote.minimumOutput;
    report.signedRefundFeeMatched=parsed.quote.refundFee===original.forwardQuote.refundFee;
  } catch(error) {if(error instanceof Error){report.signedProbeErrorClass=error.name;report.signedProbeErrorSha256=createHash('sha256').update(error.message).digest('hex');report.signedProbeErrorSite=error.stack?.match(/(?:client|signature|recovery-zero-private\.spec)\.ts:\d+:\d+/)?.[0];}}
  assert.deepEqual(hashes(),before);report.checkpointsUnchanged=true;
  writeFileSync('test-results/recovery-readonly-diagnostic.json',JSON.stringify(report));
});

test('independently reconcile original private holdings after unsigned NEAR recovery', async ({ walletB }) => {
  test.setTimeout(600_000);
  const before = hashes();
  assert.deepEqual([before[0],before[1],before[3]], [
    'a9418686339d234e245ec083668cbd2b16f5e4375098a33c9c26221fd6df37e4',
    '6ca09782587d50227093cdbef7ee40a8d1817440508b58933ab7a26094cce6c7',
    'd2283bdd2372696ebe109c6b31ce5190ac7b29be07901e2ede142ba8c1f18524'
  ]);
  const swap = loadMainnetSwapCheckpoint(paths[0]!);
  const epoch = loadMainnetEpochCheckpoint(paths[1]!);
  const near = loadMainnetNearCheckpoint(paths[2]!);
  const original = loadMainnetNearCheckpoint(paths[3]!);
  assert.ok(swap && epoch && near && original);
  assert.equal(swap.sourceRunId, '43811169447');
  assert.equal(swap.phase, 'complete'); assert.equal(epoch.phase, 'complete');
  assert.equal(epoch.sourceRunId, swap.sourceRunId); assert.equal(near.sourceRunId, swap.sourceRunId);
  assert.equal(near.phase, 'unspent'); assert.equal(original.phase, 'forward-authorized');
  assert.deepEqual({...near,phase:original.phase,updatedAt:original.updatedAt},original);
  assert.ok(Date.parse(near.updatedAt)>Date.parse(original.updatedAt));
  assert.equal(near.sendAuthority, undefined); assert.equal(near.forwardMidenTxId, undefined);
  assert.equal(swap.account, epoch.account); assert.equal(near.account, epoch.account);
  await restoreMainnetLoopGuardian(walletB, process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR ?? '');
  assert.equal(await walletB.getAccountAddress(), swap.account);
  await walletB.triggerSync(true); await walletB.refreshBalancesLanded(90_000);
  const native = await vaultBalanceByFaucetId(walletB.page, swap.native.faucetId);
  const request = await vaultBalanceByFaucetId(walletB.page, swap.request.faucetId);
  assert.equal(native, 19_879_573n); assert.equal(native.toString(), epoch.after?.native);
  assert.equal(near.native.balance, native.toString()); assert.equal(request, 0n);
  const account = getAddress(epoch.evm.account);
  const ethereum = createPublicClient({ chain: mainnet, transport: http('https://ethereum.publicnode.com', { retryCount: 0 }) });
  const arb = createPublicClient({ chain: arbitrum, transport: http('https://arb1.arbitrum.io/rpc', { retryCount: 0 }) });
  const [token, gas, nonce, pending, arbToken, arbGas, arbNonce, arbPending] = await Promise.all([
    ethereum.readContract({ address: getAddress(epoch.evm.token), abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    ethereum.getBalance({ address: account }), ethereum.getTransactionCount({ address: account, blockTag: 'latest' }),
    ethereum.getTransactionCount({ address: account, blockTag: 'pending' }),
    arb.readContract({ address: getAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831'), abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    arb.getBalance({ address: account }), arb.getTransactionCount({ address: account, blockTag: 'latest' }),
    arb.getTransactionCount({ address: account, blockTag: 'pending' })
  ]);
  assert.equal(token, 253_042_125n); assert.equal(gas, 297_568_063_255_111_083n);
  assert.equal(nonce, 105); assert.equal(pending, nonce); assert.equal(arbToken, 38_682_541n);
  assert.equal(arbGas, 19_429_691_940_260_000n); assert.equal(arbNonce, 84); assert.equal(arbPending, arbNonce);
  const names = ['e2e_mainnet_send_authorization', 'e2e_mainnet_consume_authorization'];
  const policies = await walletB.page.evaluate(async keys => chrome.storage.local.get(keys), names);
  assert.ok(names.every(name => policies[name] === undefined)); assert.deepEqual(hashes(), before);
  assert.equal(90_246n + 1_909_754n, 2_000_000n);
  writeFileSync('test-results/recovery-zero-private-audit.json', JSON.stringify({
    purpose: 'independent original PRIVATE native/request and Ethereum/Arbitrum inventory after known unsigned quote reconciliation; no grants or checkpoint mutation',
    native: native.toString(), request: request.toString(), ethereumToken: token.toString(), ethereumGas: gas.toString(),
    ethereumNonce: nonce, ethereumPending: pending, arbitrumToken: arbToken.toString(), arbitrumGas: arbGas.toString(),
    arbitrumNonce: arbNonce, arbitrumPending: arbPending, noLiveSpendingPolicy: true, immutableCheckpointsUnchanged: true,
    nearHasNoSendAuthority: true, nearUnspent: true, originalQuotePricesAmountsUnchanged: true,
    checkpointHashes: before, newSpendingAuthority: false, newTransaction: false,
    newCostUsdMicros: '0', totalSpentUsdMicros: '90246', taskRemainingUsdMicros: '1909754', noProfitCredit: true
  }));
});
