import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { CollateralType } from '@epoch-protocol/epoch-intents-sdk';
import { useTranslation } from 'react-i18next';
import { parseUnits } from 'viem';

import {
  MIDEN_DESTINATION_CHAIN_ID,
  MIDEN_MIN_RECLAIM_BLOCKS,
  createBridgeP2IDNote,
  getCurrentMidenBlock,
  useEpochSdk,
  useEpochStore
} from 'lib/epoch';
import { useMidenContext } from 'lib/miden/front/client';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { getNativeAssetId, getNativeAssetIdSync, onNativeAssetChanged } from 'lib/miden-chain/native-asset';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';
import { useWalletStore } from 'lib/store';
import { Button } from 'lib/ui/button';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { getChain, useWcStore } from 'lib/walletconnect';

interface EvmConnectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function shortenAddress(addr: string): string {
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

const inputClass =
  'rounded-lg border border-grey-200 bg-white px-3 py-2 text-sm text-heading-gray placeholder:text-grey-400 focus:outline-none focus:ring-2 focus:ring-primary-500/40';

type BridgeTab = 'miden-to-evm' | 'evm-to-miden';

interface EvmToMidenFormProps {
  evmAddress: string;
  midenRecipient: string;
}

const EvmToMidenForm: React.FC<EvmToMidenFormProps> = ({ evmAddress, midenRecipient }) => {
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
  // Default token: Epoch's mock USDC on Sepolia (6 decimals). Editable for now;
  // once we have a real token picker this gets replaced.
  const [tokenAddress, setTokenAddress] = useState('0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69');
  const [decimals, setDecimals] = useState('6');
  const [amount, setAmount] = useState('');

  // Auto-poll while pending so the user sees `done` without manual refresh.
  useEffect(() => {
    if (status !== 'pending') return;
    const id = window.setInterval(() => {
      poll().catch(err => console.error('[epoch] poll tick failed', err));
    }, 3000);
    return () => window.clearInterval(id);
  }, [status, poll]);

  // Drop quote/intent state when a different flow (or new connection) takes
  // over — keeps the form from staying stuck on a stale Miden→EVM quote.
  useEffect(() => {
    if (flow && flow !== 'evm-to-miden') reset();
  }, [flow, reset]);

  const canQuote =
    !!faucetId.trim() &&
    !!tokenAddress.trim() &&
    !!amount.trim() &&
    parseFloat(amount) > 0 &&
    parseInt(decimals, 10) >= 0;

  const handleQuote = useCallback(() => {
    hapticLight();
    quoteEVMToMiden(
      {
        sourceChainId: 11155111,
        destinationChainId: MIDEN_DESTINATION_CHAIN_ID,
        evmSourceAddress: evmAddress,
        evmTokenAddress: tokenAddress.trim(),
        evmAmount: amount.trim(),
        evmTokenDecimals: parseInt(decimals, 10),
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
            <span className="text-xs text-grey-500">Token (Sepolia USDC by default)</span>
            <input
              className={inputClass}
              placeholder="ERC-20 address on Sepolia (0x…)"
              value={tokenAddress}
              onChange={e => setTokenAddress(e.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <input
              className={`${inputClass} flex-1`}
              placeholder="Amount"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              inputMode="decimal"
            />
            <input
              className={`${inputClass} w-20`}
              placeholder="Dec"
              value={decimals}
              onChange={e => setDecimals(e.target.value)}
              inputMode="numeric"
            />
          </div>
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

interface MidenToEvmFormProps {
  evmAddress: string;
  midenAccount: string;
}

const MidenToEvmForm: React.FC<MidenToEvmFormProps> = ({ evmAddress, midenAccount }) => {
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

  // Default EVM output: Epoch's mock USDC on Sepolia.
  const [outputToken, setOutputToken] = useState('0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69');
  // minTokenOut is always 18-decimal scaled per Epoch's convention regardless
  // of the actual output token decimals.
  const [minTokenOutHuman, setMinTokenOutHuman] = useState('0.01');

  useEffect(() => {
    if (status !== 'pending') return;
    const id = window.setInterval(() => {
      poll().catch(err => console.error('[epoch] poll tick failed', err));
    }, 3000);
    return () => window.clearInterval(id);
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

  const handleBridge = useCallback(() => {
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
    executeMidenToEVM({
      collateralType: CollateralType.Miden,
      midenSourceAccount: midenAccount,
      createMidenP2IDNote: createNote
    }).catch(err => console.error('[epoch] miden→evm bridge click failed', err));
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
            <span className="text-xs text-grey-500">EVM output token (Sepolia USDC by default)</span>
            <input
              className={inputClass}
              placeholder="ERC-20 address on Sepolia (0x…)"
              value={outputToken}
              onChange={e => setOutputToken(e.target.value)}
            />
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

interface BridgeTabsProps {
  evmAddress: string;
  midenAccount: string;
}

const BridgeTabs: React.FC<BridgeTabsProps> = ({ evmAddress, midenAccount }) => {
  const [tab, setTab] = useState<BridgeTab>('miden-to-evm');
  const reset = useEpochStore(s => s.reset);

  const switchTo = useCallback(
    (next: BridgeTab) => {
      if (next === tab) return;
      hapticLight();
      // Clear any quote/intent from the previous direction so the new tab
      // starts from a clean idle state.
      reset();
      setTab(next);
    },
    [tab, reset]
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex rounded-lg bg-grey-50 p-1 text-xs">
        <button
          type="button"
          onClick={() => switchTo('miden-to-evm')}
          className={`flex-1 rounded-md py-1.5 font-medium transition ${
            tab === 'miden-to-evm' ? 'bg-white text-heading-gray shadow-sm' : 'text-grey-500'
          }`}
        >
          Miden → EVM
        </button>
        <button
          type="button"
          onClick={() => switchTo('evm-to-miden')}
          className={`flex-1 rounded-md py-1.5 font-medium transition ${
            tab === 'evm-to-miden' ? 'bg-white text-heading-gray shadow-sm' : 'text-grey-500'
          }`}
        >
          EVM → Miden
        </button>
      </div>
      {tab === 'miden-to-evm' ? (
        <MidenToEvmForm evmAddress={evmAddress} midenAccount={midenAccount} />
      ) : (
        <EvmToMidenForm evmAddress={evmAddress} midenRecipient={midenAccount} />
      )}
    </div>
  );
};

export const EvmConnectModal: React.FC<EvmConnectModalProps> = ({ open, onOpenChange }) => {
  const { t } = useTranslation();
  const status = useWcStore(s => s.status);
  const address = useWcStore(s => s.address);
  const chainId = useWcStore(s => s.chainId);
  const error = useWcStore(s => s.error);
  const connect = useWcStore(s => s.connect);
  const disconnect = useWcStore(s => s.disconnect);
  const hydrate = useWcStore(s => s.hydrate);
  const sdk = useEpochSdk();
  const currentMidenAccount = useWalletStore(s => s.currentAccount);

  useEffect(() => {
    if (!sdk) return;
    console.log('[epoch] sdk ready', sdk);
  }, [sdk]);

  // Seed from any persisted AppKit session, then open AppKit's connect modal
  // if we're not already connected. AppKit owns the connect UX (wallet list,
  // QR, mobile deep-links, foreground reconnect), so there's nothing to
  // hand-roll here.
  useEffect(() => {
    if (!open) return;
    hydrate()
      .then(() => (useWcStore.getState().status === 'idle' ? connect() : undefined))
      .catch(err => console.error('[EvmConnectModal] connect failed', err));
  }, [open, hydrate, connect]);

  const handleConnect = useCallback(() => {
    hapticMedium();
    connect().catch(err => console.error('[EvmConnectModal] connect failed', err));
  }, [connect]);

  const handleDisconnect = useCallback(() => {
    hapticMedium();
    disconnect().finally(() => onOpenChange(false));
  }, [disconnect, onOpenChange]);

  const chain = useMemo(() => (chainId !== null ? getChain(chainId) : undefined), [chainId]);

  const showConnected = status === 'connected';

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="pb-6">
        <DrawerHeader>
          <DrawerTitle>{showConnected ? t('evmWalletConnected') : t('connectEvmWallet')}</DrawerTitle>
          <DrawerDescription>
            {showConnected ? t('evmWalletConnectedDescription') : t('connectEvmWalletDescription')}
          </DrawerDescription>
        </DrawerHeader>

        <div className="flex flex-col gap-4 px-4">
          {error && (
            <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500" role="alert">
              {error}
            </div>
          )}

          {!showConnected && status === 'connecting' && (
            <div className="flex items-center justify-center py-12 text-sm text-grey-500">{t('preparing')}</div>
          )}

          {showConnected && (
            <div className="flex flex-col gap-2 rounded-lg bg-grey-50 px-4 py-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-grey-500">{t('address')}</span>
                <span className="font-medium text-heading-gray">{address ? shortenAddress(address) : '…'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-grey-500">{t('network')}</span>
                <span className="font-medium text-heading-gray">
                  {chain?.name ?? (chainId !== null ? `Chain ${chainId}` : '…')}
                </span>
              </div>
            </div>
          )}

          {showConnected && address && currentMidenAccount && (
            <BridgeTabs evmAddress={address} midenAccount={currentMidenAccount.publicKey} />
          )}

          {!showConnected && (
            <Button variant="default" size="lg" onClick={handleConnect} className="w-full">
              {t('openWallet')}
            </Button>
          )}

          {showConnected && (
            <Button variant="destructive" size="lg" onClick={handleDisconnect} className="w-full">
              {t('disconnect')}
            </Button>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
};

export default EvmConnectModal;
