import React from 'react';

import { cn } from 'lib/ui/util';

/**
 * The hero value (e.g. an amount, 32px Nunito 900) or name (e.g. an outcome or a contact's name,
 * 24px Nunito 900) — mutually exclusive at the type level, since a hero draws only one at a time.
 * Neither is required: the contact page's hero is visual-only (the name is already in the page
 * header there).
 */
type HeroContentProps =
  | { value: React.ReactNode; name?: never }
  | { name: React.ReactNode; value?: never }
  | { value?: never; name?: never };

export type HeroProps = HeroContentProps & {
  /** The 88px avatar or 64px status circle. Sized and rendered by the caller; Hero only centers it. */
  visual: React.ReactNode;
  /** A 14px muted line under the value or name. */
  subtitle?: React.ReactNode;
  className?: string;
  'data-testid'?: string;
  /** Ref for the `name` heading, e.g. to move focus there on mount so an outcome is announced. */
  nameRef?: React.Ref<HTMLHeadingElement>;
  /** The `name` heading's level: `h2` under a page header's title, `h1` on a screen with no header. */
  nameAs?: 'h1' | 'h2';
  /** Extra attributes for the `name` heading, e.g. `tabIndex={-1}` alongside `nameRef`. */
  nameProps?: Omit<React.HTMLAttributes<HTMLHeadingElement>, 'className' | 'children'>;
};

/**
 * Centered hero: an avatar or status circle, then the hero value or name, then a muted line.
 * `value` = the amount on send review; `name` = the outcome title on the transaction receipt; the
 * contact page passes neither, since its name is already in the page header.
 */
export const Hero: React.FC<HeroProps> = ({
  visual,
  value,
  name,
  subtitle,
  className,
  'data-testid': dataTestId,
  nameRef,
  nameProps,
  nameAs: NameTag = 'h2'
}) => (
  <div data-testid={dataTestId} className={cn('flex w-full flex-col items-center', className)}>
    {visual}
    {value !== undefined && <div className="mt-4 text-center text-hero-value text-ink">{value}</div>}
    {name !== undefined && (
      <NameTag ref={nameRef} className="mt-4 w-full text-center text-hero-name text-ink outline-none" {...nameProps}>
        {name}
      </NameTag>
    )}
    {subtitle !== undefined && <p className="mt-1 text-center text-body-sm text-muted">{subtitle}</p>}
  </div>
);
