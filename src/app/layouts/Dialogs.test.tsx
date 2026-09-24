import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { getCurrentScreen, setRoutePart, __resetScreenKeyForTest } from 'lib/e2e/screen-key';

import Dialogs from './Dialogs';

const ORIGINAL_E2E = process.env.MIDEN_E2E_TEST;

// `lib/ui/dialog` owns the dialog params store and the close dispatchers.
// Mock it so each test can steer `useModalsParams()` (open/closed for each
// dialog) and assert on the dispatch* calls without pulling in constate,
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

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
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
  alertParams: { isOpen: boolean; title?: string; children?: string };
  confirmParams: { isOpen: boolean; title?: string; children?: string; confirmLabel?: string; destructive?: boolean };
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
  it('renders no sheet while neither dialog is open', () => {
    render(<Dialogs />);

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  describe('confirm', () => {
    const open = { isOpen: true, title: 'Delete contact', children: 'Are you sure?' };

    it('asks as a sheet: title, sentence, OK over Cancel, on the e2e test ids', () => {
      setParams({ alertParams: { isOpen: false }, confirmParams: open });
      render(<Dialogs />);

      const sheet = screen.getByRole('alertdialog', { name: 'Delete contact' });
      expect(sheet).toHaveAccessibleDescription('Are you sure?');
      const confirm = screen.getByTestId('confirmation-modal-confirm');
      expect(confirm).toHaveTextContent('ok');
      expect(confirm).toHaveClass('bg-accent-primary');
      expect(screen.getByTestId('confirmation-modal-cancel')).toHaveTextContent('cancel');
    });

    it('uses the caller label and the destructive button when asked', () => {
      setParams({
        alertParams: { isOpen: false },
        confirmParams: { ...open, confirmLabel: 'Delete', destructive: true }
      });
      render(<Dialogs />);

      const confirm = screen.getByTestId('confirmation-modal-confirm');
      expect(confirm).toHaveTextContent('Delete');
      expect(confirm).toHaveClass('text-negative-ink');
    });

    it('resolves true from the action', () => {
      setParams({ alertParams: { isOpen: false }, confirmParams: open });
      render(<Dialogs />);

      fireEvent.click(screen.getByTestId('confirmation-modal-confirm'));

      expect(dialog.dispatchConfirmClose).toHaveBeenCalledTimes(1);
      expect(dialog.dispatchConfirmClose).toHaveBeenCalledWith(true);
      expect(dialog.dispatchAlertClose).not.toHaveBeenCalled();
    });

    it('resolves false from Cancel', () => {
      setParams({ alertParams: { isOpen: false }, confirmParams: open });
      render(<Dialogs />);

      fireEvent.click(screen.getByTestId('confirmation-modal-cancel'));

      expect(dialog.dispatchConfirmClose).toHaveBeenCalledTimes(1);
      expect(dialog.dispatchConfirmClose).toHaveBeenCalledWith(false);
    });

    it('resolves false on Escape', () => {
      setParams({ alertParams: { isOpen: false }, confirmParams: open });
      render(<Dialogs />);

      fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });

      expect(dialog.dispatchConfirmClose).toHaveBeenCalledWith(false);
    });
  });

  describe('alert', () => {
    const open = { isOpen: true, title: 'Error', children: 'boom' };

    it('shows a sheet with one OK and no Cancel', () => {
      setParams({ alertParams: open, confirmParams: { isOpen: false } });
      render(<Dialogs />);

      expect(screen.getByRole('alertdialog', { name: 'Error' })).toHaveAccessibleDescription('boom');
      expect(screen.getAllByRole('button')).toHaveLength(1);
      expect(screen.queryByTestId('confirmation-modal-cancel')).not.toBeInTheDocument();
    });

    it('closes from OK via dispatchAlertClose', () => {
      setParams({ alertParams: open, confirmParams: { isOpen: false } });
      render(<Dialogs />);

      fireEvent.click(screen.getByRole('button', { name: 'ok' }));

      expect(dialog.dispatchAlertClose).toHaveBeenCalledTimes(1);
      expect(dialog.dispatchConfirmClose).not.toHaveBeenCalled();
    });

    it('closes on Escape via dispatchAlertClose', () => {
      setParams({ alertParams: open, confirmParams: { isOpen: false } });
      render(<Dialogs />);

      fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });

      expect(dialog.dispatchAlertClose).toHaveBeenCalledTimes(1);
    });
  });

  it('registers the back handler with the dialog-open flags as deps', () => {
    setParams({ alertParams: { isOpen: true }, confirmParams: { isOpen: false } });

    render(<Dialogs />);

    expect(useMobileBackHandler).toHaveBeenCalledTimes(1);
    // deps: [confirmParams.isOpen, alertParams.isOpen]
    expect(getBackDeps()).toEqual([false, true]);
    // Alert and confirm dialogs float above any page, so they register in the overlay tier.
    expect(useMobileBackHandler.mock.calls[0][2]).toEqual({ overlay: true });
  });

  describe('mobile back handler', () => {
    it('closes the confirmation and consumes the back press when confirm is open', () => {
      setParams({ alertParams: { isOpen: false }, confirmParams: { isOpen: true } });
      render(<Dialogs />);

      const handled = getBackHandler()();

      expect(handled).toBe(true);
      expect(dialog.dispatchConfirmClose).toHaveBeenCalledTimes(1);
      expect(dialog.dispatchConfirmClose).toHaveBeenCalledWith(false);
      expect(dialog.dispatchAlertClose).not.toHaveBeenCalled();
    });

    it('prioritizes the confirmation when both dialogs are open', () => {
      setParams({ alertParams: { isOpen: true }, confirmParams: { isOpen: true } });
      render(<Dialogs />);

      const handled = getBackHandler()();

      expect(handled).toBe(true);
      expect(dialog.dispatchConfirmClose).toHaveBeenCalledWith(false);
      expect(dialog.dispatchAlertClose).not.toHaveBeenCalled();
    });

    it('closes the alert and consumes the back press when only the alert is open', () => {
      setParams({ alertParams: { isOpen: true }, confirmParams: { isOpen: false } });
      render(<Dialogs />);

      const handled = getBackHandler()();

      expect(handled).toBe(true);
      expect(dialog.dispatchAlertClose).toHaveBeenCalledTimes(1);
      expect(dialog.dispatchConfirmClose).not.toHaveBeenCalled();
    });

    it('passes the back press through (returns false) when no dialog is open', () => {
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

    it('publishes drawer:alert while the alert sheet is open', () => {
      setParams({ alertParams: { isOpen: true }, confirmParams: { isOpen: false } });

      render(<Dialogs />);

      expect(getCurrentScreen().key).toBe('/x > drawer:alert');
    });

    it('publishes drawer:confirm while the confirmation sheet is open', () => {
      setParams({ alertParams: { isOpen: false }, confirmParams: { isOpen: true } });

      render(<Dialogs />);

      expect(getCurrentScreen().key).toBe('/x > drawer:confirm');
    });

    it('publishes nothing extra when neither dialog is open', () => {
      setParams({ alertParams: { isOpen: false }, confirmParams: { isOpen: false } });

      render(<Dialogs />);

      expect(getCurrentScreen().key).toBe('/x');
    });

    it('pops drawer:alert when the alert sheet closes', () => {
      setParams({ alertParams: { isOpen: true }, confirmParams: { isOpen: false } });
      const { rerender } = render(<Dialogs />);
      expect(getCurrentScreen().key).toBe('/x > drawer:alert');

      setParams({ alertParams: { isOpen: false }, confirmParams: { isOpen: false } });
      rerender(<Dialogs />);

      expect(getCurrentScreen().key).toBe('/x');
    });
  });
});
