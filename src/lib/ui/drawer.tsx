import * as React from 'react';
import { createContext, useCallback, useContext } from 'react';

import { useTranslation } from 'react-i18next';
import { Drawer as VaulDrawer } from 'vaul';

import { Icon, IconName } from 'app/icons/v2';
import { useOverlayScreenKey } from 'lib/e2e/useOverlayScreenKey';
import { useHideNavbarWhileOpen } from 'lib/mobile/useHideNavbarWhileOpen';
import { isExtension } from 'lib/platform';

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
  /**
   * Names this drawer's overlay screen-key segment (`drawer:<screenKey>`).
   * Omit to fall back to the generic `drawer` id — open/close is still
   * captured, just without a per-drawer label. E2E-only; no visual effect.
   */
  screenKey?: string;
}

function Drawer({ open = false, onOpenChange, children, screenKey }: DrawerProps) {
  const onClose = useCallback(() => onOpenChange?.(false), [onOpenChange]);
  // Keep the bottom tab navbar hidden while any drawer is open.
  useHideNavbarWhileOpen(open);
  useOverlayScreenKey(open, screenKey ? `drawer:${screenKey}` : 'drawer');
  return (
    <DrawerContext.Provider value={{ open, onClose }}>
      <VaulDrawer.Root open={open} onOpenChange={onOpenChange} shouldScaleBackground={isExtension()} direction="bottom">
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

/**
 * Was the press that Radix is calling "outside the drawer" actually inside the
 * confirmation/alert dialog stacked ABOVE it?
 *
 * react-modal portals into a `div.ReactModalPortal` on <body>, outside the
 * drawer's subtree, so Radix reads a click on the dialog as an outside
 * interaction and dismisses the drawer — pulling it closed underneath the very
 * question it is still asking. Radix dispatches its outside-event on the element
 * that was actually pressed, so the original event's target identifies the
 * dialog.
 */
function isPressInsideModalPortal(event: { detail: { originalEvent: Event } }): boolean {
  const target = event.detail.originalEvent.target;
  return target instanceof Element && target.closest('.ReactModalPortal') !== null;
}

function DrawerContent({
  className,
  overlayClassName,
  children,
  hideHandle = true,
  onPointerDownOutside,
  forceMount,
  ...props
}: DrawerContentProps) {
  const { open } = useContext(DrawerContext);
  // The sheet animates out over 500ms (vaul's TRANSITIONS.DURATION) and stays mounted for all of
  // it, with a `fixed inset-0` overlay. Left hit-testable, that departing layer eats the tap a
  // user makes at the control it is uncovering -- and a tap landing back on the sheet could
  // re-pick a row that is already leaving. Once dismissed it is a purely visual artifact, so it
  // stops taking pointer events. Not a `className`: callers override `overlayClassName` and
  // `className` freely, and this must not be something a caller can accidentally style away.
  const inertWhileClosing = open ? undefined : ({ pointerEvents: 'none' } as const);

  return (
    <VaulDrawer.Portal forceMount={forceMount}>
      <VaulDrawer.Overlay
        style={inertWhileClosing}
        className={cn('fixed inset-0 z-50 bg-black/30 backdrop-blur-sm dark:bg-black/50', overlayClassName)}
      />
      <VaulDrawer.Content
        data-slot="drawer-content"
        aria-describedby={undefined}
        forceMount={forceMount}
        style={inertWhileClosing}
        className={cn(
          // pb: the sheet is fixed to the viewport bottom, so body's safe-area /
          // keyboard padding (mobile.html) doesn't reach it — pad past the
          // Android nav bar / iOS home indicator AND the iOS soft keyboard
          // (--keyboard-height, see lib/mobile/keyboard-inset.ts) ourselves
          // (env() and the var are 0 on extension/Android). The transition runs
          // in sync with the native keyboard slide.
          'fixed inset-x-0 bottom-0 z-50 flex max-h-[80vh] flex-col rounded-t-[20px] bg-surface-solid text-sm outline-none',
          'pb-[max(env(safe-area-inset-bottom),var(--keyboard-height,0px))] transition-[padding-bottom] duration-[250ms] ease-out',
          className
        )}
        onPointerDownOutside={event => {
          onPointerDownOutside?.(event);
          // vaul dismisses only if this event comes back un-prevented.
          if (isPressInsideModalPortal(event)) event.preventDefault();
        }}
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
