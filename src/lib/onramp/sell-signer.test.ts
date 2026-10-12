/**
 * @jest-environment node
 */
import { type Hex } from 'viem';

import { buildVaultEvmWalletClient } from 'lib/epoch/evm-account';

import { BackendOrder, BuyOrderPrepare, postBuySignature } from './buy-api';
import { CALIBUR_SEPOLIA_ADDRESS, OFFRAMP_NONCE_KEY, ONRAMP_NONCE_KEY, sellBatchTypedData } from './buy-batch';
import {
  SELL_RELAY_TOKEN,
  SellSignRefusal,
  SellSignRefusedError,
  SignSellOrderInput,
  sellRelayTokenAmount,
  signSellOrder,
  validateSellPrepare
} from './sell-signer';

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
const DEPOSIT = '0x57359A5071a83D3b5640BDcb7Ad17c70F40088A4';
const OTHER = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
const MIDEN_HEX = '0x' + '0a'.repeat(15);
const SALT: Hex = `0x${'0'.repeat(24)}00000cabfc76478c1537dd418ab00967cbbe4ae6`;
const SIGNATURE: Hex = `0x${'11'.repeat(65)}`;
/** 100 TRNSK sold: the full amount in base units, 18 decimals. */
const AMOUNT_UNITS = 100n * 10n ** 18n;
const AMOUNT = AMOUNT_UNITS.toString();

function goodPrepare(): BuyOrderPrepare {
  return {
    chainId: 11155111,
    calibur: CALIBUR_SEPOLIA_ADDRESS,
    evmAddress: EVM_ADDRESS,
    midenAccountHex: MIDEN_HEX,
    executor: '0x2222222222222222222222222222222222222222',
    batchNonce: ((OFFRAMP_NONCE_KEY << 64n) + 1n).toString(),
    salt: SALT,
    deadline: NOW + 3000,
    needsAuthorization: false,
    authorizationNonce: 7,
    tokenAmount: AMOUNT,
    depositAddress: DEPOSIT
  };
}

function orderWith(prepare: Partial<BuyOrderPrepare> = {}, order: Partial<BackendOrder> = {}): BackendOrder {
  return {
    id: 'order-1',
    side: 'sell',
    state: 'awaiting_signature',
    transakStatus: 'AWAITING_PAYMENT_FROM_USER',
    tokenAddress: SELL_RELAY_TOKEN.address,
    tokenDecimals: SELL_RELAY_TOKEN.decimals,
    tokenAmount: AMOUNT,
    relayTxHash: null,
    error: null,
    depositAddress: DEPOSIT,
    depositAmount: 100,
    autoExpiresAt: NOW + 3600,
    prepare: { ...goodPrepare(), ...prepare },
    ...order
  };
}

function inputWith(order: BackendOrder, extra: Partial<SignSellOrderInput> = {}): SignSellOrderInput {
  return {
    account: { publicKey: 'miden-pk', evmAddress: EVM_ADDRESS, midenAccountHex: MIDEN_HEX },
    depositAddress: DEPOSIT,
    cryptoAmount: '100',
    order,
    nowSeconds: NOW,
    ...extra
  };
}

function refusalOf(input: SignSellOrderInput): SellSignRefusal | undefined {
  try {
    validateSellPrepare(input);
    return undefined;
  } catch (error) {
    return error instanceof SellSignRefusedError ? error.reason : undefined;
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSignTypedData.mockResolvedValue(SIGNATURE);
  mockSignAuthorization.mockResolvedValue({
    address: CALIBUR_SEPOLIA_ADDRESS,
    chainId: 11155111,
    nonce: 7,
    r: `0x${'22'.repeat(32)}`,
    s: `0x${'33'.repeat(32)}`,
    yParity: 1
  });
  mockPost.mockResolvedValue({ state: 'signed' });
});

describe('sellRelayTokenAmount', () => {
  it('gives the full shown crypto amount in TRNSK base units', () => {
    expect(SELL_RELAY_TOKEN).toEqual({
      address: '0x0c86a754a29714c4fe9c6f1359fa7099ed174c0b',
      decimals: 18,
      symbol: 'TRNSK'
    });
    expect(sellRelayTokenAmount('100')).toBe(100n * 10n ** 18n);
    expect(sellRelayTokenAmount('12.5')).toBe(125n * 10n ** 17n);
  });

  it('refuses an amount that the token cannot hold exactly', () => {
    expect(() => sellRelayTokenAmount(`0.${'1'.repeat(19)}`)).toThrow(SellSignRefusedError);
  });
});

describe('validateSellPrepare', () => {
  it('accepts good values', () => {
    expect(refusalOf(inputWith(orderWith()))).toBeUndefined();
  });

  const cases: ReadonlyArray<[SellSignRefusal, SignSellOrderInput]> = [
    ['no-prepare', inputWith(orderWith({}, { prepare: null }))],
    ['side', inputWith(orderWith({}, { side: 'buy' }))],
    ['chain', inputWith(orderWith({ chainId: 1 }))],
    ['calibur', inputWith(orderWith({ calibur: OTHER }))],
    ['evm-address', inputWith(orderWith({ evmAddress: OTHER }))],
    ['miden-account', inputWith(orderWith({ midenAccountHex: '0x' + '0b'.repeat(15) }))],
    ['token', inputWith(orderWith({}, { tokenAddress: OTHER }))],
    ['token', inputWith(orderWith({}, { tokenDecimals: 6 }))],
    // The backend names another deposit address than the Transak page did.
    ['deposit-address', inputWith(orderWith({ depositAddress: OTHER }))],
    ['deposit-address', inputWith(orderWith({ depositAddress: null }))],
    ['deposit-address', inputWith(orderWith(), { depositAddress: 'not-an-address' })],
    ['nonce-key', inputWith(orderWith({ batchNonce: ((ONRAMP_NONCE_KEY << 64n) + 1n).toString() }))],
    ['salt', inputWith(orderWith({ salt: `0x${'0'.repeat(24)}${'ab'.repeat(20)}` }))],
    ['deadline', inputWith(orderWith({ deadline: NOW - 1 }))],
    // Past the Transak expiry: the signature must die with the order.
    ['deadline', inputWith(orderWith({ deadline: NOW + 3600 + 120 }))],
    // The old test relay sent a hundredth of the amount: the full amount is the only one accepted.
    ['amount', inputWith(orderWith({ tokenAmount: (AMOUNT_UNITS / 100n).toString() }))],
    ['amount', inputWith(orderWith({ tokenAmount: '100000000' }))],
    ['amount', inputWith(orderWith(), { cryptoAmount: '50' })],
    ['crypto-amount', inputWith(orderWith(), { cryptoAmount: 'ten' })]
  ];

  it.each(cases)('refuses %s', (reason, input) => {
    expect(refusalOf(input)).toBe(reason);
  });

  it('accepts a deadline up to the Transak expiry, and the deposit address in another case', () => {
    expect(refusalOf(inputWith(orderWith({ deadline: NOW + 3600 })))).toBeUndefined();
    expect(refusalOf(inputWith(orderWith(), { depositAddress: DEPOSIT.toLowerCase() }))).toBeUndefined();
  });
});

describe('signSellOrder', () => {
  it('signs the transfer batch to the page address and posts the prepare values', async () => {
    const order = orderWith();
    await expect(signSellOrder(inputWith(order))).resolves.toBe('signed');
    expect(mockBuildClient).toHaveBeenCalledWith('miden-pk', EVM_ADDRESS);
    const prepare = goodPrepare();
    expect(mockSignTypedData).toHaveBeenCalledWith({
      account: { address: EVM_ADDRESS, type: 'local' },
      ...sellBatchTypedData({
        evmAddress: EVM_ADDRESS,
        token: SELL_RELAY_TOKEN.address,
        depositAddress: DEPOSIT,
        amount: AMOUNT_UNITS,
        batchNonce: BigInt(prepare.batchNonce),
        salt: SALT,
        executor: prepare.executor,
        deadline: BigInt(prepare.deadline)
      })
    });
    expect(mockSignAuthorization).not.toHaveBeenCalled();
    expect(mockPost).toHaveBeenCalledWith('order-1', {
      batchNonce: prepare.batchNonce,
      salt: SALT,
      deadline: prepare.deadline,
      tokenAmount: AMOUNT,
      signature: SIGNATURE
    });
  });

  it('adds the authorization when the backend asks for one', async () => {
    await signSellOrder(inputWith(orderWith({ needsAuthorization: true })));
    expect(mockSignAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ contractAddress: CALIBUR_SEPOLIA_ADDRESS, chainId: 11155111, nonce: 7 })
    );
    expect(mockPost.mock.calls[0]?.[1].authorization).toMatchObject({ address: CALIBUR_SEPOLIA_ADDRESS, nonce: 7 });
  });

  it('signs nothing when a check fails', async () => {
    await expect(signSellOrder(inputWith(orderWith({ depositAddress: OTHER })))).rejects.toBeInstanceOf(
      SellSignRefusedError
    );
    expect(mockSignTypedData).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });
});
