import * as React from 'react';
import { createContext, useCallback, useContext, useEffect } from 'react';

import { AnimatePresence, motion, type PanInfo } from 'framer-motion';

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
}

function DrawerContent({ className, children }: DrawerContentProps) {
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
              className="fixed inset-0 z-50 bg-[#E3E3E399] dark:bg-[#00000099]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3, ease: 'easeInOut' }}
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
              transition={{ duration: 0.3, ease: 'easeOut' }}
            >
              <motion.div
                className="flex cursor-grab items-center justify-center pt-6 pb-2 active:cursor-grabbing"
                drag="y"
                dragConstraints={{ top: 0, bottom: 0 }}
                dragElastic={0.2}
                onDragEnd={handleDragEnd}
              >
                <div className="bg-primary-500 h-0.5 w-10 shrink-0 rounded-full" />
              </motion.div>
              {children}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </Portal>
  );
}

function DrawerHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="drawer-header"
      className={cn('flex flex-col gap-0.5 px-4 pb-6 text-center', className)}
      {...props}
    />
  );
}

function DrawerFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="drawer-footer" className={cn('mt-auto flex flex-col gap-2 p-4', className)} {...props} />;
}

function DrawerTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 data-slot="drawer-title" className={cn('text-base font-medium text-black', className)} {...props} />;
}

function DrawerDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p data-slot="drawer-description" className={cn('text-sm text-grey-500', className)} {...props} />;
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
