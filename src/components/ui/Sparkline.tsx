import React, { FC, useMemo } from 'react';

export interface SparklineProps {
  /** Y values in chronological order. */
  points: number[];
  /** Stroke color (any valid CSS color). Defaults to currentColor. */
  color?: string;
  /** Box width in px. */
  width?: number;
  /** Box height in px. */
  height?: number;
  /** Stroke width in px. */
  strokeWidth?: number;
  /** Draw a smooth curve through the points (Catmull-Rom) instead of straight segments. */
  smooth?: boolean;
  /**
   * The smallest value range the box stands for. A series that moves less is drawn at true scale,
   * centred, instead of stretched top to bottom — so a stablecoin's flat day reads flat.
   */
  minRange?: number;
  className?: string;
}

const DEFAULT_WIDTH = 120;
const DEFAULT_HEIGHT = 32;
const PADDING = 2;

export const Sparkline: FC<SparklineProps> = ({
  points,
  color = 'currentColor',
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  strokeWidth = 1.5,
  smooth = false,
  minRange = 0,
  className
}) => {
  const path = useMemo(() => {
    if (points.length < 2) return '';
    const min = Math.min(...points);
    const max = Math.max(...points);
    const range = Math.max(max - min, minRange) || 1;
    // Centre the series in the box when the floor widened its range.
    const floor = (min + max) / 2 - range / 2;
    const xStep = (width - PADDING * 2) / (points.length - 1);
    const yScale = (height - PADDING * 2) / range;

    const xy = points.map((v, i) => [PADDING + i * xStep, height - PADDING - (v - floor) * yScale] as const);
    const f = (n: number) => n.toFixed(2);

    if (!smooth) {
      return xy.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${f(x)},${f(y)}`).join(' ');
    }

    // Catmull-Rom through every point, as cubic Béziers: each segment's handles are a sixth of the
    // way along the line joining its neighbours, so the curve passes through the data unflattened.
    let d = `M${f(xy[0]![0])},${f(xy[0]![1])}`;
    for (let i = 0; i < xy.length - 1; i++) {
      const p0 = xy[i - 1] ?? xy[i]!;
      const p1 = xy[i]!;
      const p2 = xy[i + 1]!;
      const p3 = xy[i + 2] ?? p2;
      const c1x = p1[0] + (p2[0] - p0[0]) / 6;
      const c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6;
      const c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += ` C${f(c1x)},${f(c1y)} ${f(c2x)},${f(c2y)} ${f(p2[0])},${f(p2[1])}`;
    }
    return d;
  }, [points, width, height, smooth, minRange]);

  if (!path) return null;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="none"
      className={className}
    >
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
};

export default Sparkline;
