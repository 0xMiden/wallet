import React from 'react';

import { render } from '@testing-library/react';

import Sparkline, { Sparkline as NamedSparkline, SparklineProps } from './Sparkline';

describe('Sparkline', () => {
  it('renders nothing for an empty array', () => {
    const { container } = render(<Sparkline points={[]} />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for a single point (needs at least two)', () => {
    const { container } = render(<Sparkline points={[42]} />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it('renders an svg with default box, stroke and path for two points', () => {
    const { container } = render(<Sparkline points={[0, 10]} />);

    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('viewBox')).toBe('0 0 120 32');
    expect(svg!.getAttribute('width')).toBe('120');
    expect(svg!.getAttribute('height')).toBe('32');
    expect(svg!.getAttribute('preserveAspectRatio')).toBe('none');
    // No className passed -> attribute absent.
    expect(svg!.getAttribute('class')).toBeNull();

    const p = container.querySelector('path');
    expect(p).not.toBeNull();
    // min=0 max=10 range=10; xStep=(120-4)/1=116; yScale=(32-4)/10=2.8
    // i0: x=2,      y=32-2-0        = 30
    // i1: x=2+116=118, y=30-10*2.8  = 2
    expect(p!.getAttribute('d')).toBe('M2.00,30.00 L118.00,2.00');
    expect(p!.getAttribute('fill')).toBe('none');
    expect(p!.getAttribute('stroke')).toBe('currentColor');
    expect(p!.getAttribute('stroke-width')).toBe('1.5');
    expect(p!.getAttribute('stroke-linejoin')).toBe('round');
    expect(p!.getAttribute('stroke-linecap')).toBe('round');
  });

  it('honors custom color, dimensions, strokeWidth and className', () => {
    const props: SparklineProps = {
      points: [0, 10, 5],
      color: 'red',
      width: 200,
      height: 50,
      strokeWidth: 3,
      className: 'my-spark'
    };
    const { container } = render(<Sparkline {...props} />);

    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 200 50');
    expect(svg.getAttribute('width')).toBe('200');
    expect(svg.getAttribute('height')).toBe('50');
    expect(svg.getAttribute('class')).toBe('my-spark');

    const p = container.querySelector('path')!;
    // min=0 max=10 range=10; xStep=(200-4)/2=98; yScale=(50-4)/10=4.6
    // i0: x=2,       y=50-2-0       = 48
    // i1: x=2+98=100, y=48-10*4.6   = 2
    // i2: x=2+196=198,y=48-5*4.6    = 25
    expect(p.getAttribute('d')).toBe('M2.00,48.00 L100.00,2.00 L198.00,25.00');
    expect(p.getAttribute('stroke')).toBe('red');
    expect(p.getAttribute('stroke-width')).toBe('3');
  });

  it('falls back to a range of 1 when every point is equal, drawing the flat line mid-box', () => {
    const { container } = render(<Sparkline points={[5, 5, 5]} />);

    const p = container.querySelector('path')!;
    // range = (5-5) || 1 = 1, centred: floor = 4.5; xStep=(120-4)/2=58; yScale=(32-4)/1=28
    // every y = 32-2-(5-4.5)*28 = 16 -> a perfectly flat line through the middle
    expect(p.getAttribute('d')).toBe('M2.00,16.00 L60.00,16.00 L118.00,16.00');
  });

  it('draws a series that moves less than minRange at true scale, centred', () => {
    const { container } = render(<Sparkline points={[99, 101]} width={20} height={24} minRange={20} />);

    // range = max(2, 20) = 20; floor = 100 - 10 = 90; yScale = 20/20 = 1
    // y(99) = 24-2-9 = 13, y(101) = 24-2-11 = 11: a 2px rise, not the full box
    expect(container.querySelector('path')!.getAttribute('d')).toBe('M2.00,13.00 L18.00,11.00');
  });

  it('starts the path with a moveto and uses lineto for the rest', () => {
    const { container } = render(<Sparkline points={[1, 2, 3, 4]} />);
    const d = container.querySelector('path')!.getAttribute('d')!;
    expect(d.startsWith('M')).toBe(true);
    const commands = d.split(' ');
    expect(commands).toHaveLength(4);
    expect(commands[0]![0]).toBe('M');
    expect(commands.slice(1).every(c => c[0] === 'L')).toBe(true);
  });

  it('draws one cubic segment per gap through every point when smooth', () => {
    const { container } = render(<Sparkline points={[1, 3, 2, 4]} width={100} height={20} smooth />);
    const d = container.querySelector('path')!.getAttribute('d')!;
    expect(d.startsWith('M2.00,18.00')).toBe(true);
    const segments = d.match(/C[^C]+/g)!;
    expect(segments).toHaveLength(3);
    // The curve ends on the last point: x at the right padding, y at the top padding (the max).
    expect(segments[2]!.trim().endsWith('98.00,2.00')).toBe(true);
  });

  it('exposes the same component as the default and named export', () => {
    expect(Sparkline).toBe(NamedSparkline);
  });
});
