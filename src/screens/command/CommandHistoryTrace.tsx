import React, { useId } from 'react';

interface HistoryTracePoint {
  x: number;
  y: number;
  bucket: number;
  run: number;
}

export function CommandHistoryTrace({ points }: { points: HistoryTracePoint[] }) {
  const fillId = useId();
  const area: string[] = [];
  const trace: string[] = [];
  for (let start = 0; start < points.length; ) {
    const first = points[start]!;
    let end = start + 1;
    while (points[end]?.run === first.run) end++;
    if (end - start > 1) {
      const lines = points
        .slice(start + 1, end)
        .map(point => `L ${point.x} ${point.y}`)
        .join(' ');
      area.push(`M ${first.x} 100 L ${first.x} ${first.y} ${lines} L ${points[end - 1]!.x} 100 Z`);
      trace.push(`M ${first.x} ${first.y} ${lines}`);
    }
    start = end;
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
      {path && (
        <>
          <path data-command-chart-area="" d={area.join(' ')} fill={`url(#${fillId})`} />
          <g fill="none" stroke="var(--accent-primary)" strokeLinecap="round">
            <path
              d={path}
              strokeWidth="7"
              opacity="0.4"
              className="[filter:blur(4px)]"
              vectorEffect="non-scaling-stroke"
            />
            <path d={path} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
          </g>
        </>
      )}
      {points.map(point => (
        <circle key={point.bucket} cx={point.x} cy={point.y} r="0.35" fill="var(--accent-primary)" />
      ))}
    </svg>
  );
}
