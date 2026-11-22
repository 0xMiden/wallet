import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createPublicClient, encodeFunctionData, http, isAddressEqual, parseAbi, parseEventLogs } from 'viem';

const maturity = 1795366283n;
const activation = '0x82fc36c2a72a3611302e09f4cfa9b1e687b3874f9fd291135dcd8ed52e33682b';
const abi = parseAbi([
  'function forcedWithdrawal(uint256,address,uint256) returns (bool)',
  'function enableForcedWithdrawal(uint256) returns (uint256)',
  'function disableForcedWithdrawal(uint256) returns (bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'function getForcedWithdrawalStatus(address,uint256) view returns (uint8,uint256)',
  'function balanceOf(address,uint256) view returns (uint256)',
  'event ForcedWithdrawalStatusUpdated(address indexed account,uint256 indexed id,bool activating,uint256 withdrawableAt)'
]);

export function green10WithdrawalIntent({ owner, compact, lock, views }) {
  assert.equal(views.length, 2);
  for (const view of views) {
    assert.ok(view.finalized === true && view.status === 2 && view.maturity === maturity && view.timestamp >= view.maturity,
      'Original activation must be finalized and mature on both RPCs');
    assert.ok(view.held === 981231n && view.nonce === 123, 'Original lock or owner nonce changed');
  }
  return { to: compact, data: encodeFunctionData({ abi, functionName: 'forcedWithdrawal', args: [lock, owner, 981231n] }),
    value: 0n, chainId: 1, nonce: 123, type: 'eip1559' };
}

export function green10CleanupIntent({ owner, compact, lock, views }) {
  assert.equal(views.length, 2);
  assert.ok(views.every(v => v.finalized === true && v.status === 2 && v.maturity === maturity && v.held === 0n && v.nonce === 124));
  return { to: compact, data: encodeFunctionData({ abi, functionName: 'disableForcedWithdrawal', args: [lock] }),
    value: 0n, chainId: 1, nonce: 124, type: 'eip1559' };
}

function withdrawalBound(tx, price, views) {
  assert.equal(views.length, 2);
  assert.ok(tx.gas > 0n && tx.maxFeePerGas > 0n && tx.maxPriorityFeePerGas >= 0n && tx.maxPriorityFeePerGas <= tx.maxFeePerGas);
  assert.ok(views.every(view => typeof view.baseFeePerGas === 'bigint' && view.baseFeePerGas >= 0n &&
    view.baseFeePerGas + tx.maxPriorityFeePerGas <= tx.maxFeePerGas && view.gasBalance >= tx.gas * tx.maxFeePerGas));
  const bound = (tx.gas * tx.maxFeePerGas * price + 10n ** 18n - 1n) / 10n ** 18n;
  // Preserve room for the original Epoch principal, original receipts, and owner cleanup.
  assert.ok(bound > 0n && bound <= 100_000n && bound + 1_300_000n <= 1_510_431n);
  return bound;
}

export function assertGreen10WithdrawalUnchanged(first, fresh) {
  assert.equal(fresh.ready, true);
  assert.equal(fresh.sha256, first.sha256);
  assert.equal(fresh.account, first.account);
  const tx = first.transaction;
  for (const key of ['type', 'chainId', 'nonce', 'to', 'data', 'value']) assert.equal(fresh.transaction[key], tx[key]);
  assert.ok(fresh.transaction.gas <= tx.gas, 'Frozen withdrawal gas no longer sufficient');
  return withdrawalBound(tx, fresh.priceUsdMicros, fresh.feeViews);
}

export async function inspectGreen10Withdrawal(checkpoint, stage = 'withdraw') {
  assert.ok(stage === 'withdraw' || stage === 'disable');
  const cleanup = stage === 'disable';
  const expectedHeld = cleanup ? 0n : 981231n;
  const expectedNonce = cleanup ? 124 : 123;
  const bytes = readFileSync(checkpoint);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha256, 'feb25d31e256bc7b94ac73ba2e0a539e3ab1143250174f74b430c919db186ad4');
  const state = JSON.parse(bytes);
  const { account: owner, compact, token } = state.evm;
  const lock = (BigInt(state.reverseAuthority.lockTag) << 160n) | BigInt(token);
  const base = { address: compact, abi };
  assert.equal(new URL(state.allocatorUrl).origin, 'https://mainnet-api.epochprotocol.xyz');
  const allocator = await fetch(`${state.allocatorUrl.replace(/\/$/, '')}/intentStatus/${encodeURIComponent(owner)}/${encodeURIComponent(state.reverseNonce)}`, {
    redirect: 'error', signal: AbortSignal.timeout(12000)
  });
  assert.ok(allocator.ok);
  assert.deepEqual(await allocator.json(), []);
  const clients = ['https://eth.drpc.org', 'https://ethereum-rpc.publicnode.com'].map(url =>
    createPublicClient({ transport: http(url, { retryCount: 0, timeout: 12000 }) }));
  const views = await Promise.all(clients.map(async client => {
    const [chain, tx, receipt, block, latest, finalized, pendingNonce] = await Promise.all([
      client.getChainId(), client.getTransaction({ hash: activation }), client.getTransactionReceipt({ hash: activation }),
      client.getBlock({ blockNumber: 26471643n }), client.getBlock({ blockTag: 'latest' }), client.getBlock({ blockTag: 'finalized' }),
      client.getTransactionCount({ address: owner, blockTag: 'pending' })
    ]);
    assert.equal(chain, 1);
    assert.equal(receipt.status, 'success');
    assert.equal(block.hash, '0x5126374405061966d479c9e35dad368c7b86da15adc4f05d40842fb7fd98e785');
    assert.equal(receipt.blockHash, block.hash);
    assert.equal(tx.blockHash, block.hash);
    assert.equal(tx.nonce, 122);
    assert.ok(isAddressEqual(tx.from, owner) && isAddressEqual(tx.to, compact));
    assert.equal(tx.input, encodeFunctionData({ abi, functionName: 'enableForcedWithdrawal', args: [lock] }));
    assert.equal(tx.value, 0n);
    assert.equal(receipt.gasUsed * receipt.effectiveGasPrice, 7391017565864n);
    const logs = parseEventLogs({ abi, eventName: 'ForcedWithdrawalStatusUpdated', logs: receipt.logs }).filter(log => isAddressEqual(log.address, compact));
    assert.equal(logs.length, 1);
    assert.ok(isAddressEqual(logs[0].args.account, owner));
    assert.equal(logs[0].args.id, lock);
    assert.equal(logs[0].args.activating, true);
    assert.equal(logs[0].args.withdrawableAt, maturity);
    assert.equal(block.timestamp + 3900n, maturity);
    const custody = async ({ number: blockNumber, timestamp }) => {
      const args = [owner, lock];
      const [[status, at], held, nonce] = await Promise.all([
        client.readContract({ ...base, blockNumber, args, functionName: 'getForcedWithdrawalStatus' }),
        client.readContract({ ...base, blockNumber, args, functionName: 'balanceOf' }),
        client.getTransactionCount({ address: owner, blockNumber })
      ]);
      assert.equal(held, expectedHeld);
      assert.equal(nonce, expectedNonce);
      assert.equal(at, maturity);
      assert.equal(status, timestamp >= maturity ? 2 : 1);
      return { status, maturity: at, held, nonce, timestamp };
    };
    assert.equal(pendingNonce, expectedNonce);
    if (cleanup) {
      const hash = '0x3ab152cd888e0501aa9d102e029f6f4aa446a17ab18e8b586b1297a0685ac00d';
      const [withdraw, result, canonical] = await Promise.all([
        client.getTransaction({ hash }), client.getTransactionReceipt({ hash }), client.getBlock({ blockNumber: 26471997n })
      ]);
      assert.equal(canonical.hash, '0x2f790b313de9c87f233dfa854f3181e64cb3c4f3ce37c542b9a9a92bf420ecee');
      assert.ok(withdraw.blockHash === canonical.hash && result.blockHash === canonical.hash && result.status === 'success');
      assert.ok(withdraw.nonce === 123 && withdraw.value === 0n && isAddressEqual(withdraw.from, owner) && isAddressEqual(withdraw.to, compact));
      assert.equal(withdraw.input, encodeFunctionData({ abi, functionName: 'forcedWithdrawal', args: [lock, owner, 981231n] }));
      assert.equal(result.gasUsed * result.effectiveGasPrice, 7384566788600n);
      const transfers = parseEventLogs({ abi, eventName: 'Transfer', logs: result.logs }).filter(log => isAddressEqual(log.address, token));
      assert.equal(transfers.length, 1);
      assert.ok(isAddressEqual(transfers[0].args.from, compact) && isAddressEqual(transfers[0].args.to, owner) && transfers[0].args.value === 981231n);
    }
    const isFinalized = finalized.number >= (cleanup ? 26471997n : block.number);
    const [live] = await Promise.all([custody(latest), isFinalized && custody(finalized)]);
    return { ...live, finalized: isFinalized };
  }));
  const ready = views.every(view => view.finalized && view.status === 2);
  const status = { sha256, ready, finalized: views.every(view => view.finalized), maturity: String(maturity), heldBaseUnits: String(expectedHeld), nonce: expectedNonce };
  if (!ready) return status;
  const intent = (cleanup ? green10CleanupIntent : green10WithdrawalIntent)({ owner, compact, lock, views });
  const call = cleanup ? { functionName: 'disableForcedWithdrawal', args: [lock] } : { functionName: 'forcedWithdrawal', args: [lock, owner, 981231n] };
  const feeViews = await Promise.all(clients.map(async client => {
    const [gas, fees, sim, gasBalance, block] = await Promise.all([
      client.estimateGas({ account: owner, to: compact, data: intent.data, value: 0n }),
      client.estimateFeesPerGas(),
      client.simulateContract({ ...base, account: owner, ...call }),
      client.getBalance({ address: owner }), client.getBlock({ blockTag: 'latest' })
    ]);
    assert.equal(sim.result, true);
    return { gas, gasBalance, ...fees, baseFeePerGas: block.baseFeePerGas };
  }));
  const prices = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd&include_last_updated_at=true', { redirect: 'error', signal: AbortSignal.timeout(12000) });
  assert.ok(prices.ok);
  const { ethereum } = await prices.json();
  const now = Date.now();
  const updatedAt = ethereum.last_updated_at * 1000;
  const price = Math.ceil(ethereum.usd * 1_000_000);
  assert.ok(Number.isSafeInteger(updatedAt) && updatedAt >= now - 300000 && updatedAt <= now + 30000);
  assert.ok(Number.isSafeInteger(price) && price > 0);
  const priceUsdMicros = BigInt(Math.max(price, 1_662_490_000));
  const max = key => feeViews.map(view => view[key]).reduce((a, b) => a > b ? a : b);
  const gas = max('gas'), maxFeePerGas = max('maxFeePerGas'), maxPriorityFeePerGas = max('maxPriorityFeePerGas');
  const transaction = { ...intent, gas, maxFeePerGas, maxPriorityFeePerGas };
  const bound = withdrawalBound(transaction, priceUsdMicros, feeViews);
  return { ...status, account: owner, transaction, bound, priceUsdMicros, feeViews };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { sha256, ready, finalized, maturity, heldBaseUnits, nonce, bound } = await inspectGreen10Withdrawal(process.argv[2], process.argv[3]);
    console.log(JSON.stringify({ sha256, ready, finalized, maturity, heldBaseUnits, nonce,
      estimatedCostCeilingUsdMicros: bound?.toString(), signed: false, broadcast: false }));
  } catch {
    console.error('Read-only withdrawal custody did not qualify.');
    process.exitCode = 1;
  }
}
