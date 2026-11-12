import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  decodeFunctionData,
  parseTransaction,
  erc20Abi,
  getAddress,
  keccak256,
  toBytes,
  zeroAddress,
  zeroHash
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { COMPACT_ABI } from '@epoch-protocol/epoch-intents-sdk/dist/abis/compact.js';
import { getTokenId } from '@epoch-protocol/epoch-intents-sdk/dist/helpers/chains.js';
import {
  BASE_MANDATE_TYPESTRING,
  EVM_TO_MIDEN_EXTRA_TYPESTRING,
  getClaimHash,
  getCompactTypehash
} from '@epoch-protocol/epoch-commons-sdk';
import {
  inspectEpochEvmTransaction,
  createEpochEvmSender,
  reconcileEpochEvmReceipts,
  inspectEpochForwardReceipt
} from '../node_modules/.cache/nightly-epoch-evm.mjs';
import { epochCheckpointFixture, epochReverseAuthorityFixture } from '../node_modules/.cache/nightly-epoch-fixture.mjs';

const hash = `0x${'a'.repeat(64)}`;
function fixture() {
  return {
    ...epochCheckpointFixture(),
    phase: 'reverse-authorized',
    forwardNoteId: hash,
    forwardMidenTxId: hash,
    forwardEvmTxHash: hash,
    forwardReceived: '1001000',
    reverseNonce: '10',
    returnAmount: '1000501',
    evmNonceBefore: 0,
    reverseAuthority: epochReverseAuthorityFixture()
  };
}
function forwardReceiptFixture() {
  const state = {
    ...epochCheckpointFixture(),
    forwardNoteId: hash,
    forwardAuthority: { minimumOutput: '1000001', bindingHash: hash, reclaimHeight: 7200, mandateReclaimHeight: 2200 }
  };
  const payer = `0x${'9'.repeat(40)}`;
  const log = {
    address: state.evm.token,
    transactionHash: hash,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: payer, to: state.evm.account } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [1_001_000n])
  };
  return { state, receipt: { transactionHash: hash, from: payer, status: 'success', logs: [log] } };
}
test('reconciles the exact provider-correlated ERC20 receipt, without signing or accepting a self-fill', () => {
  const c = forwardReceiptFixture();
  assert.equal(inspectEpochForwardReceipt(c.state, hash, c.receipt), 1_001_000n);
});
for (const [name, change] of [
  [
    'different transaction',
    c => {
      c.receipt.transactionHash = `0x${'b'.repeat(64)}`;
    }
  ],
  [
    'reverted transaction',
    c => {
      c.receipt.status = 'reverted';
    }
  ],
  [
    'self-submitted transaction',
    c => {
      c.receipt.from = c.state.evm.account;
    }
  ],
  [
    'another token',
    c => {
      c.receipt.logs[0].address = `0x${'8'.repeat(40)}`;
    }
  ],
  [
    'another recipient',
    c => {
      c.receipt.logs[0].topics = encodeEventTopics({
        abi: erc20Abi,
        eventName: 'Transfer',
        args: { from: c.receipt.from, to: c.receipt.from }
      });
    }
  ],
  [
    'self-funded transfer',
    c => {
      c.receipt.logs[0].topics = encodeEventTopics({
        abi: erc20Abi,
        eventName: 'Transfer',
        args: { from: c.state.evm.account, to: c.state.evm.account }
      });
    }
  ],
  [
    'below the stronger reviewed floor',
    c => {
      c.receipt.logs[0].data = encodeAbiParameters([{ type: 'uint256' }], [1_000_000n]);
    }
  ],
  [
    'missing reviewed authority',
    c => {
      delete c.state.forwardAuthority;
    }
  ]
])
  test(`blocks forward recovery on ${name}`, () => {
    const c = forwardReceiptFixture();
    change(c);
    assert.throws(() => inspectEpochForwardReceipt(c.state, hash, c.receipt));
  });

const witnessType = `${BASE_MANDATE_TYPESTRING},${EVM_TO_MIDEN_EXTRA_TYPESTRING}`;
function compact(state, expiry) {
  return {
    arbiter: getAddress(state.reverseAuthority.arbiter),
    sponsor: getAddress(state.evm.account),
    nonce: BigInt(state.reverseNonce),
    expires: expiry,
    lockTag: BigInt(state.reverseAuthority.lockTag),
    id: getTokenId(BigInt(state.reverseAuthority.lockTag), BigInt(state.evm.token)),
    token: getAddress(state.evm.token),
    amount: state.returnAmount,
    mandate: {
      tokenIn: state.evm.token,
      tokenInAmount: state.returnAmount,
      tokenOut: zeroAddress,
      minTokenOut: state.reverseMinimum,
      destinationChainId: String(state.virtualChainId),
      taskType: keccak256(toBytes('gettokenout')).slice(0, 10),
      protocolHashIdentifier: zeroHash,
      recipient: state.evm.account,
      midenRecipientAccount: state.accountHex,
      midenFaucetId: state.native.hex
    }
  };
}
function deposit(state, expiry, changed = {}) {
  const data = compact(state, expiry);
  return {
    to: getAddress(state.evm.compact),
    value: 0n,
    data: encodeFunctionData({
      abi: COMPACT_ABI,
      functionName: 'depositERC20AndRegister',
      args: [
        getAddress(state.evm.token),
        state.reverseAuthority.lockTag,
        BigInt(state.returnAmount),
        getClaimHash({ ...data, ...changed }, witnessType),
        getCompactTypehash(witnessType)
      ]
    })
  };
}
function approval(state, amount, spender = state.evm.compact) {
  return {
    to: getAddress(state.evm.token),
    value: 0n,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [getAddress(spender), amount]
    })
  };
}
function context() {
  const state = fixture();
  return {
    state,
    expiry: BigInt(state.reverseAuthority.minimumExpiry) + 100n,
    now: Date.parse(state.reverseAuthority.preparedAt) + 1000
  };
}

test('accepts the actual SDK ABI and canonical Compact claim for the exact return authorization', () => {
  const { state, expiry, now } = context();
  assert.equal(inspectEpochEvmTransaction(state, deposit(state, expiry), expiry, now), 'deposit');
});
test('accepts only an exact bounded approval or its zero-reset prerequisite', () => {
  const { state, expiry, now } = context();
  assert.equal(inspectEpochEvmTransaction(state, approval(state, BigInt(state.returnAmount)), expiry, now), 'approve');
  assert.equal(inspectEpochEvmTransaction(state, approval(state, 0n), expiry, now), 'approve');
});
for (const [name, change] of [
  ['unlimited approval', s => approval(s, (1n << 256n) - 1n)],
  ['another approval spender', s => approval(s, BigInt(s.returnAmount), `0x${'9'.repeat(40)}`)],
  [
    'a direct token transfer',
    s => ({
      to: getAddress(s.evm.token),
      value: 0n,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [getAddress(s.evm.compact), BigInt(s.returnAmount)]
      })
    })
  ],
  ['a native value transfer', (s, e) => ({ ...deposit(s, e), value: 1n })],
  ['another Compact contract', (s, e) => ({ ...deposit(s, e), to: `0x${'9'.repeat(40)}` })],
  ['trailing undeclared calldata', (s, e) => ({ ...deposit(s, e), data: `${deposit(s, e).data}00` })],
  ['a different protocol nonce in the claim', (s, e) => deposit(s, e, { nonce: 11n })],
  ['a different sponsor in the claim', (s, e) => deposit(s, e, { sponsor: getAddress(`0x${'9'.repeat(40)}`) })],
  [
    'a lower Miden minimum in the claim',
    (s, e) => deposit(s, e, { mandate: { ...compact(s, e).mandate, minTokenOut: '1' } })
  ]
]) {
  test(`refuses ${name} before signing`, () => {
    const { state, expiry, now } = context();
    assert.throws(() => inspectEpochEvmTransaction(state, change(state, expiry), expiry, now));
  });
}
test('refuses an expiry outside the uploaded authority window even with a matching claim', () => {
  const { state, now } = context();
  const expiry = BigInt(state.reverseAuthority.maximumExpiry) + 1n;
  assert.throws(() => inspectEpochEvmTransaction(state, deposit(state, expiry), expiry, now));
});
test('does not extend signing permission when the original prepared authorization expires', () => {
  const { state, expiry } = context();
  const now = Date.parse(state.reverseAuthority.preparedAt) + 300_001;
  assert.throws(() => inspectEpochEvmTransaction(state, deposit(state, expiry), expiry, now));
});
function senderFixture() {
  const state = fixture();
  const account = privateKeyToAccount(`0x${'0'.repeat(63)}1`);
  state.evm.account = account.address;
  const now = Date.now();
  const expiry = BigInt(Math.floor(now / 1000)) + 3600n;
  state.reverseAuthority = {
    ...state.reverseAuthority,
    preparedAt: new Date(now).toISOString(),
    valuation: { ...state.reverseAuthority.valuation, pricedAt: new Date(now).toISOString() },
    minimumExpiry: expiry.toString(),
    maximumExpiry: (expiry + 300n).toString()
  };
  let allowance = 0n;
  let envelope;
  const events = [];
  let signed = 0;
  let broadcasts = 0;
  const client = {
    getChainId: async () => state.evm.chainId,
    getTransactionCount: async () => state.evmNonceBefore + (state.transactions?.length ?? 0),
    getBalance: async () => BigInt(state.evm.nativeBalance) - BigInt(state.paidEvmFees),
    readTokenBalance: async () => BigInt(state.evm.tokenBalance) + BigInt(state.forwardReceived),
    readAllowance: async () => allowance,
    estimateGas: async () => 30_000n,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
    sendRawTransaction: async ({ serializedTransaction }) => {
      broadcasts++;
      const hash = keccak256(serializedTransaction);
      assert.equal(state.transactions.at(-1).hash, hash, 'Exact signed hash must be durable before broadcast');
      assert.ok(events.includes(`persist:${hash}:pending`));
      events.push('broadcast');
      return hash;
    },
    waitForTransactionReceipt: async ({ hash }) => {
      events.push('receipt');
      if (envelope.to.toLowerCase() === state.evm.token.toLowerCase())
        allowance = decodeFunctionData({ abi: erc20Abi, data: envelope.data }).args[1];
      return { transactionHash: hash, status: 'success', gasUsed: 1000n, effectiveGasPrice: 1n };
    }
  };
  const input = {
    client,
    sign: async transaction => {
      signed++;
      events.push('sign');
      envelope = transaction;
      return account.signTransaction({ ...transaction, type: 'eip1559' });
    },
    persist: async saved => {
      const last = saved.transactions.at(-1);
      events.push(`persist:${last.hash}:${last.feeWei ?? 'pending'}`);
      assert.equal(saved.lossBudgetUsdMicros, '1999095');
    }
  };
  return {
    state,
    expiry,
    input,
    events,
    account,
    setAllowance: value => {
      allowance = value;
    },
    counts: () => ({ signed, broadcasts }),
    build: () => createEpochEvmSender(state, input)
  };
}
const activeSignal = () => new AbortController().signal;

test('signs bounded approval/deposit once each, persisting exact signed hashes before broadcasting and actual fees afterwards', async () => {
  const c = senderFixture();
  const sender = c.build();
  await sender.send(approval(c.state, BigInt(c.state.returnAmount)), activeSignal());
  await sender.send(deposit(c.state, c.expiry), activeSignal());
  assert.deepEqual(c.counts(), { signed: 2, broadcasts: 2 });
  assert.equal(c.state.transactions.length, 2);
  assert.deepEqual(
    c.state.transactions.map(tx => [tx.kind, tx.nonce, tx.feeWei]),
    [
      ['approve', 0, '1000'],
      ['deposit', 1, '1000']
    ]
  );
  assert.equal(c.state.paidEvmFees, '2000');
  await assert.rejects(sender.send(deposit(c.state, c.expiry), activeSignal()));
  assert.deepEqual(c.counts(), { signed: 2, broadcasts: 2 });
});
test('accepts canonically signed zero-priority-fee approval and deposit without weakening any actual fee bound', async () => {
  const c = senderFixture();
  c.input.client.estimateFeesPerGas = async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 0n });
  const sender = c.build();
  await sender.send(approval(c.state, BigInt(c.state.returnAmount)), activeSignal());
  await sender.send(deposit(c.state, c.expiry), activeSignal());
  assert.deepEqual(c.counts(), { signed: 2, broadcasts: 2 });
  assert.equal(c.state.paidEvmFees, '2000');
});
test('binds the actual SDK deposit expiry within the uploaded window instead of assuming a dry-quote timestamp stays unchanged', async () => {
  const c = senderFixture();
  c.setAllowance(BigInt(c.state.returnAmount));
  await c.build().send(deposit(c.state, c.expiry + 150n), activeSignal());
  assert.deepEqual(c.counts(), { signed: 1, broadcasts: 1 });
});
test('rejects an actual SDK expiry outside the exact uploaded authority window before signing', async () => {
  const c = senderFixture();
  c.setAllowance(BigInt(c.state.returnAmount));
  await assert.rejects(c.build().send(deposit(c.state, c.expiry + 301n), activeSignal()));
  assert.deepEqual(c.counts(), { signed: 0, broadcasts: 0 });
});
test('allows only one necessary zero reset before the exact approval and deposit', async () => {
  const c = senderFixture();
  c.setAllowance(1n);
  const sender = c.build();
  for (const tx of [approval(c.state, 0n), approval(c.state, BigInt(c.state.returnAmount)), deposit(c.state, c.expiry)])
    await sender.send(tx, activeSignal());
  assert.deepEqual(c.counts(), { signed: 3, broadcasts: 3 });
  assert.equal(c.state.paidEvmFees, '3000');
});
for (const [name, change] of [
  [
    'another live chain',
    c => {
      c.input.client.getChainId = async () => 1;
    }
  ],
  [
    'an unexpected pending nonce',
    c => {
      c.input.client.getTransactionCount = async () => 1;
    }
  ],
  [
    'an unrelated native balance change',
    c => {
      c.input.client.getBalance = async () => 1n;
    }
  ],
  [
    'an unrelated token balance change',
    c => {
      c.input.client.readTokenBalance = async () => 1n;
    }
  ],
  [
    'a gas envelope above the remaining budget',
    c => {
      c.input.client.estimateGas = async () => 1_000_000_000_000n;
    }
  ],
  [
    'a missing fee estimate',
    c => {
      c.input.client.estimateFeesPerGas = async () => ({});
    }
  ]
])
  test(`refuses ${name} before private signing`, async () => {
    const c = senderFixture();
    change(c);
    await assert.rejects(c.build().send(approval(c.state, BigInt(c.state.returnAmount)), activeSignal()));
    assert.deepEqual(c.counts(), { signed: 0, broadcasts: 0 });
  });
for (const [name, change] of [
  ['nonce', tx => ({ ...tx, nonce: tx.nonce + 1 })],
  ['chain', tx => ({ ...tx, chainId: 1 })],
  ['destination', tx => ({ ...tx, to: `0x${'9'.repeat(40)}` })],
  ['value', tx => ({ ...tx, value: 1n })],
  ['maximum fee', tx => ({ ...tx, maxFeePerGas: tx.maxFeePerGas + 1n })],
  ['gas limit', tx => ({ ...tx, gas: tx.gas + 1n })],
  ['calldata', tx => ({ ...tx, data: `${tx.data}00` })]
])
  test(`checks the actual signed envelope rather than trusting a signer that changes ${name}`, async () => {
    const c = senderFixture();
    c.input.sign = transaction => c.account.signTransaction({ ...change(transaction), type: 'eip1559' });
    await assert.rejects(c.build().send(approval(c.state, BigInt(c.state.returnAmount)), activeSignal()));
    assert.equal(c.counts().broadcasts, 0);
  });
test('refuses a generic-hex signer result that is a valid legacy transaction instead of EIP-1559', async () => {
  const c = senderFixture();
  c.input.sign = transaction =>
    c.account.signTransaction({
      to: transaction.to,
      data: transaction.data,
      value: transaction.value,
      nonce: transaction.nonce,
      chainId: transaction.chainId,
      gas: transaction.gas,
      gasPrice: 2n,
      type: 'legacy'
    });
  await assert.rejects(c.build().send(approval(c.state, BigInt(c.state.returnAmount)), activeSignal()), /EIP-1559/);
  assert.equal(c.counts().broadcasts, 0);
});
test('checks the recovered signing account before broadcasting', async () => {
  const c = senderFixture();
  const other = privateKeyToAccount(`0x${'0'.repeat(63)}2`);
  c.input.sign = transaction => other.signTransaction({ ...transaction, type: 'eip1559' });
  await assert.rejects(c.build().send(approval(c.state, BigInt(c.state.returnAmount)), activeSignal()));
  assert.equal(c.counts().broadcasts, 0);
});
test('can deposit without another approval when the exact allowance already exists', async () => {
  const c = senderFixture();
  c.setAllowance(BigInt(c.state.returnAmount));
  await c.build().send(deposit(c.state, c.expiry), activeSignal());
  assert.deepEqual(c.counts(), { signed: 1, broadcasts: 1 });
  assert.equal(c.state.transactions[0].kind, 'deposit');
});
test('refuses repeated approvals or an unnecessary zero reset before signing again', async () => {
  const c = senderFixture();
  const sender = c.build();
  await sender.send(approval(c.state, BigInt(c.state.returnAmount)), activeSignal());
  await assert.rejects(sender.send(approval(c.state, BigInt(c.state.returnAmount)), activeSignal()));
  assert.deepEqual(c.counts(), { signed: 1, broadcasts: 1 });
  const other = senderFixture();
  await assert.rejects(other.build().send(approval(other.state, 0n), activeSignal()));
  assert.deepEqual(other.counts(), { signed: 0, broadcasts: 0 });
});
test('does not broadcast if durable signed-hash persistence fails', async () => {
  const c = senderFixture();
  c.input.persist = async () => {
    throw new Error('disk unavailable');
  };
  await assert.rejects(
    c.build().send(approval(c.state, BigInt(c.state.returnAmount)), activeSignal()),
    /disk unavailable/
  );
  assert.deepEqual(c.counts(), { signed: 1, broadcasts: 0 });
});
test('retains the signed hash and blocks further signing after ambiguous broadcast', async () => {
  const c = senderFixture();
  let calls = 0;
  c.input.client.sendRawTransaction = async () => {
    calls++;
    throw new Error('ambiguous broadcast');
  };
  const sender = c.build();
  await assert.rejects(
    sender.send(approval(c.state, BigInt(c.state.returnAmount)), activeSignal()),
    /ambiguous broadcast/
  );
  assert.match(c.state.transactions[0].hash, /^0x[0-9a-f]{64}$/);
  await assert.rejects(sender.send(approval(c.state, BigInt(c.state.returnAmount)), activeSignal()));
  assert.equal(calls, 1);
  assert.equal(c.counts().signed, 1);
});
test('accounts for reverted receipt fees without resending the transaction', async () => {
  const c = senderFixture();
  c.input.client.waitForTransactionReceipt = async ({ hash }) => ({
    transactionHash: hash,
    status: 'reverted',
    gasUsed: 1000n,
    effectiveGasPrice: 1n
  });
  await assert.rejects(c.build().send(approval(c.state, BigInt(c.state.returnAmount)), activeSignal()), /revert/i);
  assert.equal(c.state.paidEvmFees, '1000');
  assert.equal(c.state.transactions[0].feeWei, '1000');
  assert.deepEqual(c.counts(), { signed: 1, broadcasts: 1 });
});
test('refuses to construct a fresh sender over an unresolved signed journal', () => {
  const c = senderFixture();
  c.state.transactions = [{ kind: 'approve', nonce: 0, hash }];
  assert.throws(() => c.build());
});
test('refuses an aborted request without signing', async () => {
  const c = senderFixture();
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(c.build().send(approval(c.state, BigInt(c.state.returnAmount)), abort.signal));
  assert.deepEqual(c.counts(), { signed: 0, broadcasts: 0 });
});

async function recoveryFixture() {
  const c = senderFixture();
  const raw = [];
  const send = c.input.client.sendRawTransaction;
  c.input.client.sendRawTransaction = async input => {
    raw.push(input.serializedTransaction);
    return send(input);
  };
  const sender = c.build();
  await sender.send(approval(c.state, BigInt(c.state.returnAmount)), activeSignal());
  await sender.send(deposit(c.state, c.expiry), activeSignal());
  const evidence = raw.map(bytes => {
    const tx = parseTransaction(bytes);
    const hash = keccak256(bytes);
    return {
      transaction: { ...tx, hash, from: c.account.address, input: tx.data, value: tx.value ?? 0n },
      receipt: { transactionHash: hash, status: 'success', gasUsed: 1000n, effectiveGasPrice: 1n }
    };
  });
  c.state.phase = 'recovery-required';
  c.state.paidEvmFees = '0';
  c.state.transactions.forEach(tx => {
    delete tx.feeWei;
  });
  c.state.reverseAuthority.preparedAt = new Date(Date.now() - 600_000).toISOString();
  c.state.reverseAuthority.valuation.pricedAt = c.state.reverseAuthority.preparedAt;
  return { ...c, evidence };
}
test('reconciles actual signed hashes/receipts under original expired authority without renewing signing or budgets', async () => {
  const c = await recoveryFixture();
  const original = JSON.stringify({
    source: c.state.sourceRunId,
    authorization: c.state.authorizationRunId,
    reverse: c.state.reverseAuthority,
    nonce: c.state.reverseNonce,
    amount: c.state.returnAmount,
    budget: c.state.evmFeeBudget
  });
  assert.equal(reconcileEpochEvmReceipts(c.state, c.evidence), true);
  assert.equal(c.state.paidEvmFees, '2000');
  assert.deepEqual(
    c.state.transactions.map(tx => tx.feeWei),
    ['1000', '1000']
  );
  assert.equal(c.state.phase, 'recovery-required');
  assert.equal(
    JSON.stringify({
      source: c.state.sourceRunId,
      authorization: c.state.authorizationRunId,
      reverse: c.state.reverseAuthority,
      nonce: c.state.reverseNonce,
      amount: c.state.returnAmount,
      budget: c.state.evmFeeBudget
    }),
    original
  );
  assert.throws(() => c.build());
  assert.deepEqual(c.counts(), { signed: 2, broadcasts: 2 });
});
for (const [name, change] of [
  [
    'missing receipt',
    c => {
      c.evidence.pop();
    }
  ],
  [
    'different signed hash',
    c => {
      c.evidence[1].transaction.hash = hash;
    }
  ],
  [
    'different receipt hash',
    c => {
      c.evidence[1].receipt.transactionHash = hash;
    }
  ],
  [
    'different payer',
    c => {
      c.evidence[1].transaction.from = `0x${'9'.repeat(40)}`;
    }
  ],
  [
    'different nonce',
    c => {
      c.evidence[1].transaction.nonce++;
    }
  ],
  [
    'different execution bytes',
    c => {
      c.evidence[1].transaction.input += '00';
    }
  ],
  [
    'different live chain',
    c => {
      c.evidence[1].transaction.chainId = 1;
    }
  ],
  [
    'receipt above signed gas bound',
    c => {
      c.evidence[1].receipt.gasUsed = 1_000_000n;
    }
  ],
  [
    'contradictory saved fee',
    c => {
      c.state.transactions[0].feeWei = '2000';
    }
  ]
])
  test(`blocks readonly recovery on ${name}, without creating another signature`, async () => {
    const c = await recoveryFixture();
    change(c);
    assert.throws(() => reconcileEpochEvmReceipts(c.state, c.evidence));
    assert.deepEqual(c.counts(), { signed: 2, broadcasts: 2 });
  });
test('counts a reverted deposit receipt but never treats it as permission to claim or retry funding', async () => {
  const c = await recoveryFixture();
  c.evidence[1].receipt.status = 'reverted';
  assert.equal(reconcileEpochEvmReceipts(c.state, c.evidence), false);
  assert.equal(c.state.paidEvmFees, '2000');
  assert.equal(c.state.phase, 'recovery-required');
});

test('requires explicit return-stage valuation before constructing any EVM signer', () => {
  const c = senderFixture();
  delete c.state.reverseAuthority.valuation;
  assert.throws(() => c.build(), /valuation|price/i);
  assert.deepEqual(c.counts(), { signed: 0, broadcasts: 0 });
});
test('refuses a stale market valuation even when the compact authorization was prepared now', () => {
  const c = senderFixture();
  c.state.reverseAuthority.valuation = {
    pricedAt: new Date(Date.now() - 600_001).toISOString(),
    stableUsdMicros: '1000000',
    gasUsdMicros: '2000000000'
  };
  assert.throws(() => c.build(), /valuation|price|stale/i);
  assert.deepEqual(c.counts(), { signed: 0, broadcasts: 0 });
});
test('cannot replace uploaded valuation facts after the signer was constructed', async () => {
  const c = senderFixture();
  c.state.reverseAuthority.valuation = {
    pricedAt: c.state.reverseAuthority.preparedAt,
    stableUsdMicros: '1000000',
    gasUsdMicros: '2000000000'
  };
  const sender = c.build();
  c.state.reverseAuthority.valuation.pricedAt = new Date(Date.now() - 600_001).toISOString();
  await assert.rejects(
    sender.send(approval(c.state, BigInt(c.state.returnAmount)), activeSignal()),
    /valuation|price|changed/i
  );
  assert.deepEqual(c.counts(), { signed: 0, broadcasts: 0 });
});
test('does not sign if repricing the original entire native gas reserve exceeds its original USD allowance', () => {
  const c = senderFixture();
  c.state.reverseAuthority.valuation = {
    pricedAt: c.state.reverseAuthority.preparedAt,
    stableUsdMicros: '1000000',
    gasUsdMicros: '3000000000000'
  };
  assert.throws(() => c.build(), /budget|cost|allowance|cap/i);
  assert.deepEqual(c.counts(), { signed: 0, broadcasts: 0 });
});

test('requires a reverse-authorized phase instead of reusing settled or ambiguous state', () => {
  const { state, expiry, now } = context();
  for (const phase of ['forward-settled', 'complete', 'recovery-required']) {
    assert.throws(() => inspectEpochEvmTransaction({ ...state, phase }, deposit(state, expiry), expiry, now));
  }
});
