import React, { useCallback, useEffect, useState } from 'react';

import { useAppKitBalance, useAppKitProvider } from '@reown/appkit/react';
import { EIP1193Provider, parseUnits } from 'viem';
import { useWriteContract } from 'wagmi';

import { AGGLAYER_BRIDGE_ABI, AGGLAYER_CONTRACT_ADDRESS, MIDEN_CHAIN_ID, midenAddrToEvmAddr } from 'lib/agglayer';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';
import { Button } from 'lib/ui/button';

import { inputClass } from './shared';

interface AgglayerEvmToMidenFormProps {
  evmAddress: string;
  midenRecipient: string;
}

type Status = 'idle' | 'signing' | 'submitted' | 'failed';

export const AgglayerEvmToMidenForm: React.FC<AgglayerEvmToMidenFormProps> = ({ midenRecipient }) => {
  const { walletProvider } = useAppKitProvider<EIP1193Provider>('eip155');
  const { fetchBalance } = useAppKitBalance();

  const [amount, setAmount] = useState('');
  const [balance, setBalance] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  // Native ETH balance for the connected EVM wallet.
  useEffect(() => {
    let cancelled = false;
    fetchBalance()
      .then(res => {
        if (cancelled || !res.isSuccess || !res.data) return;
        setBalance(`${res.data.balance} ${res.data.symbol}`);
      })
      .catch(err => console.error('[agglayer] balance fetch failed', err));
    return () => {
      cancelled = true;
    };
  }, [fetchBalance]);

  const canBridge = !!walletProvider && !!amount.trim() && parseFloat(amount) > 0 && status !== 'signing';

  const writeContract = useWriteContract();

  const handleBridge = useCallback(async () => {
    if (!walletProvider) return;
    hapticMedium();
    setStatus('signing');
    setError(null);
    try {
      // await bridgeAgglayer({
      //   toMidenAddress: midenRecipient,
      //   amount: amount.trim(),
      //   provider: walletProvider,
      //   tokenAddr: 'native',
      //   network: 'sepolia'
      // });
      // The Activity tab polls the indexer for the destination address, so the
      // in-progress banner appears on its own — no need to record the tx here.
      const midenEvmAddr = midenAddrToEvmAddr(midenRecipient);
      const amountInBaseUnits = parseUnits(amount, 18);

      const tx = await writeContract.mutateAsync({
        abi: AGGLAYER_BRIDGE_ABI,
        address: AGGLAYER_CONTRACT_ADDRESS.get('sepolia')! as `0x${string}`,
        functionName: 'bridgeAsset',
        args: [
          MIDEN_CHAIN_ID,
          midenEvmAddr,
          amountInBaseUnits,
          '0x0000000000000000000000000000000000000000',
          true,
          '0x'
        ],
        value: amountInBaseUnits
      });

      console.log('Transaction sumbitted on evm', tx);
      setStatus('submitted');
    } catch (err) {
      console.error('[agglayer] bridge failed', err);
      setError(err instanceof Error ? err.message : 'Bridge failed');
      setStatus('failed');
    }
  }, [walletProvider, midenRecipient, amount, writeContract]);

  const handleReset = useCallback(() => {
    hapticLight();
    setAmount('');
    setStatus('idle');
    setError(null);
  }, []);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-grey-100 bg-white px-3 py-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium text-heading-gray">Bridge ETH → Miden (Agglayer)</span>
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
              <span>Amount (ETH)</span>
              {balance && <span>Balance: {balance}</span>}
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
            Bridge to Miden
          </Button>
        </>
      )}

      {status === 'signing' && (
        <div className="flex items-center justify-center py-4 text-xs text-grey-500">Approve in your wallet…</div>
      )}

      {status === 'submitted' && (
        <div className="rounded-md bg-green-500/10 px-3 py-2 text-xs text-green-600">
          Bridge submitted. This can take a while — track progress in the Activity tab.
        </div>
      )}
    </div>
  );
};
