import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EVM_TO_MIDEN_EXTRA_TYPESTRING } from '@epoch-protocol/epoch-commons-sdk';
import { epochReadOnlyProvider, prepareEpochRoundTrip } from '../node_modules/.cache/nightly-epoch-provider.mjs';
import { epochCheckpointFixture } from '../node_modules/.cache/nightly-epoch-fixture.mjs';

const service = 'https://mainnet-api.epochprotocol.xyz';
const actor = `0x${'1'.repeat(40)}`;
const token = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const zero = `0x${'0'.repeat(40)}`;

async function prepareFixture(mutate = () => {}) {
  const input = { ...epochCheckpointFixture(), currentBlock: 813946, principal: '5000000', reverseMinimum: '4900000' };
  const health = {
    status: 'healthy',
    allocatorAddresses: { 42161: `0x${'2'.repeat(40)}`, 999999999: `0x${'2'.repeat(40)}` },
    arbiterAddresses: { 42161: `0x${'4'.repeat(40)}`, 999999999: `0x${'4'.repeat(40)}` },
    compactAddresses: { 42161: `0x${'3'.repeat(40)}`, 999999999: `0x${'3'.repeat(40)}` },
    compactLockResetPeriod: 5,
    compactLockScope: 0,
    compactExpirySeconds: 3000,
    compactExpiryBufferSeconds: 600,
    midenRecallBufferBlocks: 1000,
    midenVirtualChainId: 999999999,
    midenTestnetVirtualChainId: 123456789,
    midenMainnetVirtualChainId: 999999999
  };
  const forward = {
    resourceLockRequired: true,
    transactions: [],
    tokenIn: '5000000',
    tokenOut: '4950000',
    tokenInDecimals: 6
  };
  const reverse = {
    resourceLockRequired: true,
    transactions: [],
    tokenIn: '4930000',
    tokenOut: '4900000',
    tokenInDecimals: 6
  };
  mutate({ input, health, forward, reverse });
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, service);
    requests.push(parsed.pathname);
    if (parsed.pathname === '/health') return Response.json(health);
    if (parsed.pathname === '/miden-recipient')
      return Response.json({
        midenP2IDRecipientAccountId: '0x593c167bec26769178dcbd1f9bcb40',
        midenMinReclaimBlocks: 5200
      });
    if (parsed.pathname.startsWith('/suggested-nonce/')) return Response.json({ nonce: '0x0a' });
    assert.equal(parsed.pathname, '/checkIfDepositNeeded', 'Readonly planning must not allocate or deposit');
    const body = JSON.parse(init.body);
    if (body.chainId === '999999999') {
      assert.equal(body.compact.mandate.tokenInAmount, input.principal);
      assert.equal(body.compact.mandate.recipient.toLowerCase(), actor);
      assert.equal(body.compact.mandate.midenSourceAccount, input.accountHex);
      assert.equal(body.compact.mandate.midenFaucetId, input.native.hex);
      return Response.json(forward);
    }
    assert.equal(body.chainId, '42161');
    assert.equal(body.compact.mandate.tokenInAmount, '0', 'Reverse must use the supported fixed-output quote');
    assert.equal(body.compact.mandate.minTokenOut, input.reverseMinimum);
    assert.equal(body.compact.mandate.midenRecipientAccount, input.accountHex);
    return Response.json(reverse);
  };
  try {
    return { state: await prepareEpochRoundTrip(input), requests };
  } finally {
    globalThis.fetch = original;
  }
}

test('prepares a real SDK quote pair and pins live allocator, reclaim window, nonce and remaining budget without signing', async () => {
  const { state, requests } = await prepareFixture();
  assert.equal(state.phase, 'forward-authorized');
  assert.equal(state.virtualChainId, 999999999);
  assert.equal(state.midenAllocator, '0x593c167bec26769178dcbd1f9bcb40');
  assert.equal(state.recallBlocks, 6200);
  assert.equal(state.minimumRecallBlocks, 5200);
  assert.equal(state.forwardMinimum, '4950000');
  assert.equal(state.reverseMinimum, '4900000');
  assert.equal(state.forwardNonce, '10');
  assert.equal(state.lossBudgetUsdMicros, '1999095');
  assert.equal(state.authorizationRunId, '100');
  assert.equal(state.paidMidenFees, '0');
  assert.equal(state.paidEvmFees, '0');
  assert.equal(state.forwardNoteId, undefined);
  assert.equal(state.transactions, undefined);
  assert.ok(requests.filter(value => value === '/checkIfDepositNeeded').length >= 2);
});
for (const [name, mutate] of [
  [
    'forward amount mismatch',
    ({ forward }) => {
      forward.tokenIn = '5000001';
    }
  ],
  [
    'missing forward output',
    ({ forward }) => {
      delete forward.tokenOut;
    }
  ],
  [
    'reverse output mismatch',
    ({ reverse }) => {
      reverse.tokenOut = '4899999';
    }
  ],
  [
    'reverse exceeds guaranteed proceeds',
    ({ reverse }) => {
      reverse.tokenIn = '4950001';
    }
  ],
  [
    'missing pre-existing EVM gas',
    ({ input }) => {
      input.evm.nativeBalance = '0';
    }
  ],
  [
    'insufficient remaining allowance',
    ({ input }) => {
      input.lossBudgetUsdMicros = '1000';
    }
  ],
  [
    'invalid chain head',
    ({ input }) => {
      input.currentBlock = -1;
    }
  ]
])
  test(`refuses an unsafe readonly plan: ${name}`, async () => {
    await assert.rejects(prepareFixture(mutate), /quote|proceeds|gas|balance|allowance|bound|block|height/i);
  });

for (const [name, url, chain] of [
  ['HTTP', 'http://mainnet-api.epochprotocol.xyz', 42161],
  ['credentials', 'https://user:password@mainnet-api.epochprotocol.xyz', 42161],
  ['a query', `${service}?override=1`, 42161],
  ['testnet', service, 11155111]
]) {
  test(`refuses ${name} before constructing a provider`, () => {
    assert.throws(() => epochReadOnlyProvider(url, chain, actor));
  });
}
test('contains no private signer and refuses every EVM RPC request including signing', async () => {
  let provider;
  assert.doesNotThrow(() => {
    provider = epochReadOnlyProvider(service, 42161, actor);
  });
  assert.equal(provider.config.walletClient.account.address.toLowerCase(), actor);
  assert.equal(provider.config.walletClient.account.type, 'json-rpc');
  for (const method of ['eth_sendTransaction', 'eth_signTypedData_v4', 'personal_sign', 'eth_chainId']) {
    await assert.rejects(provider.config.walletClient.request({ method, params: [] }), /read.only/i);
  }
  assert.equal(provider.sdk.solveIntent, undefined);
  assert.equal(provider.sdk.depositToCompact, undefined);
});
test('uses the actual installed SDK reverse quote and compact builder without touching EVM RPC', async () => {
  const original = globalThis.fetch;
  let posted;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, service);
    if (url.pathname === '/health')
      return Response.json({
        status: 'healthy',
        allocatorAddresses: { 42161: `0x${'2'.repeat(40)}` },
        arbiterAddresses: { 42161: `0x${'4'.repeat(40)}` },
        compactAddresses: { 42161: `0x${'3'.repeat(40)}` },
        compactLockResetPeriod: 5,
        compactLockScope: 0,
        compactExpirySeconds: 3000,
        compactExpiryBufferSeconds: 600,
        midenRecallBufferBlocks: 1000,
        midenVirtualChainId: 999999999,
        midenTestnetVirtualChainId: 123456789,
        midenMainnetVirtualChainId: 999999999
      });
    if (url.pathname.startsWith('/suggested-nonce/42161/')) return Response.json({ nonce: '0x0a' });
    assert.equal(url.pathname, '/checkIfDepositNeeded');
    posted = JSON.parse(init.body);
    return Response.json({
      resourceLockRequired: true,
      transactions: [],
      path: [],
      tokenIn: '1000501',
      tokenOut: '1000000'
    });
  };
  try {
    let provider;
    assert.doesNotThrow(() => {
      provider = epochReadOnlyProvider(service, 42161, actor);
    });
    const task = provider.sdk.getTaskData({
      taskType: 'gettokenout',
      intentData: {
        isNative: false,
        depositTokenAddress: token,
        tokenInAmount: '0',
        outputTokenAddress: zero,
        minTokenOut: '1000000',
        destinationChainId: '999999999',
        protocolHashIdentifier: `0x${'0'.repeat(64)}`,
        recipient: actor
      },
      extraDataTypestring: EVM_TO_MIDEN_EXTRA_TYPESTRING,
      extraData: { midenRecipientAccount: `0x${'12'.repeat(15)}`, midenFaucetId: '0xe69e6ca6e39df1b10c1e5399399feb' }
    });
    const quote = await provider.sdk.getIntentQuote(provider.config, {
      ...task,
      sponsorAddress: actor,
      isNative: false
    });
    assert.equal(quote.tokenIn, '1000501');
    assert.equal(quote.tokenOut, '1000000');
    assert.equal(posted.chainId, '42161');
    assert.equal(posted.compact.nonce, '10');
    assert.equal(posted.compact.sponsor.toLowerCase(), actor);
    assert.equal(posted.compact.mandate.minTokenOut, '1000000');
    assert.equal(posted.compact.mandate.tokenInAmount, '0');
  } finally {
    globalThis.fetch = original;
  }
});
