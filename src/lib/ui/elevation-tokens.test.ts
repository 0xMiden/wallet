/**
 * The design system's raised elevation (design-system.md, "Elevation"): the tab bars' active bubble
 * and the network ribbon read their shadows from named tokens, never literals, and the raised
 * tokens are defined for both themes.
 */
import fs from 'fs';
import path from 'path';

import tailwindConfig from '../../../tailwind.config';

const css = fs.readFileSync(path.resolve(__dirname, '../../main.css'), 'utf8');

function declarations(name: string): string[] {
  return Array.from(css.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))).map(match => match[1]!.trim());
}

describe('raised elevation tokens', () => {
  const extend = tailwindConfig.theme?.extend;
  const boxShadow = (extend?.boxShadow ?? {}) as Record<string, string>;
  const colors = (tailwindConfig.theme?.colors ?? {}) as Record<string, unknown>;

  it('names shadow-raised, shadow-raised-pressed and shadow-ribbon in the Tailwind theme', () => {
    expect(boxShadow.raised).toBe('var(--ds-shadow-raised)');
    expect(boxShadow['raised-pressed']).toBe('var(--ds-shadow-raised-pressed)');
    expect(boxShadow.ribbon).toMatch(/rgba\(0, 0, 0/);
    expect(colors.raised).toBe('var(--ds-raised)');
  });

  it.each(['--ds-raised', '--ds-shadow-raised', '--ds-shadow-raised-pressed'])(
    'defines %s for light and dark',
    name => {
      const values = declarations(name);
      expect(values).toHaveLength(2);
      expect(values[0]).not.toBe(values[1]);
    }
  );

  it('raises a white bubble on light with a ring and a soft drop, and sinks it when pressed', () => {
    const [light] = declarations('--ds-shadow-raised');
    const [lightPressed] = declarations('--ds-shadow-raised-pressed');
    expect(declarations('--ds-raised')[0]).toBe('#ffffff');
    expect(light).toContain('0 0 0 1px');
    expect(light).toContain('0 2px 8px');
    expect(lightPressed).not.toContain('0 2px 8px');
  });

  it('raises the bubble on dark with the fill and a lit top edge, not a drop shadow alone', () => {
    const [, dark] = declarations('--ds-shadow-raised');
    expect(declarations('--ds-raised')[1]).toBe('#262422');
    expect(dark).toContain('inset 0 1px 0 rgba(255, 255, 255');
  });
});
