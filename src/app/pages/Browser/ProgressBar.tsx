/**
 * Thin progress bar shown under the capsule while a dApp is loading.
 *
 * The InAppBrowser plugin doesn't expose real progress events, so we fake
 * monotonic progress: jump to 30% immediately, climb slowly to 70% over
 * the next ~2 seconds, then jump to 100% when `browserPageLoaded` fires.
 * This is the same trick browsers like Safari use under the hood — users
 * can't tell the difference and it feels responsive.
 */

import React, { useEffect, useState } from 'react';

import { motion } from 'framer-motion';

import { durations, easings } from 'lib/animation';

interface ProgressBarProps {
  loading: boolean;
}

export const ProgressBar: React.FC<ProgressBarProps> = ({ loading }) => {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!loading) {
      setProgress(100);
      // Hide entirely after fade-out completes
      const timeout = setTimeout(() => setProgress(0), 400);
      return () => clearTimeout(timeout);
    }

    setProgress(30);
    let current = 30;
    const interval = setInterval(() => {
      current = Math.min(70, current + 4);
      setProgress(current);
      if (current >= 70) clearInterval(interval);
    }, 120);
    return () => clearInterval(interval);
  }, [loading]);

  return (
    <div
      className="relative h-[2px] w-full overflow-hidden bg-transparent"
      role="progressbar"
      aria-valuenow={progress}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <motion.div
        className="h-full bg-primary-500"
        animate={{ width: `${progress}%`, opacity: progress > 0 && progress < 100 ? 1 : 0 }}
        transition={{ duration: durations.normal, ease: easings.easeOutCubic }}
      />
    </div>
  );
};
