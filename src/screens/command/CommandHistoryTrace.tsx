import React, { useId } from 'react';

interface HistoryTracePoint {
  x: number;
  y: number;
  row: { bucket: number; coverageKey: string };
}

export function CommandHistoryTrace({ points, bucketMs }: { points: HistoryTracePoint[]; bucketMs: number }) {
  const fillId = useId();
  const area: string[] = [];
  const trace: string[] = [];
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1]!;
    const point = points[index]!;
    if (point.row.bucket - previous.row.bucket !== bucketMs || point.row.coverageKey !== previous.row.coverageKey)
      continue;
    area.push(`M ${previous.x} 100 L ${previous.x} ${previous.y} L ${point.x} ${point.y} L ${point.x} 100 Z`);
    trace.push(`M ${previous.x} ${previous.y} L ${point.x} ${point.y}`);
  }
  const path = trace.join(' ');
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full" aria-hidden="true">
      <defs>
        <linearGradient id={fillId} x2="0" y2="1" x1="0" y1="0">
          <stop stopColor="var(--accent-primary)" stopOpacity="0.38" />
          <stop offset="1" stopColor="var(--accent-primary)" stopOpacity="0" />
        </linearGradient>
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
      <path data-command-chart-area="" d={area.join(' ')} fill={`url(#${fillId})`} />
      <g fill="none" stroke="var(--accent-primary)" strokeLinecap="round">
        <path d={path} strokeWidth="7" opacity="0.4" className="blur-sm" vectorEffect="non-scaling-stroke" />
        <path d={path} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
      </g>
      {points.map(point => (
        <circle key={point.row.bucket} cx={point.x} cy={point.y} r="0.35" fill="var(--accent-primary)" />
      ))}
    </svg>
  );
}
