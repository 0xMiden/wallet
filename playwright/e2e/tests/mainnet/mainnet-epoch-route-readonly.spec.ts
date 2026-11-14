import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {createPublicClient,erc20Abi,formatUnits,getAddress,http,parseUnits} from 'viem';
import {expect,test} from '../../fixtures/two-wallets';
import {loadMainnetEpochCheckpoint} from '../../helpers/mainnet-epoch-checkpoint';
import {restoreMainnetLoopGuardian} from '../../helpers/mainnet-loop-wallet';
import {vaultBalanceByFaucetId} from '../../helpers/balance-truth';
import {mainnetChain,mainnetRpc} from '../../helpers/mainnet-bridge-sources';
import {openRouteStep,waitForReviewSubmitEnabled} from '../../helpers/bridge';
import {readQuoteState,waitForFastQuote} from '../../helpers/epoch-quote';
import {evmChainSlug} from '../../../../src/lib/remote-config/chains';
import {readTransactionRowsWithBytes,plantQueueBlocker,releaseQueueBlocker,assertNeverStartedBuilding,openHistoryDetails,waitForTransactionRow,assertStaysCancelledWithQueueLive,TxStatus,USER_CANCELLED_REASON} from '../../helpers/history';
import {inspectEpochForwardQuote,inspectEpochCollateralRequest} from '../../helpers/mainnet-epoch-request';
import {readMainnetMidenBlock} from '../../helpers/mainnet-miden-read';
import {getEnvironmentConfig} from '../../config/environments';
import {epochReadOnlyProvider} from '../../helpers/mainnet-epoch-provider';

const path='test-results/mainnet-epoch-state/roundtrip.json';
const digest=()=>createHash('sha256').update(readFileSync(path)).digest('hex');
test.use({injectFeeFaucet:false});
test('original Epoch readonly balances and held cancelled preview; NEVER execute',async({walletB})=>{
 test.setTimeout(360000);
 const state=loadMainnetEpochCheckpoint(path)!;
 expect(state.sourceRunId).toBe('43619310746');expect(state.phase).toBe('forward-authorized');
 expect(state.forwardAuthority).toBeUndefined();expect(state.forwardNoteId).toBeUndefined();expect(state.forwardRequestAuthority).toBeUndefined();
 const before=digest(), result:Record<string,unknown>={purpose:'original Epoch read-only route diagnosis; held cancelled local preview, NEVER execute, persist grant or sign',sourceRunId:state.sourceRunId,checkpointUnchanged:false,balancesUnchanged:false,grantPersisted:false,sdkAuthorityIssued:false};
 let phase='restore';let restored=false;let heldRow:string|undefined;let blocker:string|undefined;
 const cancelHeld=async()=>{
  if(!heldRow)return;
  const row=(await readTransactionRowsWithBytes(walletB.page,'bridged-send')).find(row=>row.id===heldRow);
  if(!row)throw new Error('Missing held row');assertNeverStartedBuilding(row,'private readonly inspection',TxStatus.Queued);
  await openHistoryDetails(walletB,heldRow);await walletB.page.getByTestId('history-cancel-button').click();
  const failed=await waitForTransactionRow(walletB.page,heldRow,row=>row?.status===TxStatus.Failed,{what:'cancelled private readonly row',timeoutMs:60000});
  assertNeverStartedBuilding(failed,'private readonly cancellation',TxStatus.Failed);expect(failed.error).toBe(USER_CANCELLED_REASON);
  if(!blocker)throw new Error('Missing held queue');await releaseQueueBlocker(walletB.page,blocker);blocker=undefined;
  await assertStaysCancelledWithQueueLive(walletB.page,heldRow,USER_CANCELLED_REASON,{forMs:15000});heldRow=undefined;result.localPreviewCancelled=true;
 }; 
 const client=createPublicClient({chain:mainnetChain(state.evm.chainId),transport:http(mainnetRpc(state.evm.chainId),{retryCount:0})});
 const holdings=async()=>({gas:await client.getBalance({address:getAddress(state.evm.account)}),token:await client.readContract({address:getAddress(state.evm.token),abi:erc20Abi,functionName:'balanceOf',args:[getAddress(state.evm.account)]})});
 try{
  const key=process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR?.trim();if(!key)throw new Error('Missing original actor');
  await restoreMainnetLoopGuardian(walletB,key);restored=true;expect(await walletB.getAccountAddress()).toBe(state.account);
  phase='balances';result.nativeInitial=(await vaultBalanceByFaucetId(walletB.page,state.native.faucetId)).toString();
  const observed:string[]=[];await expect.poll(async()=>{const value=(await vaultBalanceByFaucetId(walletB.page,state.native.faucetId)).toString();if(observed.at(-1)!==value)observed.push(value);result.nativeObserved=observed;return value;},{timeout:30000}).toBe(state.native.balance);
  const h=await holdings();expect(h.gas).toBe(BigInt(state.evm.nativeBalance));expect(h.token).toBe(BigInt(state.evm.tokenBalance));
  phase='original-status';
  try{const provider=epochReadOnlyProvider(state.allocatorUrl,state.virtualChainId,state.evm.account);const status=await provider.sdk.getIntentStatus(provider.config,state.evm.account,state.forwardNonce);result.originalStatusArray=Array.isArray(status);if(Array.isArray(status))result.originalStatusCount=status.length;}catch{result.originalStatusArray=false;}
  const rows=await readTransactionRowsWithBytes(walletB.page,'bridged-send');const ids=rows.map(row=>row.id);
  phase='open-route';const id=evmChainSlug(state.evm.chainId);if(!id)throw new Error('Unknown original chain');
  await openRouteStep(walletB,{destAddress:state.evm.account,tokenSymbol:state.native.symbol,amount:formatUnits(BigInt(state.principal),6),network:{id,name:mainnetChain(state.evm.chainId).name}});
  phase='visible-quote';const quote=await waitForFastQuote(walletB.page,[],{timeoutMs:90000});
  result.quoteAmount=quote.amount;result.quoteSymbol=quote.symbol;result.minimum=state.forwardMinimum;
  if(!quote.amount||!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(quote.amount)||parseUnits(quote.amount,6)<BigInt(state.forwardMinimum))throw new Error('Visible quote below original floor');
  phase='select-fast';await walletB.page.getByTestId('bridge-route-fast').click();await walletB.page.getByTestId('bridge-route-confirm').click();
  phase='review-url';await walletB.page.waitForURL(/#\/send\/review\?/,{timeout:30000});
  phase='review-enabled';await waitForReviewSubmitEnabled(walletB.page,90000);
  result.reachedReview=true;
  phase='held-enqueue';blocker=await plantQueueBlocker(walletB.page);
  await walletB.page.getByTestId('send-review-submit').click();
  await expect.poll(async()=>{const fresh=(await readTransactionRowsWithBytes(walletB.page,'bridged-send')).filter(row=>!ids.includes(row.id));if(fresh.length>1)throw new Error('Ambiguous local preview');const row=fresh[0];if(!row)return false;assertNeverStartedBuilding(row,'private readonly queue',TxStatus.Queued);heldRow=row.id;return true;},{timeout:90000}).toBe(true);
  phase='held-inspect';const queued=(await readTransactionRowsWithBytes(walletB.page,'bridged-send')).find(row=>row.id===heldRow)!;
  if(!queued.requestBytes||!queued.extraInputs)throw new Error('Missing held collateral bytes');
  const service=state.allocatorUrl.replace(/\/+$/,'');const requests=await walletB.page.requests();
  const quoteRequest=requests.findLast(request=>request.url()===`${service}/checkIfDepositNeeded`);
  const nonceRequest=requests.findLast(request=>request.url().toLowerCase()===`${service}/suggested-nonce/${state.virtualChainId}/${state.evm.account}`.toLowerCase());
  const response=await nonceRequest?.response();if(!quoteRequest||!response?.ok())throw new Error('Missing readonly SDK binding');
  const body=await response.json();if(typeof body.nonce!=='string'||!/^(?:0x[0-9a-f]{1,64}|0|[1-9]\d{0,77})$/i.test(body.nonce))throw new Error('Invalid readonly nonce');
  // A discarded independent UI preview, NOT renewed original authority: the original checkpoint is never modified.
  const nonce=BigInt(body.nonce).toString();result.previewNonceMatchesOriginal=nonce===state.forwardNonce;
  const candidate={...state,forwardNonce:nonce};const currentBlock=await readMainnetMidenBlock(getEnvironmentConfig().rpcUrl);
  const binding=inspectEpochForwardQuote(candidate,quoteRequest.postDataJSON(),currentBlock,nonce);
  const inspected=inspectEpochCollateralRequest(candidate,Uint8Array.from(queued.requestBytes),{currentBlock,reclaimHeight:queued.extraInputs.reclaimHeight as number,bindingHash:binding.bindingHash});
  expect(inspected.noteId).toMatch(/^0x[0-9a-f]{64}$/);result.actualCollateralInspected=true;
  phase='held-cancel';await cancelHeld();
  // The queue never builds; no policy is armed, no signing/ACK/release into execution, no grant saved.
  phase='complete';
 }catch(error){
  result.blockedAt=phase;
  result.errorClass=error instanceof Error&&/^[A-Za-z]+Error$/.test(error.name)?error.name:'Error';
  const frame=error instanceof Error?error.stack?.split('\n').find(line=>/\/(?:mainnet-epoch|bridge|epoch-quote)[^ ]*:\d+:\d+/.test(line)):undefined;
  if(frame)result.sourceLocation=frame.match(/(?:mainnet-epoch|bridge|epoch-quote)[^ ]*:\d+:\d+/)?.[0];
  const quote=restored?await readQuoteState(walletB.page).catch(()=>undefined):undefined;
  if(quote){result.quoteEnabled=quote.enabled;result.quoteLoading=quote.loading;result.hasToken=quote.hasToken;result.hasAmount=quote.hasAmount;result.quoteErrored=!!quote.error;result.quoteAmount=quote.amount;result.quoteSymbol=quote.symbol;}
 }finally{
  if(heldRow){try{await cancelHeld();}catch{result.localPreviewCancelled=false;}}
  result.checkpointUnchanged=digest()===before;
  if(restored){const h=await holdings();result.balancesUnchanged=(await vaultBalanceByFaucetId(walletB.page,state.native.faucetId))===BigInt(state.native.balance)&&h.gas===BigInt(state.evm.nativeBalance)&&h.token===BigInt(state.evm.tokenBalance);}
  result.lastPhase=phase;writeFileSync('test-results/epoch-route-readonly-result.json',JSON.stringify(result));
 }
 expect(result.checkpointUnchanged).toBe(true);expect(result.balancesUnchanged).toBe(true);expect(result.reachedReview).toBe(true);expect(result.actualCollateralInspected).toBe(true);expect(result.localPreviewCancelled).toBe(true);
});
