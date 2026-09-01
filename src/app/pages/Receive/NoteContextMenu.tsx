import React, { FC, useCallback, useEffect, useRef, useState } from 'react';

import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useListNavigation,
  useRole
} from '@floating-ui/react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { springs, useMotion } from 'lib/animation';
import { hapticLight } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';

export interface NoteContextMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The note card the menu anchors to. */
  anchorEl: HTMLElement | null;
  /** False while the note is being claimed or is terminally unavailable — hides "Claim note". */
  canClaim: boolean;
  onClaim: () => void;
  onHide: () => void;
  /** Performs the copy; the menu shows the "Copied" confirmation itself. */
  onCopySender: () => void;
  onMarkSpam: () => void;
}

interface MenuItem {
  id: 'claim' | 'hide' | 'copy' | 'spam';
  icon: IconName;
  label: string;
  destructive?: boolean;
}

const COPIED_FEEDBACK_MS = 1200;

/**
 * Press-and-hold menu for a pending-note card: claim, hide this note, copy the
 * sender, mark as spam. Controlled; the row owns the open state and anchor.
 * Floating UI does the anchoring, dismissal (outside press / Escape) and
 * roving-tabindex arrow navigation; Framer Motion does the enter/exit.
 */
export const NoteContextMenu: FC<NoteContextMenuProps> = ({
  open,
  onOpenChange,
  anchorEl,
  canClaim,
  onClaim,
  onHide,
  onCopySender,
  onMarkSpam
}) => {
  const { t } = useTranslation();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const listRef = useRef<(HTMLElement | null)[]>([]);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transition = useMotion(springs.snappy);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange,
    placement: 'bottom-start',
    // Position with top/left rather than a transform, which Framer's scale would overwrite.
    transform: false,
    elements: { reference: anchorEl },
    middleware: [offset(6), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate
  });

  const { getFloatingProps, getItemProps } = useInteractions([
    useDismiss(context),
    useRole(context, { role: 'menu' }),
    useListNavigation(context, { listRef, activeIndex, onNavigate: setActiveIndex, loop: true })
  ]);

  useEffect(() => {
    if (!open) {
      setCopied(false);
      setActiveIndex(null);
    }
  }, [open]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
    },
    []
  );

  const items: MenuItem[] = [
    ...(canClaim ? [{ id: 'claim', icon: IconName.Checkmark, label: t('noteMenuClaim') } satisfies MenuItem] : []),
    { id: 'hide', icon: IconName.EyeOff, label: t('noteMenuHide') },
    { id: 'copy', icon: IconName.Copy, label: copied ? t('copied') : t('noteMenuCopySender') },
    { id: 'spam', icon: IconName.Bin, label: t('noteMenuMarkSpam'), destructive: true }
  ];

  const select = useCallback(
    (id: MenuItem['id']) => {
      hapticLight();
      switch (id) {
        case 'claim':
          onOpenChange(false);
          onClaim();
          return;
        case 'hide':
          onOpenChange(false);
          onHide();
          return;
        case 'copy':
          onCopySender();
          setCopied(true);
          if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
          copiedTimerRef.current = setTimeout(() => onOpenChange(false), COPIED_FEEDBACK_MS);
          return;
        case 'spam':
          onOpenChange(false);
          onMarkSpam();
          return;
      }
    },
    [onClaim, onCopySender, onHide, onMarkSpam, onOpenChange]
  );

  return (
    <FloatingPortal>
      <AnimatePresence>
        {open && (
          <FloatingFocusManager context={context} modal={false} initialFocus={0} returnFocus>
            <motion.div
              ref={refs.setFloating}
              style={{ ...floatingStyles, transformOrigin: 'top left' }}
              {...getFloatingProps()}
              data-testid="note-context-menu"
              className="z-40 min-w-56 overflow-hidden rounded-2xl border border-border-card bg-surface-solid shadow-lg"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={transition}
            >
              <ul className="flex flex-col divide-y divide-border-light py-1" role="none">
                {items.map((item, index) => (
                  <li key={item.id} role="none">
                    <button
                      type="button"
                      role="menuitem"
                      data-testid={`note-menu-${item.id}`}
                      tabIndex={activeIndex === index ? 0 : -1}
                      ref={node => {
                        listRef.current[index] = node;
                      }}
                      {...getItemProps({ onClick: () => select(item.id) })}
                      className={cn(
                        'flex w-full items-center gap-3 px-4 py-3 text-left font-heading text-sm font-medium',
                        'hover:bg-surface-interactive focus:outline-none focus-visible:bg-surface-interactive',
                        item.destructive ? 'text-status-negative' : 'text-heading-gray'
                      )}
                    >
                      <Icon name={item.icon} size="xs" fill="currentColor" className="shrink-0" />
                      <span>{item.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </motion.div>
          </FloatingFocusManager>
        )}
      </AnimatePresence>
    </FloatingPortal>
  );
};
