import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {createPublicClient,erc20Abi,getAddress,http} from 'viem';
import {mainnet} from 'viem/chains';
import {test} from '../../fixtures/two-wallets';
import {vaultBalanceByFaucetId} from '../../helpers/balance-truth';
import {loadMainnetEpochCheckpoint} from '../../helpers/mainnet-epoch-checkpoint';
import {loadMainnetSwapCheckpoint} from '../../helpers/mainnet-swap-checkpoint';
import {restoreMainnetLoopGuardian} from '../../helpers/mainnet-loop-wallet';
import {realizedMainnetLoopLoss} from '../../helpers/mainnet-loop-budget';

const paths=['test-results/final/roundtrip.json','test-results/fresh/roundtrip.json','test-results/near/roundtrip.json'];
const hashes=()=>paths.map(p=>createHash('sha256').update(readFileSync(p)).digest('hex'));
test.use({injectFeeFaucet:false});
test.afterEach(async({},info)=>writeFileSync('test-results/fresh-epoch-claim-private-status.json',JSON.stringify({status:info.status,errorSha256:info.error?createHash('sha256').update(info.error.message??'unknown').digest('hex'):undefined,errorSite:info.error?.stack?.match(/fresh-epoch-claim-private\.spec\.ts:\d+:\d+/)?.[0]})));
test('independent original PRIVATE holdings after existing first Epoch claim, without new authority or mutation',async({walletB})=>{
 test.setTimeout(600_000);const before=hashes();assert.equal(before[1],'c90ce2fed01dc6e7782b8fc722749cba800a3cba11999a91d285b46e70f2a4b5');assert.equal(before[2],'c05b5f1c9c9ec3b4bb5f0e1340596fda48248ccceaa6ae70a5cd08bbacf21a68');
 const state=loadMainnetEpochCheckpoint(paths[0]!);const swap=loadMainnetSwapCheckpoint(paths[1]!);assert.ok(state&&swap);assert.equal(state.phase,'complete');assert.equal(state.sourceRunId,'43961933479');assert.equal(state.returnNoteId,'0x17154132097588ca256a046e0aa32ddc8775f2097650d5c07126676e6176ff98');assert.ok(state.returnMidenTxId&&state.consumeAuthority&&state.after&&state.reverseAuthority);
 assert.equal(state.consumeAuthority.canonicalSha256,'a3f2b7361ff3416b965c095af5522c30752c3563df760016593776d6dab54d57');
 await restoreMainnetLoopGuardian(walletB,process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR??'');assert.equal(await walletB.getAccountAddress(),state.account);await walletB.triggerSync(true);await walletB.refreshBalancesLanded(90_000);
 const native=await vaultBalanceByFaucetId(walletB.page,state.native.faucetId),request=await vaultBalanceByFaucetId(walletB.page,swap.request.faucetId);assert.equal(native.toString(),state.after.native);assert.equal(request,0n);
 assert.equal(native,BigInt(state.native.balance)-BigInt(state.principal)+BigInt(state.reverseReceived??'0')-BigInt(state.paidMidenFees));
 const client=createPublicClient({chain:mainnet,transport:http('https://ethereum.publicnode.com',{retryCount:0})});const account=getAddress(state.evm.account);
 const [token,gas,latest,pending]=await Promise.all([client.readContract({address:getAddress(state.evm.token),abi:erc20Abi,functionName:'balanceOf',args:[account]}),client.getBalance({address:account}),client.getTransactionCount({address:account,blockTag:'latest'}),client.getTransactionCount({address:account,blockTag:'pending'})]);assert.equal(token,253061140n);assert.equal(gas,297546469223440756n);assert.equal(latest,107);assert.equal(pending,latest);assert.equal(state.after.evmToken,token.toString());assert.equal(state.after.evmNative,gas.toString());
 const names=['e2e_mainnet_send_authorization','e2e_mainnet_consume_authorization'];const policies=await walletB.page.evaluate(async keys=>chrome.storage.local.get(keys),names);assert.ok(names.every(k=>policies[k]===undefined));assert.deepEqual(hashes(),before);
 const valuation=state.reverseAuthority.valuation;assert.ok(valuation);const cost=realizedMainnetLoopLoss([{identity:`miden:${state.native.hex}`,decimals:6,usdMicros:BigInt(valuation.stableUsdMicros),before:BigInt(state.native.balance),after:native},{identity:`evm:1:${state.evm.token.toLowerCase()}`,decimals:6,usdMicros:BigInt(valuation.stableUsdMicros),before:BigInt(state.evm.tokenBalance),after:token},{identity:'evm:1:native',decimals:18,usdMicros:BigInt(valuation.gasUsdMicros),before:BigInt(state.evm.nativeBalance),after:gas}]);assert.equal(cost.toString(),state.realizedCostUsdMicros);const total=90246n+1013n+cost,remaining=2000000n-total;assert.ok(remaining>=0n);
 writeFileSync('test-results/fresh-epoch-claim-private-settlement.json',JSON.stringify({purpose:'independent PRIVATE current readiness; original postclaim cost already booked, no grants/signature/broadcast/checkpoint mutation',newCampaignSpendToBookUsdMicros:'0',applicationSource:'c3b9997f069267a02a8e1715f691d0187982e23d',native:native.toString(),request:request.toString(),ethereumToken:token.toString(),ethereumGas:gas.toString(),latestNonce:latest,pendingNonce:pending,noLiveSpendingPolicy:true,checkpointHashes:before,originalEpochSource:'43961933479',returnNoteId:state.returnNoteId,claimTransactionId:state.returnMidenTxId,totalNativeFees:state.paidMidenFees,actualEvmFeesWei:state.paidEvmFees,swapCostUsdMicros:'1013',finalEpochCostUsdMicros:cost.toString(),newWholeFreshCostToDeductOnce:(1013n+cost).toString(),priorVerifiedTaskSpentUsdMicros:'90246',finalTotalTaskSpentUsdMicros:total.toString(),finalRemainingUsdMicros:remaining.toString(),noDoubleDeductionOfProvisional40601:true,overallProfitCannotIncreaseCap:true,heldReturnPrincipalNotChargedAsLoss:true,newAuthorityIssued:false,newTransaction:false}));
});
