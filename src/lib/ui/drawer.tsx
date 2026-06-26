import * as React from 'react';
import { createContext, useCallback, useContext, useEffect } from 'react';

import { AnimatePresence, motion, type PanInfo } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { durations, easings, springs } from 'lib/animation';

import Portal from './Portal';
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
  return <DrawerContext.Provider value={{ open, onClose }}>{children}</DrawerContext.Provider>;
}

interface DrawerContentProps {
  className?: string;
  children: React.ReactNode;
  /** The handle is hidden by default — the standard drawer design closes via an
   *  explicit close button (see `DrawerTopBar`). Pass `hideHandle={false}` to
   *  restore the draggable handle + drag-to-dismiss for a legacy drawer. */
  hideHandle?: boolean;
}

function DrawerContent({ className, children, hideHandle = true }: DrawerContentProps) {
  const { open, onClose } = useContext(DrawerContext);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const handleDragEnd = useCallback(
    (_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
      if (info.offset.y > 80 || info.velocity.y > 300) {
        onClose();
      }
    },
    [onClose]
  );

  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <>
            <motion.div
              key="drawer-backdrop"
              className="fixed inset-0 z-50 bg-black/30 dark:bg-black/50 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: durations.normal, ease: easings.easeInOut }}
              onClick={onClose}
            />
            <motion.div
              key="drawer-sheet"
              data-slot="drawer-content"
              className={cn(
                'fixed inset-x-0 bottom-0 z-50 flex max-h-[80vh] flex-col rounded-t-[20px] bg-surface-solid text-sm',
                className
              )}
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={springs.sheetPresent}
            >
              {!hideHandle && (
                <motion.div
                  className="flex cursor-grab items-center justify-center pt-6 pb-2 active:cursor-grabbing"
                  drag="y"
                  dragConstraints={{ top: 0, bottom: 0 }}
                  dragElastic={0.2}
                  onDragEnd={handleDragEnd}
                >
                  <div className="bg-primary-500 h-0.5 w-10 shrink-0 rounded-full" />
                </motion.div>
              )}
              {children}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </Portal>
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
    <h2
      data-slot="drawer-title"
      className={cn('text-[28px] font-semibold leading-none text-heading-gray', className)}
      {...props}
    >
      {children}
    </h2>
  );
}

function DrawerDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p data-slot="drawer-description" className={cn('text-sm text-text-muted', className)} {...props} />;
}

// Stub exports for API compatibility (unused by consumers)
function DrawerTrigger({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}
function DrawerClose({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}
function DrawerPortal({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}
function DrawerOverlay({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

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
