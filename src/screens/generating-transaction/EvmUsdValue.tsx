import React from 'react';

import { UsdValue } from 'components/TokenUsdValue';
import { evmQuote } from 'lib/prices/evm';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { useWalletStore } from 'lib/store';

/** EVM estimates resolve by configured chain and contract, never a display symbol. */
export const EvmUsdValue: React.FC<{
  amount: string | number | bigint;
  decimals?: number;
  chainId?: number;
  address?: string;
  className?: string;
}> = ({ chainId, address, ...props }) => {
  const prices = useWalletStore(state => state.tokenPrices);
  const snapshot = useBridgeConfigSnapshot({ load: false });
  return <UsdValue {...props} quote={evmQuote(prices, chainId, address, snapshot)} />;
};
