/**
 * @jest-environment node
 */
import { decodeFunctionData } from 'viem';

import {
  AGGLAYER_BRIDGE_ADDRESS,
  BRIDGE_ASSET_ABI,
  BuyBatchInput,
  ONRAMP_NONCE_KEY,
  buildBuyBatch,
  buyBatchDigest,
  buyBatchTypedData,
  midenAccountHexToEvmAddress
} from './buy-batch';

const GOLDEN_INPUT: BuyBatchInput = {
  evmAddress: '0x1111111111111111111111111111111111111111',
  midenAccountHex: '0x' + '0a'.repeat(15),
  token: '0x0c86a754a29714c4fe9c6f1359fa7099ed174c0b',
  amount: 10n ** 18n,
  batchNonce: ONRAMP_NONCE_KEY << 64n,
  salt: `0x${'0'.repeat(24)}00000cabfc76478c1537dd418ab00967cbbe4ae6`,
  executor: '0x2222222222222222222222222222222222222222',
  deadline: 1900000000n
};

// The backend test (`backend/src/calibur.test.ts`) asserts the same digest. If one changes, both must change.
const GOLDEN_DIGEST = '0x5812ce6a00bac139b8002a52b3bfa4ba58385427cba9f12ef28409ee68458638';

describe('buy batch', () => {
  it('hashes the golden vector to the digest the backend twin asserts', () => {
    expect(buyBatchDigest(GOLDEN_INPUT)).toBe(GOLDEN_DIGEST);
  });

  it('derives the on-ramp nonce key from its label', () => {
    expect(ONRAMP_NONCE_KEY.toString(16)).toBe('eb4d3c43f120977c674e52a7fbb9e6b354db3b4533691842');
  });

  it('bridges the whole amount to the Miden account on network 86', () => {
    const batch = buildBuyBatch(GOLDEN_INPUT);
    const bridgeCall = batch.batchedCall.calls[1];
    expect(bridgeCall?.to).toBe(AGGLAYER_BRIDGE_ADDRESS);
    const decoded = decodeFunctionData({ abi: BRIDGE_ASSET_ABI, data: bridgeCall?.data ?? '0x' });
    const [network, destination, amount, token, forceUpdate, permitData] = decoded.args;
    expect(network).toBe(86);
    expect(destination.toLowerCase()).toBe('0x000000000a0a0a0a0a0a0a0a0a0a0a0a0a0a0a00');
    expect(amount).toBe(10n ** 18n);
    expect(token.toLowerCase()).toBe(GOLDEN_INPUT.token);
    expect(forceUpdate).toBe(true);
    expect(permitData).toBe('0x');
    expect(batch.batchedCall.revertOnFailure).toBe(true);
  });

  it('uses the account address as the verifying contract of the domain', () => {
    expect(buyBatchTypedData(GOLDEN_INPUT).domain).toEqual({
      name: 'Calibur',
      version: '1.0.0',
      chainId: 11155111,
      verifyingContract: GOLDEN_INPUT.evmAddress,
      salt: GOLDEN_INPUT.salt
    });
  });

  it('refuses a Miden account id that is not 15 bytes', () => {
    expect(() => midenAccountHexToEvmAddress('0x1234')).toThrow('not a 15-byte');
  });
});
