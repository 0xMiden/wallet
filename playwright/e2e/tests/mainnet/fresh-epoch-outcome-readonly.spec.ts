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
import {exportPublicInputNote} from '../../helpers/swap';
import {inspectEpochReturnNote,mainnetConsumeRequestHash} from '../../helpers/mainnet-epoch-request';

const paths=['test-results/final/roundtrip.json','test-results/fresh/roundtrip.json','test-results/near/roundtrip.json'];
const hashes=()=>paths.map(p=>createHash('sha256').update(readFileSync(p)).digest('hex'));
test.use({injectFeeFaucet:false});
test.afterEach(async({},info)=>writeFileSync('test-results/fresh-epoch-private-status.json',JSON.stringify({status:info.status,errorSha256:info.error?createHash('sha256').update(info.error.message??'unknown').digest('hex'):undefined,errorSite:info.error?.stack?.match(/(?:fresh-epoch-outcome-readonly\.spec|mainnet-[\w-]+)\.ts:\d+:\d+/)?.[0]})));
test('original funded Epoch private inventory and return-note readiness without granting or claiming',async({walletB})=>{
 test.setTimeout(600_000);
 const before=hashes();assert.deepEqual(before,['cc7c8bcca1528102fedaf41ee05086192c4d55205a788ad95008b8445e7b58f3','c90ce2fed01dc6e7782b8fc722749cba800a3cba11999a91d285b46e70f2a4b5','c05b5f1c9c9ec3b4bb5f0e1340596fda48248ccceaa6ae70a5cd08bbacf21a68']);
 const state=loadMainnetEpochCheckpoint(paths[0]!);const swap=loadMainnetSwapCheckpoint(paths[1]!);assert.ok(state&&swap);
 assert.equal(state.phase,'recovery-required');assert.equal(state.sourceRunId,'43961933479');assert.equal(state.consumeAuthority,undefined);assert.equal(state.returnMidenTxId,undefined);
 const report:Record<string,unknown>={purpose:'independent original PRIVATE inventory and existing Epoch return-note readiness; no new grant/sign/broadcast/claim or checkpoint mutation',sourceRunId:state.sourceRunId,newAuthorityIssued:false,newTransaction:false,heldReturnPrincipalNotChargedAsLoss:true};
 const save=()=>writeFileSync('test-results/fresh-epoch-private-outcome.json',JSON.stringify(report));
 await restoreMainnetLoopGuardian(walletB,process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR??'');assert.equal(await walletB.getAccountAddress(),state.account);
 await walletB.triggerSync(true);await walletB.refreshBalancesLanded(90_000);
 const native=await vaultBalanceByFaucetId(walletB.page,state.native.faucetId);const request=await vaultBalanceByFaucetId(walletB.page,swap.request.faucetId);
 Object.assign(report,{native:native.toString(),request:request.toString(),expectedLiquidNative:(BigInt(state.native.balance)-BigInt(state.principal)-BigInt(state.paidMidenFees)).toString()});save();
 assert.equal(native,BigInt(state.native.balance)-BigInt(state.principal)-BigInt(state.paidMidenFees));assert.equal(native,18_878_111n);assert.equal(request,0n);
 const client=createPublicClient({chain:mainnet,transport:http('https://ethereum.publicnode.com',{retryCount:0})});const account=getAddress(state.evm.account);
 const [token,gas,latest,pending]=await Promise.all([client.readContract({address:getAddress(state.evm.token),abi:erc20Abi,functionName:'balanceOf',args:[account]}),client.getBalance({address:account}),client.getTransactionCount({address:account,blockTag:'latest'}),client.getTransactionCount({address:account,blockTag:'pending'})]);
 assert.equal(token,BigInt(state.evm.tokenBalance)+BigInt(state.forwardReceived??'0')-BigInt(state.returnAmount??'0'));assert.equal(gas,BigInt(state.evm.nativeBalance)-BigInt(state.paidEvmFees));assert.equal(latest,107);assert.equal(pending,latest);
 Object.assign(report,{ethereumToken:token.toString(),ethereumGas:gas.toString(),ethereumLatest:latest,ethereumPending:pending});save();
 const names=['e2e_mainnet_send_authorization','e2e_mainnet_consume_authorization'];const policies=await walletB.page.evaluate(async keys=>chrome.storage.local.get(keys),names);assert.ok(names.every(k=>policies[k]===undefined));report.noLiveSpendingPolicy=true;save();
 const evidence:unknown=JSON.parse(readFileSync('test-results/fresh-epoch-public-outcome.json','utf8'));
 assert.ok(typeof evidence==='object'&&evidence!==null);const noteId=Reflect.get(evidence,'publicReturnNote');assert.ok(typeof noteId==='string'&&/^0x[0-9a-f]{64}$/i.test(noteId));
 try {
  const file=await exportPublicInputNote(walletB,noteId);const bytes=Buffer.from(file,'hex');const amount=inspectEpochReturnNote(state,noteId,bytes);const canonical=mainnetConsumeRequestHash(bytes,true);
  assert.equal(amount.toString(),Reflect.get(evidence,'returnAmount'));assert.equal(canonical,Reflect.get(evidence,'prospectiveConsumeCanonicalSha256'));
  Object.assign(report,{existingReturnNoteReady:true,existingReturnNote:noteId,returnAmount:amount.toString(),prospectiveCanonicalConsumeSha256:canonical});save();
 } catch(error) {if(error instanceof Error){Object.assign(report,{existingReturnNoteReady:false,readinessErrorClass:error.name,readinessErrorSha256:createHash('sha256').update(error.message).digest('hex'),readinessErrorSite:error.stack?.match(/(?:mainnet-[\w-]+|swap|fresh-epoch-outcome-readonly\.spec)\.ts:\d+:\d+/)?.[0]});save();}throw error;}
 assert.deepEqual(hashes(),before);report.originalCheckpointBytesUnchanged=true;report.epochFinalCostPendingOriginalClaim=true;save();
});
