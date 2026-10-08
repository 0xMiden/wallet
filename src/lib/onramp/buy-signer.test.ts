/**
 * @jest-environment node
 */
import { type Hex } from 'viem';

import { buildVaultEvmWalletClient } from 'lib/epoch/evm-account';

import { BuyOrder, BuyOrderPrepare, postBuySignature } from './buy-api';
import { CALIBUR_SEPOLIA_ADDRESS, ONRAMP_NONCE_KEY, buyBatchTypedData } from './buy-batch';
import { BuySignRefusal, BuySignRefusedError, SignBuyOrderInput, signBuyOrder, validateBuyPrepare } from './buy-signer';

const mockSignTypedData = jest.fn();
const mockSignAuthorization = jest.fn();

jest.mock('lib/epoch/evm-account', () => ({
  buildVaultEvmWalletClient: jest.fn((_publicKey: string, address: string) => ({
    account: { address, type: 'local' },
    signTypedData: mockSignTypedData,
    signAuthorization: mockSignAuthorization
  }))
}));

jest.mock('./buy-api', () => ({
  ...jest.requireActual('./buy-api'),
  postBuySignature: jest.fn()
}));

const mockPost = jest.mocked(postBuySignature);
const mockBuildClient = jest.mocked(buildVaultEvmWalletClient);

const NOW = 1_800_000_000;
const EVM_ADDRESS = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const MIDEN_HEX = '0x' + '0a'.repeat(15);
const TOKEN = '0x0c86a754a29714c4fe9c6f1359fa7099ed174c0b';
const SALT: Hex = `0x${'0'.repeat(24)}00000cabfc76478c1537dd418ab00967cbbe4ae6`;
const SIGNATURE: Hex = `0x${'11'.repeat(65)}`;
const R: Hex = `0x${'22'.repeat(32)}`;
const S: Hex = `0x${'33'.repeat(32)}`;

function goodPrepare(): BuyOrderPrepare {
  return {
    chainId: 11155111,
    calibur: CALIBUR_SEPOLIA_ADDRESS,
    evmAddress: EVM_ADDRESS,
    midenAccountHex: MIDEN_HEX,
    executor: '0x2222222222222222222222222222222222222222',
    batchNonce: ((ONRAMP_NONCE_KEY << 64n) + 3n).toString(),
    salt: SALT,
    deadline: NOW + 86_400,
    needsAuthorization: false,
    authorizationNonce: 7,
    tokenAmount: (50n * 10n ** 18n).toString()
  };
}

function orderWith(prepare: Partial<BuyOrderPrepare> = {}, order: Partial<BuyOrder> = {}): BuyOrder {
  return {
    id: 'order-1',
    state: 'awaiting_signature',
    transakStatus: 'PROCESSING',
    tokenAddress: TOKEN,
    tokenDecimals: 18,
    tokenAmount: null,
    relayTxHash: null,
    error: null,
    prepare: { ...goodPrepare(), ...prepare },
    ...order
  };
}

function inputWith(order: BuyOrder, fiatAmount = '50'): SignBuyOrderInput {
  return {
    account: { publicKey: 'miden-pk', evmAddress: EVM_ADDRESS, midenAccountHex: MIDEN_HEX },
    fiatAmount,
    order,
    nowSeconds: NOW
  };
}

function refusalOf(input: SignBuyOrderInput): BuySignRefusal | undefined {
  try {
    validateBuyPrepare(input);
    return undefined;
  } catch (error) {
    return error instanceof BuySignRefusedError ? error.reason : undefined;
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSignTypedData.mockResolvedValue(SIGNATURE);
  mockSignAuthorization.mockResolvedValue({
    address: CALIBUR_SEPOLIA_ADDRESS,
    chainId: 11155111,
    nonce: 7,
    r: R,
    s: S,
    yParity: 1
  });
  mockPost.mockResolvedValue({ state: 'signed' });
});

describe('validateBuyPrepare', () => {
  it('accepts good values', () => {
    expect(refusalOf(inputWith(orderWith()))).toBeUndefined();
  });

  const cases: ReadonlyArray<[BuySignRefusal, SignBuyOrderInput]> = [
    ['no-prepare', inputWith(orderWith({}, { prepare: null }))],
    ['chain', inputWith(orderWith({ chainId: 1 }))],
    ['calibur', inputWith(orderWith({ calibur: '0x3333333333333333333333333333333333333333' }))],
    ['evm-address', inputWith(orderWith({ evmAddress: '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359' }))],
    ['miden-account', inputWith(orderWith({ midenAccountHex: '0x' + '0b'.repeat(15) }))],
    ['token', inputWith(orderWith({}, { tokenAddress: '0x4444444444444444444444444444444444444444' }))],
    ['token', inputWith(orderWith({}, { tokenDecimals: 6 }))],
    ['nonce-key', inputWith(orderWith({ batchNonce: '3' }))],
    ['salt', inputWith(orderWith({ salt: `0x${'0'.repeat(24)}${'55'.repeat(20)}` }))],
    ['deadline', inputWith(orderWith({ deadline: NOW }))],
    ['deadline', inputWith(orderWith({ deadline: NOW + 86_400 + 61 }))],
    ['amount', inputWith(orderWith({ tokenAmount: '0' }))],
    // 50 USD allows at most 52.5 tokens.
    ['amount', inputWith(orderWith({ tokenAmount: 52_500_000_000_000_000_001n.toString() }))],
    ['fiat-amount', inputWith(orderWith(), 'fifty')]
  ];

  it.each(cases)('refuses with %s', (reason, input) => {
    expect(refusalOf(input)).toBe(reason);
  });

  it('accepts the largest amount inside the margin', () => {
    expect(refusalOf(inputWith(orderWith({ tokenAmount: 52_500_000_000_000_000_000n.toString() })))).toBeUndefined();
  });

  it('refuses an account with no valid EVM address', () => {
    const input = inputWith(orderWith());
    expect(refusalOf({ ...input, account: { ...input.account, evmAddress: 'not-an-address' } })).toBe('evm-address');
  });
});

describe('signBuyOrder', () => {
  it('signs the locally built batch and posts the echoed values', async () => {
    const order = orderWith();

    await expect(signBuyOrder(inputWith(order))).resolves.toBe('signed');

    expect(mockBuildClient).toHaveBeenCalledWith('miden-pk', EVM_ADDRESS);
    const { batch } = validateBuyPrepare(inputWith(order));
    expect(mockSignTypedData).toHaveBeenCalledWith(expect.objectContaining(buyBatchTypedData(batch)));
    expect(mockSignAuthorization).not.toHaveBeenCalled();
    expect(mockPost).toHaveBeenCalledWith('order-1', {
      batchNonce: goodPrepare().batchNonce,
      salt: SALT,
      deadline: NOW + 86_400,
      tokenAmount: goodPrepare().tokenAmount,
      signature: SIGNATURE
    });
  });

  it('also signs a Calibur authorization when the address is not delegated', async () => {
    await signBuyOrder(inputWith(orderWith({ needsAuthorization: true })));

    expect(mockSignAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ contractAddress: CALIBUR_SEPOLIA_ADDRESS, chainId: 11155111, nonce: 7 })
    );
    expect(mockPost).toHaveBeenCalledWith(
      'order-1',
      expect.objectContaining({
        authorization: { address: CALIBUR_SEPOLIA_ADDRESS, chainId: 11155111, nonce: 7, r: R, s: S, yParity: 1 }
      })
    );
  });

  it('signs nothing and posts nothing when a value is refused', async () => {
    await expect(signBuyOrder(inputWith(orderWith({ chainId: 1 })))).rejects.toBeInstanceOf(BuySignRefusedError);

    expect(mockSignTypedData).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });
});
