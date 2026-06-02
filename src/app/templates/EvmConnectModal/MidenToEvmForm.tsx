import React, { useCallback, useEffect, useState } from 'react';

import { CollateralType } from '@epoch-protocol/epoch-intents-sdk';
import { parseUnits } from 'viem';

import { MIDEN_MIN_RECLAIM_BLOCKS, createBridgeP2IDNote, getCurrentMidenBlock, useEpochStore } from 'lib/epoch';
import { useMidenContext } from 'lib/miden/front/client';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { getNativeAssetId, getNativeAssetIdSync, onNativeAssetChanged } from 'lib/miden-chain/native-asset';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';
import { Button } from 'lib/ui/button';

import { SEPOLIA_TESTNET_TOKENS, inputClass, shortenAddress } from './shared';
import { TokenSelect } from './TokenSelect';

interface MidenToEvmFormProps {
  evmAddress: string;
  midenAccount: string;
}

export const MidenToEvmForm: React.FC<MidenToEvmFormProps> = ({ evmAddress, midenAccount }) => {
  const status = useEpochStore(s => s.status);
  const flow = useEpochStore(s => s.flow);
  const quote = useEpochStore(s => s.quote);
  const intent = useEpochStore(s => s.intent);
  const pollResults = useEpochStore(s => s.pollResults);
  const error = useEpochStore(s => s.error);
  const quoteMidenToEVM = useEpochStore(s => s.quoteMidenToEVM);
  const executeMidenToEVM = useEpochStore(s => s.executeMidenToEVM);
  const poll = useEpochStore(s => s.poll);
  const reset = useEpochStore(s => s.reset);
  const { signTransaction } = useMidenContext();

  // Miden source faucet defaults to the network's native asset id. We hydrate
  // sync-first (cached) and subscribe for the async-discovered value.
  const [sourceFaucet, setSourceFaucet] = useState(() => getNativeAssetIdSync() ?? '');
  useEffect(() => {
    if (!sourceFaucet) {
      getNativeAssetId()
        .then(id => setSourceFaucet(prev => prev || id))
        .catch(err => console.error('[epoch] native asset discovery failed', err));
    }
    const off = onNativeAssetChanged(id => setSourceFaucet(prev => prev || id));
    return off;
  }, [sourceFaucet]);

  // EVM output token picked from the hardcoded Sepolia list.
  const [outputToken, setOutputToken] = useState(SEPOLIA_TESTNET_TOKENS[0]!.address);
  // minTokenOut is always 18-decimal scaled per Epoch's convention regardless
  // of the actual output token decimals.
  const [minTokenOutHuman, setMinTokenOutHuman] = useState('0.01');

  useEffect(() => {
    if (status !== 'pending') return;
    const id = setInterval(() => {
      poll().catch(err => console.error('[epoch] poll tick failed', err));
    }, 3000);
    return () => clearInterval(id);
  }, [status, poll]);

  useEffect(() => {
    if (flow && flow !== 'miden-to-evm') reset();
  }, [flow, reset]);

  const canQuote =
    !!sourceFaucet.trim() && !!outputToken.trim() && !!minTokenOutHuman.trim() && parseFloat(minTokenOutHuman) > 0;

  const handleQuote = useCallback(async () => {
    hapticLight();
    try {
      const currentBlock = await getCurrentMidenBlock();
      const minTokenOut = parseUnits(minTokenOutHuman.trim(), 18).toString();
      await quoteMidenToEVM(
        {
          midenAccountId: midenAccount,
          midenFaucetId: sourceFaucet.trim(),
          evmRecipient: evmAddress,
          destinationChainId: 11155111,
          outputTokenAddress: outputToken.trim(),
          minTokenOut,
          midenReclaimHeight: currentBlock + MIDEN_MIN_RECLAIM_BLOCKS
        },
        evmAddress
      );
    } catch (err) {
      console.error('[epoch] miden→evm quote click failed', err);
    }
  }, [quoteMidenToEVM, midenAccount, sourceFaucet, evmAddress, outputToken, minTokenOutHuman]);

  const handleBridge = useCallback(async () => {
    hapticMedium();
    // The Epoch SDK invokes this callback once the allocator confirms a
    // resource lock is needed for the Miden-collateral intent. We turn it
    // into a wallet send-tx with `recallBlocks` so the resulting note is
    // a P2IDE, then hand the committed noteId back to the SDK.
    const createNote = (faucetArg: string, amountArg: string, allocatorId: string) =>
      createBridgeP2IDNote(midenAccount, faucetArg, amountArg, allocatorId, {
        signTransaction,
        guardianProvider: zustandProvider
      });

    try {
      await executeMidenToEVM({
        collateralType: CollateralType.Miden,
        midenSourceAccount: midenAccount,
        createMidenP2IDNote: createNote
      });
    } catch (err) {
      console.error('[epoch] miden→evm bridge setup failed', err);
    }
  }, [executeMidenToEVM, midenAccount, signTransaction]);

  const handleReset = useCallback(() => {
    hapticLight();
    reset();
  }, [reset]);

  const showInputs = status === 'idle' || status === 'failed' || (status === 'quoted' && flow !== 'miden-to-evm');
  const showQuote = status === 'quoted' && flow === 'miden-to-evm' && quote;
  const showInFlight = status === 'quoting' || status === 'signing' || status === 'pending';
  const showDone = status === 'done';

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-grey-100 bg-white px-3 py-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium text-heading-gray">Bridge Miden → EVM</span>
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
            <span className="text-xs text-grey-500">Miden source faucet (default: native asset)</span>
            <input
              className={inputClass}
              placeholder="Miden faucet ID (bech32 or hex)"
              value={sourceFaucet}
              onChange={e => setSourceFaucet(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-grey-500">EVM output token (Sepolia)</span>
            <TokenSelect value={outputToken} onChange={setOutputToken} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-grey-500">Min EVM tokens to receive (18-decimal convention, e.g. 0.01)</span>
            <input
              className={inputClass}
              placeholder="0.01"
              value={minTokenOutHuman}
              onChange={e => setMinTokenOutHuman(e.target.value)}
              inputMode="decimal"
            />
          </label>
          <Button variant="default" size="lg" onClick={handleQuote} disabled={!canQuote}>
            Get quote
          </Button>
        </>
      )}

      {showQuote && quote && (
        <>
          <div className="flex flex-col gap-1 rounded-md bg-grey-50 px-3 py-2 text-xs">
            <div className="flex justify-between">
              <span className="text-grey-500">Miden input (computed)</span>
              <span className="font-medium">{quote.quoteResult.tokenIn ?? '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-grey-500">You receive (EVM)</span>
              <span className="font-medium">{quote.quoteResult.tokenOut ?? '—'}</span>
            </div>
          </div>
          <Button variant="default" size="lg" onClick={handleBridge}>
            Bridge to EVM
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
