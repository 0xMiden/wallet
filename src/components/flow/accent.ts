import type { ITransactionType } from 'lib/miden/db/types';

/**
 * Highlight color of a flow. Each home action keeps its icon color as the accent of
 * its own flow (tokens in src/main.css); `brand` is the orange for everything else.
 * A flow owns its CTA too, so every page of a flow reads as one colour.
 */
export type FlowAccent = 'brand' | 'send' | 'receive' | 'earn' | 'swap';

interface AccentClasses {
  /** The brand action colour, for glyphs (the spinner, a chevron): 3:1 is all a glyph needs. */
  text: string;
  /** Text in the flow's colour: its darker `-ink`, which reads at 4.5:1 on page, fill and tint. */
  ink: string;
  /** Solid fill, for a badge that carries the accent rather than hinting at it. */
  bg: string;
  border: string;
  tint: string;
  /**
   * What sits on the solid fill (a glyph, the toggle thumb): white, but dark on the dark theme's
   * pastel fills. 3:1 only, so never small text; a pill takes `tint` and `ink` instead.
   */
  on: string;
  /** `on` as an SVG fill. */
  onFill: string;
  /** The same colour as a stroke, for a stroked glyph (the `ListRow` chevron). */
  stroke: string;
  /** A hairline in the flow's colour, quiet enough to stay a rule: the `before:` rule of a row. */
  rule: string;
  /**
   * The filled primary CTA: its label, and rest, hover and disabled in one string, so `Button` can
   * swap the whole set rather than let tailwind-merge override them one modifier at a time (a
   * leftover `dark:disabled:` from the brand set would otherwise survive into a flow's button).
   *
   * Disabled is the colour at 40%, the same ratio the brand's pre-blended `primary-disabled`
   * is; unlike that token it stays translucent, which is what keeps one string correct in both
   * themes. Hover is the colour at 90% — it dims toward the page in light mode and toward the
   * page in dark mode, so the press target always moves, without a per-action hover token.
   */
  cta: string;
}

// Literal class strings, so Tailwind generates every one of them.
export const ACCENT_CLASSES: Record<FlowAccent, AccentClasses> = {
  brand: {
    text: 'text-primary-500',
    ink: 'text-accent-tint-ink',
    bg: 'bg-primary-500',
    on: 'text-accent-brand-on',
    onFill: 'fill-accent-brand-on',
    border: 'border-primary-500',
    tint: 'bg-primary-50',
    stroke: 'stroke-primary-500',
    rule: 'before:bg-primary-500/25',
    cta: 'text-accent-brand-on bg-accent-primary hover:bg-accent-primary-hover disabled:bg-primary-disabled dark:disabled:bg-primary-disabled-dark'
  },
  send: {
    text: 'text-accent-send',
    ink: 'text-accent-send-ink',
    bg: 'bg-accent-send',
    on: 'text-accent-send-on',
    onFill: 'fill-accent-send-on',
    border: 'border-accent-send',
    tint: 'bg-accent-send-tint',
    stroke: 'stroke-accent-send',
    rule: 'before:bg-accent-send/25',
    cta: 'text-accent-send-on bg-accent-send hover:bg-accent-send/90 disabled:bg-accent-send/40'
  },
  receive: {
    text: 'text-accent-receive',
    ink: 'text-accent-receive-ink',
    bg: 'bg-accent-receive',
    on: 'text-accent-receive-on',
    onFill: 'fill-accent-receive-on',
    border: 'border-accent-receive',
    tint: 'bg-accent-receive-tint',
    stroke: 'stroke-accent-receive',
    rule: 'before:bg-accent-receive/25',
    cta: 'text-accent-receive-on bg-accent-receive hover:bg-accent-receive/90 disabled:bg-accent-receive/40'
  },
  earn: {
    text: 'text-accent-earn',
    ink: 'text-accent-earn-ink',
    bg: 'bg-accent-earn',
    on: 'text-accent-earn-on',
    onFill: 'fill-accent-earn-on',
    border: 'border-accent-earn',
    tint: 'bg-accent-earn-tint',
    stroke: 'stroke-accent-earn',
    rule: 'before:bg-accent-earn/25',
    cta: 'text-accent-earn-on bg-accent-earn hover:bg-accent-earn/90 disabled:bg-accent-earn/40'
  },
  swap: {
    text: 'text-accent-swap',
    ink: 'text-accent-swap-ink',
    bg: 'bg-accent-swap',
    on: 'text-accent-swap-on',
    onFill: 'fill-accent-swap-on',
    border: 'border-accent-swap',
    tint: 'bg-accent-swap-tint',
    stroke: 'stroke-accent-swap',
    rule: 'before:bg-accent-swap/25',
    cta: 'text-accent-swap-on bg-accent-swap hover:bg-accent-swap/90 disabled:bg-accent-swap/40'
  }
};

/** The flow a transaction belongs to, for the screens every flow shares (Processing, the receipt). */
export function accentForTransactionType(type: ITransactionType | undefined): FlowAccent {
  switch (type) {
    case 'send':
    case 'bridged-send':
      return 'send';
    case 'consume':
    case 'bridged-receive':
      return 'receive';
    case 'earn-deposit':
    case 'earn-withdraw':
      return 'earn';
    case 'swap':
      return 'swap';
    default:
      return 'brand';
  }
}
