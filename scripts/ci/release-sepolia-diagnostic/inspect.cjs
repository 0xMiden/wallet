const fs = require('fs');
const {createPublicClient,http,parseAbi,pad,keccak256} = require('viem');
const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const event = parseAbi(['event AttestationUsed(address indexed token, address indexed recipient, bytes32 indexed transferSpecHash, uint32 sourceDomain, bytes32 sourceDepositor, bytes32 sourceSigner, uint256 value)']);
const tokenAbi = parseAbi(['function balanceOf(address) view returns(uint256)']);
(async()=>{
 for (const endpoint of input.endpoints) {
  const client=createPublicClient({transport:http(endpoint,{retryCount:0,timeout:20000})});
  try {
   if(await client.getChainId()!==input.chainId)throw Error('wrong chain');
   const logs=await client.getLogs({address:input.minter,event:event[0],args:{token:input.token,recipient:input.recipient},fromBlock:BigInt(input.fromBlock+1),toBlock:BigInt(input.toBlock),strict:true});
   const before=await client.readContract({address:input.token,abi:tokenAbi,functionName:'balanceOf',args:[input.recipient],blockNumber:BigInt(input.fromBlock)});
   const after=await client.readContract({address:input.token,abi:tokenAbi,functionName:'balanceOf',args:[input.recipient],blockNumber:BigInt(input.toBlock)});
   const report={endpoint:new URL(endpoint).hostname,logCount:logs.length,before:String(before),after:String(after),delta:String(after-before),logs:[]};
   for(const log of logs){
    const tx=await client.getTransaction({hash:log.transactionHash});
    const receipt=await client.getTransactionReceipt({hash:log.transactionHash});
    const block=await client.getBlock({blockNumber:log.blockNumber});
    report.logs.push({transactionHash:log.transactionHash,blockNumber:String(log.blockNumber),timestamp:String(block.timestamp),status:receipt.status,toMinter:tx.to.toLowerCase()===input.minter.toLowerCase(),sourceDomain:log.args.sourceDomain,sourceDepositor:log.args.sourceDepositor,transferSpecHash:log.args.transferSpecHash,value:String(log.args.value),fee:String(BigInt(input.burnUnits)-log.args.value),equalsDelta:log.args.value===after-before,burnNoteInCalldata:tx.input.toLowerCase().includes(input.burnNoteId.slice(2).toLowerCase()),inputHash:keccak256(tx.input),savedFeeExceeded:BigInt(input.burnUnits)-log.args.value>BigInt(input.savedFeeAllowance)});
   }
   console.log(JSON.stringify(report));
  }catch(error){console.log(JSON.stringify({endpoint:new URL(endpoint).hostname,error:error.shortMessage||error.message}));process.exitCode=1;}
 }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
