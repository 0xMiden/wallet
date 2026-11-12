import { createRequire } from 'node:module';
import { join } from 'node:path';

import type { EpochIntentSDKConfig } from '@epoch-protocol/epoch-intents-sdk';
import { createWalletClient, custom, getAddress } from 'viem';
import { arbitrum, mainnet } from 'viem/chains';

import { parseMainnetEpochCheckpoint, type MainnetEpochCheckpoint, type EpochEvmSnapshot } from './mainnet-epoch-checkpoint';
import { planEpochRoundTrip } from './mainnet-epoch-ui';

type ReadOnlySdk = typeof import('../../../scripts/helpers/mainnet-epoch-readonly-sdk');
export type EpochPrepareInput = Pick<MainnetEpochCheckpoint,
  'account' | 'accountHex' | 'sourceRunId' | 'native' | 'allocatorUrl' | 'principal' |
  'reverseMinimum' | 'lossBudgetUsdMicros' | 'feeBudget' | 'evmFeeBudget' | 'pricedAt'> & {
  evm: Omit<EpochEvmSnapshot, 'compact' | 'allocator'>;
  currentBlock: number;
};

export async function prepareEpochRoundTrip(input: EpochPrepareInput): Promise<MainnetEpochCheckpoint> {
  if (!Number.isSafeInteger(input.currentBlock) || input.currentBlock <= 0)
    throw new Error('Invalid live Miden block height for Epoch preparation');
  const reverseProvider = epochReadOnlyProvider(input.allocatorUrl, input.evm.chainId, input.evm.account);
  const { sdk } = reverseProvider;
  const forwardProvider = epochReadOnlyProvider(input.allocatorUrl, sdk.MIDEN_VIRTUAL_CHAIN_ID, input.evm.account);
  const service = await sdk.resolveServiceConfiguration(reverseProvider.config, input.evm.chainId);
  if (service.midenMainnetVirtualChainId !== sdk.MIDEN_VIRTUAL_CHAIN_ID)
    throw new Error('Epoch service has an unexpected mainnet virtual chain');
  const collateral = await sdk.getMidenCollateralConfig(forwardProvider.config);
  const recallBlocks = collateral.minReclaimBlocks + collateral.recallBufferBlocks;
  const reclaimHeight = input.currentBlock + recallBlocks;
  if (!Number.isSafeInteger(reclaimHeight) || reclaimHeight > 0xffff_ffff)
    throw new Error('Epoch reclaim block exceeds its authorized height range');
  const zero = '0x0000000000000000000000000000000000000000';
  const protocolHashIdentifier = `0x${'0'.repeat(64)}`;
  const forwardTask = sdk.getTaskData({
    taskType: sdk.TaskType.GetTokenOut,
    intentData: { isNative: false, depositTokenAddress: zero, tokenInAmount: input.principal,
      outputTokenAddress: input.evm.token, minTokenOut: '0', destinationChainId: String(input.evm.chainId),
      protocolHashIdentifier, recipient: input.evm.account },
    extraDataTypestring: `uint256 midenReclaimHeight,${sdk.MIDEN_TO_EVM_EXTRA_TYPESTRING}`,
    extraData: { midenSourceAccount: input.accountHex, midenFaucetId: input.native.hex,
      midenNoteType: 'P2IDE', midenNoteId: '', midenReclaimHeight: String(reclaimHeight) }
  });
  const sponsorAddress = getAddress(input.evm.account);
  const forward = await sdk.getIntentQuote(forwardProvider.config, { ...forwardTask, sponsorAddress, isNative: false });
  const positive = (value: unknown): value is string => typeof value === 'string' &&
    /^[1-9]\d{0,77}$/.test(value) && BigInt(value) < (1n << 256n);
  if (!forward.success || forward.tokenIn !== input.principal || !positive(forward.tokenOut))
    throw new Error('Epoch forward quote does not bind the exact principal and positive output');
  const reverseTask = sdk.getTaskData({
    taskType: sdk.TaskType.GetTokenOut,
    intentData: { isNative: false, depositTokenAddress: input.evm.token, tokenInAmount: '0',
      outputTokenAddress: zero, minTokenOut: input.reverseMinimum,
      destinationChainId: String(sdk.MIDEN_VIRTUAL_CHAIN_ID), protocolHashIdentifier, recipient: input.evm.account },
    extraDataTypestring: sdk.EVM_TO_MIDEN_EXTRA_TYPESTRING,
    extraData: { midenRecipientAccount: input.accountHex, midenFaucetId: input.native.hex }
  });
  const reverse = await sdk.getIntentQuote(reverseProvider.config, { ...reverseTask, sponsorAddress, isNative: false });
  if (!reverse.success || !positive(reverse.tokenIn) || reverse.tokenOut !== input.reverseMinimum ||
      BigInt(reverse.tokenIn) > BigInt(forward.tokenOut))
    throw new Error('Epoch reverse quote exceeds guaranteed proceeds or changes its output floor');
  const prepared = await sdk.getCompactData(forwardProvider.config, { ...forwardTask, sponsorAddress, isNative: false });
  const now = new Date().toISOString();
  const state = parseMainnetEpochCheckpoint({
    version: 1, network: 'mainnet', account: input.account, accountHex: input.accountHex,
    sourceRunId: input.sourceRunId, authorizationRunId: input.sourceRunId, phase: 'forward-authorized',
    createdAt: now, updatedAt: now, pricedAt: input.pricedAt, native: input.native,
    evm: { ...input.evm, compact: service.compactAddress, allocator: service.allocatorAddress },
    allocatorUrl: forwardProvider.config.apiBaseUrl, virtualChainId: sdk.MIDEN_VIRTUAL_CHAIN_ID,
    midenAllocator: collateral.recipientAccountId, recallBlocks, minimumRecallBlocks: collateral.minReclaimBlocks,
    principal: input.principal, forwardMinimum: forward.tokenOut, reverseMinimum: input.reverseMinimum,
    lossBudgetUsdMicros: input.lossBudgetUsdMicros, feeBudget: input.feeBudget, evmFeeBudget: input.evmFeeBudget,
    paidMidenFees: '0', paidEvmFees: '0', forwardNonce: prepared.compactData.nonce.toString()
  });
  planEpochRoundTrip(state, BigInt(reverse.tokenIn));
  return state;
}

export function epochReadOnlyProvider(serviceUrl: string, chainId: number, actor: string): {
  config: EpochIntentSDKConfig;
  sdk: ReadOnlySdk;
} {
  const url = new URL(serviceUrl);
  if (serviceUrl.length > 512 || serviceUrl.trim() !== serviceUrl || url.protocol !== 'https:' ||
      url.username || url.password || url.search || url.hash)
    throw new Error('Epoch qualification requires a real HTTPS provider');
  // Bundle the installed SDK's extensionless imports; expose no funded methods.
  const sdk: ReadOnlySdk = createRequire(join(process.cwd(), 'package.json'))(
    join(process.cwd(), 'node_modules/.cache/nightly-epoch-readonly-sdk.cjs')
  );
  if (![1, 42161, sdk.MIDEN_VIRTUAL_CHAIN_ID].includes(chainId))
    throw new Error('Unsupported mainnet Epoch source chain');
  const chain = chainId === sdk.MIDEN_VIRTUAL_CHAIN_ID ? { ...mainnet, id: chainId } : chainId === 1 ? mainnet : arbitrum;
  const walletClient = createWalletClient({
    account: getAddress(actor), chain,
    transport: custom({ request: async () => { throw new Error('Epoch quote transport is read-only; EVM RPC is forbidden'); } }, { retryCount: 0 })
  });
  return { config: { apiBaseUrl: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, walletClient }, sdk };
}
