import { useCallback } from 'react';

import { encodeFunctionData, Hash, isHash, isHex, toHex } from 'viem';
import { useSwitchChain, useWriteContract } from 'wagmi';

import { updateBridgedReceivePhase } from 'lib/miden/activity';
import { IUsdcxCctpLeg } from 'lib/miden/db/types';
import { revertedExecuteLeg } from 'lib/usdcx/cctp';
import { GENERIC_EXECUTOR_ABI, getUsdcxExecutorSource } from 'lib/usdcx/constant';
import { readNativeFeeFields } from 'lib/walletconnect/fees';
import { isNativeReownAvailable, NativeReown, unwrapNativeResult } from 'lib/walletconnect/native';
import { EvmTransactionRevertedError, waitForEvmReceipt } from 'lib/walletconnect/receipt';

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
      const { target } = getUsdcxExecutorSource(sourceChainId);
      const { message, attestation } = leg;
      if (!isHex(message) || !isHex(attestation)) {
        throw new Error('The CCTP attestation is not available yet.');
      }
      const data = encodeFunctionData({
        abi: GENERIC_EXECUTOR_ABI,
        functionName: 'execute',
        args: [message, attestation]
      });

      let hash: Hash;
      if (nativeReownAvailable) {
        const result = await NativeReown.sendTransaction({
          chainId: target.chain.id,
          to: target.executor,
          value: toHex(0n),
          data,
          ...(await readNativeFeeFields(target.chain.id))
        });
        const unwrapped = unwrapNativeResult(result.hash);
        if (!isHash(unwrapped)) throw new Error('The wallet returned no transaction hash.');
        hash = unwrapped;
      } else {
        await switchChainAsync({ chainId: target.chain.id });
        hash = await writeContract.mutateAsync({
          chainId: target.chain.id,
          abi: GENERIC_EXECUTOR_ABI,
          address: target.executor,
          functionName: 'execute',
          args: [message, attestation]
        });
      }

      await updateBridgedReceivePhase(txId, 'delivering', {
        cctp: { sourceDomain: leg.sourceDomain, executeTxHash: hash }
      });
      try {
        await waitForEvmReceipt(hash, target.chain);
      } catch (error) {
        if (error instanceof EvmTransactionRevertedError) {
          await updateBridgedReceivePhase(txId, 'delivering', { cctp: revertedExecuteLeg(leg.sourceDomain, hash) });
          throw error;
        }
        // Keep the saved hash if the receipt cannot be read. Circle can still confirm execution.
        console.warn('[useCctpExecute] execute receipt could not be read', hash, error);
      }
      return hash;
    },
    [nativeReownAvailable, switchChainAsync, writeContract]
  );
}
