/**
 * The type scale's role utilities, declared with `@utility` in `src/main.css`. Each sets family,
 * size, line-height and weight together; colour stays a separate class. Listed here so
 * tailwind-merge (`cn`) knows them: by default it reads any unknown `text-*` class as a colour, so
 * `cn('text-title-page', 'text-ink')` would drop the type style.
 */
export const TYPE_STYLES = [
  'display',
  'entry',
  'entry-unit',
  'title-tab',
  'hero-value',
  'hero-name',
  'title-page',
  'title-section',
  'cta',
  'cta-sm',
  'row-title',
  'value',
  'action',
  'pill',
  'badge',
  'body',
  'body-strong',
  'body-sm',
  'label',
  'caption'
] as const;

export type TypeStyle = `text-${(typeof TYPE_STYLES)[number]}`;
