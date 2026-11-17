// Adapted from bridge-portal@cb52c470 src/bridge/providers/xreserve/{deposit,cctp-deposit}.ts (MIT).
import { encodeFunctionData, erc20Abi, isHash, parseUnits, toHex, type Address, type EIP1193Provider, type Hash, type Hex, type PublicClient } from 'viem';

import { quoteAmounts } from 'lib/bridge/core/quote';
import type { SubmissionChecks } from 'lib/bridge/core/submission';
import { ensureTokenApproval, type TokenApprovalClient } from 'lib/bridge/evm/token-approval';
import { recordBridgeSourceAttempt, type BridgeOperationSnapshot } from 'lib/bridge/operation';
import { updateBridgedReceivePhase } from 'lib/miden/transaction/complete';
import { validateCctpBurnQuote } from 'lib/usdcx/cctp';
import { getUsdcxSourceChain } from 'lib/usdcx/constant';
import { runUsdcxDeposit } from 'lib/usdcx/deposit';
import { usdcxRemoteRecipientFor } from 'lib/usdcx/deposit-target';
import { runUsdcxExecutorDeposit, type DepositForBurnWithHookAndFeesArgs } from 'lib/usdcx/executor';
import { TOKEN_MESSENGER_WITH_FEES_ABI, XRESERVE_ABI } from 'lib/usdcx/protocol';

import { assertUsdcxDepositCurrent } from './ownership';

export type XReserveClient = TokenApprovalClient & Pick<PublicClient, 'estimateGas' | 'getBalance' | 'getGasPrice'>;
export interface XReserveDepositRequest {
  rowId: string;
  operation: BridgeOperationSnapshot;
  provider: EIP1193Provider;
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
  const assertWallet = async () => {
    const active: unknown = await provider.request({ method: 'eth_accounts' });
    const activeChain: unknown = await provider.request({ method: 'eth_chainId' });
    if (!Array.isArray(active) || typeof active[0] !== 'string' || active[0].toLowerCase() !== account.toLowerCase() ||
        Number(activeChain) !== chain.chainId) throw new Error('Circle wallet account or chain changed');
    await assertUsdcxDepositCurrent(owned);
  };
  const send = async (to: Address, data: Hex, burnArgs?: DepositForBurnWithHookAndFeesArgs): Promise<Hash> => {
    await client.call({ account, to, data, value: 0n });
    const gas = (await client.estimateGas({ account, to, data, value: 0n })) * 120n / 100n;
    const gasPrice = await client.getGasPrice();
    if (await client.getBalance({ address: account }) < gas * gasPrice) throw new Error('Insufficient Circle source gas');
    const deadline = burnArgs && quote.kind === 'cctp' && source.route === 'cctp-executor'
      ? await validateCctpBurnQuote(source.domain, source.irisApi, burnArgs, quote.authorization) : undefined;
    await assertWallet();
    if (deadline !== undefined && performance.now() >= deadline) throw new Error('Circle quote expires before signing');
    const hash: unknown = await provider.request({ method: 'eth_sendTransaction',
      params: [{ from: account, chainId: toHex(chain.chainId), to, data, value: '0x0', gas: toHex(gas) }] });
    if (typeof hash !== 'string' || !isHash(hash)) throw new Error('Circle wallet returned no source identity');
    return hash;
  };
  try {
    await assertWallet();
    const spender = source.route === 'xreserve' ? source.xReserve : source.tokenMessengerWithFees;
    const total = parseUnits(quoteAmounts(route, quote).sourceTotal, 6);
    if (await client.readContract({ address: source.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [account] }) < total)
      throw new Error('Insufficient Circle source balance');
    await ensureTokenApproval({ operation, chainId: chain.chainId, account, token: source.usdc, spender, amount: total,
      client, send: (to, data) => send(to, data), assertCurrent: assertWallet });
    const target = source.route === 'xreserve' ? source : source.target;
    const deps = {
      sourceChainId: chain.chainId, source, owned,
      isRemoteDomainRegistered: (domain: number) => client.readContract({ address: target.xReserve, abi: XRESERVE_ABI,
        functionName: 'isRemoteDomainRegistered', args: [domain] }),
      readAllowance: (address: Address) => client.readContract({ address: source.usdc, abi: erc20Abi, functionName: 'allowance', args: [account, address] }),
      waitForReceipt: async (hash: Hash) => {
        const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120000 });
        if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase() || receipt.status !== 'success')
          throw new Error('Circle source receipt is not confirmed');
      },
      updatePhase: updateBridgedReceivePhase
    };
    const approve = async (): Promise<Hash> => { throw new Error('Circle allowance changed; review again'); };
    const recipient = usdcxRemoteRecipientFor(accounts.midenAccount);
    if (source.route === 'xreserve') await runUsdcxDeposit(rowId, amount, recipient, { ...deps, source,
      signer: { approve, depositToRemote: args => send(source.xReserve, encodeFunctionData({ abi: XRESERVE_ABI, functionName: 'depositToRemote', args })) } });
    else {
      if (quote.kind !== 'cctp') throw new Error('Circle forwarding quote unavailable');
      await runUsdcxExecutorDeposit(rowId, amount, recipient, { ...deps, source, depositor: account,
        readBalance: () => client.readContract({ address: source.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
        fetchQuote: async () => quote.authorization,
        signer: { approve, depositForBurnWithHookAndFees: args => send(source.tokenMessengerWithFees, encodeFunctionData({ abi: TOKEN_MESSENGER_WITH_FEES_ABI, functionName: 'depositForBurnWithHookAndFees', args }), args) }
      });
    }
  } catch (error) {
    await recordBridgeSourceAttempt(operation.operationId, operation.revision, { phase: 'uncertain' });
    throw error;
  }
}
