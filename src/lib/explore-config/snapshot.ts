import faucetIcon from 'app/misc/dapp-icons/faucet.png';
import forkchoiceFaucetIcon from 'app/misc/dapp-icons/forkchoice-faucet.png';

import devnet from './snapshot/devnet.json';
import testnet from './snapshot/testnet.json';

// Byte copies of 0xMiden/wallet-explore's documents at release time: the catalog a device shows before its first
// fetch lands, and whenever none ever has. Networks without a published document have none.
const SNAPSHOTS: Record<string, unknown> = { devnet, testnet };

export function bundledExploreConfig(network: string): unknown {
  return SNAPSHOTS[network] ?? null;
}

/** The icons the bundled documents name, shipped with the build so a first run and an offline one draw them too. */
export const BUNDLED_EXPLORE_ICONS: Readonly<Record<string, string>> = {
  'icons/faucet.png': faucetIcon,
  'icons/forkchoice-faucet.png': forkchoiceFaucetIcon
};
