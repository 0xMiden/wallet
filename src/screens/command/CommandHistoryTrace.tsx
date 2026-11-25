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

function buildSmoothSegment(segment: readonly HistoryTracePoint[]): { line: string; area: string } | null {
  const n = segment.length;
  if (n < 2) return null;
  const first = segment[0]!;
  const last = segment[n - 1]!;
  if (n === 2) {
    const seg = `L ${last.x} ${last.y}`;
    return {
      line: `M ${first.x} ${first.y} ${seg}`,
      area: `M ${first.x} 100 L ${first.x} ${first.y} ${seg} L ${last.x} 100 Z`
    };
  }

  const dx: number[] = [];
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const a = segment[i]!;
    const b = segment[i + 1]!;
    const h = b.x - a.x;
    dx.push(h);
    slopes.push(h > 1e-6 ? (b.y - a.y) / h : 0);
  }

  const tangents = new Array<number>(n).fill(0);
  tangents[0] = slopes[0]!;
  tangents[n - 1] = slopes[n - 2]!;
  for (let i = 1; i < n - 1; i += 1) {
    const prev = slopes[i - 1]!;
    const next = slopes[i]!;
    if (prev * next <= 0) {
      tangents[i] = 0;
    } else {
      const hPrev = dx[i - 1]!;
      const hNext = dx[i]!;
      const w1 = 2 * hNext + hPrev;
      const w2 = hNext + 2 * hPrev;
      tangents[i] = hPrev > 1e-6 && hNext > 1e-6 ? (w1 + w2) / (w1 / prev + w2 / next) : 0;
    }
  }

  const cmds: string[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const p0 = segment[i]!;
    const p1 = segment[i + 1]!;
    const h = dx[i]!;
    if (h <= 1e-6) {
      cmds.push(`L ${p1.x} ${p1.y}`);
    } else {
      const c1x = p0.x + h / 3;
      const c1y = p0.y + (tangents[i]! * h) / 3;
      const c2x = p1.x - h / 3;
      const c2y = p1.y - (tangents[i + 1]! * h) / 3;
      cmds.push(`C ${c1x} ${c1y} ${c2x} ${c2y} ${p1.x} ${p1.y}`);
    }
  }

  const body = cmds.join(' ');
  return {
    line: `M ${first.x} ${first.y} ${body}`,
    area: `M ${first.x} 100 L ${first.x} ${first.y} ${body} L ${last.x} 100 Z`
  };
}

export function CommandHistoryTrace({ points, reveal = false }: { points: HistoryTracePoint[]; reveal?: boolean }) {
  const fillId = useId();
  const strokeId = useId();
  const sweepId = useId();
  const reducedMotion = useReducedMotion();
  const sweep = reducedMotion === false && reveal;
  const segments: Array<{ line: string; area: string }> = [];
  const gapConnectors: string[] = [];

  for (let start = 0; start < points.length; ) {
    const first = points[start]!;
    let end = start + 1;
    while (points[end]?.run === first.run) end++;
    const built = buildSmoothSegment(points.slice(start, end));
    if (built) segments.push(built);
    const previous = points[start - 1];
    if (previous && previous.run !== first.run) {
      gapConnectors.push(`M ${previous.x} ${previous.y} L ${first.x} ${first.y}`);
    }
    start = end;
  }

  const path = segments.map(seg => seg.line).join(' ');
  const gapPath = gapConnectors.join(' ');
  const showMarkers = points.length <= MAX_POINT_MARKERS;
  const lastPoint = points[points.length - 1];

  return (
    <div className="relative h-full w-full">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full" aria-hidden="true">
        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent-primary)" stopOpacity="0.22" />
            <stop offset="78%" stopColor="var(--accent-primary)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={strokeId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#ffb86c" />
            <stop offset="52%" stopColor="var(--accent-primary)" />
            <stop offset="100%" stopColor="#ff6b35" />
          </linearGradient>
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
          {segments.map((seg, index) => (
            <path key={`glow-${index}`} d={seg.area} fill={`url(#${fillId})`} />
          ))}
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
                strokeWidth="12"
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity="0.16"
                className="[filter:blur(8px)]"
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={path}
                stroke="var(--accent-primary)"
                strokeWidth="5"
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity="0.36"
                className="[filter:blur(2px)]"
                vectorEffect="non-scaling-stroke"
              />
              <path
                data-command-chart-line=""
                d={path}
                stroke={`url(#${strokeId})`}
                strokeWidth="2.5"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
              {!reducedMotion &&
                segments.map((seg, index) => (
                  <path
                    key={`spark-${index}`}
                    d={seg.line}
                    pathLength={100}
                    stroke="#fff3df"
                    strokeWidth="2.5"
                    strokeDasharray="12 88"
                    strokeLinecap="round"
                    opacity="0.85"
                    className="command-chart-energy-spark"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
            </>
          )}
        </g>
      </svg>
      {lastPoint && !reducedMotion && (
        <span
          aria-hidden="true"
          className="command-chart-beacon pointer-events-none absolute size-3 rounded-full border border-accent-primary/80"
          style={{ left: `${lastPoint.x}%`, top: `${lastPoint.y}%` }}
        />
      )}
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
