import * as React from 'react';
import { createContext, useCallback, useContext } from 'react';

import { useTranslation } from 'react-i18next';
import { Drawer as VaulDrawer } from 'vaul';

import { Icon, IconName } from 'app/icons/v2';
import { useHideNavbarWhileOpen } from 'lib/mobile/useHideNavbarWhileOpen';

import { cn } from './util';

interface DrawerContextValue {
  open: boolean;
  onClose: () => void;
}

const DrawerContext = createContext<DrawerContextValue>({ open: false, onClose: () => {} });

interface DrawerProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}

function Drawer({ open = false, onOpenChange, children }: DrawerProps) {
  const onClose = useCallback(() => onOpenChange?.(false), [onOpenChange]);
  // Keep the bottom tab navbar hidden while any drawer is open.
  useHideNavbarWhileOpen(open);
  return (
    <DrawerContext.Provider value={{ open, onClose }}>
      <VaulDrawer.Root open={open} onOpenChange={onOpenChange} direction="bottom">
        {children}
      </VaulDrawer.Root>
    </DrawerContext.Provider>
  );
}

interface DrawerContentProps extends Omit<
  React.ComponentPropsWithoutRef<typeof VaulDrawer.Content>,
  'children' | 'className'
> {
  className?: string;
  overlayClassName?: string;
  children: React.ReactNode;
  /** The visual handle is hidden by default. Vaul still handles sheet drag
   *  gestures; pass `hideHandle={false}` to show the handle affordance. */
  hideHandle?: boolean;
}

function DrawerContent({ className, overlayClassName, children, hideHandle = true, ...props }: DrawerContentProps) {
  return (
    <VaulDrawer.Portal>
      <VaulDrawer.Overlay
        className={cn('fixed inset-0 z-50 bg-black/30 backdrop-blur-sm dark:bg-black/50', overlayClassName)}
      />
      <VaulDrawer.Content
        data-slot="drawer-content"
        aria-describedby={undefined}
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 flex max-h-[80vh] flex-col rounded-t-[20px] bg-surface-solid text-sm outline-none',
          className
        )}
        {...props}
      >
        {!hideHandle && (
          <div className="flex cursor-grab items-center justify-center pt-6 pb-2 active:cursor-grabbing">
            <VaulDrawer.Handle className="h-0.5 w-10 shrink-0 rounded-full bg-primary-500 opacity-100" />
          </div>
        )}
        {children}
      </VaulDrawer.Content>
    </VaulDrawer.Portal>
  );
}

/**
 * Drawer header / top bar: a large left-aligned title (via `DrawerTitle`, 28px
 * semibold) with a circular close button on the right, a bottom divider, and a
 * 16px gap to the content below (`mb-4`). The handle-less default closes through
 * this button — it reads `onClose` from the drawer context, so no extra wiring.
 * Children render in a column on the left (title + optional `DrawerDescription`).
 */
function DrawerHeader({ className, children }: { className?: string; children?: React.ReactNode }) {
  const { t } = useTranslation();
  const { onClose } = useContext(DrawerContext);
  return (
    <div data-slot="drawer-header" className={cn('border-b border-border-faint mb-4', className)}>
      <div className="flex w-full items-center justify-between gap-3 p-4">
        <div className="flex min-w-0 flex-col gap-0.5">{children}</div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('close')}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-100"
        >
          <Icon name={IconName.Close} size="xs" fill="currentColor" className="text-heading-gray" />
        </button>
      </div>
    </div>
  );
}

function DrawerFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="drawer-footer" className={cn('mt-auto flex flex-col gap-2 p-4', className)} {...props} />;
}

function DrawerTitle({ className, children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <VaulDrawer.Title
      data-slot="drawer-title"
      className={cn('text-3xl font-bold font-heading leading-none text-heading-gray', className)}
      {...props}
    >
      {children}
    </VaulDrawer.Title>
  );
}

function DrawerDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <VaulDrawer.Description
      data-slot="drawer-description"
      className={cn('text-sm text-text-muted', className)}
      {...props}
    />
  );
}

const DrawerTrigger = VaulDrawer.Trigger;
const DrawerClose = VaulDrawer.Close;
const DrawerPortal = VaulDrawer.Portal;
const DrawerOverlay = VaulDrawer.Overlay;

export {
  Drawer,
  DrawerPortal,
  DrawerOverlay,
  DrawerTrigger,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription
};
