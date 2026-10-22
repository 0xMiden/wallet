import { OneClickEvmBalanceDependencies, readOneClickEvmBalance } from './evm-balance';
import { OneClickAsset } from './types';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const DEPOSIT = '0x2222222222222222222222222222222222222222';

const native: OneClickAsset = {
  assetId: 'eth',
  blockchain: 'eth',
  symbol: 'ETH',
  decimals: 18,
  contractAddress: 'native',
  chainId: 1
};
const token: OneClickAsset = {
  assetId: 'usdc',
  blockchain: 'base',
  symbol: 'USDC',
  decimals: 6,
  contractAddress: '0x3333333333333333333333333333333333333333',
  chainId: 8453
};

function harness(overrides: Record<string, unknown> = {}) {
  const client = {
    getBlockNumber: jest.fn(async () => 10n),
    getBalance: jest.fn(async () => 1_000_000_000_000_000_000n),
    readContract: jest.fn(async () => 9_000_000n),
    estimateGas: jest.fn(async () => 50_000n),
    estimateFeesPerGas: jest.fn(async () => ({ maxFeePerGas: 22n })),
    estimateL1Fee: jest.fn(async () => 100n),
    ...overrides
  };
  const dependencies: OneClickEvmBalanceDependencies = {
    getChain: jest.fn(id =>
      id === 1 || id === 10 || id === 8453
        ? {
            id,
            name: id === 1 ? 'Ethereum' : 'Base',
            rpcUrl: 'https://rpc.example',
            publicRpcUrl: 'https://rpc.example',
            explorer: 'https://explorer.example',
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }
          }
        : undefined
    ),
    createClient: jest.fn(() => client),
    now: () => 1234
  };
  return { client, dependencies };
}

const transaction = { from: ACCOUNT, to: DEPOSIT, value: '0x0', chainId: '0x2105', data: '0xa9059cbb' };

describe('readOneClickEvmBalance', () => {
  it('keeps comparisons in base units and estimates the exact selected-chain transaction', async () => {
    const { client, dependencies } = harness();
    const result = await readOneClickEvmBalance(
      {
        asset: token,
        account: ACCOUNT,
        depositAddress: DEPOSIT,
        amountIn: '8500000',
        transaction
      },
      dependencies
    );

    expect(result.tokenBalance).toBe(9_000_000n);
    expect(result.requiredTokenAmount).toBe(8_500_000n);
    expect(result.nativeBalance).toBe(1_000_000_000_000_000_000n);
    expect(result.gasReserve).toBeGreaterThan(0n);
    expect(result.tokenSufficient).toBe(true);
    expect(result.gasSufficient).toBe(true);
    expect(result.canDeposit).toBe(true);
    expect(client.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: token.contractAddress,
        functionName: 'balanceOf',
        args: [ACCOUNT],
        blockNumber: 10n
      })
    );
    expect(client.estimateGas).toHaveBeenCalledWith(
      expect.objectContaining({
        account: ACCOUNT,
        to: DEPOSIT,
        chainId: 8453
      })
    );
  });

  it('subtracts the gas reserve from spendable native asset without floating point', async () => {
    const { dependencies } = harness({ getBalance: jest.fn(async () => 1_000_000n) });
    const result = await readOneClickEvmBalance(
      {
        asset: native,
        account: ACCOUNT,
        depositAddress: DEPOSIT,
        amountIn: '999999',
        transaction: { from: ACCOUNT, to: DEPOSIT, value: '0x0', chainId: '0x1' }
      },
      dependencies
    );

    expect(result.spendableTokenBalance).toBe(76_000n);
    expect(result.tokenSufficient).toBe(false);
    expect(result.gasSufficient).toBe(true);
    expect(result.canDeposit).toBe(false);
  });

  it('keeps full ERC20 spendable balance separate from native gas sufficiency', async () => {
    const { dependencies, client } = harness({ getBalance: jest.fn(async () => 0n) });
    const result = await readOneClickEvmBalance(
      {
        asset: token,
        account: ACCOUNT,
        depositAddress: DEPOSIT,
        amountIn: '1000000',
        transaction
      },
      dependencies
    );

    expect(result.spendableTokenBalance).toBe(9_000_000n);
    expect(result.tokenSufficient).toBe(true);
    expect(result.gasSufficient).toBe(false);
    expect(result.canDeposit).toBe(false);
    expect(client.estimateGas).not.toHaveBeenCalled();
  });

  it('returns a known token shortfall without letting a reverting gas estimate hide it', async () => {
    const { client, dependencies } = harness({
      readContract: jest.fn(async () => 9_000_000n),
      estimateGas: jest.fn(async () => {
        throw new Error('execution reverted: transfer amount exceeds balance');
      })
    });
    const result = await readOneClickEvmBalance(
      {
        asset: token,
        account: ACCOUNT,
        depositAddress: DEPOSIT,
        amountIn: '10000000',
        transaction
      },
      dependencies
    );

    expect(result.tokenSufficient).toBe(false);
    expect(result.gasCheckComplete).toBe(true);
    expect(result.gasSufficient).toBe(true);
    expect(result.canDeposit).toBe(false);
    expect(client.estimateGas).not.toHaveBeenCalled();
  });

  it('includes the Optimism L1 data fee in its native reserve', async () => {
    const optimismAsset = { ...token, blockchain: 'op' as const, chainId: 10 };
    const { client, dependencies } = harness();
    await readOneClickEvmBalance(
      {
        asset: optimismAsset,
        account: ACCOUNT,
        depositAddress: DEPOSIT,
        amountIn: '1000000',
        transaction: { ...transaction, chainId: '0xa' }
      },
      dependencies
    );
    expect(client.estimateL1Fee).toHaveBeenCalledWith(expect.objectContaining({ account: ACCOUNT, to: DEPOSIT }));
  });

  it('fails closed for unsupported chain, invalid address, malformed amount, and RPC failure', async () => {
    const { dependencies, client } = harness({
      readContract: jest.fn(async () => {
        throw new Error('rpc failed');
      })
    });
    await expect(
      readOneClickEvmBalance({ asset: { ...token, chainId: 2 }, account: ACCOUNT, transaction }, dependencies)
    ).rejects.toThrow(/network|chain/i);
    await expect(readOneClickEvmBalance({ asset: token, account: 'bad', transaction }, dependencies)).rejects.toThrow(
      /account|address/i
    );
    await expect(
      readOneClickEvmBalance({ asset: token, account: ACCOUNT, amountIn: '1.5', transaction }, dependencies)
    ).rejects.toThrow(/amount/i);
    await expect(readOneClickEvmBalance({ asset: token, account: ACCOUNT, transaction }, dependencies)).rejects.toThrow(
      'rpc failed'
    );
    expect(client.estimateGas).not.toHaveBeenCalled();
  });
});
