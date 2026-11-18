// Adapted from bridge-portal@cb52c470 src/bridge/providers/xreserve/{deposit,cctp-deposit}.ts (MIT).
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

import { quoteAmounts } from 'lib/bridge/core/quote';
import { assertReviewedBridge } from 'lib/bridge/core/review';
import type { SubmissionChecks } from 'lib/bridge/core/submission';
import { ensureTokenApproval, type TokenApprovalClient } from 'lib/bridge/evm/token-approval';
import {
  recordBridgePreSourceStop,
  recordBridgeSourceAttempt,
  type BridgeOperationSnapshot
} from 'lib/bridge/operation';
import { updateBridgedReceivePhase } from 'lib/miden/transaction/complete';
import { validateCctpBurnQuote } from 'lib/usdcx/cctp';
import { getUsdcxSourceChain } from 'lib/usdcx/constant';
import { runUsdcxDeposit } from 'lib/usdcx/deposit';
import { usdcxRemoteRecipientFor } from 'lib/usdcx/deposit-target';
import {
  encodeExecutorHookData,
  runUsdcxExecutorDeposit,
  type DepositForBurnWithHookAndFeesArgs
} from 'lib/usdcx/executor';
import { TOKEN_MESSENGER_WITH_FEES_ABI, XRESERVE_ABI } from 'lib/usdcx/protocol';
import { UsdcxBurnError } from 'lib/usdcx/withdrawal';

import { assertCctpSourceMessage, sourceMessageFromReceipt } from './cctp-message';
import { assertXReserveRouteAvailable } from './deposit-preflight';
import { assertUsdcxDepositCurrent, assertUsdcxDepositTerms, recordCctpSourceFacts } from './ownership';
import { xreserveReadClient } from './provider';

const feeAbi = parseAbi(['function getFee(bytes) view returns (uint256,address)']);
const messengerAbi = parseAbi(['function localMessageTransmitter() view returns (address)']);

export type XReserveClient = TokenApprovalClient & Pick<PublicClient, 'estimateGas' | 'getBalance' | 'getGasPrice'>;
export interface XReserveDepositRequest {
  rowId: string;
  operation: BridgeOperationSnapshot;
  provider: Pick<EIP1193Provider, 'request'>;
  client: XReserveClient;
  checks: Pick<SubmissionChecks, 'readCurrent' | 'now'>;
}

/** The wallet's USDCx leaves own deposit/burn tracking; the wrapper's original winner owns source permission. */
export async function submitXReserveDeposit(request: XReserveDepositRequest): Promise<void> {
  const { rowId, provider, client, checks } = request;
  const operation = structuredClone(request.operation);
  const { route, accounts, amount, quote } = operation.review;
  const chain = route.recovery.config.supportedEvmChains[route.source.network];
  if (!chain || !quote || route.source.kind !== 'erc20') throw new Error('Circle source unavailable');
  const source = getUsdcxSourceChain(chain.chainId);
  const account: Address = `0x${accounts.evmAddress.slice(2)}`;
  const owned = { rowId, operation, checks };
  const recipient = usdcxRemoteRecipientFor(accounts.midenAccount);
  assertUsdcxDepositTerms(owned, rowId, amount, recipient, source, account);
  const target = source.route === 'xreserve' ? source : source.target;
  const targetClient = xreserveReadClient(target.chain.id);
  const assertRoute = () =>
    assertXReserveRouteAvailable(targetClient, source, route.recovery.nativeAsset?.faucetId ?? '');
  const assertFee = async () => {
    if (quote.kind !== 'cctp' || source.route !== 'cctp-executor') return;
    const [fee, token] = await client.readContract({
      address: source.tokenMessengerWithFees,
      abi: feeAbi,
      functionName: 'getFee',
      args: [quote.authorization.signedQuote]
    });
    if (fee !== quote.authorization.feeTotalAmount || token.toLowerCase() !== source.usdc.toLowerCase())
      throw new Error('Circle signed fee or token changed');
  };
  const assertWallet = async () => {
    const active: unknown = await provider.request({ method: 'eth_accounts' });
    const activeChain: unknown = await provider.request({ method: 'eth_chainId' });
    if (
      !Array.isArray(active) ||
      typeof active[0] !== 'string' ||
      active[0].toLowerCase() !== account.toLowerCase() ||
      Number(activeChain) !== chain.chainId
    )
      throw new Error('Circle wallet account or chain changed');
    await assertUsdcxDepositCurrent(owned);
    assertReviewedBridge(operation.review, await checks.readCurrent(), checks.now());
  };
  let walletWriteStarted = false;
  const send = async (to: Address, data: Hex, burnArgs?: DepositForBurnWithHookAndFeesArgs): Promise<Hash> => {
    await client.call({ account, to, data, value: 0n });
    const gas = ((await client.estimateGas({ account, to, data, value: 0n })) * 120n) / 100n;
    const gasPrice = await client.getGasPrice();
    if ((await client.getBalance({ address: account })) < gas * gasPrice)
      throw new Error('Insufficient Circle source gas');
    await assertRoute();
    await assertFee();
    const deadline =
      burnArgs && quote.kind === 'cctp' && source.route === 'cctp-executor'
        ? await validateCctpBurnQuote(source.domain, source.irisApi, burnArgs, quote.authorization)
        : undefined;
    await assertWallet();
    if (deadline !== undefined && performance.now() >= deadline) throw new Error('Circle quote expires before signing');
    walletWriteStarted = true;
    const hash: unknown = await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from: account, chainId: toHex(chain.chainId), to, data, value: '0x0', gas: toHex(gas) }]
    });
    if (typeof hash !== 'string' || !isHash(hash)) throw new Error('Circle wallet returned no source identity');
    return hash;
  };
  let messageTransmitter: Address | undefined;
  try {
    await assertWallet();
    if (source.route === 'cctp-executor') {
      if (!source.tokenMessenger) throw new Error('Circle source messenger unavailable');
      const transmitter = await client.readContract({
        address: source.tokenMessenger,
        abi: messengerAbi,
        functionName: 'localMessageTransmitter'
      });
      if (!isAddress(transmitter) || /^0x0{40}$/i.test(transmitter))
        throw new Error('Circle source transmitter unavailable');
      messageTransmitter = transmitter;
      await recordCctpSourceFacts(owned, { messageTransmitter });
    }
    await assertRoute();
    await assertFee();
    const spender = source.route === 'xreserve' ? source.xReserve : source.tokenMessengerWithFees;
    const total = parseUnits(quoteAmounts(route, quote).sourceTotal, 6);
    if (
      (await client.readContract({ address: source.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [account] })) <
      total
    )
      throw new Error('Insufficient Circle source balance');
    await ensureTokenApproval({
      operation,
      chainId: chain.chainId,
      account,
      token: source.usdc,
      spender,
      amount: total,
      client,
      send: (to, data) => send(to, data),
      assertCurrent: assertWallet
    });
    const deps = {
      sourceChainId: chain.chainId,
      source,
      owned,
      isRemoteDomainRegistered: (domain: number) =>
        targetClient.readContract({
          address: target.xReserve,
          abi: XRESERVE_ABI,
          functionName: 'isRemoteDomainRegistered',
          args: [domain]
        }),
      readAllowance: (address: Address) =>
        client.readContract({
          address: source.usdc,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [account, address]
        }),
      waitForReceipt: async (hash: Hash) => {
        const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120000 });
        if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase() || receipt.status !== 'success')
          throw new Error('Circle source receipt is not confirmed');
        if (source.route === 'cctp-executor') {
          if (!messageTransmitter) throw new Error('Circle original transmitter unavailable');
          const sourceMessage = sourceMessageFromReceipt(receipt, hash, messageTransmitter);
          assertCctpSourceMessage(
            sourceMessage,
            source,
            parseUnits(amount, 6),
            encodeExecutorHookData(source.target, recipient, account)
          );
          await recordCctpSourceFacts(owned, { sourceMessage });
        }
      },
      updatePhase: updateBridgedReceivePhase
    };
    const approve = async (): Promise<Hash> => {
      throw new Error('Circle allowance changed; review again');
    };
    if (source.route === 'xreserve')
      await runUsdcxDeposit(rowId, amount, recipient, {
        ...deps,
        source,
        signer: {
          approve,
          depositToRemote: args =>
            send(source.xReserve, encodeFunctionData({ abi: XRESERVE_ABI, functionName: 'depositToRemote', args }))
        }
      });
    else {
      if (quote.kind !== 'cctp') throw new Error('Circle forwarding quote unavailable');
      await runUsdcxExecutorDeposit(rowId, amount, recipient, {
        ...deps,
        source,
        depositor: account,
        readBalance: () =>
          client.readContract({ address: source.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
        fetchQuote: async () => quote.authorization,
        signer: {
          approve,
          depositForBurnWithHookAndFees: args =>
            send(
              source.tokenMessengerWithFees,
              encodeFunctionData({
                abi: TOKEN_MESSENGER_WITH_FEES_ABI,
                functionName: 'depositForBurnWithHookAndFees',
                args
              }),
              args
            )
        }
      });
    }
  } catch {
    try {
      if (walletWriteStarted || !(await recordBridgePreSourceStop(rowId, operation)))
        await recordBridgeSourceAttempt(operation.operationId, operation.revision, { phase: 'uncertain' });
    } finally {
      throw new UsdcxBurnError('bridgeReviewChanged');
    }
  }
}
