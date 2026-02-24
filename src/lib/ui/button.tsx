import * as React from 'react';

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from './util';

const buttonVariants = cva(
  'focus-visible:border-primary-500 focus-visible:ring-primary-500/50 rounded-lg border border-transparent bg-clip-padding text-sm font-medium focus-visible:ring-3 [&_svg:not([class*=size-])]:size-4 inline-flex items-center justify-center whitespace-nowrap transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none shrink-0 [&_svg]:shrink-0 outline-none group/button select-none',
  {
    variants: {
      variant: {
        default: 'bg-primary-500 text-white [a]:hover:bg-primary-500/80',
        outline:
          'border-grey-200 bg-white hover:bg-grey-50 hover:text-heading-gray aria-expanded:bg-grey-50 aria-expanded:text-heading-gray',
        secondary:
          'bg-grey-100 text-heading-gray hover:bg-grey-200/80 aria-expanded:bg-grey-100 aria-expanded:text-heading-gray',
        ghost: 'hover:bg-grey-50 hover:text-heading-gray aria-expanded:bg-grey-50 aria-expanded:text-heading-gray',
        destructive:
          'bg-red-500/10 hover:bg-red-500/20 focus-visible:ring-red-500/20 text-red-500 focus-visible:border-red-500/40',
        link: 'text-primary-500 underline-offset-4 hover:underline'
      },
      size: {
        default: 'h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3',
        icon: 'size-8',
        'icon-xs':
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg',
        'icon-lg': 'size-9'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
);

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : 'button';

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
