import React from 'react';

import { cn } from 'lib/ui/util';

export interface HeroProps {
  /** The 88px avatar or 64px status circle. Sized and rendered by the caller; Hero only centers it. */
  visual: React.ReactNode;
  /** The hero value (e.g. an amount): 32px Nunito 900. Mutually exclusive with `name`. */
  value?: React.ReactNode;
  /** The hero name (e.g. an outcome or a contact's name): 24px Nunito 900. Mutually exclusive with `value`. */
  name?: React.ReactNode;
  /** A 14px muted line under the value or name. */
  subtitle?: React.ReactNode;
  className?: string;
  'data-testid'?: string;
  /** Ref for the `name` heading, e.g. to move focus there on mount so an outcome is announced. */
  nameRef?: React.Ref<HTMLHeadingElement>;
  /** Extra attributes for the `name` heading, e.g. `tabIndex={-1}` alongside `nameRef`. */
  nameProps?: Omit<React.HTMLAttributes<HTMLHeadingElement>, 'className' | 'children'>;
}

/**
 * Centered hero: an avatar or status circle, then the hero value or name, then a muted line.
 * Used on the send review and transaction receipt (`value` = the amount) and the contact page
 * (visual only — the name is already in the page header there).
 */
export const Hero: React.FC<HeroProps> = ({
  visual,
  value,
  name,
  subtitle,
  className,
  'data-testid': dataTestId,
  nameRef,
  nameProps
}) => (
  <div data-testid={dataTestId} className={cn('flex w-full flex-col items-center', className)}>
    {visual}
    {value !== undefined && (
      <div className="mt-4 text-center font-heading text-[32px] leading-9 font-black text-ink">{value}</div>
    )}
    {name !== undefined && (
      <h2
        ref={nameRef}
        className="mt-4 w-full text-center font-heading text-2xl leading-7 font-black text-ink outline-none"
        {...nameProps}
      >
        {name}
      </h2>
    )}
    {subtitle && <p className="mt-1 text-center text-sm text-muted">{subtitle}</p>}
  </div>
);
