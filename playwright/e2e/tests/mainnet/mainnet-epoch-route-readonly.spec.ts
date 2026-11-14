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
import {readTransactionRowsWithBytes} from '../../helpers/history';

const path='test-results/mainnet-epoch-state/roundtrip.json';
const digest=()=>createHash('sha256').update(readFileSync(path)).digest('hex');
test.use({injectFeeFaucet:false});
test('original Epoch readonly balances and route preview; NEVER submit',async({walletB})=>{
 test.setTimeout(360000);
 const state=loadMainnetEpochCheckpoint(path)!;
 expect(state.sourceRunId).toBe('43619310746');expect(state.phase).toBe('forward-authorized');
 expect(state.forwardAuthority).toBeUndefined();expect(state.forwardNoteId).toBeUndefined();expect(state.forwardRequestAuthority).toBeUndefined();
 const before=digest(), result:Record<string,unknown>={purpose:'original Epoch read-only route diagnosis; NEVER submit, persist grant or sign',sourceRunId:state.sourceRunId,checkpointUnchanged:false,balancesUnchanged:false,grantPersisted:false,sdkAuthorityIssued:false};
 let phase='restore';let restored=false;
 const client=createPublicClient({chain:mainnetChain(state.evm.chainId),transport:http(mainnetRpc(state.evm.chainId),{retryCount:0})});
 const holdings=async()=>({gas:await client.getBalance({address:getAddress(state.evm.account)}),token:await client.readContract({address:getAddress(state.evm.token),abi:erc20Abi,functionName:'balanceOf',args:[getAddress(state.evm.account)]})});
 try{
  const key=process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR?.trim();if(!key)throw new Error('Missing original actor');
  await restoreMainnetLoopGuardian(walletB,key);restored=true;expect(await walletB.getAccountAddress()).toBe(state.account);
  phase='balances';expect(await vaultBalanceByFaucetId(walletB.page,state.native.faucetId)).toBe(BigInt(state.native.balance));
  const h=await holdings();expect(h.gas).toBe(BigInt(state.evm.nativeBalance));expect(h.token).toBe(BigInt(state.evm.tokenBalance));
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
  // No submit/enqueue, signatures, native request preparation, policy arming, ACK or authority persistence.
  expect((await readTransactionRowsWithBytes(walletB.page,'bridged-send')).map(row=>row.id)).toEqual(ids);
  phase='complete';
 }catch(error){
  result.blockedAt=phase;
  result.errorClass=error instanceof Error&&/^[A-Za-z]+Error$/.test(error.name)?error.name:'Error';
  const frame=error instanceof Error?error.stack?.split('\n').find(line=>/\/(?:mainnet-epoch|bridge|epoch-quote)[^ ]*:\d+:\d+/.test(line)):undefined;
  if(frame)result.sourceLocation=frame.match(/(?:mainnet-epoch|bridge|epoch-quote)[^ ]*:\d+:\d+/)?.[0];
  const quote=restored?await readQuoteState(walletB.page).catch(()=>undefined):undefined;
  if(quote){result.quoteEnabled=quote.enabled;result.quoteLoading=quote.loading;result.hasToken=quote.hasToken;result.hasAmount=quote.hasAmount;result.quoteErrored=!!quote.error;result.quoteAmount=quote.amount;result.quoteSymbol=quote.symbol;}
 }finally{
  result.checkpointUnchanged=digest()===before;
  if(restored){const h=await holdings();result.balancesUnchanged=(await vaultBalanceByFaucetId(walletB.page,state.native.faucetId))===BigInt(state.native.balance)&&h.gas===BigInt(state.evm.nativeBalance)&&h.token===BigInt(state.evm.tokenBalance);}
  result.lastPhase=phase;writeFileSync('test-results/epoch-route-readonly-result.json',JSON.stringify(result));
 }
 expect(result.checkpointUnchanged).toBe(true);expect(result.balancesUnchanged).toBe(true);expect(result.reachedReview).toBe(true);
});
