import React, { useCallback, useMemo, useState } from 'react';

import { AgglayerDeposit, claimAgglayerDeposit, findClaimableMidenToEvmDeposit, useBridgeTracker } from 'lib/agglayer';
import { bridgeB2Agg } from 'lib/agglayer/b2agg';
import { EVM_AGGLAYER_NETWORK_ID, MIDEN_AGGLAYER_FAUCET_ID } from 'lib/agglayer/b2agg/constant';
import { useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { useMidenContext } from 'lib/miden/front/client';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';
import { Button } from 'lib/ui/button';
import { useEvmWalletProvider } from 'lib/walletconnect/useEvmWalletProvider';

import { inputClass } from './shared';

interface AgglayerMidenToEvmFormProps {
  evmAddress: string;
  midenAccount: string;
}

type Status = 'idle' | 'signing' | 'submitted' | 'failed';
type ClaimStatus = 'idle' | 'claiming' | 'claimed' | 'failed';

/** Convert a decimal string to base units for the given token decimals. */
function toBaseUnits(value: string, decimals: number): bigint {
  const [intPart = '0', fracPartRaw = ''] = value.trim().split('.');
  const frac = (fracPartRaw + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(intPart || '0') * 10n ** BigInt(decimals) + BigInt(frac || '0');
}

export const AgglayerMidenToEvmForm: React.FC<AgglayerMidenToEvmFormProps> = ({ evmAddress }) => {
  const { currentAccount, signTransaction } = useMidenContext();
  // Unified across web (AppKit) and native (Reown plugin) so the claim works on
  // device too — the bare `useAppKitProvider` is undefined on iOS/Android.
  const { provider: walletProvider } = useEvmWalletProvider();

  const senderPublicKey = currentAccount?.publicKey ?? '';

  // Available balance of the bridge faucet asset on Miden, shown above the input.
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: balances } = useAllBalances(senderPublicKey, allTokensBaseMetadata);
  const agglayerBalance = useMemo(
    () => balances.find(b => b.tokenId.toLowerCase() === MIDEN_AGGLAYER_FAUCET_ID.toLowerCase()),
    [balances]
  );
  const decimals = agglayerBalance?.metadata.decimals ?? 8;
  const symbol = agglayerBalance?.metadata.symbol ?? 'tokens';
  const available = agglayerBalance?.balance ?? null;

  const [amount, setAmount] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  // A deposit to the connected EVM wallet that's ready to claim on L1.
  const [claimable, setClaimable] = useState<AgglayerDeposit | null>(null);
  const [claimStatus, setClaimStatus] = useState<ClaimStatus>('idle');
  const [claimError, setClaimError] = useState<string | null>(null);

  // Poll the bridge service for a claimable Miden→EVM deposit whenever this tab
  // is open. Stateless/indexer-driven, so it surfaces deposits from a previous
  // session or device too. Stops once one is found.
  useBridgeTracker({
    active: !!evmAddress && claimStatus !== 'claimed',
    intervalMs: 8000,
    poll: async () => {
      const deposit = await findClaimableMidenToEvmDeposit(evmAddress);
      if (deposit) {
        setClaimable(deposit);
        return true;
      }
      return false;
    }
  });

  const parsedAmount = useMemo(() => parseFloat(amount), [amount]);
  const canBridge =
    !!senderPublicKey &&
    !!amount.trim() &&
    parsedAmount > 0 &&
    (available === null || parsedAmount <= available) &&
    status !== 'signing';

  const handleBridge = useCallback(async () => {
    if (!senderPublicKey) return;
    hapticMedium();
    setStatus('signing');
    setError(null);
    try {
      await bridgeB2Agg({
        amount: toBaseUnits(amount, decimals),
        destinationAddress: evmAddress as `0x${string}`,
        senderPublicKey,
        destinationNetwork: EVM_AGGLAYER_NETWORK_ID,
        deps: { signTransaction, guardianProvider: zustandProvider }
      });
      setStatus('submitted');
    } catch (err) {
      console.error('[agglayer] miden→evm bridge failed', err);
      setError(err instanceof Error ? err.message : 'Bridge failed');
      setStatus('failed');
    }
  }, [senderPublicKey, amount, decimals, evmAddress, signTransaction]);

  const handleClaim = useCallback(async () => {
    if (!claimable || !walletProvider) return;
    hapticMedium();
    setClaimStatus('claiming');
    setClaimError(null);
    try {
      const tx = await claimAgglayerDeposit({ deposit: claimable, provider: walletProvider, network: 'sepolia' });
      await tx.wait();
      setClaimStatus('claimed');
      setClaimable(null);
    } catch (err) {
      console.error('[agglayer] claim failed', err);
      setClaimError(err instanceof Error ? err.message : 'Claim failed');
      setClaimStatus('failed');
    }
  }, [claimable, walletProvider]);

  const handleReset = useCallback(() => {
    hapticLight();
    setAmount('');
    setStatus('idle');
    setError(null);
  }, []);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-grey-100 bg-white px-3 py-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium text-heading-gray">Bridge Miden → EVM (Agglayer)</span>
        {(status === 'submitted' || status === 'failed') && (
          <button type="button" onClick={handleReset} className="text-xs text-grey-500 underline">
            Reset
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-500" role="alert">
          {error}
        </div>
      )}

      {(status === 'idle' || status === 'failed') && (
        <>
          <label className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-xs text-grey-500">
              <span>Amount</span>
              {agglayerBalance && (
                <span>
                  Balance: {agglayerBalance.balance} {symbol}
                </span>
              )}
            </div>
            <input
              className={inputClass}
              placeholder="0.0"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              inputMode="decimal"
            />
          </label>
          <Button variant="default" size="lg" onClick={handleBridge} disabled={!canBridge}>
            Bridge to EVM
          </Button>
        </>
      )}

      {status === 'signing' && (
        <div className="flex items-center justify-center py-4 text-xs text-grey-500">Generating transaction…</div>
      )}

      {status === 'submitted' && (
        <div className="rounded-md bg-green-500/10 px-3 py-2 text-xs text-green-600">
          Bridge submitted. Waiting for the deposit to become claimable on EVM — this can take a while.
        </div>
      )}

      {/* Claim panel — shown whenever a deposit to the connected wallet is ready. */}
      {claimable && claimStatus !== 'claimed' && (
        <div className="flex flex-col gap-2 rounded-md bg-grey-50 px-3 py-2 text-xs">
          <span className="text-grey-600">A bridged deposit is ready to claim on EVM.</span>
          {claimError && (
            <span className="text-red-500" role="alert">
              {claimError}
            </span>
          )}
          <Button
            variant="default"
            size="lg"
            onClick={handleClaim}
            disabled={!walletProvider || claimStatus === 'claiming'}
          >
            {claimStatus === 'claiming' ? 'Claiming…' : 'Claim'}
          </Button>
        </div>
      )}

      {claimStatus === 'claimed' && (
        <div className="rounded-md bg-green-500/10 px-3 py-2 text-xs text-green-600">
          Claim submitted — funds are on the connected EVM wallet.
        </div>
      )}
    </div>
  );
};
