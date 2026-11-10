import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { TokenLogo } from 'components/TokenLogo';
import { SectionHeader } from 'components/ui/SectionHeader';
import { outlineSurfaceClassName } from 'components/ui/surfaces';
import type { BasketComponent } from 'lib/prices';
import { cn } from 'lib/ui/util';

// A token whose brand has one well-known colour keeps it, as TokenLogo's marks do; any other takes the theme's chart
// palette in order. Each token keeps its colour in the bar and on its dot in the legend.
const BRAND_COLORS: Record<string, string> = {
  BTC: '#F7931A',
  ETH: '#627EEA',
  SOL: '#9945FF',
  USDC: '#2775CA'
};
const SEGMENT_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];

/** Each component's colour: its brand's, else the next palette colour no brand already took. */
function componentColors(components: readonly BasketComponent[]): string[] {
  let next = 0;
  return components.map(c => BRAND_COLORS[c.priceSymbol] ?? SEGMENT_COLORS[next++ % SEGMENT_COLORS.length] ?? '');
}

/** A share as a percent with one decimal, or `<0.1%` for a share that would round to nothing. */
function formatShare(weight: number): string {
  const percent = weight * 100;
  return percent > 0 && percent < 0.1 ? '<0.1%' : `${percent.toFixed(1)}%`;
}

/**
 * What one unit of a basket token holds: a bar split by each token's share of the basket's value, and under it each
 * token's mark, symbol and share. The tokens are the verified constituents the token list names, weighted by what the vault holds (`basketComposition`).
 */
export const BasketComposition: FC<{ components: readonly BasketComponent[]; className?: string }> = ({
  components,
  className
}) => {
  const { t } = useTranslation();
  const colors = componentColors(components);
  return (
    <section data-testid="token-detail-composition" className={className}>
      <SectionHeader size="2xl" tone="muted" className="px-0 pb-3">
        {t('basketComposition')}
      </SectionHeader>
      <div className={cn('flex flex-col gap-3 rounded-2xl px-4 py-4', outlineSurfaceClassName)}>
        {/* The legend below says the same in words, so the bar is decoration to assistive technology. */}
        <div aria-hidden="true" className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full">
          {components.map((c, i) => (
            <span
              key={c.faucetId}
              className="h-full first:rounded-l-full last:rounded-r-full"
              style={{ width: `${c.weight * 100}%`, backgroundColor: colors[i] }}
              data-testid="token-detail-composition-segment"
            />
          ))}
        </div>
        <ul className="flex flex-col gap-2.5">
          {components.map((c, i) => (
            <li key={c.faucetId} className="flex items-center gap-2.5" data-testid="token-detail-composition-item">
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: colors[i] }}
              />
              <TokenLogo symbol={c.symbol} faucetId={c.faucetId} size="sm" />
              <span className="min-w-0 flex-1 truncate text-value text-ink">{c.symbol}</span>
              <span className="text-value tabular-nums text-muted">{formatShare(c.weight)}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
};
