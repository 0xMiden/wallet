import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decodeFunctionData, getAddress } from 'viem';

import { AGGLAYER_BRIDGE_ADDRESS, BRIDGE_ASSET_ABI, midenAccountHexToEvmAddress } from './agglayer.js';
import {
  batchDigest,
  buildBatch,
  CALIBUR_ABI,
  encodeExecution,
  OFFRAMP_NONCE_KEY,
  ONRAMP_NONCE_KEY,
  type BatchInput
} from './calibur.js';
import { ERC20_ABI } from './erc20.js';

/** The golden buy vector. The wallet test (`src/lib/onramp/buy-batch`) asserts the same digest. */
const GOLDEN: BatchInput = {
  side: 'buy',
  evmAddress: '0x1111111111111111111111111111111111111111',
  midenAccountHex: `0x${'0a'.repeat(15)}`,
  token: '0x0c86a754a29714c4fe9c6f1359fa7099ed174c0b',
  depositAddress: null,
  amount: 10n ** 18n,
  batchNonce: ONRAMP_NONCE_KEY << 64n,
  salt: `0x${'0'.repeat(24)}00000cabfc76478c1537dd418ab00967cbbe4ae6`,
  executor: '0x2222222222222222222222222222222222222222',
  deadline: 1900000000n
};

const GOLDEN_DIGEST = '0x53ced547f87f74297962f3bd574f25ca7a8f3392fea412b02e942b8ffcea29d2';

/** The golden sell vector. The wallet test asserts the same digest. */
const GOLDEN_SELL: BatchInput = {
  side: 'sell',
  evmAddress: '0x1111111111111111111111111111111111111111',
  midenAccountHex: `0x${'0a'.repeat(15)}`,
  token: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  depositAddress: '0x57359A5071a83D3b5640BDcb7Ad17c70F40088A4',
  amount: 1_000_000n,
  batchNonce: OFFRAMP_NONCE_KEY << 64n,
  salt: `0x${'0'.repeat(24)}00000cabfc76478c1537dd418ab00967cbbe4ae6`,
  executor: '0x2222222222222222222222222222222222222222',
  deadline: 1900000000n
};

const GOLDEN_SELL_DIGEST = '0xf51b1837c41f5128f295dcc17b811a4d7905ae66d6be235b9327df25a055a96d';

describe('calibur buy batch', () => {
  it('encodes the Miden account as an Agglayer destination address', () => {
    assert.equal(midenAccountHexToEvmAddress(`0x${'0A'.repeat(15)}`), `0x00000000${'0a'.repeat(15)}00`);
    assert.throws(() => midenAccountHexToEvmAddress('0x1234'));
  });

  it('builds approve then bridgeAsset, with the root key and revert on failure', () => {
    const batch = buildBatch(GOLDEN);
    assert.equal(batch.batchedCall.revertOnFailure, true);
    assert.equal(batch.keyHash, `0x${'0'.repeat(64)}`);
    const [approve, bridge] = batch.batchedCall.calls;
    assert.ok(approve && bridge);
    assert.equal(approve.to, GOLDEN.token);
    assert.deepEqual(decodeFunctionData({ abi: ERC20_ABI, data: approve.data }).args, [
      getAddress(AGGLAYER_BRIDGE_ADDRESS),
      10n ** 18n
    ]);
    assert.equal(AGGLAYER_BRIDGE_ADDRESS, '0x528e26b25a34a4a5d0dbda1d57d318153d2ed582');
    assert.equal(bridge.to, AGGLAYER_BRIDGE_ADDRESS);
    const decoded = decodeFunctionData({ abi: BRIDGE_ASSET_ABI, data: bridge.data });
    assert.equal(decoded.functionName, 'bridgeAsset');
    assert.deepEqual(decoded.args, [
      73,
      getAddress(`0x00000000${'0a'.repeat(15)}00`),
      10n ** 18n,
      getAddress(GOLDEN.token),
      true,
      '0x'
    ]);
  });

  it('matches the golden EIP-712 digest', () => {
    const digest = batchDigest(GOLDEN);
    console.log(`golden buy batch digest: ${digest}`);
    assert.equal(digest, GOLDEN_DIGEST);
  });

  it('wraps the signature for execute', () => {
    const signature = `0x${'11'.repeat(65)}` satisfies `0x${string}`;
    const decoded = decodeFunctionData({ abi: CALIBUR_ABI, data: encodeExecution(GOLDEN, signature) });
    assert.equal(decoded.functionName, 'execute');
  });
});

describe('calibur sell batch', () => {
  it('builds one transfer to the deposit address under the off-ramp nonce key', () => {
    const batch = buildBatch(GOLDEN_SELL);
    assert.equal(batch.batchedCall.calls.length, 1);
    const [transfer] = batch.batchedCall.calls;
    assert.ok(transfer);
    assert.equal(transfer.to, GOLDEN_SELL.token);
    const decoded = decodeFunctionData({ abi: ERC20_ABI, data: transfer.data });
    assert.equal(decoded.functionName, 'transfer');
    assert.deepEqual(decoded.args, [GOLDEN_SELL.depositAddress, 1_000_000n]);
    assert.notEqual(OFFRAMP_NONCE_KEY, ONRAMP_NONCE_KEY);
  });

  it('refuses a sell batch without a deposit address', () => {
    assert.throws(() => buildBatch({ ...GOLDEN_SELL, depositAddress: null }), /deposit address/);
  });

  it('matches the golden EIP-712 digest', () => {
    const digest = batchDigest(GOLDEN_SELL);
    console.log(`golden sell batch digest: ${digest}`);
    assert.equal(digest, GOLDEN_SELL_DIGEST);
  });
});
