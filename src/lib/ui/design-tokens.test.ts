import fs from 'fs';
import path from 'path';

const css = fs.readFileSync(path.join(__dirname, '../../main.css'), 'utf8');
const config = fs.readFileSync(path.join(__dirname, '../../../tailwind.config.ts'), 'utf8');

/** The custom properties declared in one top-level block of `@layer base`. */
function themeVars(selector: ':root' | '.dark'): Record<string, string> {
  const layer = css.slice(css.indexOf('@layer base {'));
  const start = layer.indexOf(`  ${selector} {`);
  const end = layer.indexOf('\n  }', start);
  const vars: Record<string, string> = {};
  for (const m of layer.slice(start, end).matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    if (m[1] && m[2]) vars[m[1]] = m[2].trim();
  }
  return vars;
}

function luminance(hex: string): number {
  const match = hex.replace('#', '').match(/../g);
  if (!match || match.length < 3) throw new Error(`not a hex color: ${hex}`);
  const channels = match
    .map(c => parseInt(c, 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(a: string, b: string): number {
  const sorted = [luminance(a), luminance(b)].sort((x, y) => y - x);
  const [hi, lo] = [sorted[0]!, sorted[1]!];
  return (hi + 0.05) / (lo + 0.05);
}

const TOKENS = [
  'page',
  'fill',
  'fill-pressed',
  'hairline',
  'ink',
  'muted',
  'accent-tint',
  'accent-tint-ink',
  'positive-ink',
  'pending-ink',
  'negative-ink'
];

describe.each([':root', '.dark'] as const)('design tokens in %s', selector => {
  const vars = themeVars(selector);
  const v = (name: string) => vars[`ds-${name}`];
  const vRequired = (name: string): string => {
    const value = v(name);
    if (!value) throw new Error(`token ds-${name} not defined`);
    return value;
  };

  it('declares every token', () => {
    for (const name of TOKENS) expect(v(name)).toBeDefined();
  });

  it.each([
    ['ink', 'page'],
    ['ink', 'fill'],
    ['muted', 'page'],
    ['muted', 'fill'],
    ['accent-tint-ink', 'accent-tint'],
    ['positive-ink', 'page'],
    ['pending-ink', 'page'],
    ['negative-ink', 'page']
  ])('%s on %s reads at 4.5:1 or better', (text, surface) => {
    expect(contrast(vRequired(text), vRequired(surface))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps white CTA labels at 3:1 on the brand orange (19px bold is large text)', () => {
    const accentPrimary = vars['accent-primary'];
    if (!accentPrimary) throw new Error('accent-primary not defined');
    expect(contrast('#FFFFFF', accentPrimary)).toBeGreaterThanOrEqual(3);
  });
});

it('maps every token to a Tailwind color', () => {
  for (const name of TOKENS) expect(config).toMatch(new RegExp(`'?${name}'?: 'var\\(--ds-${name}\\)'`));
});
