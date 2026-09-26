import React, { cloneElement, memo, ReactElement, useMemo } from 'react';

import BigNumber from 'bignumber.js';
import classNames from 'clsx';
import CSSTransition from 'react-transition-group/CSSTransition';

import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { priceSymbolFor } from 'lib/miden/swap/tokens';
import { quotedPrice } from 'lib/prices';
import { useWalletStore } from 'lib/store';

type BalanceProps = {
  /** The fiat total, or null when the account holds tokens and none of them has a price. */
  children: (b: BigNumber | null) => ReactElement;
};

const Balance = memo<BalanceProps>(({ children }) => {
  const account = useAccount();
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: allTokenBalances = [] } = useAllBalances(account.publicKey, allTokensBaseMetadata);
  const tokenPrices = useWalletStore(s => s.tokenPrices);

  return useMemo(() => {
    // A token whose decimals were never resolved contributes a `balance` that was
    // divided by the placeholder's guessed 6, so it can be off by a factor of a
    // trillion. Folding that into the portfolio total does not make the total
    // partly wrong — it makes it meaningless, and unlike a single row there is no
    // way for the user to see which asset spoiled it. Leaving such an asset out
    // understates the total; including it can invent one.
    //
    // A token with no quote is left out the same way: it has no dollar value to add. When
    // something is held and none of it is quoted there is no total at all, rather than a $0.00
    // that reads as an empty wallet.
    let totalFiat = 0;
    let holdsAnything = false;
    let valuedAnything = false;
    for (const token of allTokenBalances) {
      if (!(token.balance > 0)) continue;
      holdsAnything = true;
      if (!hasKnownScale(token.metadata)) continue;
      const quote = quotedPrice(tokenPrices, priceSymbolFor(token.tokenId, token.metadata.symbol));
      if (!quote) continue;
      valuedAnything = true;
      totalFiat += token.balance * quote.price;
    }
    const childNode = children(holdsAnything && !valuedAnything ? null : new BigNumber(totalFiat));
    const exist = true;

    return (
      <CSSTransition
        in={exist}
        timeout={200}
        classNames={{
          enter: 'opacity-0',
          enterActive: classNames('opacity-100', 'transition ease-out duration-200'),
          exit: classNames('opacity-0', 'transition ease-in duration-200')
        }}
      >
        {cloneElement(childNode, {
          className: classNames(childNode.props.className, !exist && 'invisible')
        })}
      </CSSTransition>
    );
  }, [children, allTokenBalances, tokenPrices]);
});

export default Balance;
