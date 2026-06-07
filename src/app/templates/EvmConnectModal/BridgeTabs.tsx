import React, { useCallback, useState } from 'react';

import { useEpochStore } from 'lib/epoch';
import { hapticLight } from 'lib/mobile/haptics';

import { AgglayerEvmToMidenForm } from './AgglayerEvmToMidenForm';
import { AgglayerMidenToEvmForm } from './AgglayerMidenToEvmForm';
import { EvmToMidenForm } from './EvmToMidenForm';
import { MidenToEvmForm } from './MidenToEvmForm';
import { BridgeProvider, BridgeTab } from './shared';

interface BridgeTabsProps {
  evmAddress: string;
  midenAccount: string;
}
const segmentClass = (active: boolean) =>
  `flex-1 rounded-md py-1.5 font-medium transition ${active ? 'bg-white text-heading-gray shadow-sm' : 'text-grey-500'}`;

export const BridgeTabs: React.FC<BridgeTabsProps> = ({ evmAddress, midenAccount }) => {
  const [provider, setProvider] = useState<BridgeProvider>('epoch');
  const [tab, setTab] = useState<BridgeTab>('miden-to-evm');
  const reset = useEpochStore(s => s.reset);

  const switchProvider = useCallback(
    (next: BridgeProvider) => {
      if (next === provider) return;
      hapticLight();
      // Clear any in-flight quote/intent so the new provider starts clean.
      reset();
      setProvider(next);
    },
    [provider, reset]
  );

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
        <button type="button" onClick={() => switchProvider('epoch')} className={segmentClass(provider === 'epoch')}>
          Epoch
        </button>
        <button
          type="button"
          onClick={() => switchProvider('agglayer')}
          className={segmentClass(provider === 'agglayer')}
        >
          Agglayer
        </button>
      </div>

      <div className="flex rounded-lg bg-grey-50 p-1 text-xs">
        <button type="button" onClick={() => switchTo('miden-to-evm')} className={segmentClass(tab === 'miden-to-evm')}>
          Miden → EVM
        </button>
        <button type="button" onClick={() => switchTo('evm-to-miden')} className={segmentClass(tab === 'evm-to-miden')}>
          EVM → Miden
        </button>
      </div>

      {provider === 'epoch' ? (
        tab === 'miden-to-evm' ? (
          <MidenToEvmForm evmAddress={evmAddress} midenAccount={midenAccount} />
        ) : (
          <EvmToMidenForm evmAddress={evmAddress} midenRecipient={midenAccount} />
        )
      ) : tab === 'miden-to-evm' ? (
        <AgglayerMidenToEvmForm evmAddress={evmAddress} midenAccount={midenAccount} />
      ) : (
        <AgglayerEvmToMidenForm evmAddress={evmAddress} midenRecipient={midenAccount} />
      )}
    </div>
  );
};
