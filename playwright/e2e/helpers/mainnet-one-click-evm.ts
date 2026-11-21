import { createPublicClient, http, isAddress, isHash, parseAbi, type Address, type Hash, type Hex } from 'viem';

import { assertOneClickQuoteBinding } from '../../../src/lib/one-click/client';
import { buildEvmOneClickTransaction } from '../../../src/lib/one-click/evm';
import { assertOneClickFundingDeadline } from '../../../src/lib/one-click/deadline';
import type {
  OneClickAsset,
  OneClickConfig,
  OneClickQuoteRequest,
  OneClickQuoteResponse
} from '../../../src/lib/one-click/types';
import type { CounterpartyTransaction } from '../ios/helpers/wc-counterparty-request';
import { mainnetChain, mainnetRpc } from './mainnet-bridge-sources';

const ERC20_BALANCE_ABI = parseAbi(['function balanceOf(address account) view returns (uint256)']);
const GAS_PRICE_HEADROOM = 2n;
const MAX_TRANSFER_GAS_BY_CHAIN: Readonly<Record<number, bigint>> = { 1: 100_000n, 42161: 1_000_000n };

export interface MainnetEvmHolding {
  asset: OneClickAsset;
  balanceBaseUnits: bigint;
  nativeBalanceWei: bigint;
  gasPriceWei: bigint;
  gasReserveWei: bigint;
  client: MainnetEvmClient;
}

export interface MainnetEvmClient {
  estimateGas(input: { account: Address; to: Address; data: Hex; value: bigint }): Promise<bigint>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }>;
  getBalance(input: { address: Address }): Promise<bigint>;
  readTokenBalance(token: Address, account: Address): Promise<bigint>;
  waitForTransactionReceipt(input: { hash: Hash; timeout?: number }): Promise<{
    status: 'success' | 'reverted';
    effectiveGasPrice?: bigint;
    gasUsed: bigint;
  }>;
}

export interface MainnetOneClickEvmSenderInput {
  holding: MainnetEvmHolding;
  account: Address;
  config: OneClickConfig;
  gasBudgetWei: bigint;
  broadcast: (transaction: {
    to: Address;
    data: Hex;
    value: bigint;
    gas: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas?: bigint;
  }) => Promise<Hash>;
}

export interface MainnetOneClickEvmSender {
  bind(request: OneClickQuoteRequest, quote: OneClickQuoteResponse): void;
  send(transaction: CounterpartyTransaction, signal: AbortSignal): Promise<Hash>;
  readonly broadcastCount: number;
  receiptFee(hash: Hash, timeout?: number): Promise<bigint>;
}

export async function readMainnetEvmHolding(asset: OneClickAsset, account: Address): Promise<MainnetEvmHolding> {
  if (!asset.chainId || !asset.contractAddress) {
    throw new Error(`1Click asset ${asset.symbol} has no verified EVM transfer route`);
  }
  const maxTransferGas = MAX_TRANSFER_GAS_BY_CHAIN[asset.chainId];
  if (!maxTransferGas) throw new Error(`1Click asset ${asset.symbol} has no verified all-in gas bound`);
  const chain = mainnetChain(asset.chainId);
  const client = createPublicClient({ chain, transport: http(mainnetRpc(asset.chainId)) });
  const [nativeBalanceWei, gasPriceWei] = await Promise.all([
    client.getBalance({ address: account }),
    client.getGasPrice()
  ]);
  let balanceBaseUnits: bigint;
  if (asset.contractAddress === 'native') {
    balanceBaseUnits = nativeBalanceWei;
  } else {
    if (!isAddress(asset.contractAddress)) {
      throw new Error(`1Click asset ${asset.symbol} has an invalid EVM contract address`);
    }
    balanceBaseUnits = await client.readContract({
      address: asset.contractAddress,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [account]
    });
  }
  return {
    asset,
    balanceBaseUnits,
    nativeBalanceWei,
    gasPriceWei,
    gasReserveWei: maxTransferGas * gasPriceWei * GAS_PRICE_HEADROOM,
    client: {
      estimateGas: input => client.estimateGas(input),
      estimateFeesPerGas: () => client.estimateFeesPerGas(),
      getBalance: input => client.getBalance(input),
      readTokenBalance: (token, address) =>
        client.readContract({
          address: token,
          abi: ERC20_BALANCE_ABI,
          functionName: 'balanceOf',
          args: [address]
        }),
      waitForTransactionReceipt: input => client.waitForTransactionReceipt(input)
    }
  };
}

export function assertMainnetEvmFunding(holding: MainnetEvmHolding, principalBaseUnits: bigint): void {
  if (principalBaseUnits < 0n) throw new Error('The required EVM principal cannot be negative');
  const requiredNative =
    holding.asset.contractAddress === 'native' ? principalBaseUnits + holding.gasReserveWei : holding.gasReserveWei;
  if (holding.nativeBalanceWei < requiredNative) {
    throw new Error(`The existing ${holding.asset.blockchain} EVM account cannot cover the principal and reserved gas`);
  }
  if (holding.balanceBaseUnits < principalBaseUnits) {
    throw new Error(
      `The existing ${holding.asset.blockchain} account lacks the required ${holding.asset.symbol} principal`
    );
  }
}

export function createMainnetOneClickEvmSender({
  holding,
  account,
  config,
  gasBudgetWei,
  broadcast
}: MainnetOneClickEvmSenderInput): MainnetOneClickEvmSender {
  const supportedChain =
    (holding.asset.chainId === 1 && holding.asset.blockchain === 'eth') ||
    (holding.asset.chainId === 42161 && holding.asset.blockchain === 'arb');
  if (!supportedChain) {
    throw new Error(
      'The 1Click acceptance sender only supports Ethereum L1 and Arbitrum One with verifiable all-in fees'
    );
  }
  if (gasBudgetWei <= 0n || holding.gasPriceWei <= 0n || holding.gasReserveWei <= 0n) {
    throw new Error('The 1Click EVM gas budget and reserve must be positive');
  }
  if (!isAddress(account)) throw new Error('The 1Click EVM account is invalid');
  let expected: { target: string; data: string; value: bigint; amount: bigint; deadline: string } | undefined;
  let attempts = 0;
  let broadcastHash: Hash | undefined;

  return {
    bind(request, quote) {
      if (expected || attempts !== 0) throw new Error('The reviewed reverse 1Click transfer is already bound');
      assertOneClickQuoteBinding(request, quote, false, config);
      if (
        request.originAsset.assetId !== holding.asset.assetId ||
        request.originAsset.chainId !== holding.asset.chainId ||
        request.originAsset.contractAddress !== holding.asset.contractAddress ||
        request.originAsset.decimals !== holding.asset.decimals ||
        holding.asset.contractAddress === 'native' ||
        !holding.asset.contractAddress ||
        quote.quoteRequest.refundTo.toLowerCase() !== account.toLowerCase() ||
        quote.quoteRequest.amount !== request.amount ||
        quote.quote.amountIn !== request.amount ||
        quote.quote.depositAddress === undefined
      ) {
        throw new Error(
          'The signed reverse quote is not bound to the funded Ethereum account and exact received amount'
        );
      }
      const transfer = buildEvmOneClickTransaction(
        holding.asset,
        quote.quote.depositAddress,
        quote.quote.amountIn,
        account
      );
      if (!transfer.to || !transfer.from) {
        throw new Error('The reviewed reverse transfer has no exact sender or target');
      }
      const fundingDeadline = assertOneClickFundingDeadline(request.deadline, quote.quote.deadline);
      expected = {
        target: transfer.to,
        data: transfer.data ?? '0x',
        value: transfer.value ? BigInt(transfer.value) : 0n,
        amount: BigInt(quote.quote.amountIn),
        deadline: fundingDeadline
      };
    },
    async send(transaction, signal) {
      attempts += 1;
      if (attempts !== 1) throw new Error('The one-time reverse EVM transfer refuses a second send');
      if (!expected) throw new Error('The reviewed reverse 1Click transfer has not been bound');
      if (signal.aborted) throw new Error('The reverse EVM transfer was aborted before sending');
      assertQuoteNotExpired(expected.deadline);
      if (
        transaction.to.toLowerCase() !== expected.target.toLowerCase() ||
        transaction.data.toLowerCase() !== expected.data.toLowerCase() ||
        transaction.value !== expected.value
      ) {
        throw new Error('The WalletConnect transfer does not match the signed reverse 1Click deposit and amount');
      }
      const [gas, fees, currentNative, currentToken] = await Promise.all([
        holding.client.estimateGas({ account, to: transaction.to, data: transaction.data, value: transaction.value }),
        holding.client.estimateFeesPerGas(),
        holding.client.getBalance({ address: account }),
        readCurrentTokenBalance(holding, account)
      ]);
      if (signal.aborted) throw new Error('The reverse EVM transfer was aborted before sending');
      assertQuoteNotExpired(expected.deadline);
      const maxFeePerGas = fees.maxFeePerGas;
      const maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
      const maxTransferGas = MAX_TRANSFER_GAS_BY_CHAIN[holding.asset.chainId ?? 0];
      if (
        !maxFeePerGas ||
        maxFeePerGas <= 0n ||
        gas <= 0n ||
        !maxTransferGas ||
        gas > maxTransferGas ||
        maxFeePerGas > holding.gasPriceWei * GAS_PRICE_HEADROOM ||
        (maxPriorityFeePerGas !== undefined && maxPriorityFeePerGas > maxFeePerGas)
      ) {
        throw new Error('The reviewed reverse EVM transaction exceeds the captured gas or fee bound');
      }
      const maximumGasCost = gas * maxFeePerGas;
      const principalReserve = holding.asset.contractAddress === 'native' ? expected.amount : 0n;
      if (
        maximumGasCost > gasBudgetWei ||
        currentNative < holding.gasReserveWei + maximumGasCost + principalReserve ||
        currentToken < expected.amount
      ) {
        throw new Error('The existing EVM balance cannot cover the bounded transfer and retained gas reserve');
      }
      if (signal.aborted) throw new Error('The reverse EVM transfer was aborted before sending');
      const hash = await broadcast({
        to: transaction.to,
        data: transaction.data,
        value: transaction.value,
        gas,
        maxFeePerGas,
        ...(maxPriorityFeePerGas ? { maxPriorityFeePerGas } : {})
      });
      if (!isHash(hash)) throw new Error('The EVM signer returned an invalid transaction hash');
      broadcastHash = hash;
      return hash;
    },
    get broadcastCount() {
      return broadcastHash === undefined ? 0 : 1;
    },
    async receiptFee(hash, timeout) {
      if (!broadcastHash || hash !== broadcastHash) {
        throw new Error('The receipt hash is not the recorded reverse transfer');
      }
      const receipt = await holding.client.waitForTransactionReceipt({
        hash,
        ...(timeout === undefined ? {} : { timeout })
      });
      if (receipt.effectiveGasPrice === undefined) {
        throw new Error('The reverse EVM receipt has no verifiable all-in fee');
      }
      return receipt.gasUsed * receipt.effectiveGasPrice;
    }
  };
}

function assertQuoteNotExpired(deadline: string): void {
  const expiresAt = Date.parse(deadline);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error('The signed reverse 1Click deposit quote has expired');
  }
}

async function readCurrentTokenBalance(holding: MainnetEvmHolding, account: Address): Promise<bigint> {
  if (holding.asset.contractAddress === 'native') return holding.client.getBalance({ address: account });
  if (!holding.asset.contractAddress || !isAddress(holding.asset.contractAddress)) {
    throw new Error('The reverse 1Click asset has no verified ERC20 balance method');
  }
  return holding.client.readTokenBalance(holding.asset.contractAddress, account);
}
