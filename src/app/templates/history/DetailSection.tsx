import React, { FC, ReactNode } from 'react';

import { DetailCard } from 'components/ui/DetailCard';
import { SectionHeader } from 'components/ui/SectionHeader';

/**
 * A history section (transfer details, bridge details, notes, …): a `SectionHeader` over an outlined
 * `DetailCard`.
 */
export const DetailSection: FC<{ title?: string; children: ReactNode; className?: string }> = ({
  title,
  children,
  className
}) => (
  <section>
    {title && <SectionHeader size="md">{title}</SectionHeader>}
    <DetailCard surface="outline" className={className}>
      {children}
    </DetailCard>
  </section>
);
