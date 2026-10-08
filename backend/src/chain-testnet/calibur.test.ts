import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decodeFunctionData, getAddress } from 'viem';

import { AGGLAYER_BRIDGE_ADDRESS, BRIDGE_ASSET_ABI, midenAccountHexToEvmAddress } from './agglayer.js';
import {
  buildBuyBatch,
  buyBatchDigest,
  CALIBUR_ABI,
  encodeBuyExecution,
  ONRAMP_NONCE_KEY,
  type BuyBatchInput
} from './calibur.js';
import { ERC20_ABI } from './erc20.js';

/** The golden vector. The wallet test (`src/lib/onramp/buy-batch`) asserts the same digest. */
const GOLDEN: BuyBatchInput = {
  evmAddress: '0x1111111111111111111111111111111111111111',
  midenAccountHex: `0x${'0a'.repeat(15)}`,
  token: '0x0c86a754a29714c4fe9c6f1359fa7099ed174c0b',
  amount: 10n ** 18n,
  batchNonce: ONRAMP_NONCE_KEY << 64n,
  salt: `0x${'0'.repeat(24)}00000cabfc76478c1537dd418ab00967cbbe4ae6`,
  executor: '0x2222222222222222222222222222222222222222',
  deadline: 1900000000n
};

const GOLDEN_DIGEST = '0x5812ce6a00bac139b8002a52b3bfa4ba58385427cba9f12ef28409ee68458638';

describe('calibur buy batch', () => {
  it('encodes the Miden account as an Agglayer destination address', () => {
    assert.equal(midenAccountHexToEvmAddress(`0x${'0A'.repeat(15)}`), `0x00000000${'0a'.repeat(15)}00`);
    assert.throws(() => midenAccountHexToEvmAddress('0x1234'));
  });

  it('builds approve then bridgeAsset, with the root key and revert on failure', () => {
    const batch = buildBuyBatch(GOLDEN);
    assert.equal(batch.batchedCall.revertOnFailure, true);
    assert.equal(batch.keyHash, `0x${'0'.repeat(64)}`);
    const [approve, bridge] = batch.batchedCall.calls;
    assert.ok(approve && bridge);
    assert.equal(approve.to, GOLDEN.token);
    assert.deepEqual(decodeFunctionData({ abi: ERC20_ABI, data: approve.data }).args, [
      getAddress(AGGLAYER_BRIDGE_ADDRESS),
      10n ** 18n
    ]);
    assert.equal(bridge.to, AGGLAYER_BRIDGE_ADDRESS);
    const decoded = decodeFunctionData({ abi: BRIDGE_ASSET_ABI, data: bridge.data });
    assert.equal(decoded.functionName, 'bridgeAsset');
    assert.deepEqual(decoded.args, [
      86,
      getAddress(`0x00000000${'0a'.repeat(15)}00`),
      10n ** 18n,
      getAddress(GOLDEN.token),
      true,
      '0x'
    ]);
  });

  it('matches the golden EIP-712 digest', () => {
    const digest = buyBatchDigest(GOLDEN);
    console.log(`golden buy batch digest: ${digest}`);
    assert.equal(digest, GOLDEN_DIGEST);
  });

  it('wraps the signature for execute', () => {
    const signature = `0x${'11'.repeat(65)}` satisfies `0x${string}`;
    const decoded = decodeFunctionData({ abi: CALIBUR_ABI, data: encodeBuyExecution(GOLDEN, signature) });
    assert.equal(decoded.functionName, 'execute');
  });
});
