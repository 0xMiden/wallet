import fs from 'fs';
import path from 'path';

import { CARD_COLORS } from 'lib/settings/constants';

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

function hue(hex: string): number {
  const match = hex.replace('#', '').match(/../g);
  if (!match || match.length < 3) throw new Error(`not a hex color: ${hex}`);
  const [r = 0, g = 0, b = 0] = match.map(c => parseInt(c, 16) / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
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
  'negative-tint',
  'positive-tint-ink',
  'pending-tint-ink',
  'negative-tint-ink'
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
    ['positive-tint-ink', 'positive-tint'],
    ['pending-tint-ink', 'pending-tint'],
    ['negative-tint-ink', 'negative-tint'],
    // Signed amounts in Activity rows and detail cards, on `fill` cards and on the page.
    ['positive-tint-ink', 'fill'],
    ['negative-tint-ink', 'fill'],
    ['positive-tint-ink', 'page'],
    ['negative-tint-ink', 'page'],
    // StatusBadge's neutral tone (cancelled, reclaimed, checking).
    ['ink', 'fill-pressed']
  ])('%s on %s reads at 4.5:1 or better', (text, surface) => {
    expect(contrast(vRequired(text), vRequired(surface))).toBeGreaterThanOrEqual(4.5);
  });

  // The measured ratios, pinned so a token edit that erodes the margin shows up in review.
  it.each([
    ['positive-tint-ink', 'positive-tint', { ':root': 5.41, '.dark': 7.36 }],
    ['pending-tint-ink', 'pending-tint', { ':root': 5.33, '.dark': 6.91 }],
    ['negative-tint-ink', 'negative-tint', { ':root': 5.17, '.dark': 6.55 }],
    ['ink', 'fill-pressed', { ':root': 8.4, '.dark': 13.11 }]
  ] as const)('status badge %s on %s measures as documented', (text, surface, ratios) => {
    expect(contrast(vRequired(text), vRequired(surface))).toBeCloseTo(ratios[selector], 2);
  });

  // Pending used to share its orange-red with negative. The two tones must now sit apart in hue
  // (a sand and a clay), so the color agrees with the word instead of blurring into it.
  it('keeps the pending and negative badge inks at least 20 degrees apart in hue', () => {
    const diff = Math.abs(hue(vRequired('pending-tint-ink')) - hue(vRequired('negative-tint-ink')));
    expect(Math.min(diff, 360 - diff)).toBeGreaterThanOrEqual(20);
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

/** `#rrggbb` or `rgba(r, g, b, a)` as [r, g, b, alpha]. */
function rgba(value: string): [number, number, number, number] {
  const fn = value.match(/rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)/);
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3]), Number(fn[4])];
  const hex = value.replace('#', '').match(/../g);
  if (!hex || hex.length < 3) throw new Error(`not a color: ${value}`);
  return [parseInt(hex[0]!, 16), parseInt(hex[1]!, 16), parseInt(hex[2]!, 16), 1];
}

/** `top` painted over the opaque `bottom`, as the browser composites it (sRGB). */
function over(top: string, bottom: string): string {
  const [r, g, b, a] = rgba(top);
  const [br, bg, bb] = rgba(bottom);
  return `#${[r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)]
    .map(c => Math.round(c).toString(16).padStart(2, '0'))
    .join('')}`;
}

// The five card colors are BRAND colors: they never shift for contrast. Readability on them comes
// from the type instead, and this pins both halves of that rule.
describe('card colors are the brand colors', () => {
  const BRAND: Record<string, string> = {
    slate: '#777386',
    orange: '#e77537',
    blue: '#607c92',
    green: '#778c72',
    purple: '#847595'
  };
  const vars = themeVars(':root');

  it.each(Object.entries(BRAND))('light %s is exactly %s', (color, hex) => {
    expect(vars[`card-${color}`]?.toLowerCase()).toBe(hex);
  });
});

// The Home balance card draws its text in `surface-balance-fg` on the account's card color. Light
// mode paints the card solid; dark mode paints it at 50% over the page (`dark:bg-card-*\/50` on
// `app-bg`). What each text needs depends on its size (WCAG 1.4.3):
// - the amount (40-56px extrabold) and the currency (22px bold) are large text: 3:1 on the bare
//   color. White on the brand orange is 3.0:1, which is why they may never shrink below 18.66px bold.
// - the label and the footer (13px bold) sit on the bare color too, by choice: the card keeps its
//   plain brand color, so in light mode they fall under 4.5:1 on every color but slate. Not pinned.
// - the change pill (14px) is small text: 4.5:1 on `surface-balance-pill` over the color.
describe.each([':root', '.dark'] as const)('balance card ink on every card color in %s', selector => {
  const vars = themeVars(selector);
  const need = (name: string): string => {
    const value = vars[name];
    if (!value) throw new Error(`--${name} not defined in ${selector}`);
    return value;
  };
  // What the text actually sits on: the solid color in light mode, half of it over the page in dark.
  const card = (color: string): string => {
    const [r, g, b] = rgba(need(`card-${color}`));
    return selector === ':root' ? need(`card-${color}`) : over(`rgba(${r}, ${g}, ${b}, 0.5)`, need('color-app-bg'));
  };

  it.each(CARD_COLORS)('%s carries the large amount and currency at 3:1 on the bare color', color => {
    expect(contrast(need('surface-balance-fg'), card(color))).toBeGreaterThanOrEqual(3);
  });

  it.each(CARD_COLORS)('%s carries the change pill at 4.5:1', color => {
    expect(
      contrast(need('surface-balance-fg'), over(need('surface-balance-pill'), card(color)))
    ).toBeGreaterThanOrEqual(4.5);
  });
});

/** A custom property's value in a theme, `var(--x)` chains followed: `.dark` sits on the same root
 * element as `:root`, so it overrides `:root` and an alias declared once resolves per theme. */
function resolved(selector: ':root' | '.dark', name: string): string {
  const vars = selector === ':root' ? themeVars(':root') : { ...themeVars(':root'), ...themeVars('.dark') };
  let value = vars[name];
  for (let hops = 0; value?.startsWith('var(--') && hops < 5; hops++) value = vars[value.slice(6, -1)];
  if (!value) throw new Error(`--${name} does not resolve in ${selector}`);
  return value;
}

// Home's five actions each take one account card colour; the tab's icon and its flow's accent are
// that one colour (references/design-system.md, "Action colours").
const ACTION_CARD = [
  ['overview', 'orange'],
  ['send', 'blue'],
  ['receive', 'green'],
  ['earn', 'slate'],
  ['swap', 'purple']
] as const;
const FLOWS = ['send', 'receive', 'earn', 'swap'] as const;

describe('action colours', () => {
  const root = themeVars(':root');

  it.each(ACTION_CARD)('%s is the %s card colour', (action, card) => {
    expect(root[`action-${action}`]).toBe(`var(--card-${card})`);
  });

  it.each(FLOWS)('the %s flow accent and its tint alias the action tokens', flow => {
    expect(root[`accent-${flow}`]).toBe(`var(--action-${flow})`);
    expect(root[`accent-${flow}-tint`]).toBe(`var(--action-${flow}-tint)`);
  });

  it('leaves the dark theme no flow accent of its own to drift', () => {
    const dark = themeVars('.dark');
    for (const flow of FLOWS) {
      expect(dark[`accent-${flow}`]).toBeUndefined();
      expect(dark[`accent-${flow}-tint`]).toBeUndefined();
    }
  });

  it.each(ACTION_CARD)('maps action-%s and its tint to Tailwind colors', action => {
    expect(config).toContain(`'action-${action}': 'var(--action-${action})'`);
    expect(config).toContain(`'action-${action}-tint': 'var(--action-${action}-tint)'`);
  });
});

// Where an action colour draws text or a glyph (back arrows, chevrons, Max, links, route labels,
// the processing spinner), it sits on `page`, on `fill` or on its own tint. Text needs 4.5:1, which
// also covers the 3:1 a glyph needs.
describe.each([':root', '.dark'] as const)('action colour contrast in %s', selector => {
  const value = (name: string) => resolved(selector, name);

  it.each(ACTION_CARD)('%s tint is the colour at 12%% over the page', action => {
    const [r, g, b] = rgba(value(`action-${action}`));
    expect(value(`action-${action}-tint`)).toBe(over(`rgba(${r}, ${g}, ${b}, 0.12)`, value('ds-page')));
  });

  it.each(ACTION_CARD)('%s reads as text at 4.5:1 on page, fill and its own tint', action => {
    for (const surface of ['ds-page', 'ds-fill', `action-${action}-tint`]) {
      expect(contrast(value(`action-${action}`), value(surface))).toBeGreaterThanOrEqual(4.5);
    }
  });
});
