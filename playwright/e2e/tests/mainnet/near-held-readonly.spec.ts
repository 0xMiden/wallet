import assert from 'node:assert/strict';
import {createHash,createHmac,randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {test} from '../../fixtures/two-wallets';
import {restoreMainnetLoopGuardian} from '../../helpers/mainnet-loop-wallet';
import {loadMainnetNearCheckpoint} from '../../helpers/mainnet-near-checkpoint';
import {canonicalMainnetLoopFaucet} from '../../helpers/mainnet-loop-config';
import {loadMainnetOneClickSetup} from '../../helpers/mainnet-one-click-config';
import {fromBaseUnits,vaultBalanceByFaucetId} from '../../helpers/balance-truth';
import {captureMainnetOneClickReviewQuote,confirmMainnetOneClickReview} from '../../helpers/mainnet-one-click-ui';
import {armMainnetSendAuthorization} from '../../helpers/mainnet-send-authorization';
import {plantQueueBlocker,releaseQueueBlocker,readTransactionRows,TxStatus} from '../../helpers/history';
import {assertOneClickQuoteBinding} from '../../../../src/lib/one-click/client';
import {assertOneClickFundingDeadline} from '../../../../src/lib/one-click/deadline';

const checkpoint='test-results/original-near/roundtrip.json';
const hash=()=>createHash('sha256').update(readFileSync(checkpoint)).digest('hex');
const expectedHash='a4546b4126ba6c81bc19272117d60ac904eedcea65add3ed7ff7d990817d2b12';
const key='e2e_mainnet_send_authorization',hmacKey=randomBytes(32);
const fingerprint=(value:string)=>createHmac('sha256',hmacKey).update(value).digest('hex');
const publicSources=['src/screens/swap-flow/OneClickFlow.tsx','src/lib/one-click/client.ts','src/lib/one-click/tracking.ts','src/lib/miden/transaction/initiate.ts','src/lib/miden/sdk/test-send-authorization.ts'];
const catalog=publicSources.flatMap(path=>{const source=readFileSync(path,'utf8');return [...source.matchAll(/throw new Error\(\s*(['"])([^'"\n]{4,180})\1\s*\)/g)].map(m=>({literal:m[2]!,site:`${path}:${source.slice(0,m.index).split('\n').length}`}));});
const classify=(message:string)=>catalog.filter(entry=>message.includes(entry.literal)).map(entry=>entry.site);
assert.ok(catalog.length>10);assert.deepEqual(classify('private payload not in the public error catalog'),[]);
const publicAssets=new Set(readdirSync('dist/chrome_unpacked',{recursive:true}).filter((p):p is string=>typeof p==='string'&&p.endsWith('.js')));
const safeFrames=(frames:any[])=>frames.flatMap(frame=>{try{const url=new URL(frame.url),path=url.pathname.slice(1);return url.protocol==='chrome-extension:'&&publicAssets.has(path)&&Number.isSafeInteger(frame.location.lineNumber)&&Number.isSafeInteger(frame.location.columnNumber)?[{asset:path,line:frame.location.lineNumber+1,column:frame.location.columnNumber+1}]:[];}catch{return [];}}).slice(0,3);
let stage='checkpoint-binding';
const report:Record<string,unknown>={purpose:'held-only native NEAR UI/queue/SDK boundary diagnostic; never release SDK authorization, no upload ACK, no financial checkpoint mutation',applicationSource:'c3b9997f069267a02a8e1715f691d0187982e23d',originalRunId:'43999834254',diagnosticOnly:true};
test.use({injectFeeFaucet:false});
test.afterEach(async({},info)=>{report.testStatus=info.status;report.stage=stage;if(info.error)report.errorFingerprint=fingerprint(info.error.message??'unknown');writeFileSync('test-results/near-held-diagnostic.json',JSON.stringify(report,null,2));});
test('observe original-source native NEAR boundaries with mandatory SDK hold and unchanged actual private holdings',async({walletB})=>{
 test.setTimeout(600_000);assert.equal(hash(),expectedHash);const state=loadMainnetNearCheckpoint(checkpoint);assert.ok(state&&state.forwardQuote);assert.equal(state.sourceRunId,'43999834254');assert.equal(state.phase,'forward-authorized');assert.equal(state.sendAuthority,undefined);assert.equal(state.forwardMidenTxId,undefined);
 const accepted=JSON.parse(readFileSync('test-results/accepted-private/fresh-epoch-claim-private-settlement.json','utf8'));assert.equal(accepted.sourceRunId,state.sourceRunId);assert.equal(accepted.native,'19837087');assert.equal(accepted.nearStatus,'PENDING_DEPOSIT');assert.equal(accepted.noLiveSpendingPolicy,true);assert.equal(accepted.nearOriginalQuoteSignatureAndTermsVerified,true);assert.equal(accepted.prospectiveRemainingUsdMicros,'1827631');
 stage='restore-original-private-account';await restoreMainnetLoopGuardian(walletB,process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR??'');assert.equal(await walletB.getAccountAddress(),state.account);await walletB.triggerSync(true);await walletB.refreshBalancesLanded(90_000);const before=await vaultBalanceByFaucetId(walletB.page,state.native.faucetId);assert.equal(before,19837087n);
 const setup=await loadMainnetOneClickSetup(fetch,fetch,walletB.extensionId);assert.ok(setup);const native=setup.assets.find(a=>a.assetId===state.nativeAssetId),evm=setup.assets.find(a=>a.assetId===state.evmAssetId);assert.ok(native&&evm);assert.equal(setup.config.serviceUrl,state.serviceUrl);
 const cdp=await walletB.page.context().newCDPSession(walletB.page);const exceptions:{fingerprint:string;publicSites:string[];frames:ReturnType<typeof safeFrames>}[]=[];await cdp.send('Debugger.enable');cdp.on('Debugger.paused',async event=>{try{if(['exception','promiseRejection'].includes(event.reason)&&exceptions.length<40){const message=event.data?.description??'';exceptions.push({fingerprint:fingerprint(message),publicSites:classify(message),frames:safeFrames(event.callFrames)});}}finally{await cdp.send('Debugger.resume').catch(()=>{});}});await cdp.send('Debugger.setPauseOnExceptions',{state:'all'});
 let armed=false,releasedQueue=false;const blocker=await plantQueueBlocker(walletB.page);const started=Date.now();
 try{
  stage='fresh-unsigned-review-only';await walletB.navigateTo('/swap');const quote=await captureMainnetOneClickReviewQuote(walletB,{payNetwork:'miden',payAssetId:native.assetId,receiveNetwork:evm.blockchain,receiveAssetId:evm.assetId,amount:fromBaseUnits(BigInt(state.principal),6),externalAddress:state.evm.account},{originAsset:native.assetId,destinationAsset:evm.assetId,amount:BigInt(state.principal),refundTo:state.account,recipient:state.evm.account});assert.ok(quote.quote.depositAddress&&quote.quoteRequest.deadline);assertOneClickQuoteBinding({originAsset:native,destinationAsset:evm,amount:state.principal,refundTo:state.account,recipient:state.evm.account,deadline:quote.quoteRequest.deadline,slippageTolerance:100},quote,false,setup.config);const deadline=assertOneClickFundingDeadline(quote.quoteRequest.deadline,quote.quote.deadline);
  stage='mandatory-local-sdk-hold';await armMainnetSendAuthorization(walletB.page,{accountId:state.accountHex,recipientId:canonicalMainnetLoopFaucet(quote.quote.depositAddress),faucetId:state.native.hex,amount:state.principal,expiresAt:Math.min(Date.parse(deadline),Date.now()+300_000)});armed=true;
  await confirmMainnetOneClickReview(walletB.page);stage='observe-queue-and-sdk-without-release';let lastStatus:unknown;
  for(let poll=0;poll<240;poll++){
   const policy=await walletB.page.evaluate(async key=>(await chrome.storage.local.get(key))[key],key);assert.ok(policy&&['armed','waiting'].includes(policy.status));lastStatus=policy.status;
   const rows=await readTransactionRows(walletB.page);const sends=rows.filter(row=>row.type==='send'&&row.accountId&&canonicalMainnetLoopFaucet(row.accountId)===state.accountHex);
   report.rows=sends.map(row=>({status:row.status,started:row.processingStartedAt!==undefined,hasTransactionId:!!row.transactionId,hasPaidFee:row.feeAmount!==undefined&&row.feeAmount!=='0',publicErrorSites:classify(`${row.error??''}\n${row.rawError??''}`),errorFingerprint:row.error||row.rawError?fingerprint(`${row.error??''}\n${row.rawError??''}`):undefined}));
   assert.ok(sends.every(row=>!row.transactionId&&(!row.feeAmount||row.feeAmount==='0')),'Held diagnostic unexpectedly acquired an on-chain receipt');
   if(!releasedQueue&&sends.some(row=>row.status===TxStatus.Queued)){assert.equal(sends.length,1);await releaseQueueBlocker(walletB.page,blocker);releasedQueue=true;}
   if(policy.status==='waiting'||sends.some(row=>row.status===TxStatus.Failed))break;
   await walletB.page.waitForTimeout(1000);
  }
  report.observedPolicyStatus=lastStatus;report.releasedQueueBlocker=releasedQueue;
 }catch(error){report.observedBoundaryFailure=true;report.boundaryFailureStage=stage;report.boundaryErrorFingerprint=fingerprint(error instanceof Error?error.message:String(error));report.boundaryPublicErrorSites=classify(error instanceof Error?error.message:String(error));}
 finally{
  stage='block-held-scope-with-required-guard-preserved';if(armed){await walletB.page.evaluate(async key=>{const value=(await chrome.storage.local.get(key))[key];if(!value||!['armed','waiting'].includes(value.status))throw new Error('Diagnostic scope changed outside the mandatory hold');await chrome.storage.local.set({[key]:{...value,status:'blocked'}});const stored=await chrome.storage.local.get([key,`${key}_required`]);if(stored[key].status!=='blocked'||stored[`${key}_required`]?.nonce!==value.nonce)throw new Error('Mandatory diagnostic guard missing');},key);report.finalSdkPolicyStatus='blocked';}
  await cdp.send('Debugger.setPauseOnExceptions',{state:'none'});await cdp.detach();report.exceptions=exceptions;report.elapsedMs=Date.now()-started;report.sdkAuthorizationReleased=false;report.uploadAckCreated=false;assert.equal(hash(),expectedHash);report.originalCheckpointUnchanged=true;
 }
 stage='independent-post-diagnostic-private-sync';await walletB.page.waitForTimeout(1500);await walletB.triggerSync(true);await walletB.refreshBalancesLanded(90_000);const after=await vaultBalanceByFaucetId(walletB.page,state.native.faucetId);assert.equal(after,before);report.nativeBefore=before.toString();report.nativeAfter=after.toString();report.newNativeSpend='0';report.originalCheckpointHash=hash();stage='no-spend-diagnostic-complete';
});
