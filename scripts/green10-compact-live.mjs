import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createPublicClient, http, parseAbi, encodeFunctionData, parseEventLogs, isAddressEqual } from 'viem';
import { assertGreen10ActivationReadiness } from './green10-compact-readiness.mjs';

export async function inspectGreen10Activation(checkpoint, remainingUsdMicros) {
const bytes = readFileSync(checkpoint);
const sha256 = createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256, 'feb25d31e256bc7b94ac73ba2e0a539e3ab1143250174f74b430c919db186ad4');
const state = JSON.parse(bytes);
const { account, compact, token, allocator } = state.evm;
const id = (BigInt(state.reverseAuthority.lockTag) << 160n) | BigInt(token);
const deposit = state.transactions.find(row => row.kind === 'deposit');
assert.equal(deposit.nonce, 121);
const abi = parseAbi([
  'function balanceOf(address,uint256) view returns (uint256)',
  'function getForcedWithdrawalStatus(address,uint256) view returns (uint8,uint256)',
  'function getLockDetails(uint256) view returns (address,address,uint8,uint8,bytes12)',
  'function enableForcedWithdrawal(uint256) returns (uint256)',
  'event Transfer(address indexed from,address indexed to,uint256 value)'
]);
const data = encodeFunctionData({ abi, functionName: 'enableForcedWithdrawal', args: [id] });
async function get(url) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(12000) });
  assert.ok(response.ok, `Read-only request failed: ${response.status}`);
  return response.json();
}
assert.equal(new URL(state.allocatorUrl).origin, 'https://mainnet-api.epochprotocol.xyz');
const [legs, price, ...views] = await Promise.all([
  get(`${state.allocatorUrl.replace(/\/$/, '')}/intentStatus/${encodeURIComponent(account)}/${encodeURIComponent(state.reverseNonce)}`),
  get('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd&include_last_updated_at=true'),
  ...['https://eth.drpc.org', 'https://ethereum-rpc.publicnode.com'].map(async url => {
    const client = createPublicClient({ transport: http(url, { retryCount: 0, timeout: 12000 }) });
    const [chainId, latest, finalizedBlock, receipt, tx, pendingNonce, fees] = await Promise.all([
      client.getChainId(), client.getBlock({ blockTag: 'latest' }), client.getBlock({ blockTag: 'finalized' }),
      client.getTransactionReceipt({ hash: deposit.hash }), client.getTransaction({ hash: deposit.hash }),
      client.getTransactionCount({ address: account, blockTag: 'pending' }), client.estimateFeesPerGas()
    ]);
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    const transfer = parseEventLogs({ abi, eventName: 'Transfer', logs: receipt.logs }).filter(log =>
      isAddressEqual(log.address, token) && isAddressEqual(log.args.from, account) && isAddressEqual(log.args.to, compact));
    const depositMatches = receipt.status === 'success' && block.hash === receipt.blockHash && tx.nonce === 121 &&
      isAddressEqual(tx.from, account) && isAddressEqual(tx.to, compact) && transfer.length === 1 &&
      transfer[0].args.value === 981231n && receipt.gasUsed * receipt.effectiveGasPrice === BigInt(deposit.feeWei);
    const base = { address: compact, abi };
    const [views, gas, sim, ownerGasWei] = await Promise.all([
      Promise.all([latest, finalizedBlock].map(async ({ number: blockNumber }) => Promise.all([
        client.readContract({ ...base, blockNumber, functionName: 'balanceOf', args: [account, id] }),
        client.readContract({ ...base, blockNumber, functionName: 'getForcedWithdrawalStatus', args: [account, id] }),
        client.readContract({ ...base, blockNumber, functionName: 'getLockDetails', args: [id] }),
        client.getTransactionCount({ address: account, blockNumber })
      ]))),
      client.estimateGas({ account, to: compact, data, value: 0n }),
      client.simulateContract({ ...base, account, blockNumber: latest.number, functionName: 'enableForcedWithdrawal', args: [id] }),
      client.getBalance({ address: account, blockNumber: latest.number })
    ]);
    for (const [balance, [status, at], [asset, manager, reset, scope, tag], nonce] of views) {
      assert.equal(balance, 981231n); assert.equal(status, 0); assert.equal(at, 0n); assert.equal(nonce, 122);
      assert.ok(isAddressEqual(asset, token) && isAddressEqual(manager, allocator));
      assert.equal(reset, 4); assert.equal(scope, 0); assert.equal(tag, state.reverseAuthority.lockTag);
    }
    assert.equal(pendingNonce, 122);
    return { chainId, finalized: receipt.blockNumber <= finalizedBlock.number, depositMatches, lockMatches: true,
      held: 981231n, status: 0, withdrawableAt: 0n, nonce: pendingNonce, ownerGasWei, gas,
      maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, timestamp: latest.timestamp, baseFeePerGas: latest.baseFeePerGas, simulatedAt: latest.timestamp, simulatedMaturity: sim.result };
  })
]);
const now = Date.now();
const updatedAt = price.ethereum?.last_updated_at * 1000;
assert.ok(Number.isSafeInteger(updatedAt) && updatedAt >= now - 300000 && updatedAt <= now + 30000);
const currentPrice = Math.ceil(price.ethereum.usd * 1_000_000);
assert.ok(Number.isSafeInteger(currentPrice) && currentPrice > 0);
const priceUsdMicros = BigInt(Math.max(currentPrice, 1_662_490_000));
assertGreen10ActivationReadiness({ legs, views, priceUsdMicros, remainingUsdMicros });
const max = values => values.reduce((a, b) => a > b ? a : b);
const gas = max(views.map(v => v.gas));
const maxFeePerGas = max(views.map(v => v.maxFeePerGas));
const maxPriorityFeePerGas = max(views.map(v => v.maxPriorityFeePerGas));
assert.ok(typeof maxPriorityFeePerGas === 'bigint' && maxPriorityFeePerGas >= 0n && maxPriorityFeePerGas <= maxFeePerGas);
const bound = assertGreen10ActivationReadiness({ legs, views: views.map(v => ({ ...v, gas, maxFeePerGas })), priceUsdMicros, remainingUsdMicros });
return { account, sha256, priceUsdMicros, bound, views, transaction: { type: 'eip1559', chainId: 1, nonce: 122, to: compact, data, value: 0n, gas, maxFeePerGas, maxPriorityFeePerGas } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { sha256, bound } = await inspectGreen10Activation(process.argv[2], BigInt(process.argv[3]));
  console.log(JSON.stringify({ sha256, rpcCount: 2, heldBaseUnits: '981231', nonce: 122,
    activationSimulationPassed: true, estimatedCostCeilingUsdMicros: String(bound), signed: false, broadcast: false }));
}
