import React from 'react';

import { render, screen } from '@testing-library/react';

// Recharts pulls in ResizeObserver-based `ResponsiveContainer` (which renders
// nothing under jsdom's zero-size layout) plus heavy SVG chart primitives. We
// replace the module boundary with light stand-ins so that:
//   - `ResponsiveContainer` renders its child directly, letting the internal
//     `ChartContext` reach `ChartTooltipContent` / `ChartLegendContent`.
//   - `Tooltip` / `Legend` are trivial components (only used as re-export
//     identities, never actually mounted by these tests).
// The factory intentionally references no out-of-scope bindings so swc's
// jest-hoist is happy and no JSX (React.createElement) is needed here.
jest.mock('recharts', () => ({
  __esModule: true,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => children,
  Tooltip: () => null,
  Legend: () => null
}));

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartStyle,
  ChartTooltip,
  ChartTooltipContent
} from './charts';

// Render a tooltip/legend inside a real `ChartContainer` so it receives the
// `ChartContext` the way the app wires it up.
const renderInChart = (ui: React.ReactElement, config: any = {}) =>
  render(<ChartContainer config={config}>{ui as any}</ChartContainer>);

describe('recharts re-exports', () => {
  it('re-exports the recharts Tooltip and Legend primitives', () => {
    expect(ChartTooltip).toBeDefined();
    expect(ChartLegend).toBeDefined();
  });
});

describe('ChartContainer', () => {
  it('uses an explicit id for data-chart and renders the child + style block', () => {
    const { container } = render(
      <ChartContainer id="myChart" config={{ sales: { color: '#ff0000' } }}>
        <div>chart-child</div>
      </ChartContainer>
    );

    const chartDiv = container.querySelector('[data-slot="chart"]');
    expect(chartDiv).toHaveAttribute('data-chart', 'chart-myChart');
    expect(chartDiv).toHaveClass('flex', 'aspect-video', 'justify-center');
    expect(screen.getByText('chart-child')).toBeInTheDocument();
    // config carries a color → ChartStyle emits a <style> block.
    expect(container.querySelector('style')).toBeTruthy();
  });

  it('falls back to a generated id, merges className, spreads props, and omits style for empty config', () => {
    const { container } = render(
      <ChartContainer config={{}} className="my-extra-class" data-testid="cc" role="figure">
        <div>x</div>
      </ChartContainer>
    );

    const chartDiv = screen.getByTestId('cc');
    expect(chartDiv.getAttribute('data-chart')).toMatch(/^chart-/);
    expect(chartDiv).toHaveClass('my-extra-class', 'flex', 'aspect-video');
    expect(chartDiv).toHaveAttribute('role', 'figure');
    // empty config → ChartStyle returns null → no <style>.
    expect(container.querySelector('style')).toBeNull();
  });
});

describe('ChartStyle', () => {
  it('returns null when no entry defines a color or theme', () => {
    const { container } = render(<ChartStyle id="c-none" config={{ a: { label: 'A' } }} />);
    expect(container.querySelector('style')).toBeNull();
  });

  it('emits per-key CSS variables for a flat color config', () => {
    const { container } = render(
      <ChartStyle id="c-color" config={{ sales: { label: 'Sales', color: '#ff0000' } }} />
    );

    const style = container.querySelector('style');
    expect(style).toBeTruthy();
    expect(style!.innerHTML).toContain('[data-chart=c-color]');
    // A flat `color` is applied to both the light and dark theme blocks.
    expect(style!.innerHTML).toContain('--color-sales: #ff0000;');
  });

  it('emits theme-specific colors and skips keys that resolve to no color for a theme', () => {
    const { container } = render(
      <ChartStyle
        id="c-theme"
        config={{
          visitors: { label: 'Visitors', theme: { light: '#111111', dark: '#222222' } },
          // light resolves to '' (falsy) and there is no flat color → the
          // `color ? ... : null` null branch is taken for the light block.
          blank: { label: 'Blank', theme: { light: '', dark: '#333333' } }
        }}
      />
    );

    const html = container.querySelector('style')!.innerHTML;
    expect(html).toContain('--color-visitors: #111111;');
    expect(html).toContain('--color-visitors: #222222;');
    expect(html).toContain('--color-blank: #333333;');
    // The light-theme block never produces a color line for `blank`.
    expect(html).not.toContain('--color-blank: ;');
  });
});

describe('ChartTooltipContent', () => {
  it('throws when used outside of a ChartContainer', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      render(<ChartTooltipContent active payload={[{ dataKey: 'x', value: 1, payload: {} }]} />)
    ).toThrow('useChart must be used within a <ChartContainer />');
    spy.mockRestore();
  });

  it('renders nothing when inactive', () => {
    const { container } = renderInChart(
      <ChartTooltipContent active={false} payload={[{ dataKey: 'a', name: 'a', value: 1, color: '#abc', payload: {} }]} />,
      { a: { label: 'A', color: '#abc' } }
    );
    expect(container.querySelector('.min-w-32')).toBeNull();
  });

  it('renders nothing when the payload is empty', () => {
    const { container } = renderInChart(<ChartTooltipContent active payload={[]} />, {});
    expect(container.querySelector('.min-w-32')).toBeNull();
  });

  it('renders a string label resolved from config and formats the numeric value', () => {
    renderInChart(
      <ChartTooltipContent
        active
        label="sales"
        payload={[{ dataKey: 'sales', name: 'sales', value: 1234, color: '#abc', payload: { fill: '#def' } }]}
      />,
      { sales: { label: 'Total Sales', color: '#abc' } }
    );

    // Appears both as the tooltip label and the row label.
    expect(screen.getAllByText('Total Sales').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('1,234')).toBeInTheDocument();
  });

  it('uses labelFormatter to render the label when provided', () => {
    const labelFormatter = jest.fn((value: React.ReactNode) => `LF:${value}`);
    renderInChart(
      <ChartTooltipContent
        active
        label="sales"
        labelFormatter={labelFormatter}
        payload={[{ dataKey: 'sales', name: 'sales', value: 10, color: '#abc', payload: {} }]}
      />,
      { sales: { label: 'S', color: '#abc' } }
    );

    expect(labelFormatter).toHaveBeenCalled();
    expect(screen.getByText('LF:S')).toBeInTheDocument();
  });

  it('omits the top label when hideLabel is set', () => {
    renderInChart(
      <ChartTooltipContent
        active
        hideLabel
        label="sales"
        payload={[{ dataKey: 'sales', name: 'sales', value: 5, color: '#abc', payload: {} }]}
      />,
      { sales: { label: 'S', color: '#abc' } }
    );

    // With hideLabel the tooltip label is gone; 'S' only appears in the row.
    expect(screen.getAllByText('S')).toHaveLength(1);
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('renders no label when the resolved label value is empty and there is no labelFormatter', () => {
    renderInChart(
      <ChartTooltipContent
        active
        labelKey="nope"
        payload={[{ dataKey: 'x', name: 'x', value: 7, color: '#000', payload: {} }]}
      />,
      { x: { color: '#000' } }
    );

    // No top label div, but the row value still renders.
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.queryByText('nope')).toBeNull();
  });

  it('nests the label inside the row for a single payload with a non-dot indicator', () => {
    const { container } = renderInChart(
      <ChartTooltipContent
        active
        indicator="line"
        label="sales"
        payload={[{ dataKey: 'sales', name: 'sales', value: 20, color: '#abc', payload: { fill: '#f00' } }]}
      />,
      { sales: { label: 'Sales', color: '#abc' } }
    );

    expect(screen.getAllByText('Sales').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('20')).toBeInTheDocument();
    // The line indicator swatch uses the `w-1` modifier.
    expect(container.querySelector('.w-1')).toBeTruthy();
  });

  it('renders a dashed indicator with nested-label spacing', () => {
    const { container } = renderInChart(
      <ChartTooltipContent
        active
        indicator="dashed"
        label="sales"
        payload={[{ dataKey: 'sales', name: 'sales', value: 3, color: '#abc', payload: {} }]}
      />,
      { sales: { label: 'Sales', color: '#abc' } }
    );

    expect(screen.getByText('3')).toBeInTheDocument();
    expect(container.querySelector('.border-dashed')).toBeTruthy();
    expect(container.querySelector('.my-0\\.5')).toBeTruthy();
  });

  it('hides the indicator swatch when hideIndicator is set', () => {
    const { container } = renderInChart(
      <ChartTooltipContent
        active
        hideIndicator
        label="sales"
        payload={[{ dataKey: 'sales', name: 'sales', value: 9, color: '#abc', payload: {} }]}
      />,
      { sales: { label: 'Sales', color: '#abc' } }
    );

    expect(screen.getByText('9')).toBeInTheDocument();
    expect(container.querySelector('[style*="--color-bg"]')).toBeNull();
  });

  it('renders the config icon instead of the default indicator', () => {
    const Icon = () => <svg data-testid="cfg-icon" />;
    renderInChart(
      <ChartTooltipContent
        active
        label="sales"
        payload={[{ dataKey: 'sales', name: 'sales', value: 2, color: '#abc', payload: {} }]}
      />,
      { sales: { label: 'Sales', color: '#abc', icon: Icon } }
    );

    expect(screen.getByTestId('cfg-icon')).toBeInTheDocument();
  });

  it('uses the custom formatter when value and name are present', () => {
    const formatter = jest.fn(() => <span data-testid="fmt">formatted</span>);
    renderInChart(
      <ChartTooltipContent
        active
        formatter={formatter}
        label="sales"
        payload={[{ dataKey: 'sales', name: 'sales', value: 100, color: '#abc', payload: {} }]}
      />,
      { sales: { label: 'Sales', color: '#abc' } }
    );

    expect(formatter).toHaveBeenCalledWith(100, 'sales', expect.anything(), 0, {});
    expect(screen.getByTestId('fmt')).toBeInTheDocument();
  });

  it('prefers the color prop for the indicator swatch and resolves config via nameKey', () => {
    const { container } = renderInChart(
      <ChartTooltipContent
        active
        color="#123456"
        nameKey="name"
        label="sales"
        payload={[{ dataKey: 'sales', name: 'sales', value: 4, color: '#abc', payload: { fill: '#f00' } }]}
      />,
      { sales: { label: 'Sales', color: '#abc' } }
    );

    const swatch = container.querySelector('[style*="--color-bg"]') as HTMLElement | null;
    expect(swatch).toBeTruthy();
    expect(swatch!.getAttribute('style')).toContain('#123456');
  });

  it('omits the value span when a payload entry has no value', () => {
    renderInChart(
      <ChartTooltipContent
        active
        hideLabel
        payload={[{ dataKey: 'sales', name: 'sales', color: '#abc', payload: {} }]}
      />,
      { sales: { label: 'Sales', color: '#abc' } }
    );

    // Label still renders in the row, but there is no numeric value span.
    expect(screen.getByText('Sales')).toBeInTheDocument();
    expect(screen.queryByText('NaN')).toBeNull();
  });

  it('derives the label key from item.name when there is no dataKey', () => {
    renderInChart(
      <ChartTooltipContent active payload={[{ name: 'onlyname', value: 42, color: '#abc', payload: {} }]} />,
      { onlyname: { label: 'Only Name' } }
    );

    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('derives the row key from item.dataKey when there is no name', () => {
    renderInChart(
      <ChartTooltipContent active hideLabel payload={[{ dataKey: 'dk', value: 7, color: '#abc', payload: {} }]} />,
      { dk: { label: 'DeeKay' } }
    );

    expect(screen.getByText('DeeKay')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('falls back to the literal "value" key when the entry has neither dataKey nor name', () => {
    renderInChart(<ChartTooltipContent active hideLabel payload={[{ value: 3, color: '#abc', payload: {} }]} />, {});

    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('uses the raw string label when config has no matching entry', () => {
    renderInChart(
      <ChartTooltipContent
        active
        label="missingKey"
        payload={[{ dataKey: 'd', name: 'd', value: 1, color: '#abc', payload: {} }]}
      />,
      { d: { label: 'D' } }
    );

    expect(screen.getByText('missingKey')).toBeInTheDocument();
  });

  it('filters out payload entries whose type is "none"', () => {
    renderInChart(
      <ChartTooltipContent
        active
        hideLabel
        payload={[
          { dataKey: 'a', name: 'a', value: 1, color: '#111', payload: {}, type: 'none' },
          { dataKey: 'b', name: 'b', value: 2, color: '#222', payload: {} }
        ]}
      />,
      { a: { label: 'AAA' }, b: { label: 'BBB' } }
    );

    expect(screen.queryByText('AAA')).toBeNull();
    expect(screen.getByText('BBB')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });
});

describe('ChartLegendContent', () => {
  it('renders nothing without a payload', () => {
    const { container } = renderInChart(<ChartLegendContent payload={undefined} />, {});
    // The legend wrapper carries `gap-4`, which the chart wrapper does not.
    expect(container.querySelector('.gap-4')).toBeNull();
  });

  it('renders swatches and labels for a bottom-aligned legend', () => {
    const { container } = renderInChart(
      <ChartLegendContent
        payload={[
          { value: 'a', dataKey: 'a', color: '#ff0000' },
          { value: 'b', dataKey: 'b', color: '#00ff00' }
        ]}
      />,
      { a: { label: 'Alpha' }, b: { label: 'Beta' } }
    );

    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    // Default verticalAlign 'bottom' → `pt-3`.
    expect(container.querySelector('.pt-3')).toBeTruthy();
    expect(container.querySelector('.pb-3')).toBeNull();
  });

  it('renders config icons and honours verticalAlign="top"', () => {
    const Icon = () => <svg data-testid="legend-icon" />;
    const { container } = renderInChart(
      <ChartLegendContent verticalAlign="top" payload={[{ value: 'a', dataKey: 'a', color: '#f00' }]} />,
      { a: { label: 'Alpha', icon: Icon } }
    );

    expect(screen.getByTestId('legend-icon')).toBeInTheDocument();
    expect(container.querySelector('.pb-3')).toBeTruthy();
  });

  it('renders a color swatch (not the icon) when hideIcon is set and filters "none" entries', () => {
    const Icon = () => <svg data-testid="legend-icon-hidden" />;
    renderInChart(
      <ChartLegendContent
        hideIcon
        payload={[
          { value: 'a', dataKey: 'a', color: '#f00' },
          { value: 'skip', dataKey: 'skip', color: '#00f', type: 'none' },
          { value: 'b', dataKey: 'b', color: '#0f0' }
        ]}
      />,
      { a: { label: 'Alpha', icon: Icon }, b: { label: 'Beta' } }
    );

    expect(screen.queryByTestId('legend-icon-hidden')).toBeNull();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.queryByText('skip')).toBeNull();
  });

  it('resolves config through a nameKey that points at a string field on the item', () => {
    renderInChart(
      <ChartLegendContent nameKey="category" payload={[{ value: 'x', category: 'running', color: '#f00' }]} />,
      { running: { label: 'Running' } }
    );

    expect(screen.getByText('Running')).toBeInTheDocument();
  });

  it('resolves config through the nested payload object', () => {
    renderInChart(
      <ChartLegendContent
        nameKey="category"
        payload={[{ value: 'y', color: '#0f0', payload: { category: 'walking' } }]}
      />,
      { walking: { label: 'Walking' } }
    );

    expect(screen.getByText('Walking')).toBeInTheDocument();
  });

  it('falls back to config[key] when the resolved label key is not itself in config', () => {
    renderInChart(
      <ChartLegendContent nameKey="category" payload={[{ value: 'z', category: 'unknown', color: '#00f' }]} />,
      { category: { label: 'Category' } }
    );

    expect(screen.getByText('Category')).toBeInTheDocument();
  });

  it('handles a primitive payload entry without crashing (non-object config lookup)', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = renderInChart(<ChartLegendContent payload={['just-a-string']} />, {
      value: { label: 'V' }
    });

    // No config resolves for a primitive item, so only the swatch renders.
    expect(container.querySelector('.gap-4')).toBeTruthy();
    spy.mockRestore();
  });

  it('ignores an item.payload that is a non-object or null when resolving config', () => {
    renderInChart(
      <ChartLegendContent
        nameKey="k"
        payload={[
          { value: 'p', k: 'p', color: '#f00', payload: 'str' },
          { value: 'q', k: 'q', color: '#0f0', payload: null }
        ]}
      />,
      { p: { label: 'Pcfg' }, q: { label: 'Qcfg' } }
    );

    expect(screen.getByText('Pcfg')).toBeInTheDocument();
    expect(screen.getByText('Qcfg')).toBeInTheDocument();
  });
});
