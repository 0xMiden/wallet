import type { EIP1193Provider } from 'viem';

import { buildEvmOneClickTransaction, OneClickDepositBroadcastError, submitEvmOneClickDeposit } from './evm';
import type { OneClickAsset, OneClickConfig, OneClickQuoteRequest, OneClickQuoteResponse } from './types';

jest.mock('./client', () => ({
  ...jest.requireActual('./client'),
  assertOneClickQuoteBinding: jest.fn()
}));

const native: OneClickAsset = {
  assetId: 'eth:native',
  blockchain: 'eth',
  symbol: 'ETH',
  decimals: 18,
  contractAddress: 'native',
  chainId: 1
};
const token: OneClickAsset = {
  assetId: 'base:token',
  blockchain: 'base',
  symbol: 'USDC',
  decimals: 6,
  contractAddress: '0x1111111111111111111111111111111111111111',
  chainId: 8453
};
const deposit = '0x2222222222222222222222222222222222222222';
const account = '0x3333333333333333333333333333333333333333';
const refundAccount = '0x4444444444444444444444444444444444444444';
const txHash = `0x${'a'.repeat(64)}`;
const config: OneClickConfig = { serviceUrl: 'https://proxy.example', midenAssets: [] };
function signedDeposit(deadline = '2099-10-22T12:00:00.000Z'): {
  request: OneClickQuoteRequest;
  quote: OneClickQuoteResponse;
} {
  const request: OneClickQuoteRequest = {
    amount: '1000',
    originAsset: token,
    destinationAsset: { assetId: 'miden:usdc', blockchain: 'miden', symbol: 'USDC', decimals: 6 },
    refundTo: account,
    recipient: 'miden-account',
    deadline,
    slippageTolerance: 100
  };
  const quote: OneClickQuoteResponse = {
    correlationId: 'trace',
    timestamp: '2026-10-22T10:00:00.000Z',
    signature: 'test-signature',
    quoteRequest: {
      dry: false,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: token.assetId,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: 'miden:usdc',
      amount: '1000',
      refundTo: request.refundTo,
      refundType: 'ORIGIN_CHAIN',
      recipient: request.recipient,
      recipientType: 'DESTINATION_CHAIN',
      deadline
    },
    quote: {
      amountIn: '1000',
      amountInFormatted: '0.001',
      amountInUsd: '1',
      minAmountIn: '1000',
      amountOut: '1000',
      amountOutFormatted: '0.001',
      amountOutUsd: '1',
      minAmountOut: '990',
      timeEstimate: 60,
      depositAddress: deposit,
      deadline
    }
  };
  return { request, quote };
}

const mockRequest = jest.fn();
const mockAssertFunded = jest.fn();

jest.mock('./evm-balance', () => ({
  assertOneClickEvmDepositFunded: (...args: unknown[]) => mockAssertFunded(...args)
}));

function providerWith(answer: (method: string) => unknown | Promise<unknown>): EIP1193Provider {
  mockRequest.mockImplementation(async ({ method }: { method: string }) => answer(method));
  return { request: mockRequest, on: jest.fn(), removeListener: jest.fn() };
}

describe('EVM 1Click transfer construction', () => {
  it('sends a native asset directly to the signed deposit address for the exact quoted amount', () => {
    expect(buildEvmOneClickTransaction(native, deposit, '1000000000000000000', account)).toEqual({
      from: account,
      to: deposit,
      value: '0xde0b6b3a7640000',
      chainId: '0x1'
    });
  });

  it('encodes an ERC-20 transfer only to the asset contract and exact deposit address', () => {
    const transaction = buildEvmOneClickTransaction(token, deposit, '1234567', account);
    expect(transaction.from).toBe(account);
    expect(transaction.to).toBe(token.contractAddress);
    expect(transaction.chainId).toBe('0x2105');
    expect(transaction.data).toMatch(/^0xa9059cbb/);
    expect(transaction.data).toContain(deposit.slice(2).toLowerCase());
    expect(transaction.data).toContain(BigInt(1234567).toString(16));
  });

  it('refuses missing native markers, unsupported chains, decimals and unsafe amounts', () => {
    expect(() => buildEvmOneClickTransaction({ ...native, contractAddress: undefined }, deposit, '1', account)).toThrow(
      'verified transfer'
    );
    expect(() => buildEvmOneClickTransaction({ ...native, chainId: 2 }, deposit, '1', account)).toThrow('Unsupported');
    expect(() => buildEvmOneClickTransaction(token, deposit, '1.5', account)).toThrow('amount');
    expect(() => buildEvmOneClickTransaction(token, deposit, '9'.repeat(79), account)).toThrow('amount');
  });
});

describe('EVM 1Click wallet submission', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    mockRequest.mockReset();
    mockAssertFunded.mockReset().mockResolvedValue({});
  });

  it('requires the sending account to equal the quote refund account before wallet calls', async () => {
    const { request, quote } = signedDeposit();
    const wallet = providerWith(async () => '0x1');
    await expect(
      submitEvmOneClickDeposit({ provider: wallet, account: refundAccount, request, quote, config })
    ).rejects.toThrow('refund account');
    expect(wallet.request).not.toHaveBeenCalled();
  });

  it('switches to the asset chain, rechecks the account, then sends and persists the returned hash', async () => {
    const { request, quote } = signedDeposit();
    const calls: string[] = [];
    let switched = false;
    const wallet = providerWith(async method => {
      calls.push(method);
      if (method === 'eth_chainId') return switched ? '0x2105' : '0x5';
      if (method === 'wallet_switchEthereumChain') {
        switched = true;
        return null;
      }
      if (method === 'eth_accounts') return [account];
      if (method === 'eth_sendTransaction') return txHash;
      return null;
    });
    const onSubmitted = jest.fn(async () => undefined);
    await expect(
      submitEvmOneClickDeposit({ provider: wallet, account, request, quote, config, onSubmitted })
    ).resolves.toBe(txHash);
    expect(calls).toEqual([
      'eth_chainId',
      'wallet_switchEthereumChain',
      'eth_chainId',
      'eth_accounts',
      'eth_chainId',
      'eth_accounts',
      'eth_sendTransaction'
    ]);
    expect(mockAssertFunded).toHaveBeenCalledWith({ asset: token, account, depositAddress: deposit, amountIn: '1000' });
    expect(onSubmitted).toHaveBeenCalledWith(txHash);
    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'eth_sendTransaction',
        params: [expect.objectContaining({ chainId: '0x2105' })]
      })
    );
  });

  it('refuses to broadcast if the selected wallet account changed during network switching', async () => {
    const { request, quote } = signedDeposit();
    let switched = false;
    const wallet = providerWith(async method => {
      if (method === 'eth_chainId') return switched ? '0x2105' : '0x5';
      if (method === 'wallet_switchEthereumChain') {
        switched = true;
        return null;
      }
      if (method === 'eth_accounts') return [refundAccount];
      return null;
    });
    await expect(submitEvmOneClickDeposit({ provider: wallet, account, request, quote, config })).rejects.toThrow(
      'account changed'
    );
    expect(wallet.request).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'eth_sendTransaction' }));
  });

  it('refuses to open the signing prompt when the fresh balance check fails', async () => {
    const { request, quote } = signedDeposit();
    const wallet = providerWith(async method =>
      method === 'eth_chainId' ? '0x2105' : method === 'eth_accounts' ? [account] : null
    );
    mockAssertFunded.mockRejectedValueOnce(new Error('native balance is insufficient for gas'));
    await expect(submitEvmOneClickDeposit({ provider: wallet, account, request, quote, config })).rejects.toThrow(
      'insufficient for gas'
    );
    expect(wallet.request).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'eth_sendTransaction' }));
  });

  it('refuses to broadcast after the quote expires while a network-switch prompt is open', async () => {
    let now = Date.parse('2099-10-22T10:00:00.000Z');
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const deadline = '2099-10-22T10:00:02.000Z';
    const { request, quote } = signedDeposit(deadline);
    quote.quote.deadline = '2099-10-22T10:01:00.000Z';
    let switched = false;
    const wallet = providerWith(async method => {
      if (method === 'eth_chainId') return switched ? '0x2105' : '0x5';
      if (method === 'wallet_switchEthereumChain') {
        switched = true;
        now = Date.parse(deadline);
        return null;
      }
      if (method === 'eth_accounts') return [account];
      if (method === 'eth_sendTransaction') return txHash;
      return null;
    });
    await expect(submitEvmOneClickDeposit({ provider: wallet, account, request, quote, config })).rejects.toThrow(
      'expired'
    );
    expect(wallet.request).toHaveBeenCalledTimes(4);
    expect(wallet.request).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'eth_sendTransaction' }));
    nowSpy.mockRestore();
  });

  it('rechecks the signed request cutoff after the fresh balance read', async () => {
    let now = Date.parse('2099-10-22T10:00:00.000Z');
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const signedCutoff = '2099-10-22T10:00:02.000Z';
    const { request, quote } = signedDeposit(signedCutoff);
    quote.quote.deadline = '2099-10-22T10:01:00.000Z';
    const wallet = providerWith(async method => {
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'eth_accounts') return [account];
      if (method === 'eth_sendTransaction') return txHash;
      return null;
    });
    mockAssertFunded.mockImplementationOnce(async () => {
      now = Date.parse(signedCutoff);
      return {};
    });

    try {
      await expect(submitEvmOneClickDeposit({ provider: wallet, account, request, quote, config })).rejects.toThrow(
        'expired'
      );
      expect(wallet.request).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'eth_sendTransaction' }));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('returns a known-broadcast error with the hash when persistence fails after wallet submission', async () => {
    const { request, quote } = signedDeposit();
    const wallet = providerWith(async method => {
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'eth_accounts') return [account];
      if (method === 'eth_sendTransaction') return txHash;
      return null;
    });
    const onSubmitted = jest.fn(async () => {
      throw new Error('database unavailable');
    });
    const outcome = await submitEvmOneClickDeposit({
      provider: wallet,
      account,
      request,
      quote,
      config,
      onSubmitted
    }).catch(error => error);
    expect(outcome).toBeInstanceOf(OneClickDepositBroadcastError);
    expect(outcome).toMatchObject({ transactionHash: txHash });
    expect(onSubmitted).toHaveBeenCalledWith(txHash);
  });

  it('preserves the known transaction when the quote expires during the wallet send prompt', async () => {
    let now = Date.parse('2099-10-22T10:00:00.000Z');
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const deadline = '2099-10-22T10:00:02.000Z';
    const { request, quote } = signedDeposit(deadline);
    const wallet = providerWith(async method => {
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'eth_accounts') return [account];
      if (method === 'eth_sendTransaction') {
        now = Date.parse(deadline);
        return txHash;
      }
      return null;
    });
    const onSubmitted = jest.fn(async () => undefined);
    const outcome = await submitEvmOneClickDeposit({
      provider: wallet,
      account,
      request,
      quote,
      config,
      onSubmitted
    }).catch(error => error);
    expect(outcome).toBeInstanceOf(OneClickDepositBroadcastError);
    expect(outcome).toMatchObject({ transactionHash: txHash });
    expect(onSubmitted).toHaveBeenCalledWith(txHash);
    nowSpy.mockRestore();
  });
});
