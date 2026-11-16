import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {expect} from '@playwright/test';
import {createPublicClient,getAddress,http,isHex} from 'viem';
import {privateKeyToAddress} from 'viem/accounts';
import {test} from '../../fixtures/two-wallets';
import {captureMainnetOneClickReviewQuote,connectMainnetOneClickWallet,selectMainnetOneClickAssets} from '../../helpers/mainnet-one-click-ui';
import {mainnetChain,mainnetRpc} from '../../helpers/mainnet-bridge-sources';
import {WcCounterparty} from '../../ios/helpers/wc-counterparty';
import {restoreMainnetLoopGuardian} from '../../helpers/mainnet-loop-wallet';
import {fromBaseUnits,vaultBalanceByFaucetId,walletDiscoveredBaseFee,walletDiscoveredNativeFaucetId} from '../../helpers/balance-truth';
import {canonicalMainnetLoopFaucet} from '../../helpers/mainnet-loop-config';
import {loadMainnetOneClickSetup} from '../../helpers/mainnet-one-click-config';
import {createMainnetOneClickOriginFetcher} from '../../helpers/mainnet-one-click-origin';
import {fetchMainnetOneClickUsdPrices,mainnetOneClickPriceId} from '../../helpers/mainnet-one-click-prices';
import {readMainnetEvmHolding} from '../../helpers/mainnet-one-click-evm';
import {prepareMainnetNearRoundTrip,selectMainnetNearNativeAsset,type MainnetNearPlanningFacts} from '../../helpers/mainnet-near-plan';
import {assertOneClickQuoteBinding,ONE_CLICK_EVM_CHAIN_IDS,requestOneClickQuote,OneClickHttpError} from '../../../../src/lib/one-click/client';
import {assertOneClickFundingDeadline} from '../../../../src/lib/one-click/deadline';
import type {OneClickQuoteRequest} from '../../../../src/lib/one-click/types';
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const safe=(value:string)=>value.slice(0,400).replace(/0x[0-9a-fA-F]{30,}/g,'<address-or-hash>').replace(/mm1[a-z0-9_]{20,150}/g,'<miden-address>').replace(/eyJ[A-Za-z0-9_.-]{30,}/g,'<token>');
const report:Record<string,unknown>={purpose:'current original-wallet bidirectional planner and both actual amount-review bindings; prospective return uses existing holdings, never fabricated fill; no grants, signing or payments',originalPlannerEligible:false,grantPersisted:false,sdkAuthorityIssued:false,transactionSigned:false,transactionBroadcast:false,failureCaptured:false};
test.use({injectFeeFaucet:false});
test.afterEach(async({},info)=>{report.probeExecuted=info.status===info.expectedStatus;if(info.error)report.errorSha256=hash(info.error.message??'unknown');writeFileSync('test-results/near-planner-paired-readonly.json',JSON.stringify(report));});
test('validate original-wallet planner and both actual review bindings without granting or spending',async({walletB})=>{
 test.setTimeout(600000);
 const raw=readFileSync('test-results/final/roundtrip.json'),epoch=JSON.parse(raw);assert.equal(hash(raw),'e98a7e61a5b206441fcc1dcdd4727b50b9b056268f24a9cd72b902509ca32bb8');assert.equal(epoch.phase,'complete');assert.equal(epoch.sourceRunId,'43698767716');
 await restoreMainnetLoopGuardian(walletB,process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR??'');assert.equal(await walletB.getAccountAddress(),epoch.account);await walletB.triggerSync(true);await walletB.refreshBalancesLanded(90000);
 const faucet=await walletDiscoveredNativeFaucetId(walletB.page),baseFee=await walletDiscoveredBaseFee(walletB.page);assert.ok(faucet&&baseFee!==null&&baseFee>0);const balance=await vaultBalanceByFaucetId(walletB.page,faucet);assert.equal(balance,19900782n);
 const setup=await loadMainnetOneClickSetup(fetch,fetch,walletB.extensionId);assert.ok(setup);assert.equal(new URL(setup.config.serviceUrl).origin,'https://1click.chaindefuser.com');
 const nativeHex=canonicalMainnetLoopFaucet(faucet),nativeAsset=selectMainnetNearNativeAsset(setup.assets,nativeHex,balance,BigInt(baseFee)*60n),verified=setup.config.midenAssets.find(asset=>asset.assetId===nativeAsset.assetId&&canonicalMainnetLoopFaucet(asset.faucetId)===nativeHex);assert.ok(verified);
 const assets=setup.assets.filter(asset=>(asset.chainId===1||asset.chainId===42161)&&/^(USDC|USDT|USDT0)$/i.test(asset.symbol)&&asset.decimals===6&&asset.contractAddress&&asset.contractAddress!=='native'&&asset.coingeckoId).sort((a,b)=>(a.chainId===42161?0:1)-(b.chainId===42161?0:1)).slice(0,4);
 const nativeId=mainnetOneClickPriceId(nativeAsset,verified),prices=await fetchMainnetOneClickUsdPrices([...new Set([nativeId,'ethereum',...assets.map(asset=>mainnetOneClickPriceId(asset,verified))])]),nativePrice=prices.usdMicrosById[nativeId],gasPrice=prices.usdMicrosById.ethereum;assert.ok(nativePrice&&gasPrice);
 const candidates:MainnetNearPlanningFacts['candidates']=[];
 for(const asset of assets){const price=prices.usdMicrosById[mainnetOneClickPriceId(asset,verified)];assert.ok(price);const holding=await readMainnetEvmHolding(asset,epoch.evm.account);if(asset.chainId===42161&&asset.contractAddress?.toLowerCase()===epoch.evm.token.toLowerCase()){assert.equal(holding.balanceBaseUnits,38682541n);assert.equal(holding.nativeBalanceWei,19429691940260000n);}candidates.push({holding,tokenUsdMicros:price,gasUsdMicros:gasPrice});}
 const sdk=createRequire(`${process.env.NEAR_SDK_CONTROL}/package.json`)('@defuse-protocol/one-click-sdk-typescript');sdk.OpenAPI.BASE='https://1click.chaindefuser.com';sdk.OpenAPI.TOKEN='';sdk.OpenAPI.HEADERS={Origin:`chrome-extension://${walletB.extensionId}`};
 const rows:Array<Record<string,unknown>>=[],pairedFailureControls:Array<Record<string,unknown>>=[],maximumReturns=new Map<string,string>(),scoped=createMainnetOneClickOriginFetcher(setup.config.serviceUrl,walletB.extensionId);
 let maximum=(10000000n*1000000n/nativePrice).toString(),lastBody:string|undefined;
 const observed:typeof fetch=async(input,init)=>{
  assert.equal(typeof init?.body,'string');lastBody=String(init?.body);const response=await scoped(input,init);
  if(!response.ok){const text=await response.clone().text();let messages:string[]=[];try{const body=JSON.parse(text);if(body&&typeof body==='object')for(const value of [body.message,body.error,body.reason,body.detail])for(const item of Array.isArray(value)?value:[value])if(typeof item==='string')messages.push(safe(item));}catch{}rows.push({http:response.status,contentType:response.headers.get('content-type'),messages:messages.slice(0,4),errorSha256:hash(text)});}
  return response;
 };
 const quote=async(request:OneClickQuoteRequest)=>{
  const row:Record<string,unknown>={origin:request.originAsset.assetId,destination:request.destinationAsset.assetId,amount:request.amount};rows.push(row);
  const maxForward=request.originAsset.assetId===nativeAsset.assetId&&request.amount===maximum,maxReverse=request.destinationAsset.assetId===nativeAsset.assetId&&maximumReturns.get(request.originAsset.assetId)===request.amount;
  lastBody=undefined;
  try{const value=await requestOneClickQuote(setup.config,request,true,observed);if(maxForward)maximumReturns.set(request.destinationAsset.assetId,value.quote.minAmountOut);Object.assign(row,{ok:true,minimum:value.quote.minAmountOut,refundFee:value.quote.refundFee,withdrawFee:value.quote.withdrawFee??'0'});return value;}
  catch(error){
   row.error=safe(error instanceof Error?error.message:'unknown');
   if((maxForward||maxReverse)&&lastBody&&pairedFailureControls.length<2){
    const body=JSON.parse(lastBody);assert.equal(body.dry,true);assert.equal(body.amount,request.amount);assert.equal(hash(JSON.stringify(body)),hash(lastBody));
    const control:Record<string,unknown>={at:new Date().toISOString(),direction:maxForward?'forward':'reverse',amount:request.amount,actualBodyMatched:true,commonBodySha256:hash(lastBody),walletError:row.error};if(error instanceof OneClickHttpError)control.walletHttp=error.status;pairedFailureControls.push(control);report.failureCaptured=true;
    try{const pending=sdk.OneClickService.getQuote(body),timer=setTimeout(()=>pending.cancel(),30000);let value;try{value=await pending;control.sdkCallSucceeded=true;}finally{clearTimeout(timer);}assert.equal(value.quoteRequest.dry,true);assert.equal(value.quote.amountIn,request.amount);assert.ok(BigInt(value.quote.minAmountOut)>0n);control.sdkSignatureVerified=sdk.verifyQuoteSignature(value);control.sdkQuoted=true;control.sdkMinimumOutput=value.quote.minAmountOut;}
    catch(sdkError){control.sdkError=safe(sdkError instanceof Error?sdkError.message:'unknown');if(sdkError&&typeof sdkError==='object'){const status=Reflect.get(sdkError,'status');if(typeof status==='number')control.sdkHttp=status;const body=Reflect.get(sdkError,'body');if(body&&typeof body==='object'&&typeof Reflect.get(body,'message')==='string')control.sdkMessage=safe(Reflect.get(body,'message'));}}
   }
   if(error instanceof OneClickHttpError&&error.status===400){row.status=400;return undefined;}throw error;
  }
 };
 Object.assign(report,{stage:'exact-production-bidirectional-planner',extensionId:walletB.extensionId,actualBaseFee:baseFee,native:balance.toString(),nativeUsdMicros:nativePrice.toString(),gasUsdMicros:gasPrice.toString(),actualRemainingAllowanceUsdMicros:'1953919',candidateFacts:candidates.map(value=>({asset:value.holding.asset.assetId,gas:value.holding.nativeBalanceWei.toString(),gasReserve:value.holding.gasReserveWei.toString(),token:value.holding.balanceBaseUnits.toString(),tokenUsdMicros:value.tokenUsdMicros.toString()})),rows,pairedFailureControls});
 let selectedPlan:Awaited<ReturnType<typeof prepareMainnetNearRoundTrip>>|undefined;
 try{const plan=await prepareMainnetNearRoundTrip({account:epoch.account,accountHex:epoch.accountHex,evmAccount:epoch.evm.account,sourceRunId:process.env.GITHUB_RUN_ID??'',pricedAt:prices.fetchedAt,native:{faucetId:faucet,hex:nativeHex,symbol:'USDCX',decimals:6,balance:balance.toString(),usdMicros:nativePrice.toString()},baseFee:BigInt(baseFee),lossBudgetUsdMicros:1953919n,config:setup.config,nativeAsset,candidates},quote);report.originalPlannerEligible=true;report.selected={chainId:plan.evm.chainId,principal:plan.principal,forwardMinimum:plan.forwardMinimum,reverseMinimum:plan.reverseMinimum};selectedPlan=plan;}catch(error){if(!(error instanceof Error)||error.message!=='No existing funded native NEAR route fits the remaining shared allowance')throw error;}
 assert.ok(selectedPlan,'Current production planner must be eligible before held UI checks');
 const state=selectedPlan,evmAsset=assets.find(asset=>asset.assetId===state.evmAssetId);assert.ok(evmAsset);
 const key=`0x${(process.env.E2E_MAINNET_EVM_KEY??'').trim().replace(/^0x/,'')}`;assert.ok(isHex(key)&&/^0x[0-9a-f]{64}$/i.test(key));assert.equal(privateKeyToAddress(key).toLowerCase(),epoch.evm.account.toLowerCase());
 const existing=await readMainnetEvmHolding(evmAsset,epoch.evm.account),client=createPublicClient({chain:mainnetChain(state.evm.chainId),transport:http(mainnetRpc(state.evm.chainId),{retryCount:0})}),evmAccount=getAddress(epoch.evm.account);
 const [latest,pending]=await Promise.all([client.getTransactionCount({address:evmAccount,blockTag:'latest'}),client.getTransactionCount({address:evmAccount,blockTag:'pending'})]);if(state.evm.chainId===42161)assert.equal(latest,84);assert.equal(pending,latest);Object.assign(report,{evmChainId:state.evm.chainId,evmLatestNonce:latest,evmPendingNonce:pending});
 report.stage='held-forward-review';await walletB.navigateTo('/swap');
 const forward=await captureMainnetOneClickReviewQuote(walletB,{payNetwork:'miden',payAssetId:nativeAsset.assetId,receiveNetwork:evmAsset.blockchain,receiveAssetId:evmAsset.assetId,amount:fromBaseUnits(BigInt(state.principal),6),externalAddress:state.evm.account},{originAsset:nativeAsset.assetId,destinationAsset:evmAsset.assetId,amount:BigInt(state.principal),refundTo:state.account,recipient:state.evm.account});
 assert.ok(forward.quoteRequest.deadline);assertOneClickQuoteBinding({originAsset:nativeAsset,destinationAsset:evmAsset,amount:state.principal,refundTo:state.account,recipient:state.evm.account,deadline:forward.quoteRequest.deadline,slippageTolerance:100},forward,false,setup.config);assertOneClickFundingDeadline(forward.quoteRequest.deadline,forward.quote.deadline);
 await expect(walletB.page.getByTestId('one-click-minimum-row').locator('[title]')).toHaveAttribute('title',`${fromBaseUnits(BigInt(forward.quote.minAmountOut),evmAsset.decimals)} ${evmAsset.symbol}`);report.actualForwardReview=true;
 const returnAmount=BigInt(state.forwardMinimum);assert.ok(existing.balanceBaseUnits>=returnAmount);let attemptedTransactions=0;
 const counterparty=new WcCounterparty({privateKey:key,rpcUrl:mainnetRpc(state.evm.chainId),chainId:state.evm.chainId,sessionChainIds:Object.values(ONE_CLICK_EVM_CHAIN_IDS),send:async()=>{attemptedTransactions++;throw new Error('Read-only UI probe forbids every transaction');}});
 try{
  report.stage='held-return-walletconnect';await walletB.navigateTo('/swap');await walletB.page.reload({waitUntil:'domcontentloaded'});await expect(walletB.page.getByTestId('one-click-pay-network-picker')).toBeVisible({timeout:90000});
  const route={payNetwork:evmAsset.blockchain,payAssetId:evmAsset.assetId,receiveNetwork:'miden',receiveAssetId:nativeAsset.assetId,amount:fromBaseUnits(returnAmount,6)};await selectMainnetOneClickAssets(walletB.page,route);await connectMainnetOneClickWallet(walletB,counterparty);report.stage='held-return-review';
  const reverse=await captureMainnetOneClickReviewQuote(walletB,route,{originAsset:evmAsset.assetId,destinationAsset:nativeAsset.assetId,amount:returnAmount,refundTo:state.evm.account,recipient:state.account},true);assert.ok(reverse.quoteRequest.deadline);
  assertOneClickQuoteBinding({originAsset:evmAsset,destinationAsset:nativeAsset,amount:returnAmount.toString(),refundTo:state.evm.account,recipient:state.account,deadline:reverse.quoteRequest.deadline,slippageTolerance:100},reverse,false,setup.config);assertOneClickFundingDeadline(reverse.quoteRequest.deadline,reverse.quote.deadline);
  await expect(walletB.page.getByTestId('one-click-minimum-row').locator('[title]')).toHaveAttribute('title',`${fromBaseUnits(BigInt(reverse.quote.minAmountOut),nativeAsset.decimals)} ${nativeAsset.symbol}`);report.prospectiveReturnReview=true;
 }finally{await counterparty.stop();}
 assert.equal(attemptedTransactions,0);const after=await readMainnetEvmHolding(evmAsset,epoch.evm.account);assert.equal(after.balanceBaseUnits,existing.balanceBaseUnits);assert.equal(after.nativeBalanceWei,existing.nativeBalanceWei);assert.equal(await client.getTransactionCount({address:evmAccount,blockTag:'pending'}),pending);
 const keys=['e2e_mainnet_send_authorization','e2e_mainnet_consume_authorization'],policies=await walletB.page.evaluate(async names=>chrome.storage.local.get(names),keys);assert.ok(keys.every(key=>policies[key]===undefined));Object.assign(report,{portfoliosUnchanged:true,noLivePolicy:true});
 assert.equal(hash(readFileSync('test-results/final/roundtrip.json')),hash(raw));assert.equal(await vaultBalanceByFaucetId(walletB.page,faucet),balance);assert.ok(pairedFailureControls.length<=2);report.stage='discarded-native-and-evm-candidates-no-grant';
});
