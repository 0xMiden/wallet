import fs from 'fs';
import path from 'path';

/**
 * Text in the shared components takes its family, size and line-height from one role utility
 * (`text-title-page`, `text-value`, `text-body`...; see `lib/ui/type-styles.ts`), never from a
 * hand-assembled `font-heading text-[15px] leading-6`. Weight classes stay allowed on their own:
 * they are modifiers (a semibold `xs` pill) that the utilities are built to accept.
 */
const AD_HOC = [
  /\bfont-(heading|sans|inter|serif|mono)\b/,
  /\btext-\[[\d.]+(px|rem|em)\]/,
  /\btext-(xs|sm|base|lg|[2-9]?xl)\b/,
  /\bleading-\[[^\]]+\]/,
  /\btracking-\[[^\]]+\]/
];

/** Files whose text is sized to something other than a text role. */
const ALLOWED: Record<string, string> = {
  // Initials scale with the avatar (10px on 24px up to 30px on 88px), not with a text role.
  'components/ui/Avatar.tsx': 'initials'
};

const SRC = path.join(__dirname, '../..');
const FILES = [
  ...fs
    .readdirSync(__dirname, { recursive: true, encoding: 'utf8' })
    .filter(f => f.endsWith('.tsx') && !f.endsWith('.test.tsx'))
    .map(f => path.join('components/ui', f)),
  'components/PageHeader.tsx',
  'lib/ui/drawer.tsx'
];

describe('type scale guard', () => {
  it.each(FILES.filter(f => !(f in ALLOWED)))('%s uses the role utilities, not ad-hoc typography', file => {
    const source = fs.readFileSync(path.join(SRC, file), 'utf8');
    const offenders = source
      .split('\n')
      .map((line, i) => ({ line: i + 1, text: line.trim() }))
      // Comments may name the classes they replaced.
      .filter(({ text }) => !text.startsWith('//') && !text.startsWith('*') && !text.startsWith('/*'))
      .filter(({ text }) => AD_HOC.some(pattern => pattern.test(text)));
    expect(offenders).toEqual([]);
  });

  it('flags the combinations it exists to catch', () => {
    const flagged = (className: string) => AD_HOC.some(pattern => pattern.test(className));
    expect(flagged('font-heading text-[15px] font-bold')).toBe(true);
    expect(flagged('font-sans text-sm leading-6')).toBe(true);
    expect(flagged('text-[13px] leading-[17px]')).toBe(true);
    expect(flagged('text-value text-ink')).toBe(false);
    expect(flagged('text-badge font-semibold')).toBe(false);
    expect(flagged('text-accent-tint-ink text-positive-tint-ink')).toBe(false);
  });

  it('keeps the allow-list honest: every entry still exists', () => {
    for (const file of Object.keys(ALLOWED)) expect(fs.existsSync(path.join(SRC, file))).toBe(true);
  });
});
