import React from 'react';

import { cva } from 'class-variance-authority';

import { cn } from 'lib/ui/util';

/**
 * What the notice says about its content:
 * - `neutral` — a quiet aside, `fill` with a `muted` body.
 * - `warning` — something to act on with care (test funds, a pending state).
 * - `negative` — an error or a destructive consequence.
 * - `positive` — a confirmation.
 */
export type NoticeTone = 'neutral' | 'warning' | 'negative' | 'positive';

export interface NoticeProps {
  /** The body copy: one or two short lines. */
  children: React.ReactNode;
  /** Optional bold first line, in the tone's ink. */
  title?: React.ReactNode;
  /** Leading glyph, drawn 16px in the tone's ink. Decorative: the text carries the meaning. */
  icon?: React.ReactNode;
  tone?: NoticeTone;
  /** `note` (default) for standing copy; `alert` only for something that just went wrong. */
  role?: 'note' | 'status' | 'alert';
  /** Layout only (margins, width). */
  className?: string;
  'data-testid'?: string;
}

// Literal class strings, so Tailwind generates them. The status tints are the Pill's 10%: every ink
// below clears 4.5:1 on its tint over `page` in both themes (light 4.65–4.85, dark 6.4–6.7), and the
// body is `ink` (9:1 and up). Like a status Pill, a tinted notice sits on `page`, never on `fill`.
const noticeVariants = cva('flex w-full items-start gap-2.5 rounded-2xl px-3.5 py-3 text-left', {
  variants: {
    tone: {
      neutral: 'bg-fill',
      warning: 'bg-status-pending/10',
      negative: 'bg-status-negative/10',
      positive: 'bg-status-positive/10'
    } satisfies Record<NoticeTone, string>
  },
  defaultVariants: { tone: 'neutral' }
});

// The glyph and the title share the tone's ink.
const noticeInkVariants = cva('', {
  variants: {
    tone: {
      neutral: 'text-ink',
      warning: 'text-pending-ink',
      negative: 'text-negative-ink',
      positive: 'text-positive-ink'
    } satisfies Record<NoticeTone, string>
  },
  defaultVariants: { tone: 'neutral' }
});

const noticeBodyVariants = cva('text-caption', {
  variants: {
    tone: {
      // `muted` on `fill` is 4.7:1.
      neutral: 'text-muted',
      warning: 'text-ink',
      negative: 'text-ink',
      positive: 'text-ink'
    } satisfies Record<NoticeTone, string>
  },
  defaultVariants: { tone: 'neutral' }
});

/**
 * An inline notice: a compact tinted block with a leading glyph, an optional bold title and one or
 * two lines of 13px body copy. No border: the tint is the surface, as with every card. Use it for
 * standing copy on a page (a test-funds warning, a fee note); a transient confirmation is a toast
 * and a decision is an `AlertSheet`.
 */
export const Notice: React.FC<NoticeProps> = ({
  children,
  title,
  icon,
  tone = 'neutral',
  role = 'note',
  className,
  'data-testid': dataTestId
}) => (
  <div role={role} data-tone={tone} data-testid={dataTestId} className={cn(noticeVariants({ tone }), className)}>
    {icon && (
      <span
        aria-hidden="true"
        data-slot="icon"
        // 17px line box, 16px glyph: a 0.5px nudge centres it on the first line.
        className={cn(
          'mt-px flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full',
          noticeInkVariants({ tone })
        )}
      >
        {icon}
      </span>
    )}
    <div className="flex min-w-0 flex-col gap-0.5">
      {title && (
        <span data-slot="title" className={cn('text-label', noticeInkVariants({ tone }))}>
          {title}
        </span>
      )}
      <span data-slot="body" className={noticeBodyVariants({ tone })}>
        {children}
      </span>
    </div>
  </div>
);
