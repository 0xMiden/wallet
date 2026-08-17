import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { getCurrentScreen, setRoutePart, __resetScreenKeyForTest } from 'lib/e2e/screen-key';

import Dialogs from './Dialogs';

const ORIGINAL_E2E = process.env.MIDEN_E2E_TEST;

// `lib/ui/dialog` owns the modal params store and the close dispatchers.
// Mock it so each test can steer `useModalsParams()` (open/closed for each
// modal) and assert on the dispatch* calls without pulling in constate,
// CustomEvent classes, or the `#root` lookup the real module does at import.
jest.mock('lib/ui/dialog', () => ({
  useModalsParams: jest.fn(),
  dispatchAlertClose: jest.fn(),
  dispatchConfirmClose: jest.fn()
}));

// `useMobileBackHandler` is a jest.fn so we can capture the handler/deps the
// component registers and invoke the handler directly to exercise every
// branch of the back-button logic.
jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: jest.fn()
}));

// Stub the two child modals to lightweight probes that surface the props the
// component wires up (isOpen passthrough + the onRequestClose / onConfirm
// callbacks) so we can click them and verify the right dispatcher fires.
jest.mock('app/templates/ConfirmationModal', () => ({
  __esModule: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: (props: any) => (
    <div data-testid="confirm-modal" data-open={String(props.isOpen)}>
      <button data-testid="confirm-close" onClick={props.onRequestClose}>
        confirm-close
      </button>
      <button data-testid="confirm-ok" onClick={props.onConfirm}>
        confirm-ok
      </button>
    </div>
  )
}));

jest.mock('app/templates/AlertModal', () => ({
  __esModule: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: (props: any) => (
    <div data-testid="alert-modal" data-open={String(props.isOpen)}>
      <button data-testid="alert-close" onClick={props.onRequestClose}>
        alert-close
      </button>
    </div>
  )
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const dialog = require('lib/ui/dialog') as {
  useModalsParams: jest.Mock;
  dispatchAlertClose: jest.Mock;
  dispatchConfirmClose: jest.Mock;
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { useMobileBackHandler } = require('lib/mobile/useMobileBackHandler') as {
  useMobileBackHandler: jest.Mock;
};

type ModalsParams = {
  alertParams: { isOpen: boolean };
  confirmParams: { isOpen: boolean };
};

function setParams(params: ModalsParams): void {
  dialog.useModalsParams.mockReturnValue(params);
}

/** Returns the back-handler callback most recently registered by the component. */
function getBackHandler(): () => boolean | void {
  const calls = useMobileBackHandler.mock.calls;
  return calls[calls.length - 1][0];
}

/** Returns the deps array passed alongside the back handler. */
function getBackDeps(): unknown[] {
  const calls = useMobileBackHandler.mock.calls;
  return calls[calls.length - 1][1];
}

beforeEach(() => {
  jest.clearAllMocks();
  setParams({ alertParams: { isOpen: false }, confirmParams: { isOpen: false } });
});

describe('Dialogs', () => {
  it('renders both modals and forwards the isOpen params from the store', () => {
    setParams({ alertParams: { isOpen: true }, confirmParams: { isOpen: false } });

    render(<Dialogs />);

    expect(screen.getByTestId('confirm-modal')).toHaveAttribute('data-open', 'false');
    expect(screen.getByTestId('alert-modal')).toHaveAttribute('data-open', 'true');
  });

  it('closes the confirmation modal (onRequestClose) via dispatchConfirmClose(false)', () => {
    render(<Dialogs />);

    fireEvent.click(screen.getByTestId('confirm-close'));

    expect(dialog.dispatchConfirmClose).toHaveBeenCalledTimes(1);
    expect(dialog.dispatchConfirmClose).toHaveBeenCalledWith(false);
    expect(dialog.dispatchAlertClose).not.toHaveBeenCalled();
  });

  it('confirms (onConfirm) via dispatchConfirmClose(true)', () => {
    render(<Dialogs />);

    fireEvent.click(screen.getByTestId('confirm-ok'));

    expect(dialog.dispatchConfirmClose).toHaveBeenCalledTimes(1);
    expect(dialog.dispatchConfirmClose).toHaveBeenCalledWith(true);
  });

  it('closes the alert modal (onRequestClose) via dispatchAlertClose', () => {
    render(<Dialogs />);

    fireEvent.click(screen.getByTestId('alert-close'));

    expect(dialog.dispatchAlertClose).toHaveBeenCalledTimes(1);
    expect(dialog.dispatchConfirmClose).not.toHaveBeenCalled();
  });

  it('registers the back handler with the modal-open flags as deps', () => {
    setParams({ alertParams: { isOpen: true }, confirmParams: { isOpen: false } });

    render(<Dialogs />);

    expect(useMobileBackHandler).toHaveBeenCalledTimes(1);
    // deps: [confirmParams.isOpen, alertParams.isOpen]
    expect(getBackDeps()).toEqual([false, true]);
  });

  describe('mobile back handler', () => {
    it('closes the confirmation modal and consumes the back press when confirm is open', () => {
      setParams({ alertParams: { isOpen: false }, confirmParams: { isOpen: true } });
      render(<Dialogs />);

      const handled = getBackHandler()();

      expect(handled).toBe(true);
      expect(dialog.dispatchConfirmClose).toHaveBeenCalledTimes(1);
      expect(dialog.dispatchConfirmClose).toHaveBeenCalledWith(false);
      expect(dialog.dispatchAlertClose).not.toHaveBeenCalled();
    });

    it('prioritizes the confirmation modal when both modals are open', () => {
      setParams({ alertParams: { isOpen: true }, confirmParams: { isOpen: true } });
      render(<Dialogs />);

      const handled = getBackHandler()();

      expect(handled).toBe(true);
      expect(dialog.dispatchConfirmClose).toHaveBeenCalledWith(false);
      expect(dialog.dispatchAlertClose).not.toHaveBeenCalled();
    });

    it('closes the alert modal and consumes the back press when only the alert is open', () => {
      setParams({ alertParams: { isOpen: true }, confirmParams: { isOpen: false } });
      render(<Dialogs />);

      const handled = getBackHandler()();

      expect(handled).toBe(true);
      expect(dialog.dispatchAlertClose).toHaveBeenCalledTimes(1);
      expect(dialog.dispatchConfirmClose).not.toHaveBeenCalled();
    });

    it('passes the back press through (returns false) when no modal is open', () => {
      setParams({ alertParams: { isOpen: false }, confirmParams: { isOpen: false } });
      render(<Dialogs />);

      const handled = getBackHandler()();

      expect(handled).toBe(false);
      expect(dialog.dispatchConfirmClose).not.toHaveBeenCalled();
      expect(dialog.dispatchAlertClose).not.toHaveBeenCalled();
    });
  });

  describe('screen-key overlay wiring', () => {
    beforeEach(() => {
      process.env.MIDEN_E2E_TEST = 'true';
      __resetScreenKeyForTest();
      setRoutePart('/x');
    });

    afterEach(() => {
      if (ORIGINAL_E2E === undefined) delete process.env.MIDEN_E2E_TEST;
      else process.env.MIDEN_E2E_TEST = ORIGINAL_E2E;
    });

    it('publishes dialog:alert while the alert modal is open', () => {
      setParams({ alertParams: { isOpen: true }, confirmParams: { isOpen: false } });

      render(<Dialogs />);

      expect(getCurrentScreen().key).toBe('/x > dialog:alert');
    });

    it('publishes dialog:confirm while the confirmation modal is open', () => {
      setParams({ alertParams: { isOpen: false }, confirmParams: { isOpen: true } });

      render(<Dialogs />);

      expect(getCurrentScreen().key).toBe('/x > dialog:confirm');
    });

    it('publishes nothing extra when neither modal is open', () => {
      setParams({ alertParams: { isOpen: false }, confirmParams: { isOpen: false } });

      render(<Dialogs />);

      expect(getCurrentScreen().key).toBe('/x');
    });

    it('pops dialog:alert when the alert modal closes', () => {
      setParams({ alertParams: { isOpen: true }, confirmParams: { isOpen: false } });
      const { rerender } = render(<Dialogs />);
      expect(getCurrentScreen().key).toBe('/x > dialog:alert');

      setParams({ alertParams: { isOpen: false }, confirmParams: { isOpen: false } });
      rerender(<Dialogs />);

      expect(getCurrentScreen().key).toBe('/x');
    });
  });
});
