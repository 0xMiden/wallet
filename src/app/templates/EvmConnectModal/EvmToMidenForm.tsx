import React, { useCallback, useEffect, useState } from 'react';

import { MIDEN_DESTINATION_CHAIN_ID, useEpochStore } from 'lib/epoch';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';
import { Button } from 'lib/ui/button';

import { TokenSelect } from './TokenSelect';
import { SEPOLIA_TESTNET_TOKENS, inputClass, shortenAddress } from './shared';

interface EvmToMidenFormProps {
  evmAddress: string;
  midenRecipient: string;
}

export const EvmToMidenForm: React.FC<EvmToMidenFormProps> = ({ evmAddress, midenRecipient }) => {
  const status = useEpochStore(s => s.status);
  const flow = useEpochStore(s => s.flow);
  const quote = useEpochStore(s => s.quote);
  const intent = useEpochStore(s => s.intent);
  const pollResults = useEpochStore(s => s.pollResults);
  const error = useEpochStore(s => s.error);
  const quoteEVMToMiden = useEpochStore(s => s.quoteEVMToMiden);
  const executeEVMToMiden = useEpochStore(s => s.executeEVMToMiden);
  const poll = useEpochStore(s => s.poll);
  const reset = useEpochStore(s => s.reset);

  // Default Miden faucet for the bridged USDC on testnet.
  const [faucetId, setFaucetId] = useState('0x0a7d175ed63ec5200fb2ced86f6aa5');
  // Source token picked from the hardcoded Sepolia list; decimals come from
  // the matched token entry.
  const [tokenAddress, setTokenAddress] = useState(SEPOLIA_TESTNET_TOKENS[0].address);
  const decimals = SEPOLIA_TESTNET_TOKENS.find(t => t.address === tokenAddress)?.decimals ?? 18;
  const [amount, setAmount] = useState('');

  // Auto-poll while pending so the user sees `done` without manual refresh.
  useEffect(() => {
    if (status !== 'pending') return;
    const id = setInterval(() => {
      poll().catch(err => console.error('[epoch] poll tick failed', err));
    }, 3000);
    return () => clearInterval(id);
  }, [status, poll]);

  // Drop quote/intent state when a different flow (or new connection) takes
  // over — keeps the form from staying stuck on a stale Miden→EVM quote.
  useEffect(() => {
    if (flow && flow !== 'evm-to-miden') reset();
  }, [flow, reset]);

  const canQuote = !!faucetId.trim() && !!tokenAddress.trim() && !!amount.trim() && parseFloat(amount) > 0;

  const handleQuote = useCallback(() => {
    hapticLight();
    quoteEVMToMiden(
      {
        sourceChainId: 11155111,
        destinationChainId: MIDEN_DESTINATION_CHAIN_ID,
        evmSourceAddress: evmAddress,
        evmTokenAddress: tokenAddress.trim(),
        evmAmount: amount.trim(),
        evmTokenDecimals: decimals,
        midenRecipientId: midenRecipient,
        midenFaucetId: faucetId.trim(),
        minTokenOut: '1000000' //TODO: ask epoch what this should be calculated when mainnet
      },
      evmAddress
    ).catch(err => console.error('[epoch] quote click failed', err));
  }, [quoteEVMToMiden, evmAddress, tokenAddress, amount, decimals, midenRecipient, faucetId]);

  const handleBridge = useCallback(() => {
    hapticMedium();
    executeEVMToMiden().catch(err => console.error('[epoch] bridge click failed', err));
  }, [executeEVMToMiden]);

  const handleReset = useCallback(() => {
    hapticLight();
    reset();
  }, [reset]);

  const showInputs = status === 'idle' || status === 'failed' || (status === 'quoted' && flow !== 'evm-to-miden');
  const showQuote = status === 'quoted' && flow === 'evm-to-miden' && quote;
  const showInFlight = status === 'quoting' || status === 'signing' || status === 'pending';
  const showDone = status === 'done';

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-grey-100 bg-white px-3 py-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium text-heading-gray">Bridge EVM → Miden</span>
        {(showQuote || showInFlight || showDone || error) && (
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

      {showInputs && (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-grey-500">Miden faucet (default: USDC-on-Miden testnet)</span>
            <input
              className={inputClass}
              placeholder="Miden faucet ID (bech32 or hex)"
              value={faucetId}
              onChange={e => setFaucetId(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-grey-500">Token (Sepolia)</span>
            <TokenSelect value={tokenAddress} onChange={setTokenAddress} />
          </label>
          <input
            className={inputClass}
            placeholder="Amount"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            inputMode="decimal"
          />
          <Button variant="default" size="lg" onClick={handleQuote} disabled={!canQuote}>
            Get quote
          </Button>
        </>
      )}

      {showQuote && quote && (
        <>
          <div className="flex flex-col gap-1 rounded-md bg-grey-50 px-3 py-2 text-xs">
            <div className="flex justify-between">
              <span className="text-grey-500">You spend</span>
              <span className="font-medium">{quote.quoteResult.tokenIn ?? amount}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-grey-500">You receive (Miden)</span>
              <span className="font-medium">{quote.quoteResult.tokenOut ?? '—'}</span>
            </div>
          </div>
          <Button variant="default" size="lg" onClick={handleBridge}>
            Bridge to Miden
          </Button>
        </>
      )}

      {showInFlight && (
        <div className="flex items-center justify-center py-4 text-xs text-grey-500">
          {status === 'quoting' && 'Fetching quote…'}
          {status === 'signing' && 'Approve in your wallet…'}
          {status === 'pending' && (
            <span>
              Bridging… {pollResults && pollResults.length > 0 ? `(${pollResults.map(r => r.status).join(', ')})` : ''}
            </span>
          )}
        </div>
      )}

      {showDone && (
        <div className="rounded-md bg-green-500/10 px-3 py-2 text-xs text-green-600">
          Bridge complete{intent?.solveResult?.hash ? `: ${shortenAddress(intent.solveResult.hash)}` : ''}
        </div>
      )}
    </div>
  );
};
