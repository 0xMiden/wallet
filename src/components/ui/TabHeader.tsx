import React, { FC, ReactNode } from 'react';

export interface TabHeaderProps {
  title: string;
  /** Extra action buttons rendered on the right of the title. */
  actions?: ReactNode;
}

/**
 * Header for top-level tab pages (Activity, Explore): page title on the
 * left, any `actions` on the right.
 *
 * The settings gear that used to live here is gone — Settings is a primary
 * bottom-nav destination now, so a gear on the very screens that show that
 * tab was a duplicate affordance.
 */
export const TabHeader: FC<TabHeaderProps> = ({ title, actions }) => (
  <>
    <header className="shrink-0 px-4 py-3 flex items-center justify-between">
      <h1 className="font-heading text-[28px] font-bold text-heading-gray dark:text-pure-white">{title}</h1>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
    <div aria-hidden="true" className="shrink-0 mx-4 h-1 rounded-full bg-gray-50" />
  </>
);

export default TabHeader;
