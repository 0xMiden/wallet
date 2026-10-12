import React, { ReactNode, useId, useRef } from 'react';

import { Button, ButtonVariant } from 'components/ui/Button';
import { useCloseOnBack } from 'lib/mobile/useCloseOnBack';
import { useHideDappBubblesWhileOpen } from 'lib/mobile/useHideDappBubblesWhileOpen';
import { Drawer, DrawerContent, DrawerTitle } from 'lib/ui/drawer';
import { useImperativeModalFocus } from 'lib/ui/host-modal';

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

function AlertBack({ dismiss }: { dismiss: () => void }) {
  useCloseOnBack(true, dismiss);
  return null;
}

/**
 * A confirmation or an alert as a bottom sheet, with Radix AlertDialog semantics
 * (skills/miden-wallet-frontend/references/design-system.md, "Confirm / alert"): the sheet is an
 * `alertdialog` named by its title and described by its sentence; focus lands on Cancel (or on
 * the only action) and returns on close to whatever had it before, or to the nearest
 * `[data-focus-fallback]` around it once it is gone, unless something else has taken it by then;
 * Escape cancels (or acknowledges an alert); a drag or a press outside does nothing, because the
 * question needs an answer. The caller owns `open`.
 *
 * It joins the shared modal stack in opening order and leaves the Safari body pin to the
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
  const focus = useImperativeModalFocus();
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
      {open && <AlertBack dismiss={dismiss} />}
      <DrawerContent
        role="alertdialog"
        aria-describedby={hasDescription ? descriptionId : undefined}
        onOpenAutoFocus={event => {
          event.preventDefault();
          focus.remember();
          (cancelRef.current ?? actionRef.current)?.focus();
        }}
        onCloseAutoFocus={focus.restore}
        onEscapeKeyDown={event => {
          event.preventDefault();
          dismiss();
        }}
      >
        <div className="px-4 pt-6 pb-4">
          <DrawerTitle>{title}</DrawerTitle>
          {hasDescription && (
            <div id={descriptionId} className="mt-2 text-body text-muted">
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
