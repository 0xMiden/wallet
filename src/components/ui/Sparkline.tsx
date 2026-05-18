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
  className
}) => {
  const path = useMemo(() => {
    if (points.length < 2) return '';
    const min = Math.min(...points);
    const max = Math.max(...points);
    const range = max - min || 1;
    const xStep = (width - PADDING * 2) / (points.length - 1);
    const yScale = (height - PADDING * 2) / range;

    return points
      .map((v, i) => {
        const x = PADDING + i * xStep;
        const y = height - PADDING - (v - min) * yScale;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
  }, [points, width, height]);

  if (!path) return null;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="none"
      className={className}
    >
      <path d={path} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
};

export default Sparkline;
