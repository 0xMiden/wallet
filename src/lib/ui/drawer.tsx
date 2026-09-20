import * as React from 'react';
import { createContext, useCallback, useContext } from 'react';

import { useTranslation } from 'react-i18next';
import { Drawer as VaulDrawer } from 'vaul';

import { IconName } from 'app/icons/v2';
import { IconButton } from 'components/ui/IconButton';
import { sheetMotionVars } from 'lib/animation';
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
  /**
   * `false` makes the sheet close only when the caller sets `open` to false: no drag down, press
   * outside or Escape closes it on its own. Callers that want Escape handle it on `DrawerContent`.
   */
  dismissible?: boolean;
  /**
   * Skip vaul's Safari body pin and its black body paint on open. vaul keeps the pinned body's
   * previous position in one module-level slot and restores it when ANY sheet closes, so a sheet
   * opened over another sheet passes this to leave the pin of the one beneath in place. That pin
   * is all it protects: vaul's scale cleanup (`useScaleBackground`) still resets
   * `body.style.background` 500ms after this sheet closes, with no `noBodyStyles` guard, so on the
   * extension a sheet closing over an open drawer still clears that drawer's black background.
   */
  noBodyStyles?: boolean;
}

function Drawer({ open = false, onOpenChange, children, screenKey, dismissible, noBodyStyles }: DrawerProps) {
  const onClose = useCallback(() => onOpenChange?.(false), [onOpenChange]);
  // Keep the bottom tab navbar hidden while any drawer is open.
  useHideNavbarWhileOpen(open);
  useOverlayScreenKey(open, screenKey ? `drawer:${screenKey}` : 'drawer');
  return (
    <DrawerContext.Provider value={{ open, onClose }}>
      <VaulDrawer.Root
        open={open}
        onOpenChange={onOpenChange}
        shouldScaleBackground={isExtension()}
        direction="bottom"
        dismissible={dismissible}
        noBodyStyles={noBodyStyles}
      >
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

function DrawerContent({
  className,
  overlayClassName,
  children,
  hideHandle = true,
  style,
  ...props
}: DrawerContentProps) {
  return (
    <VaulDrawer.Portal>
      {/* A plain scrim, one token in both themes: dimming the page is the whole job, and a frosted
          blur over it only smears whatever is underneath. */}
      <VaulDrawer.Overlay style={sheetMotionVars} className={cn('fixed inset-0 z-50 bg-scrim', overlayClassName)} />
      <VaulDrawer.Content
        data-slot="drawer-content"
        aria-describedby={undefined}
        // The tab-bar springs, as the `linear()` curves `main.css` reads off these elements.
        style={{ ...sheetMotionVars, ...style }}
        className={cn(
          // pb: the sheet is fixed to the viewport bottom, so body's safe-area /
          // keyboard padding (mobile.html) doesn't reach it — pad past the
          // Android nav bar / iOS home indicator AND the iOS soft keyboard
          // (--keyboard-height, see lib/mobile/keyboard-inset.ts) ourselves
          // (env() and the var are 0 on extension/Android). The transition runs
          // in sync with the native keyboard slide.
          'fixed inset-x-0 bottom-0 z-50 flex max-h-[80vh] flex-col rounded-t-[28px] bg-page text-body-sm outline-none',
          'pb-[max(env(safe-area-inset-bottom),var(--keyboard-height,0px))] transition-[padding-bottom] duration-[250ms] ease-out',
          className
        )}
        {...props}
      >
        {!hideHandle && (
          <div className="flex cursor-grab items-center justify-center pt-6 pb-2 active:cursor-grabbing">
            <VaulDrawer.Handle className="h-[5px] w-9 shrink-0 rounded-full bg-fill-pressed opacity-100" />
          </div>
        )}
        {children}
      </VaulDrawer.Content>
    </VaulDrawer.Portal>
  );
}

/**
 * The one sheet header, used by every drawer in the app: a left-aligned `DrawerTitle` (optionally
 * over a `DrawerDescription`) and the 32px circular close on the right, on the 16px sheet margin.
 * No rule under it — separation inside a sheet comes from the `fill` groups below, not from a
 * divider across the top (design-system.md, "Elevation"). The close reads `onClose` from the drawer
 * context, so the handle-less default needs no extra wiring.
 */
function DrawerHeader({ className, children }: { className?: string; children?: React.ReactNode }) {
  const { t } = useTranslation();
  const { onClose } = useContext(DrawerContext);
  return (
    <div
      data-slot="drawer-header"
      className={cn('flex w-full shrink-0 items-center justify-between gap-3 px-4 pt-5 pb-4', className)}
    >
      <div className="flex min-w-0 flex-col gap-0.5">{children}</div>
      <IconButton icon={IconName.Close} label={t('close')} appearance="circle" onClick={onClose} />
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
      className={cn('text-left text-title-section text-ink', className)}
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
      className={cn('text-body-sm text-muted', className)}
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
