import { decodeFunctionData, parseAbi, decodeAbiParameters } from 'viem';
const hash='0xc06d998f7442e24f4a2ee3197f49ee34ebaf2871a381ca106ec4876265c0a416';
const abi=parseAbi(['function depositForBurnWithHookAndFees(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller,bytes hookData,(bytes signedQuote,address refundAddress) claim) payable']);
const log=x=>console.log(JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v));
for(const url of ['https://ethereum.publicnode.com','https://eth.drpc.org']) {
 const rpc=async(method,params)=>{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(18000)});const d=await r.json();if(d.error)throw d.error;return d.result;};
 const safe=async(method,params)=>{try{return await rpc(method,params)}catch(error){return {error}}};
 try{
  const tx=await rpc('eth_getTransactionByHash',[hash]);const receipt=await rpc('eth_getTransactionReceipt',[hash]);
  const block=await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);
  log({url,tx,receipt,block:{number:block.number,timestamp:block.timestamp}});
  const decoded=decodeFunctionData({abi,data:tx.input});log({url,decoded});
  const token=decoded.args[3],owner=tx.from.slice(2).padStart(64,'0'),spender=tx.to.slice(2).padStart(64,'0');
  for(const tag of ['0x'+(BigInt(receipt.blockNumber)-1n).toString(16),receipt.blockNumber]){
   log({url,tag,balance:await safe('eth_call',[{to:token,data:'0x70a08231'+owner},tag]),allowance:await safe('eth_call',[{to:token,data:'0xdd62ed3e'+owner+spender},tag]),replayOriginalGas:await safe('eth_call',[{from:tx.from,to:tx.to,data:tx.input,value:tx.value,gas:tx.gas},tag]),replayHighGas:await safe('eth_call',[{from:tx.from,to:tx.to,data:tx.input,value:tx.value,gas:'0x989680'},tag]),estimate:await safe('eth_estimateGas',[{from:tx.from,to:tx.to,data:tx.input,value:tx.value},tag])});
  }
  log({url,trace:await safe('debug_traceTransaction',[hash,{tracer:'callTracer',timeout:'10s'}])});
 }catch(error){log({url,error})}
}
