import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { ButtonVariant } from 'components/ui/Button';
import { getCurrentScreen, setRoutePart, __resetScreenKeyForTest } from 'lib/e2e/screen-key';
import { hapticLight } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';

import { AlertSheet } from './AlertSheet';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isMobile: jest.fn(() => false),
  isExtension: jest.fn(() => false)
}));

const ORIGINAL_E2E = process.env.MIDEN_E2E_TEST;

function renderConfirm(overrides: Partial<React.ComponentProps<typeof AlertSheet>> = {}) {
  const onAction = jest.fn();
  const onCancel = jest.fn();
  const utils = render(
    <AlertSheet
      open
      title="Delete contact"
      actionLabel="Delete"
      onAction={onAction}
      onCancel={onCancel}
      cancelLabel="Cancel"
      actionTestId="confirmation-modal-confirm"
      cancelTestId="confirmation-modal-cancel"
      {...overrides}
    >
      Are you sure you want to delete this contact?
    </AlertSheet>
  );
  return { ...utils, onAction, onCancel };
}

afterEach(() => {
  jest.clearAllMocks();
  document.body.removeAttribute('data-drawer-open');
});

describe('AlertSheet', () => {
  it('renders nothing while closed', () => {
    renderConfirm({ open: false });

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('confirmation-modal-confirm')).not.toBeInTheDocument();
  });

  it('is an alertdialog named by its title and described by its sentence', () => {
    renderConfirm();

    const sheet = screen.getByRole('alertdialog', { name: 'Delete contact' });
    expect(sheet).toHaveAccessibleDescription('Are you sure you want to delete this contact?');
    expect(screen.getByRole('heading', { name: 'Delete contact' })).toHaveClass('text-[20px]', 'text-left');
    expect(screen.getByText('Are you sure you want to delete this contact?')).toHaveClass('text-base', 'text-muted');
  });

  it('is a bottom sheet with 28px top corners, stacked above drawers', () => {
    renderConfirm();

    const sheet = screen.getByRole('alertdialog');
    expect(sheet).toHaveAttribute('data-vaul-drawer-direction', 'bottom');
    expect(sheet.className).toContain('rounded-t-[28px]');
    expect(sheet).toHaveClass('z-80');
    expect(sheet).not.toHaveClass('z-50');
    const overlay = document.querySelector('[data-vaul-overlay]');
    expect(overlay).toHaveClass('z-80');
  });

  it('puts a primary action over a secondary Cancel by default', () => {
    renderConfirm();

    const action = screen.getByTestId('confirmation-modal-confirm');
    const cancel = screen.getByTestId('confirmation-modal-cancel');
    expect(action).toHaveTextContent('Delete');
    expect(action).toHaveClass('bg-accent-primary');
    expect(cancel).toHaveTextContent('Cancel');
    expect(cancel).toHaveClass('bg-fill', 'text-ink');
    // The action sits above Cancel.
    expect(action.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders the destructive variant when asked', () => {
    renderConfirm({ actionVariant: ButtonVariant.Destructive });

    const action = screen.getByTestId('confirmation-modal-confirm');
    expect(action).toHaveClass('text-negative-ink');
    expect(action).not.toHaveClass('bg-accent-primary');
  });

  it('calls onAction from the action and onCancel from Cancel, with a light haptic', () => {
    const { onAction, onCancel } = renderConfirm();

    fireEvent.click(screen.getByTestId('confirmation-modal-confirm'));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('confirmation-modal-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(hapticLight).toHaveBeenCalledTimes(2);
  });

  it('moves focus to Cancel when it opens, as an alert dialog does', () => {
    renderConfirm();

    expect(screen.getByTestId('confirmation-modal-cancel')).toHaveFocus();
  });

  describe('focus return', () => {
    function Harness({ open, showTrigger = true }: { open: boolean; showTrigger?: boolean }) {
      return (
        <>
          {showTrigger && (
            <button type="button" data-testid="trigger">
              Delete contact
            </button>
          )}
          <input data-testid="elsewhere" aria-label="elsewhere" />
          <AlertSheet open={open} title="Delete contact" actionLabel="Delete" onAction={jest.fn()} onCancel={jest.fn()}>
            Are you sure?
          </AlertSheet>
        </>
      );
    }

    // jsdom never runs vaul's slideToBottom animation, so Radix Presence keeps the closing sheet
    // mounted until told the animation ended, as a browser does after 0.5s. jsdom has no
    // AnimationEvent (fireEvent.animationEnd drops `animationName`), so the event is built by hand.
    const finishSlideOut = (sheet: HTMLElement) => {
      expect(getComputedStyle(sheet).animationName).toBe('slideToBottom');
      const animationEnd = Object.assign(new Event('animationend', { bubbles: true }), {
        animationName: 'slideToBottom'
      });
      act(() => {
        sheet.dispatchEvent(animationEnd);
      });
      expect(sheet.isConnected).toBe(false);
    };
    // Radix FocusScope runs its close-autofocus in a setTimeout(0) after the content unmounts.
    const closeAutoFocus = () => act(() => new Promise(resolve => setTimeout(resolve, 0)));

    it('returns focus to the element that had it when the sheet closes', async () => {
      const { rerender } = render(<Harness open={false} />);
      const trigger = screen.getByTestId('trigger');
      trigger.focus();

      rerender(<Harness open />);
      expect(trigger).not.toHaveFocus();

      const focusSpy = jest.spyOn(trigger, 'focus');
      const sheet = screen.getByRole('alertdialog');
      rerender(<Harness open={false} />);
      finishSlideOut(sheet);
      await closeAutoFocus();
      expect(trigger).toHaveFocus();
      // Without scrolling the page to it.
      expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    });

    it('leaves focus where it is when something else took it while the sheet slid out', async () => {
      const { rerender } = render(<Harness open={false} />);
      const trigger = screen.getByTestId('trigger');
      trigger.focus();
      rerender(<Harness open />);

      const sheet = screen.getByRole('alertdialog');
      rerender(<Harness open={false} />);
      // Say, the page navigated to under the closing sheet autofocuses its input.
      const elsewhere = screen.getByTestId('elsewhere');
      elsewhere.focus();
      finishSlideOut(sheet);
      await closeAutoFocus();

      expect(elsewhere).toHaveFocus();
      expect(trigger).not.toHaveFocus();
    });

    it('skips the return quietly when that element is gone by the time the sheet closes', async () => {
      const { rerender } = render(<Harness open={false} />);
      const trigger = screen.getByTestId('trigger');
      trigger.focus();
      rerender(<Harness open />);
      // The page under the sheet re-rendered without it (say, the row was deleted).
      rerender(<Harness open showTrigger={false} />);

      const sheet = screen.getByRole('alertdialog');
      rerender(<Harness open={false} showTrigger={false} />);
      finishSlideOut(sheet);
      await closeAutoFocus();
      expect(trigger.isConnected).toBe(false);
      expect(document.activeElement).toBe(document.body);
    });
  });

  it('cancels on Escape', () => {
    const { onAction, onCancel } = renderConfirm();

    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('does not dismiss on a press outside the sheet', async () => {
    const { onAction, onCancel } = renderConfirm();
    // Radix attaches its outside-press listener on the next tick.
    await act(() => new Promise(resolve => setTimeout(resolve, 0)));

    const overlay = document.querySelector('[data-vaul-overlay]');
    expect(overlay).not.toBeNull();
    fireEvent.pointerDown(overlay!);
    fireEvent.pointerDown(document.body);

    expect(onCancel).not.toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  describe('as an alert (no onCancel)', () => {
    function renderAlert() {
      const onAction = jest.fn();
      render(
        <AlertSheet open title="Error" actionLabel="OK" onAction={onAction}>
          boom
        </AlertSheet>
      );
      return { onAction };
    }

    it('renders the one action and no Cancel', () => {
      renderAlert();

      expect(screen.getByRole('button', { name: 'OK' })).toHaveClass('bg-accent-primary');
      expect(screen.getAllByRole('button')).toHaveLength(1);
    });

    it('focuses the action when it opens', () => {
      renderAlert();

      expect(screen.getByRole('button', { name: 'OK' })).toHaveFocus();
    });

    it('acknowledges on Escape', () => {
      const { onAction } = renderAlert();

      fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });

      expect(onAction).toHaveBeenCalledTimes(1);
    });
  });

  it('leaves the description out when there is no sentence', () => {
    render(<AlertSheet open title="Heads up" actionLabel="OK" onAction={jest.fn()} />);

    expect(screen.getByRole('alertdialog')).not.toHaveAttribute('aria-describedby');
  });

  describe('dApp bubbles', () => {
    it('hides them on mobile while open', () => {
      jest.mocked(isMobile).mockReturnValue(true);
      const { rerender, onAction, onCancel } = renderConfirm();

      expect(document.body).toHaveAttribute('data-drawer-open');

      rerender(
        <AlertSheet open={false} title="t" actionLabel="a" onAction={onAction} onCancel={onCancel}>
          x
        </AlertSheet>
      );
      expect(document.body).not.toHaveAttribute('data-drawer-open');
      jest.mocked(isMobile).mockReturnValue(false);
    });

    it('leaves them alone off mobile', () => {
      renderConfirm();

      expect(document.body).not.toHaveAttribute('data-drawer-open');
    });
  });

  describe('screen key', () => {
    beforeEach(() => {
      process.env.MIDEN_E2E_TEST = 'true';
      __resetScreenKeyForTest();
      setRoutePart('/contacts');
    });

    afterEach(() => {
      if (ORIGINAL_E2E === undefined) delete process.env.MIDEN_E2E_TEST;
      else process.env.MIDEN_E2E_TEST = ORIGINAL_E2E;
    });

    it('publishes its screen key while open', () => {
      renderConfirm({ screenKey: 'confirm' });

      expect(getCurrentScreen().key).toBe('/contacts > drawer:confirm');
    });
  });
});
