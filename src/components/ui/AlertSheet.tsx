import React, { ReactNode, useId, useRef } from 'react';

import { Button, ButtonVariant } from 'components/ui/Button';
import { useHideDappBubblesWhileOpen } from 'lib/mobile/useHideDappBubblesWhileOpen';
import { Drawer, DrawerContent, DrawerTitle } from 'lib/ui/drawer';

export interface AlertSheetProps {
  open: boolean;
  title: ReactNode;
  /** The one sentence under the title. It becomes the sheet's accessible description. */
  children?: ReactNode;
  actionLabel: ReactNode;
  /** `destructive` for an action that deletes or resets; `primary` otherwise. */
  actionVariant?: ButtonVariant.Primary | ButtonVariant.Destructive;
  onAction: () => void;
  /** Present for a confirmation: a secondary Cancel under the action. Absent for an alert. */
  onCancel?: () => void;
  cancelLabel?: ReactNode;
  actionTestId?: string;
  cancelTestId?: string;
  /** Names the sheet's overlay screen-key segment (`drawer:<screenKey>`). E2E-only. */
  screenKey?: string;
}

/**
 * A confirmation or an alert as a bottom sheet, with Radix AlertDialog semantics
 * (skills/miden-wallet-frontend/references/design-system.md, "Confirm / alert"): the sheet is an
 * `alertdialog` named by its title and described by its sentence; focus lands on Cancel (or on
 * the only action) and returns on close to whatever had it before, unless something else has
 * taken it by then; Escape cancels (or acknowledges an alert); a drag or a press outside does
 * nothing, because the question needs an answer. The caller owns `open`.
 *
 * It opens above every other layer (drawers 50 < native navbar 60 < dApp confirm 70 < this), since
 * a confirmation is usually asked from inside a drawer, and it leaves the Safari body pin to the
 * sheet beneath it (`noBodyStyles`; see `Drawer` for what that does not cover).
 */
export function AlertSheet({
  open,
  title,
  children,
  actionLabel,
  actionVariant = ButtonVariant.Primary,
  onAction,
  onCancel,
  cancelLabel,
  actionTestId,
  cancelTestId,
  screenKey
}: AlertSheetProps) {
  const descriptionId = useId();
  const actionRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Radix Dialog returns focus on close to its `Dialog.Trigger`, and these sheets are opened
  // imperatively (`useConfirm`) with no trigger, so focus would drop to <body>. Remember what had
  // focus when the sheet opened and give it back instead.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const hasDescription = children !== undefined && children !== null && children !== '';

  useHideDappBubblesWhileOpen(open);

  const dismiss = onCancel ?? onAction;

  return (
    <Drawer
      open={open}
      // A drag or a press outside never closes the sheet. Were vaul ever to close it anyway, the
      // question resolves as cancelled rather than leaving its promise pending.
      dismissible={false}
      onOpenChange={next => {
        if (!next) dismiss();
      }}
      noBodyStyles
      screenKey={screenKey}
    >
      <DrawerContent
        role="alertdialog"
        aria-describedby={hasDescription ? descriptionId : undefined}
        className="z-80"
        overlayClassName="z-80"
        onOpenAutoFocus={event => {
          event.preventDefault();
          returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          (cancelRef.current ?? actionRef.current)?.focus();
        }}
        onCloseAutoFocus={event => {
          event.preventDefault();
          // This runs after the slide-out. Give focus back only if nothing has taken it since (a new
          // layer, an autofocusing input on a page navigated to), and without scrolling the page.
          // A detached element ignores focus(), so a trigger gone by now is simply skipped.
          const active = document.activeElement;
          if (active === null || active === document.body) returnFocusRef.current?.focus({ preventScroll: true });
          returnFocusRef.current = null;
        }}
        onEscapeKeyDown={event => {
          event.preventDefault();
          dismiss();
        }}
      >
        <div className="px-4 pt-6 pb-4">
          <DrawerTitle>{title}</DrawerTitle>
          {hasDescription && (
            <div id={descriptionId} className="mt-2 text-base leading-6 text-muted">
              {children}
            </div>
          )}
          <div className="mt-6 flex flex-col items-center gap-2.5">
            <Button ref={actionRef} variant={actionVariant} onClick={onAction} data-testid={actionTestId}>
              {actionLabel}
            </Button>
            {onCancel && (
              <Button ref={cancelRef} variant={ButtonVariant.Secondary} onClick={onCancel} data-testid={cancelTestId}>
                {cancelLabel}
              </Button>
            )}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
