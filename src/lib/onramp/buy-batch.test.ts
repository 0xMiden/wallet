/**
 * @jest-environment node
 */
import { decodeFunctionData } from 'viem';

import {
  AGGLAYER_BRIDGE_ADDRESS,
  BRIDGE_ASSET_ABI,
  BuyBatchInput,
  ERC20_ABI,
  OFFRAMP_NONCE_KEY,
  ONRAMP_NONCE_KEY,
  SellBatchInput,
  buildBuyBatch,
  buildSellBatch,
  buyBatchDigest,
  buyBatchTypedData,
  midenAccountHexToEvmAddress,
  sellBatchDigest
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

// The backend test (`backend/src/chain-testnet/calibur.test.ts`) asserts the same digest. If one changes, both must change.
const GOLDEN_DIGEST = '0x53ced547f87f74297962f3bd574f25ca7a8f3392fea412b02e942b8ffcea29d2';
// The sell twin: `calibur sell batch` in the same backend test asserts this digest.
const GOLDEN_SELL_DIGEST = '0xf51b1837c41f5128f295dcc17b811a4d7905ae66d6be235b9327df25a055a96d';

describe('buy batch', () => {
  it('hashes the golden vector to the digest the backend twin asserts', () => {
    expect(buyBatchDigest(GOLDEN_INPUT)).toBe(GOLDEN_DIGEST);
  });

  it('derives the on-ramp nonce key from its label', () => {
    expect(ONRAMP_NONCE_KEY.toString(16)).toBe('eb4d3c43f120977c674e52a7fbb9e6b354db3b4533691842');
  });

  it('bridges the whole amount to the Miden account on network 73', () => {
    const batch = buildBuyBatch(GOLDEN_INPUT);
    const bridgeCall = batch.batchedCall.calls[1];
    expect(bridgeCall?.to).toBe(AGGLAYER_BRIDGE_ADDRESS);
    const decoded = decodeFunctionData({ abi: BRIDGE_ASSET_ABI, data: bridgeCall?.data ?? '0x' });
    const [network, destination, amount, token, forceUpdate, permitData] = decoded.args;
    expect(network).toBe(73);
    expect(AGGLAYER_BRIDGE_ADDRESS).toBe('0x528e26b25a34a4a5d0dbda1d57d318153d2ed582');
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

describe('sell batch', () => {
  const GOLDEN_SELL: SellBatchInput = {
    evmAddress: '0x1111111111111111111111111111111111111111',
    token: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    depositAddress: '0x57359A5071a83D3b5640BDcb7Ad17c70F40088A4',
    amount: 1_000_000n,
    batchNonce: OFFRAMP_NONCE_KEY << 64n,
    salt: `0x${'0'.repeat(24)}00000cabfc76478c1537dd418ab00967cbbe4ae6`,
    executor: '0x2222222222222222222222222222222222222222',
    deadline: 1900000000n
  };

  it('hashes the golden vector to the digest the backend twin asserts', () => {
    expect(sellBatchDigest(GOLDEN_SELL)).toBe(GOLDEN_SELL_DIGEST);
  });

  it('transfers the amount to the deposit address in one call under the off-ramp key', () => {
    const batch = buildSellBatch(GOLDEN_SELL);
    expect(batch.batchedCall.calls).toHaveLength(1);
    const decoded = decodeFunctionData({ abi: ERC20_ABI, data: batch.batchedCall.calls[0]?.data ?? '0x' });
    expect(decoded.functionName).toBe('transfer');
    expect(decoded.args).toEqual([GOLDEN_SELL.depositAddress, 1_000_000n]);
    expect(OFFRAMP_NONCE_KEY).not.toBe(ONRAMP_NONCE_KEY);
  });
});
