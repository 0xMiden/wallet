import React, { FC } from 'react';

import classNames from 'clsx';

interface SyncWaveBackgroundProps {
  isSyncing: boolean;
  className?: string;
}

export const SyncWaveBackground: FC<SyncWaveBackgroundProps> = ({ isSyncing, className }) => {
  if (!isSyncing) return null;

  return (
    <div className={classNames('absolute inset-0 overflow-hidden pointer-events-none z-10', className)}>
      {/* Animated shimmer wave */}
      <div
        className="absolute inset-0 animate-gradient-wave motion-reduce:animate-none"
        style={{
          background: 'linear-gradient(90deg, transparent 0%, rgba(249, 115, 22, 0.3) 50%, transparent 100%)',
          backgroundSize: '200% 100%'
        }}
      />
    </div>
  );
};
