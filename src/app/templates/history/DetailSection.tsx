import React, { FC, ReactNode } from 'react';

import classNames from 'clsx';

import { DetailCard } from 'components/ui/DetailCard';

/**
 * A `DetailCard` with an optional compact pill label above it — the shape every history
 * section (transfer details, bridge details, notes, …) uses. The label predates the design
 * system's `SectionHeader` (*planned*, see `skills/miden-wallet-frontend/references/design-system.md`);
 * once that lands, history sections should move onto it instead of this local pill.
 */
export const DetailSection: FC<{ title?: string; children: ReactNode; className?: string }> = ({
  title,
  children,
  className
}) => (
  <section className="font-heading">
    {title && (
      // `gray-50` + `heading-gray` rather than a literal #F1F1F1 with `text-gray`: gray-50 is
      // that same near-white in light and flips on its own, so the `dark:` override is no
      // longer needed, and #808080 ink was 3.51:1 on the light chip. Same treatment as
      // `StatusPill` in `./TransactionStatus`.
      <div className="inline-flex rounded-full bg-gray-50 px-2.5 py-1 text-sm font-bold leading-4 text-heading-gray">
        {title}
      </div>
    )}
    <DetailCard className={classNames(title && 'mt-2', className)}>{children}</DetailCard>
  </section>
);
