// Adapted from bridge-portal@cb52c470 src/bridge/providers/agglayer/{deposit,agglayer}.ts (MIT).
import {
  encodeFunctionData,
  erc20Abi,
  isAddress,
  isHash,
  parseAbi,
  parseUnits,
  toHex,
  type Address,
  type EIP1193Provider,
  type Hash,
  type Hex,
  type PublicClient
} from 'viem';

import { AGGLAYER_BRIDGE_ABI } from 'lib/agglayer/constant';
import { midenAddrToEvmAddr } from 'lib/agglayer/contract';
import { assertReviewedBridge } from 'lib/bridge/core/review';
import { configKey } from 'lib/bridge/core/routes';
import { validateTransferAmount } from 'lib/bridge/core/rules';
import type { SubmissionChecks } from 'lib/bridge/core/submission';
import type { SourceTransactionClient } from 'lib/bridge/evm/source-transaction';
import {
  assertBridgeOperationCurrent,
  bridgeOperationOf,
  recordBridgeSourceAttempt,
  type BridgeOperationSnapshot
} from 'lib/bridge/operation';
import * as Repo from 'lib/miden/repo';
import { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { selectAgglayerRecoveryConfig } from 'lib/remote-config/values';

import { ensureAgglayerApproval } from './approval';

const agglayerStatusAbi = parseAbi(['function isEmergencyState() view returns (bool)']);
export type AgglayerClient = SourceTransactionClient &
  Pick<
    PublicClient,
    'readContract' | 'call' | 'estimateGas' | 'waitForTransactionReceipt' | 'getBalance' | 'getGasPrice'
  >;
export interface AgglayerDepositRequest {
  rowId: string;
  operation: BridgeOperationSnapshot;
  provider: Pick<EIP1193Provider, 'request'>;
  client: AgglayerClient;
  checks: Pick<SubmissionChecks, 'readCurrent' | 'now'>;
}

/** Consumes the receive wrapper's winning snapshot; it never claims or resumes an idle-looking row. */
export async function submitAgglayerDeposit(request: AgglayerDepositRequest): Promise<void> {
  const { rowId, provider, client, checks } = request;
  const operation = structuredClone(request.operation);
  const { review } = operation;
  const { route, amount, accounts } = review;
  const source = route.source;
  const chain = route.recovery.config.supportedEvmChains[source.network];
  const recovery =
    chain && selectAgglayerRecoveryConfig({ ...route.recovery, status: 'ready', lastFetch: null }, chain.chainId);
  if (
    route.provider !== 'agglayer' ||
    route.mode !== 'receive' ||
    source.kind === 'miden' ||
    !recovery ||
    !isAddress(accounts.evmAddress, { strict: false })
  )
    throw new Error('Agglayer deposit terms changed');
  validateTransferAmount(route, amount);
  const account: Address = `0x${accounts.evmAddress.slice(2)}`;
  const token: Address =
    source.kind === 'erc20' && isAddress(source.address, { strict: false })
      ? `0x${source.address.slice(2)}`
      : '0x0000000000000000000000000000000000000000';
  const units = parseUnits(amount, source.decimals);
  const assertCurrent = async () => {
    const row = await Repo.transactions.get(rowId);
    const recorded = row && bridgeOperationOf(row);
    if (
      !row ||
      !recorded ||
      recorded.revision !== operation.revision ||
      recorded.sourceAttempt?.phase !== 'running' ||
      row.extraInputs?.phase !== 'submitting' ||
      row.extraInputs.evmTxHash ||
      row.extraInputs.intentNonce
    )
      throw new Error('Agglayer source ownership changed');
    assertBridgeOperationCurrent(row, operation);
    const current = getBridgeConfigSnapshot();
    if (
      current.status !== 'ready' ||
      configKey([current.network, current.config, current.derived]) !==
        configKey([route.recovery.network, route.recovery.config, route.recovery.derived])
    )
      throw new Error('Agglayer deposit terms changed');
  };
  const assertWallet = async () => {
    assertReviewedBridge(review, await checks.readCurrent(), checks.now());
    const active: unknown = await provider.request({ method: 'eth_accounts' });
    const activeChain: unknown = await provider.request({ method: 'eth_chainId' });
    if (
      !Array.isArray(active) ||
      typeof active[0] !== 'string' ||
      active[0].toLowerCase() !== account.toLowerCase() ||
      Number(activeChain) !== recovery.chainId
    )
      throw new Error('Agglayer wallet account or chain changed');
    await assertCurrent();
  };
  const send = async (to: Address, data: Hex, value: bigint): Promise<Hash> => {
    const gas = ((await client.estimateGas({ account, to, data, value })) * 120n) / 100n;
    const gasPrice = await client.getGasPrice();
    if ((await client.getBalance({ address: account })) < value + gas * gasPrice)
      throw new Error('Insufficient Agglayer native balance for gas');
    await assertWallet();
    const result: unknown = await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from: account, chainId: toHex(recovery.chainId), to, data, value: toHex(value), gas: toHex(gas) }]
    });
    if (typeof result !== 'string' || !isHash(result)) throw new Error('Agglayer wallet returned no source identity');
    return result;
  };
  try {
    await assertWallet();
    if (
      await client.readContract({
        address: recovery.contractAddress,
        abi: agglayerStatusAbi,
        functionName: 'isEmergencyState'
      })
    )
      throw new Error('Agglayer is paused');
    if (source.kind === 'erc20') {
      if ((await client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' })) !== source.decimals)
        throw new Error('Agglayer token decimals changed');
      if (
        (await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] })) <
        units
      )
        throw new Error('Insufficient Agglayer token balance');
      await ensureAgglayerApproval({
        operation,
        chainId: recovery.chainId,
        account,
        token,
        spender: recovery.contractAddress,
        amount: units,
        client,
        send,
        assertCurrent: assertWallet
      });
    }
    const data = encodeFunctionData({
      abi: AGGLAYER_BRIDGE_ABI,
      functionName: 'bridgeAsset',
      args: [recovery.rollupId, midenAddrToEvmAddr(accounts.midenAccount), units, token, true, '0x']
    });
    const hash = await send(recovery.contractAddress, data, source.kind === 'native' ? units : 0n);
    if (!(await recordBridgeSourceAttempt(operation.operationId, operation.revision, { hash })))
      throw new Error('Agglayer source identity could not be recorded');
  } catch (error) {
    await recordBridgeSourceAttempt(operation.operationId, operation.revision, { phase: 'uncertain' });
    throw error;
  }
}
