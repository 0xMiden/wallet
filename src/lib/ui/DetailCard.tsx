import React, { FC } from 'react';

import classNames from 'clsx';

export const DetailCard: FC<{ title?: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="border border-[#E6E6E6] rounded-10 bg-white overflow-hidden">
    {title && (
      <div className="text-xs border-b border-[#E6E6E6] font-semibold text-heading-gray uppercase tracking-[0.6px] leading-4 w-full py-3 pl-4">
        {title}
      </div>
    )}
    {children}
  </div>
);

export const DetailRow: FC<{
  label: string;
  value?: string;
  badge?: string;
  icon?: React.ReactNode;
  isLast?: boolean;
  children?: React.ReactNode;
}> = ({ label, value, badge, icon, isLast, children }) => (
  <div className={classNames('flex items-center justify-between px-4 py-3', !isLast && 'border-b border-[#BABABA33]')}>
    <div className="flex items-center gap-3">
      {icon}
      <span className="text-sm text-heading-gray font-medium">{label}</span>
    </div>
    {children ? (
      <div className="flex items-center">{children}</div>
    ) : badge ? (
      <span className="text-sm font-medium text-[#CC5200] bg-[#FFF3EB] px-3 py-1 rounded-full">{badge}</span>
    ) : (
      <span className="text-sm text-heading-gray font-medium">{value}</span>
    )}
  </div>
);
