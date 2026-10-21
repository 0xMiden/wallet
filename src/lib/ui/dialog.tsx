import { ReactNode, useCallback, useMemo, useState } from 'react';

import constate from 'constate';

import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';
import { UserErrorId } from 'lib/telemetry/user-visible-error-contract';

interface DialogOptions {
  title?: ReactNode;
  children?: ReactNode;
  variant?: 'default' | 'explanation';
}

/** What `useAlert()` shows: a title and one sentence, acknowledged with OK. */
export interface AlertOptions extends DialogOptions {
  errorId: UserErrorId | null;
}

/** What `useConfirm()` asks: a title and one sentence, answered with the action or Cancel. */
export interface ConfirmOptions extends DialogOptions {
  /** The action's label. Defaults to "OK". */
  confirmLabel?: ReactNode;
  /** The action deletes or resets something: it gets the destructive button. */
  destructive?: boolean;
}

type AlertParams = DialogOptions &
  ({ isOpen: false; errorId?: UserErrorId | null } | { isOpen: true; errorId: UserErrorId | null });
type ConfirmParams = ConfirmOptions & { isOpen: boolean };

export type AlertFn = (params: AlertOptions) => Promise<void>;
export type ConfirmFn = (params: ConfirmOptions) => Promise<boolean>;

type DummyEventListener = (e: Event) => void;

const ALERT_CLOSE_EVENT_NAME = 'alertclosed';
const CONFIRM_CLOSE_EVENT_NAME = 'confirmclosed';

class AlertClosedEvent extends CustomEvent<void> {}
class ConfirmClosedEvent extends CustomEvent<boolean> {}

export const [DialogsProvider, useAlert, useConfirm, useModalsParams] = constate(
  useDialogs,
  v => v.alert,
  v => v.confirm,
  v => v.modalsParams
);

function useDialogs() {
  const [alertParams, setAlertParams] = useState<AlertParams>({
    isOpen: false
  });
  const [confirmParams, setConfirmParams] = useState<ConfirmParams>({
    isOpen: false
  });

  const alert = useCallback(async (params: AlertOptions) => {
    setAlertParams({ ...params, isOpen: true });
    if (params.errorId) reportUserVisibleError(params.errorId, 'dialog');
    await waitForEvent<AlertClosedEvent>(ALERT_CLOSE_EVENT_NAME);
    setAlertParams({ ...params, isOpen: false });
  }, []);

  const confirm = useCallback(async (params: ConfirmOptions) => {
    setConfirmParams({ ...params, isOpen: true });
    const result = await waitForEvent<ConfirmClosedEvent>(CONFIRM_CLOSE_EVENT_NAME);
    setConfirmParams({ ...params, isOpen: false });
    return result;
  }, []);

  const modalsParams = useMemo(
    () => ({
      alertParams,
      confirmParams
    }),
    [alertParams, confirmParams]
  );

  return {
    alert,
    confirm,
    modalsParams
  };
}

const rootElement = document.getElementById('root');
function waitForEvent<E extends CustomEvent>(eventName: E['type']) {
  return new Promise<E['detail']>(resolve => {
    const listener = (event: CustomEvent) => {
      rootElement?.removeEventListener(eventName, listener as DummyEventListener);
      resolve(event.detail);
    };
    rootElement?.addEventListener(eventName, listener as DummyEventListener);
  });
}

export function dispatchAlertClose() {
  rootElement?.dispatchEvent(new AlertClosedEvent(ALERT_CLOSE_EVENT_NAME));
}

export function dispatchConfirmClose(value: boolean) {
  rootElement?.dispatchEvent(new ConfirmClosedEvent(CONFIRM_CLOSE_EVENT_NAME, { detail: value }));
}
