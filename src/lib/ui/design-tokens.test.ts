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
  'negative-ink',
  'positive-tint',
  'pending-tint',
  'negative-tint'
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
    ['negative-ink', 'page'],
    // StatusBadge: the ink on its own opaque tint, so the badge reads the same on `page` and `fill`.
    ['positive-ink', 'positive-tint'],
    ['pending-ink', 'pending-tint'],
    ['negative-ink', 'negative-tint'],
    // Signed amounts in Activity rows and detail cards, which sit on `fill`.
    ['positive-ink', 'fill'],
    ['negative-ink', 'fill'],
    // StatusBadge's neutral tone (cancelled, reclaimed, checking).
    ['ink', 'fill-pressed']
  ])('%s on %s reads at 4.5:1 or better', (text, surface) => {
    expect(contrast(vRequired(text), vRequired(surface))).toBeGreaterThanOrEqual(4.5);
  });

  // The measured ratios, pinned so a token edit that erodes the margin shows up in review.
  it.each([
    ['positive-ink', 'positive-tint', { ':root': 4.61, '.dark': 5.64 }],
    ['pending-ink', 'pending-tint', { ':root': 4.83, '.dark': 5.11 }],
    ['negative-ink', 'negative-tint', { ':root': 4.62, '.dark': 5.5 }],
    ['ink', 'fill-pressed', { ':root': 8.4, '.dark': 13.11 }]
  ] as const)('status badge %s on %s measures as documented', (text, surface, ratios) => {
    expect(contrast(vRequired(text), vRequired(surface))).toBeCloseTo(ratios[selector], 2);
  });

  it('keeps white CTA labels at 3:1 on the brand orange (19px bold is large text)', () => {
    const accentPrimary = vars['accent-primary'];
    if (!accentPrimary) throw new Error('accent-primary not defined');
    expect(contrast('#FFFFFF', accentPrimary)).toBeGreaterThanOrEqual(3);
  });

  it('keeps white CTA labels at 3:1 on the hovered brand orange', () => {
    const accentPrimaryHover = vars['accent-primary-hover'];
    if (!accentPrimaryHover) throw new Error('accent-primary-hover not defined');
    expect(contrast('#FFFFFF', accentPrimaryHover)).toBeGreaterThanOrEqual(3);
  });
});

it('maps every token to a Tailwind color', () => {
  for (const name of TOKENS) expect(config).toMatch(new RegExp(`'?${name}'?: 'var\\(--ds-${name}\\)'`));
});

describe.each([':root', '.dark'] as const)('legacy muted text in %s', selector => {
  it('matches the design system muted color', () => {
    const vars = themeVars(selector);
    expect(vars['color-text-muted']).toBe('var(--ds-muted)');
  });
});

describe('retired legacy surfaces', () => {
  it.each(['surface-input', 'surface-interactive', 'surface-nav-button', 'button-secondary', 'button-secondary-hover'])(
    'no longer maps %s to a Tailwind color (use fill / fill-pressed)',
    name => {
      expect(config).not.toMatch(new RegExp(`'${name}':`));
    }
  );

  it('no longer defines the gray-25 / gray-50 surfaces', () => {
    expect(config).not.toMatch(/^\s*(25|50): 'var\(--color-surface-(secondary|tertiary)\)'/m);
  });

  it.each([':root', '.dark'] as const)('declares none of the retired surface vars in %s', selector => {
    const vars = themeVars(selector);
    for (const name of [
      'color-surface-secondary',
      'color-surface-tertiary',
      'surface-input',
      'surface-interactive',
      'surface-nav-button',
      'surface-button-secondary',
      'surface-button-secondary-hover'
    ]) {
      expect(vars[name]).toBeUndefined();
    }
  });
});

describe('legacy ink', () => {
  it('no longer maps heading-gray to a Tailwind color (use ink)', () => {
    expect(config).not.toMatch(/'heading-gray':/);
  });

  it.each([':root', '.dark'] as const)(
    'drops the heading-gray var and aliases the legacy black to ink in %s',
    selector => {
      const vars = themeVars(selector);
      expect(vars['color-text-secondary']).toBeUndefined();
      expect(vars['color-text-primary']).toBe('var(--ds-ink)');
    }
  );

  it('still routes the legacy black through that aliased var', () => {
    expect(config).toMatch(/\bblack: 'var\(--color-text-primary\)'/);
  });
});
