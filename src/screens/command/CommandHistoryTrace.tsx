import React, { useId } from 'react';

import { motion, useReducedMotion } from 'framer-motion';

import { presets } from 'lib/animation';

interface HistoryTracePoint {
  x: number;
  y: number;
  bucket: number;
  run: number;
}

const MAX_POINT_MARKERS = 30;

export function CommandHistoryTrace({ points, reveal = false }: { points: HistoryTracePoint[]; reveal?: boolean }) {
  const sweepId = useId();
  const sweep = useReducedMotion() === false && reveal;
  const trace: string[] = [];
  const gapConnectors: string[] = [];
  for (let start = 0; start < points.length; ) {
    const first = points[start]!;
    let end = start + 1;
    while (points[end]?.run === first.run) end++;
    if (end - start > 1) {
      const lines = points
        .slice(start + 1, end)
        .map(point => `L ${point.x} ${point.y}`)
        .join(' ');
      trace.push(`M ${first.x} ${first.y} ${lines}`);
    }
    const previous = points[start - 1];
    if (previous && previous.run !== first.run) {
      gapConnectors.push(`M ${previous.x} ${previous.y} L ${first.x} ${first.y}`);
    }
    start = end;
  }
  const path = trace.join(' ');
  const gapPath = gapConnectors.join(' ');
  const showMarkers = points.length <= MAX_POINT_MARKERS;

  return (
    <div className="relative h-full w-full">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full" aria-hidden="true">
        <defs>
          {sweep && (path || gapPath) && (
            <clipPath id={sweepId}>
              <motion.rect
                data-command-chart-sweep=""
                height="100"
                width="100"
                initial={{ width: 0 }}
                animate={{ width: 100 }}
                transition={presets.fade.transition}
              />
            </clipPath>
          )}
        </defs>
        {[25, 50, 75].map(y => (
          <line
            key={y}
            x1="0"
            x2="100"
            y1={y}
            y2={y}
            stroke="currentColor"
            strokeOpacity="0.12"
            strokeDasharray="1 5"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <g clipPath={sweep && (path || gapPath) ? `url(#${sweepId})` : undefined} fill="none">
          {gapPath && (
            <path
              data-command-chart-gap-line=""
              d={gapPath}
              stroke="var(--accent-primary)"
              strokeOpacity="0.45"
              strokeWidth="1.75"
              strokeDasharray="4 4"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {path && (
            <>
              <path
                d={path}
                stroke="var(--accent-primary)"
                strokeWidth="6"
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity="0.28"
                className="[filter:blur(4px)]"
                vectorEffect="non-scaling-stroke"
              />
              <path
                data-command-chart-line=""
                d={path}
                stroke="var(--accent-primary)"
                strokeWidth="2.5"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </>
          )}
        </g>
      </svg>
      {showMarkers &&
        points.map((point, index) => (
          <span
            key={`${point.bucket}-${index}`}
            aria-hidden="true"
            data-command-chart-point=""
            data-x={point.x}
            className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent-primary ring-2 ring-page"
            style={{ left: `${point.x}%`, top: `${point.y}%` }}
          />
        ))}
    </div>
  );
}
