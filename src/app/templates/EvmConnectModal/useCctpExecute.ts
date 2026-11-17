import { useCallback } from 'react';

import { encodeFunctionData, Hash, isHash, isHex, toHex } from 'viem';
import { useSwitchChain, useWriteContract } from 'wagmi';

import { captureBridgeWalletScope } from 'lib/bridge/operation';
import {
  captureCctpExecution,
  recordCctpExecutionHash,
  reserveCctpExecution
} from 'lib/bridge/providers/xreserve/manual-execute';
import { updateBridgedReceivePhase } from 'lib/miden/activity';
import { IBridgedReceiveExtraInputs, IUsdcxCctpLeg } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { revertedExecuteLeg } from 'lib/usdcx/cctp';
import { GENERIC_EXECUTOR_ABI, getUsdcxExecutorSource } from 'lib/usdcx/constant';
import { UsdcxBurnError } from 'lib/usdcx/withdrawal';
import { readNativeFeeFields } from 'lib/walletconnect/fees';
import {
  isNativeReownAvailable,
  NativeReown,
  prepareNativeSessionChain,
  unwrapNativeResult
} from 'lib/walletconnect/native';
import { EvmTransactionRevertedError, waitForEvmReceipt } from 'lib/walletconnect/receipt';
import { nativeSigningErrorId } from 'lib/walletconnect/signing-error';

/** The Arc leg of an executor-route deposit: `GenericExecutor.execute` with the attested CCTP message. */
export type CctpExecute = (txId: string, sourceChainId: number, leg: IUsdcxCctpLeg) => Promise<Hash>;

/**
 * Execute an attested CCTP message on Circle's executor on Arc from the connected EVM wallet, then record
 * the Arc transaction on the row so the reconciler asks xReserve's attestation service for it. Native Reown
 * takes calldata and returns a JSON-quoted hash; wagmi switches to Arc first and takes the typed call.
 * Save the hash before the receipt wait so status checks can resume after the popup closes.
 * A revert seen here reopens the leg (`revertedExecuteLeg`) so the user can execute again; the reconciler does the
 * same for a revert it reads later.
 */
export function useCctpExecute(): CctpExecute {
  const nativeReownAvailable = isNativeReownAvailable();
  const writeContract = useWriteContract();
  const { switchChainAsync } = useSwitchChain();

  return useCallback(
    async (txId, sourceChainId, leg) => {
      const invocationScope = captureBridgeWalletScope();
      const originalLeg = structuredClone(leg);
      const row = await Repo.transactions.get(txId);
      const owned = captureCctpExecution(row, sourceChainId, originalLeg, invocationScope);
      const inputs: IBridgedReceiveExtraInputs | undefined = row?.extraInputs;
      const saved = inputs?.usdcxSource;
      const source = owned?.source ?? saved ?? getUsdcxExecutorSource(sourceChainId);
      if (source.route !== 'cctp-executor') throw new Error('The saved route has no executor');
      const { target } = source;
      const { message, attestation } = originalLeg;
      if (!isHex(message) || !isHex(attestation)) {
        throw new Error('The CCTP attestation is not available yet.');
      }
      const data = encodeFunctionData({
        abi: GENERIC_EXECUTOR_ABI,
        functionName: 'execute',
        args: [message, attestation]
      });

      let hash: Hash;
      let attemptId: string | undefined;
      try {
        if (nativeReownAvailable) {
          // A session that did not approve the target chain fails here, before the wallet prompt.
          await prepareNativeSessionChain(target.chain.id);
          const feeFields = await readNativeFeeFields(target.chain.id);
          if (owned) attemptId = await reserveCctpExecution(owned);
          const result = await NativeReown.sendTransaction({
            chainId: target.chain.id,
            to: target.executor,
            value: toHex(0n),
            data,
            ...feeFields
          });
          const unwrapped = unwrapNativeResult(result.hash);
          if (!isHash(unwrapped)) throw new Error('The wallet returned no transaction hash.');
          hash = unwrapped;
        } else {
          await switchChainAsync({ chainId: target.chain.id });
          if (owned) attemptId = await reserveCctpExecution(owned);
          hash = await writeContract.mutateAsync({
            chainId: target.chain.id,
            abi: GENERIC_EXECUTOR_ABI,
            address: target.executor,
            functionName: 'execute',
            args: [message, attestation]
          });
        }

        if (!isHash(hash)) throw new Error('The wallet returned no transaction hash.');
        if (owned) {
          if (!attemptId) throw new Error('Circle execute attempt unavailable');
          await recordCctpExecutionHash(owned, attemptId, hash);
        } else
          await updateBridgedReceivePhase(txId, 'delivering', {
            cctp: { sourceDomain: originalLeg.sourceDomain, executeTxHash: hash }
          });
      } catch (cause) {
        if (!owned) throw cause;
        const id = nativeSigningErrorId(cause);
        throw new UsdcxBurnError(
          id ?? 'bridgeReviewChanged',
          id === 'evmChainNotApproved' ? { network: target.chain.name } : undefined
        );
      }
      try {
        await waitForEvmReceipt(hash, target.chain);
      } catch (error) {
        if (error instanceof EvmTransactionRevertedError) {
          await updateBridgedReceivePhase(txId, 'delivering', {
            cctp: revertedExecuteLeg(originalLeg.sourceDomain, hash)
          });
          throw error;
        }
        // Keep the saved hash if the receipt cannot be read. Circle can still confirm execution.
        if (owned) console.warn('[useCctpExecute] owned execute receipt could not be read');
        else console.warn('[useCctpExecute] execute receipt could not be read', hash, error);
      }
      return hash;
    },
    [nativeReownAvailable, switchChainAsync, writeContract]
  );
}
