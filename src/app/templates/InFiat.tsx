import React, { FC, ReactElement, ReactNode, useMemo } from 'react';

import BigNumber from 'bignumber.js';

import Money from 'app/atoms/Money';
import { useAssetFiatCurrencyPrice, useFiatCurrency } from 'lib/fiat-curency';

type OutputProps = {
  balance: ReactNode;
  symbol: string;
};

type InFiatProps = {
  volume: BigNumber | number | string;
  assetSlug?: string;
  children: (output: OutputProps) => ReactElement;
  roundingMode?: BigNumber.RoundingMode;
  shortened?: boolean;
  smallFractionFont?: boolean;
  mainnet?: boolean;
  showCents?: boolean;
};

const InFiat: FC<InFiatProps> = ({
  volume,
  assetSlug,
  children,
  roundingMode,
  shortened,
  smallFractionFont,
  mainnet,
  showCents = true
}) => {
  const price = useAssetFiatCurrencyPrice(assetSlug ?? 'aleo');
  const { selectedFiatCurrency } = useFiatCurrency();

  if (mainnet === undefined) {
    mainnet = true;
  }
  const roundedInFiat = useMemo(() => {
    if (!price) {
      return new BigNumber(0);
    }
    const inFiat = new BigNumber(volume).times(price);
    if (showCents) {
      return inFiat;
    }
    return inFiat.integerValue();
  }, [price, showCents, volume]);

  const cryptoDecimals = showCents ? undefined : 0;

  return mainnet && price !== null
    ? children({
        balance: (
          <Money
            fiat={showCents}
            cryptoDecimals={cryptoDecimals}
            roundingMode={roundingMode}
            shortened={shortened}
            smallFractionFont={smallFractionFont}
          >
            {roundedInFiat}
          </Money>
        ),
        symbol: selectedFiatCurrency?.symbol ?? ''
      })
    : null;
};

export default InFiat;
