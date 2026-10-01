import fs from 'fs';
import path from 'path';

import { TYPE_STYLES } from './type-styles';

const css = fs.readFileSync(path.join(__dirname, '../../main.css'), 'utf8');

/** The declarations of one `@utility` block in main.css, by property. */
function utility(name: string): Record<string, string> {
  const match = css.match(new RegExp(`@utility ${name} \\{([^}]*)\\}`));
  if (!match?.[1]) throw new Error(`no @utility ${name} in main.css`);
  const declarations: Record<string, string> = {};
  for (const m of match[1].matchAll(/([\w-]+):\s*([^;]+);/g)) {
    if (m[1] && m[2]) declarations[m[1]] = m[2].trim();
  }
  return declarations;
}

const HEADING = 'var(--font-heading)';
const SANS = 'var(--font-sans)';

/** The spec's type scale (design-system.md, Foundations, Type): family, size, line-height, weight. */
const EXPECTED: Record<(typeof TYPE_STYLES)[number], [string, string, string, string]> = {
  display: [HEADING, '48px', '52px', '800'],
  'entry-unit': [HEADING, '22px', '28px', '700'],
  'title-tab': [HEADING, '28px', '36px', '800'],
  'hero-value': [HEADING, '32px', '36px', '900'],
  'hero-name': [HEADING, '24px', '28px', '900'],
  'title-page': [HEADING, '20px', '26px', '800'],
  'title-section': [HEADING, '18px', '24px', '800'],
  cta: [HEADING, '19px', '24px', '800'],
  'cta-sm': [HEADING, '15px', '20px', '800'],
  'row-title': [HEADING, '16px', '20px', '700'],
  value: [HEADING, '15px', '20px', '700'],
  action: [HEADING, '14px', '20px', '700'],
  pill: [HEADING, '14px', '1', '700'],
  badge: [HEADING, '12px', '1', '700'],
  body: [SANS, '16px', '24px', '400'],
  'body-strong': [SANS, '16px', '24px', '600'],
  explainer: [SANS, '15px', '22px', '400'],
  'body-sm': [SANS, '14px', '20px', '400'],
  label: [SANS, '13px', '17px', '700'],
  caption: [SANS, '13px', '17px', '400'],
  'caption-heading': [HEADING, '13px', '17px', '600']
};

describe('type scale utilities', () => {
  it.each(TYPE_STYLES)('text-%s sets family, size, line-height and weight together', name => {
    const [family, size, lineHeight, weight] = EXPECTED[name];
    const declarations = utility(`text-${name}`);
    expect(declarations['font-family']).toBe(family);
    expect(declarations['font-size']).toBe(size);
    // Through Tailwind's own variables, so a `leading-*` or `font-*` modifier wins in any order.
    expect(declarations['line-height']).toBe(`var(--tw-leading, ${lineHeight})`);
    expect(declarations['font-weight']).toBe(`var(--tw-font-weight, ${weight})`);
  });

  it('never sets a colour: colour is a separate class', () => {
    for (const name of TYPE_STYLES) expect(utility(`text-${name}`)).not.toHaveProperty('color');
  });

  it('tracks the tab title tighter, as the spec asks', () => {
    expect(utility('text-title-tab')['letter-spacing']).toBe('var(--tw-tracking, -0.5px)');
  });

  it('declares no role utility that the registry does not list', () => {
    const declared = [...css.matchAll(/@utility text-([\w-]+) \{/g)].map(m => m[1]);
    expect(declared.sort()).toEqual([...TYPE_STYLES].sort());
  });
});
