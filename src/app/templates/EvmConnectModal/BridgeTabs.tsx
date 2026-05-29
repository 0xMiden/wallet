import React, { useCallback, useState } from 'react';

import { useEpochStore } from 'lib/epoch';
import { hapticLight } from 'lib/mobile/haptics';

import { EvmToMidenForm } from './EvmToMidenForm';
import { MidenToEvmForm } from './MidenToEvmForm';
import { BridgeTab } from './shared';

interface BridgeTabsProps {
  evmAddress: string;
  midenAccount: string;
}

export const BridgeTabs: React.FC<BridgeTabsProps> = ({ evmAddress, midenAccount }) => {
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
