import {
  EpochIntentSDK,
  executeWalletBatch,
  resolveWalletBatchStrategy,
  TaskType
} from '@epoch-protocol/epoch-intents-sdk';
import { type Address, createPublicClient, formatUnits, http, parseUnits } from 'viem';
import { sepolia } from 'viem/chains';

import { registerPendingBridgeIn } from 'lib/miden/activity';

import { buildEVMToMidenTaskDataParams } from './bridge';
import { BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS } from './bridgeable-token';
import { EPOCH_ALLOCATOR_URL, MIDEN_DESTINATION_CHAIN_ID } from './config';
import { EARN_PROTOCOL_HASH, EARN_UNDERLYING, MIDEN_USDC_FAUCET } from './earn';
import { buildVaultEvmWalletClient } from './evm-account';
import { ensureEpochSmartAccount } from './sdk';

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export interface GaslessEarnWithdrawalArgs {
  midenAccountPublicKey: string;
  evmAddress: string;
  marketUid: string;
  underlyingAddress: string;
  /** Human-decimal withdrawable amount returned by the positions API. */
  amount: string;
  underlyingDecimals: number;
}

export interface GaslessEarnWithdrawalResult {
  nonce: string;
}

interface GaslessEarnWithdrawalDeps {
  sdk?: EpochIntentSDK;
  ensureSmartAccount?: typeof ensureEpochSmartAccount;
  registerBridgeIn?: typeof registerPendingBridgeIn;
}

function asAddress(value: string, label: string): Address {
  if (!EVM_ADDRESS_RE.test(value)) throw new Error(`${label} is not a valid EVM address.`);
  return value as Address;
}

function parseWithdrawAmount(value: string, decimals: number): bigint {
  const match = value.trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error('Withdraw amount is invalid.');
  const fraction = (match[2] ?? '').slice(0, decimals);
  return parseUnits(fraction ? `${match[1]}.${fraction}` : match[1]!, decimals);
}

/** Build the direct lending-protocol withdrawal task. */
export function buildEarnWithdrawTaskDataParams(args: {
  sponsorAddress: Address;
  marketUid: string;
  underlyingAddress: Address;
  amountAtomic: string;
  chainId: number;
}) {
  return {
    taskType: TaskType.ProtocolInteraction,
    intentData: {
      isNative: false,
      depositTokenAddress: args.underlyingAddress,
      tokenInAmount: args.amountAtomic,
      outputTokenAddress: args.underlyingAddress,
      minTokenOut: '0',
      destinationChainId: String(args.chainId),
      protocolHashIdentifier: EARN_PROTOCOL_HASH,
      recipient: args.sponsorAddress
    },
    extraDataTypestring: 'string marketUid,string action,string payAsset,bool isAll,bool simulate',
    extraData: {
      marketUid: args.marketUid,
      action: 'withdraw',
      payAsset: args.underlyingAddress,
      isAll: false, // true → protocol max-withdraw (maxUint256 / share redeem)
      simulate: true // always true on withdraw
    }
  };
}

/** Withdraw an Earn position and deliver the underlying asset to Miden using Epoch's gasless route. */
export async function gaslessEarnWithdrawalToMiden(
  args: GaslessEarnWithdrawalArgs,
  deps: GaslessEarnWithdrawalDeps = {}
): Promise<GaslessEarnWithdrawalResult> {
  const sponsorAddress = asAddress(args.evmAddress, 'Position owner');
  const underlyingAddress = asAddress(args.underlyingAddress, 'Underlying token');
  if (!args.midenAccountPublicKey) throw new Error('A Miden destination account is required.');
  if (!args.marketUid) throw new Error('The lending market identifier is missing.');
  if (
    underlyingAddress.toLowerCase() !== EARN_UNDERLYING.toLowerCase() ||
    args.underlyingDecimals !== BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS
  ) {
    throw new Error('Gasless withdrawal only supports the configured USDC Earn market.');
  }

  const chainId = Number(args.marketUid.split(':')[1]);
  if (chainId !== sepolia.id) throw new Error('Gasless withdrawal currently supports Sepolia only.');
  const amountAtomic = parseWithdrawAmount(args.amount, args.underlyingDecimals);
  if (amountAtomic <= 0n) throw new Error('Withdraw amount must be greater than zero.');

  const ensureSmartAccount = deps.ensureSmartAccount ?? ensureEpochSmartAccount;
  await ensureSmartAccount(args.midenAccountPublicKey, sponsorAddress);
  const walletClient = buildVaultEvmWalletClient(args.midenAccountPublicKey, sponsorAddress);
  const sdk =
    deps.sdk ??
    new EpochIntentSDK({
      apiBaseUrl: EPOCH_ALLOCATOR_URL,
      walletClient,
      allowGaslessSmartAccount: true
    });

  console.log('=== Gasless status ===');
  const status = await sdk.getWalletGaslessStatus(chainId);
  console.log(status);

  if (!status.is7702Capable) {
    console.log('Wallet/chain not 7702-capable — call convertToSmartAccount before gasless solveIntent.');
    throw new Error('Walelt is not capable');
  }

  if (status.needsSetup) {
    console.log('=== convertToSmartAccount (local private-key EOA) ===');
    const setup = await sdk.convertToSmartAccount({ chainId });
    console.log(setup);
    if (!setup.ok) {
      console.log('Conversion failed — use user-paid flow or fix delegation conflict.');
      throw new Error('setup failed');
    }
  }

  const withdrawTask = await sdk.getTaskData(
    buildEarnWithdrawTaskDataParams({
      sponsorAddress,
      marketUid: args.marketUid,
      underlyingAddress,
      amountAtomic: amountAtomic.toString(),
      chainId
    })
  );
  const withdrawQuote = await sdk.getIntentQuote({
    sponsorAddress,
    taskTypeString: withdrawTask.taskTypeString,
    intentData: withdrawTask.intentData,
    isNative: false
  });
  if (!withdrawQuote.success) throw new Error(withdrawQuote.error ?? 'Earn withdrawal quote failed.');
  const withdrawTxs = withdrawQuote.transactions ?? [];

  const swapTask = await sdk.getTaskData(
    buildEVMToMidenTaskDataParams({
      sourceChainId: chainId,
      destinationChainId: MIDEN_DESTINATION_CHAIN_ID,
      evmSourceAddress: sponsorAddress,
      evmTokenAddress: underlyingAddress,
      evmAmount: formatUnits(amountAtomic, args.underlyingDecimals),
      evmTokenDecimals: args.underlyingDecimals,
      midenRecipientId: args.midenAccountPublicKey,
      midenFaucetId: MIDEN_USDC_FAUCET,
      // A zero minimum selects Epoch's normal fixed-input forward quote.
      minTokenOut: '0'
    })
  );
  const swapQuote = await sdk.getIntentQuote({
    sponsorAddress,
    taskTypeString: swapTask.taskTypeString,
    intentData: swapTask.intentData,
    isNative: false
  });
  if (!swapQuote.success) throw new Error(swapQuote.error ?? 'Miden delivery quote failed.');
  // 3. Deposit calls — from the SWAP leg
  const { calls: lockCalls, createAllocationRequest } = await sdk.buildResourceLockCalls({
    isNative: false,
    sponsorAddress,
    taskTypeString: swapTask.taskTypeString,
    intentData: swapTask.intentData,
    quoteResult: swapQuote
  });

  // 4. Prepend withdraw calldata → [withdraw, approve, depositERC20AndRegister]
  const calls = [
    ...withdrawTxs.map(t => ({
      to: t.target as `0x${string}`,
      data: t.callData as `0x${string}`,
      value: BigInt(t.value ?? '0')
    })),
    ...lockCalls.map(c => ({
      to: c.to as `0x${string}`,
      data: c.data as `0x${string}`,
      value: BigInt(c.value ?? '0')
    }))
  ];

  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(sepolia.rpcUrls.default.http[0])
  });

  const strategy = await resolveWalletBatchStrategy({
    walletClient,
    chainId: sepolia.id,
    user: sponsorAddress,
    publicClient
  });
  console.log(strategy);
  await executeWalletBatch({
    walletClient,
    chainId: sepolia.id,
    account: sponsorAddress,
    calls,
    forceAtomic: true
  });

  const { nonce } = await sdk.submitAllocation(createAllocationRequest);
  const nonceString = String(nonce);

  const registerBridgeIn = deps.registerBridgeIn ?? registerPendingBridgeIn;
  await registerBridgeIn(sponsorAddress, nonceString, {
    provider: 'epoch',
    sourceAmount: args.amount,
    sourceSymbol: 'USDC',
    intentNonce: nonceString
  });

  return { nonce: nonceString };
}
