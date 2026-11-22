import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, encodeFunctionData, http, isAddressEqual, parseAbi, parseEventLogs } from 'viem';
import { loadMainnetEpochCheckpoint, saveMainnetEpochCheckpoint } from '../node_modules/.cache/nightly-epoch-checkpoint.mjs';

const [source, custodyPath, dest, report] = process.argv.slice(2);
const bytes = readFileSync(source);
const sha256 = input => createHash('sha256').update(input).digest('hex');
const digest = sha256(bytes);
assert.equal(digest, 'feb25d31e256bc7b94ac73ba2e0a539e3ab1143250174f74b430c919db186ad4');
const original = loadMainnetEpochCheckpoint(source);
assert.deepEqual(original, JSON.parse(bytes));
assert.equal(original.sourceRunId, '44985161986');
assert.equal(original.phase, 'recovery-required');
for (const k of ['consumeAuthority', 'returnNoteId', 'returnMidenTxId']) assert.equal(original[k], undefined);
const miden = JSON.parse(readFileSync(custodyPath));
assert.equal(miden.custodyMatches, true);
assert.equal(miden.epochNativeFee, original.paidMidenFees);
assert.equal(miden.epochNativeFee, '133');
assert.equal(miden.swapCostUsdMicros, '968');
assert.equal(BigInt(miden.midenBalance), BigInt(original.native.balance) - BigInt(original.principal) - 133n);
const { account, token, compact } = original.evm;
const lock = (BigInt(original.reverseAuthority.lockTag) << 160n) | BigInt(token);
const returned = 981231n;
assert.equal(BigInt(original.returnAmount), returned);
const abi = parseAbi(['function enableForcedWithdrawal(uint256) returns (uint256)', 'function forcedWithdrawal(uint256,address,uint256) returns (bool)', 'function disableForcedWithdrawal(uint256) returns (bool)', 'function balanceOf(address,uint256) view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'function getForcedWithdrawalStatus(address,uint256) view returns (uint8,uint256)', 'event Transfer(address indexed from,address indexed to,uint256 value)']);
const expected = [
  ...original.transactions.map((tx, i) => ({ ...tx, block: [26468310n, 26468327n][i], to: i === 0 ? token : compact })),
  ...[
    ['0x82fc36c2a72a3611302e09f4cfa9b1e687b3874f9fd291135dcd8ed52e33682b', 26471643n, '7391017565864', 'enableForcedWithdrawal', [lock]],
    ['0x3ab152cd888e0501aa9d102e029f6f4aa446a17ab18e8b586b1297a0685ac00d', 26471997n, '7384566788600', 'forcedWithdrawal', [lock, account, returned]],
    ['0x26ef7220363230a143ff3cf8a04b139ff42a1fbf03744d132e27559a4b9346cb', 26472184n, '2897212582340', 'disableForcedWithdrawal', [lock]]
  ].map(([hash, block, feeWei, functionName, args], i) => ({hash, block, feeWei, nonce: 122 + i, to: compact, data: encodeFunctionData({abi, functionName, args})}))
];
assert.deepEqual(expected.map(tx => tx.nonce), [120, 121, 122, 123, 124]);
assert.equal(new URL(original.allocatorUrl).origin, 'https://mainnet-api.epochprotocol.xyz');
const intent = await fetch(`${original.allocatorUrl.replace(/\/$/, '')}/intentStatus/${encodeURIComponent(account)}/${encodeURIComponent(original.reverseNonce)}`, { redirect: 'error', signal: AbortSignal.timeout(12000) });
assert.ok(intent.ok);
assert.deepEqual(await intent.json(), []);
const views = await Promise.all(['https://eth.drpc.org','https://ethereum-rpc.publicnode.com'].map(async url => {
  const rpc = createPublicClient({transport:http(url,{retryCount:0,timeout:12000})});
  assert.equal(await rpc.getChainId(), 1);
  const finalized = await rpc.getBlock({blockTag:'finalized'});
  const hashes = await Promise.all(expected.map(async row => {
    const [receipt, tx, block] = await Promise.all([rpc.getTransactionReceipt({hash:row.hash}), rpc.getTransaction({hash:row.hash}),rpc.getBlock({blockNumber:row.block})]);
    assert.ok(block.number <= finalized.number && receipt.blockNumber === block.number && receipt.blockHash === block.hash && tx.blockHash === block.hash);
    assert.equal(receipt.status, 'success'); assert.equal(tx.nonce, row.nonce); assert.equal(tx.value, 0n);
    assert.ok(isAddressEqual(tx.from, account) && isAddressEqual(tx.to, row.to));
    if (row.data) assert.equal(tx.input, row.data);
    assert.equal(receipt.gasUsed * receipt.effectiveGasPrice, BigInt(row.feeWei));
    if (row.nonce === 121 || row.nonce === 123) {
      const [from,to] = row.nonce === 121 ? [account,compact] : [compact,account];
      const matches = parseEventLogs({abi,eventName:'Transfer',logs:receipt.logs}).filter(l => isAddressEqual(l.address,token) && isAddressEqual(l.args.from,from) && isAddressEqual(l.args.to,to));
      assert.equal(matches.length,1); assert.equal(matches[0].args.value,returned);
    }
    return block.hash;
  }));
  const custodyAt = async blockNumber => {
    const base = { abi, address: compact, blockNumber, args: [account, lock] };
    const [balance, timer, nonce, evmNative, evmToken] = await Promise.all([
      rpc.readContract({...base,functionName:'balanceOf'}), rpc.readContract({...base,functionName:'getForcedWithdrawalStatus'}),
      rpc.getTransactionCount({address:account,blockNumber}), rpc.getBalance({address:account,blockNumber}),
      rpc.readContract({address:token,abi,functionName:'balanceOf',args:[account],blockNumber})
    ]);
    assert.equal(balance,0n); assert.deepEqual(timer,[0,0n]); assert.equal(nonce,125);
    return {evmNative:String(evmNative),evmToken:String(evmToken)};
  };
  assert.equal(await rpc.getTransactionCount({address:account,blockTag:'pending'}),125);
  const after = await custodyAt(finalized.number);
  assert.deepEqual(await custodyAt(await rpc.getBlockNumber()),after);
  return {hashes,after};
}));
assert.deepEqual(views[0],views[1]);
const ceil = (n,d) => (n+d-1n)/d;
const originalGas = expected.slice(0,2).reduce((sum,r) => sum+BigInt(r.feeWei),0n);
const recoveryGas = expected.slice(2).reduce((sum,r) => sum+BigInt(r.feeWei),0n);
assert.equal(originalGas,BigInt(original.paidEvmFees));
// Charge gross principal difference and fees; do not credit the USDC left in the payer.
const stableCost = ceil((BigInt(original.principal)-returned+133n)*BigInt(original.native.usdMicros),10n**6n);
const gasCost = ceil(originalGas*BigInt(original.evm.nativeUsdMicros),10n**18n) + ceil(recoveryGas*1662490000n,10n**18n);
const cost = stableCost + gasCost;
assert.ok(cost > 0n && cost <= 1510431n);
const updatedAt = new Date().toISOString();
assert.ok(Date.parse(updatedAt) > Date.parse(original.updatedAt));
const after = {native:miden.midenBalance,...views[0].after};
const next = {...original,after,updatedAt,phase:'cancelled',realizedCostUsdMicros:String(cost)};
saveMainnetEpochCheckpoint(dest,next);
assert.deepEqual(loadMainnetEpochCheckpoint(dest),next);
const changes = Object.keys(next).filter(key => JSON.stringify(next[key]) !== JSON.stringify(original[key])).sort();
assert.deepEqual(changes,['after','phase','realizedCostUsdMicros','updatedAt']);
assert.equal(sha256(readFileSync(source)),digest);
writeFileSync(report, JSON.stringify({originalDigest:digest, retiredDigest:sha256(readFileSync(dest)), epochCostUsdMicros:String(cost), principalReturned:String(returned), stableCost:String(stableCost), gasCost:String(gasCost), verifiedReceipts:5, rpcCount:2, noSpend:true})+'\n',{flag:'wx'});
