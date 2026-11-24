import React from 'react';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { AlertSheet } from 'components/ui/AlertSheet';
import { DappSession } from 'lib/dapp-browser';
import { DAppConfirmationRequest } from 'lib/dapp-browser/confirmation-store';

import { DappActionsSheet } from './DappActionsSheet';
import { DappConfirmationModal } from './DappConfirmationModal';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isMobile: () => true,
  isExtension: () => false
}));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticMedium: jest.fn() }));
jest.mock('lib/biometric', () => ({ confirmSensitiveAction: jest.fn() }));
jest.mock('lib/miden/back/protector-probe', () => ({ probeHardwareProtector: jest.fn() }));
jest.mock('lib/dapp-browser', () => ({
  getDappDisplayName: () => 'Game actions',
  getRecentDapps: async () => [],
  recordRecentDapp: jest.fn(),
  forgetRecentDapp: jest.fn()
}));
jest.mock('components/StrictActionAuthentication', () => ({
  StrictActionAuthentication: () => <button>Authenticate</button>
}));
const mockBack: { handler: () => boolean | void; active: boolean }[] = [];
jest.mock('lib/mobile/back-handler', () => ({
  registerMobileBackHandler: (handler: () => boolean | void) => {
    const entry = { handler, active: true };
    mockBack.push(entry);
    return () => {
      entry.active = false;
    };
  }
}));

const session = { url: 'https://example.test/game', origin: 'https://example.test' } as DappSession;
const request = {
  id: 'stack-request',
  type: 'sign',
  origin: 'https://example.test',
  network: 'testnet'
} as DAppConfirmationRequest;
const deny = jest.fn();
const alertClose = jest.fn();
const actionsClose = jest.fn();
function Layers({
  alert = false,
  actions = false,
  approval = false
}: {
  alert?: boolean;
  actions?: boolean;
  approval?: boolean;
}) {
  return (
    <>
      <AlertSheet open={alert} title="Alert" actionLabel="Acknowledge" onAction={alertClose} />
      <DappActionsSheet session={session} open={actions} onOpenChange={actionsClose} onReopen={() => {}} />
      {approval && <DappConfirmationModal request={request} accountId={null} onResolve={deny} />}
    </>
  );
}
const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
  });
const back = () =>
  act(() => {
    mockBack
      .filter(entry => entry.active)
      .at(-1)
      ?.handler();
  });
beforeEach(() => {
  jest.clearAllMocks();
  mockBack.length = 0;
});

describe('host modal ownership', () => {
  it.each(['alert', 'actions'] as const)(
    'newest modal owns focus, pointer eligibility and dismissal after %s',
    async first => {
      const view = render(<Layers alert={first === 'alert'} actions={first === 'actions'} />);
      await settle();
      const older = document.querySelector('[data-slot="drawer-content"]') as HTMLElement;
      view.rerender(<Layers alert actions />);
      await settle();
      const newer = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="drawer-content"]')).find(
        node => node !== older
      )!;
      expect(newer).toContainElement(document.activeElement as HTMLElement);
      expect(newer.style.pointerEvents).toBe('auto');
      expect(older.style.pointerEvents).toBe('none');
      expect(newer.className.match(/\bz-\S+/)?.[0]).toBe(older.className.match(/\bz-\S+/)?.[0]);
      const buttons = within(newer).getAllByRole('button');
      buttons.at(-1)!.focus();
      fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
      expect(buttons[0]).toHaveFocus();
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      expect(first === 'alert' ? actionsClose : alertClose).toHaveBeenCalledTimes(1);
      expect(first === 'alert' ? alertClose : actionsClose).not.toHaveBeenCalled();
      back();
      expect(first === 'alert' ? actionsClose : alertClose).toHaveBeenCalledTimes(2);
    }
  );

  it('a drawer over approval owns Escape and Tab without denying the underlying request', async () => {
    const view = render(<Layers approval />);
    await settle();
    const approval = screen.getByRole('dialog');
    view.rerender(<Layers approval actions />);
    await settle();
    const actions = screen.getByRole('dialog', { name: 'dappActionsSheet' });
    expect(actions).toContainElement(document.activeElement as HTMLElement);
    const last = within(actions).getAllByRole('button').at(-1)!;
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(actions).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(actionsClose).toHaveBeenCalledWith(false);
    expect(deny).not.toHaveBeenCalled();
    expect(approval.style.pointerEvents).toBe('none');
  });

  it('closing an underlying approval does not steal focus from the surviving alert', async () => {
    const view = render(<Layers approval />);
    await settle();
    view.rerender(<Layers approval alert />);
    await settle();
    const action = screen.getByRole('button', { name: 'Acknowledge' });
    expect(action).toHaveFocus();
    view.rerender(<Layers alert />);
    await settle();
    expect(action).toHaveFocus();
    expect(screen.getByRole('alertdialog').style.pointerEvents).toBe('auto');
  });

  it('a real spending challenge joins the same stack above approval', async () => {
    const limited = { ...request, spendingLimitAssessment: { revision: 'test-revision' } } as DAppConfirmationRequest;
    render(<DappConfirmationModal request={limited} accountId={null} onResolve={deny} />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));
    await settle();
    const challenge = screen.getByTestId('spending-limit-challenge');
    expect(challenge).toContainElement(document.activeElement as HTMLElement);
    screen.getByRole('button', { name: 'Authenticate' }).focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(within(challenge).getByRole('button', { name: 'close' })).toHaveFocus();
    expect(deny).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(deny).toHaveBeenCalledTimes(1);
    expect(deny).toHaveBeenCalledWith({ confirmed: false }, request.id);
  });

  it('removing the older drawer preserves the alert focus and back ownership', async () => {
    const view = render(<Layers actions />);
    await settle();
    const older = screen.getByRole('dialog');
    view.rerender(<Layers actions alert />);
    await settle();
    const action = screen.getByRole('button', { name: 'Acknowledge' });
    view.rerender(<Layers alert />);
    act(() => {
      older.dispatchEvent(
        Object.assign(new Event('animationend', { bubbles: true }), { animationName: 'slideToBottom' })
      );
    });
    await settle();
    expect(action).toHaveFocus();
    back();
    expect(alertClose).toHaveBeenCalledTimes(1);
    expect(actionsClose).not.toHaveBeenCalled();
  });

  it('returns to the connected fallback when a drawer opener is removed', async () => {
    const fallback = document.createElement('div');
    fallback.tabIndex = -1;
    fallback.dataset.focusFallback = '';
    const opener = document.createElement('button');
    fallback.append(opener);
    document.body.append(fallback);
    opener.focus();
    const view = render(<Layers actions />);
    await settle();
    opener.remove();
    const sheet = screen.getByRole('dialog');
    view.rerender(<Layers />);
    act(() => {
      sheet.dispatchEvent(
        Object.assign(new Event('animationend', { bubbles: true }), { animationName: 'slideToBottom' })
      );
    });
    await waitFor(() => expect(fallback).toHaveFocus());
    fallback.remove();
  });

  it.each(['approval', 'alert'] as const)('does not return %s focus into an underlying closing sheet', async front => {
    const view = render(<Layers actions />);
    await settle();
    const older = screen.getByRole('dialog');
    const opener = within(older).getByRole('button', { name: 'close' });
    expect(opener).toHaveFocus();
    view.rerender(<Layers actions approval={front === 'approval'} alert={front === 'alert'} />);
    await settle();
    const top = front === 'approval' ? screen.getByRole('dialog') : screen.getByRole('alertdialog');
    view.rerender(<Layers approval={front === 'approval'} alert={front === 'alert'} />);
    expect(older).toHaveAttribute('data-state', 'closed');
    expect(older.isConnected).toBe(true);
    view.rerender(<Layers />);
    if (front === 'alert') {
      act(() => {
        top.dispatchEvent(
          Object.assign(new Event('animationend', { bubbles: true }), { animationName: 'slideToBottom' })
        );
      });
    }
    await settle();
    expect(older).not.toContainElement(document.activeElement as HTMLElement);
  });

  it('imperative drawer restores its connected opener after dismissal', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const view = render(<Layers actions />);
    await settle();
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
    const sheet = screen.getByRole('dialog');
    view.rerender(<Layers />);
    act(() => {
      sheet.dispatchEvent(
        Object.assign(new Event('animationend', { bubbles: true }), { animationName: 'slideToBottom' })
      );
    });
    await waitFor(() => expect(opener).toHaveFocus());
    opener.remove();
  });
});
