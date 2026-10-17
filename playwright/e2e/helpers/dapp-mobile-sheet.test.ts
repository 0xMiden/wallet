/**
 * @jest-environment jsdom
 */
import React from 'react';

import { AllowedPrivateData, PrivateDataPermission } from '@miden-sdk/miden-wallet-adapter-base';
import { render } from '@testing-library/react';

import { DappConfirmationModal } from 'app/pages/Browser/DappConfirmationModal';

import { deadlineIn, HarnessFault, type CellContext } from './dapp-cells';
import type { DappChannel } from './dapp-channel';
import {
  answerSheet,
  expectNoSheet,
  pressSheet,
  readSheet,
  waitForSheetClosed,
  type SheetHost,
  type SheetWallet
} from './dapp-mobile-sheet';

jest.mock('@playwright/test', () => ({
  expect: (globalThis as typeof globalThis & { expect: typeof expect }).expect
}));

// What the component's own test mocks to render it in jsdom: the adapter's enum values (its manual mock leaves them
// undefined), i18n keys for text, and stand-ins for motion, haptics, back handling, biometrics and icons.
jest.mock('@miden-sdk/miden-wallet-adapter-base', () => ({
  PrivateDataPermission: { UponRequest: 'UPON_REQUEST', Auto: 'AUTO' },
  AllowedPrivateData: { None: 0, Assets: 1, Notes: 2, Storage: 4, All: 65535 }
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/animation', () => ({ useSprings: () => ({ overlay: {}, modal: {}, reduceMotion: false }) }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticMedium: jest.fn() }));
jest.mock('lib/mobile/useMobileBackHandler', () => ({ useMobileBackHandler: jest.fn() }));
jest.mock('lib/biometric', () => ({ confirmSensitiveAction: jest.fn() }));
jest.mock('lib/miden/back/protector-probe', () => ({ probeHardwareProtector: jest.fn() }));
jest.mock('framer-motion', () => {
  const { createElement, forwardRef } = jest.requireActual<typeof import('react')>('react');
  const passthrough = forwardRef<HTMLDivElement, { children?: React.ReactNode }>(({ children, ...rest }, ref) =>
    createElement('div', { ref, ...rest }, children)
  );
  return { motion: new Proxy({}, { get: () => passthrough }) };
});
jest.mock('app/icons/v2', () => ({ Icon: () => null, IconName: {} }));
jest.mock('components/SpendingLimitChallenge', () => ({ SpendingLimitChallenge: () => null }));

// The sheet's DOM as DappConfirmationModal.tsx renders it after Task 1: Radix portals the dialog into <body> between
// its focus guards; the origin span carries the full origin as its title.
function renderSheet(options: { approveDisabled?: boolean; messages?: string[]; before?: string } = {}): {
  approve: HTMLButtonElement;
  deny: HTMLButtonElement;
} {
  const guard = '<span data-radix-focus-guard="" tabindex="0"></span>';
  const lines = (options.messages ?? [])
    .map(line => `<div data-testid="dapp-confirmation-message">${line}</div>`)
    .join('');
  document.body.innerHTML = `
    <div id="root" aria-hidden="true">${options.before ?? ''}</div>
    ${guard}
    <div role="dialog" aria-modal="true" id="radix-:r0:" aria-labelledby="radix-:r1:" data-state="open" tabindex="-1">
      <div>
        <div><h2 id="radix-:r1:"><span title="http://localhost:4810" data-testid="dapp-confirmation-origin"><span>http://</span><span>localhost:4810</span></span></h2></div>
        <div>
          <p>confirmTransaction</p>
          ${lines === '' ? '' : `<div>${lines}</div>`}
          <div><p>network</p><p data-testid="dapp-confirmation-network">Testnet</p></div>
        </div>
        <div><button type="button" data-testid="dapp-confirmation-deny">deny</button><button type="button" data-testid="dapp-confirmation-approve">confirm</button></div>
      </div>
    </div>
    ${guard}`;
  const sheet = document.querySelector('[aria-labelledby="radix-:r1:"]');
  const deny = sheet?.querySelector('[data-testid="dapp-confirmation-deny"]');
  const approve = sheet?.querySelector('[data-testid="dapp-confirmation-approve"]');
  if (!(deny instanceof HTMLButtonElement) || !(approve instanceof HTMLButtonElement)) throw new Error('no buttons');
  approve.disabled = options.approveDisabled === true;
  return { approve, deny };
}

// Another dialog in the app, earlier in the document, with a button of the same id.
const OTHER_DIALOG =
  '<div role="dialog" aria-modal="true" data-other=""><h2>Choose a token</h2>' +
  '<button type="button" data-testid="dapp-confirmation-approve">confirm</button></div>';

// The page objects run each body as a function body in the wallet webview; jsdom stands in.
// eslint-disable-next-line no-new-func
const wallet: SheetWallet = { evalJs: async js => new Function(js)() };
const channel: DappChannel = { label: 'A/one', send: jest.fn(async () => ({ visibility: 'visible' })) };
const host: SheetHost = { wallet, channel, origin: 'http://localhost:4810' };
const contextFor = (ms = 60_000): CellContext => ({
  deadline: deadlineIn(ms, 'cell'),
  evidence: {},
  softFail: jest.fn()
});

afterEach(() => {
  jest.useRealTimers();
  document.body.innerHTML = '';
});

describe('the approval sheet over the wallet webview', () => {
  it('reads the origin, the message lines in order and whether Approve is enabled', async () => {
    renderSheet({ messages: ['Simulated effects:', 'Notes created, 1'] });
    await expect(readSheet(wallet)).resolves.toEqual({
      origin: 'http://localhost:4810',
      messages: ['Simulated effects:', 'Notes created, 1'],
      approveEnabled: true
    });
  });

  it('reads no sheet when none is open', async () => {
    await expect(readSheet(wallet)).resolves.toBeNull();
  });

  it('finds the sheet from its origin, not the first dialog in the document', async () => {
    const { approve } = renderSheet({ before: OTHER_DIALOG });
    const seen: string[] = [];
    approve.addEventListener('click', () => seen.push('sheet'));
    document.querySelector('[data-other] button')?.addEventListener('click', () => seen.push('other'));
    await pressSheet(wallet, 'approve', 5_000);
    expect(seen).toEqual(['sheet']);
  }, 10_000);

  it('waits for Approve to enable before it clicks it, once', async () => {
    const { approve } = renderSheet({ approveDisabled: true });
    let clicks = 0;
    approve.addEventListener('click', () => {
      clicks += 1;
    });
    let enabledAt = Number.POSITIVE_INFINITY;
    setTimeout(() => {
      approve.disabled = false;
      enabledAt = Date.now();
    }, 600);
    const pressedAt = await pressSheet(wallet, 'approve', 5_000);
    expect(clicks).toBe(1);
    expect(pressedAt).toBeGreaterThanOrEqual(enabledAt);
  }, 10_000);

  it('presses Deny by its id', async () => {
    const { approve, deny } = renderSheet();
    const seen: string[] = [];
    approve.addEventListener('click', () => seen.push('approve'));
    deny.addEventListener('click', () => seen.push('deny'));
    await pressSheet(wallet, 'deny', 5_000);
    expect(seen).toEqual(['deny']);
  }, 10_000);

  it('reports when the sheet has closed', async () => {
    renderSheet();
    const start = Date.now();
    setTimeout(() => {
      document.body.innerHTML = '';
    }, 300);
    const closedAt = await waitForSheetClosed(wallet, 5_000);
    expect(closedAt - start).toBeGreaterThanOrEqual(250);
  }, 10_000);

  it('answers nothing while an earlier sheet is still open', async () => {
    jest.useFakeTimers();
    renderSheet();
    const start = jest.fn(() => new Promise<never>(() => undefined));
    await Promise.all([
      expect(answerSheet(host, start, { decision: 'approve' }, contextFor())).rejects.toBeInstanceOf(HarnessFault),
      jest.advanceTimersByTimeAsync(11_000)
    ]);
    expect(start).not.toHaveBeenCalled();
  });

  it('records a sheet that opens for a request that must not prompt', async () => {
    const ctx = contextFor();
    setTimeout(() => renderSheet(), 300);
    await expect(expectNoSheet(host, () => new Promise<never>(() => undefined), ctx)).rejects.toThrow(
      'an approval sheet opened for a request that must not prompt'
    );
    expect(ctx.evidence.popupOpened).toBe(true);
  }, 10_000);

  it("takes the wallet's own answer when nothing is pressed, once the sheet has closed", async () => {
    const declined = { ok: false, error: { name: 'WalletTransactionError', message: 'NOT_GRANTED' } };
    const ctx = contextFor();
    const start = () =>
      new Promise(resolve => {
        setTimeout(() => renderSheet(), 50);
        setTimeout(() => {
          document.body.innerHTML = '';
        }, 400);
        setTimeout(() => resolve(declined), 500);
      });
    const { result, sheet } = await answerSheet(host, start, { decision: 'none' }, ctx);
    expect(result).toEqual(declined);
    expect(sheet.origin).toBe('http://localhost:4810');
    expect(ctx.evidence.dappError).toEqual(declined.error);
    expect(channel.send).not.toHaveBeenCalled();
  }, 10_000);
});

describe('the driver over the sheet DappConfirmationModal renders', () => {
  // The fixture above is a copy of this markup; reading the component itself is what catches the two drifting apart.
  it('reads its origin, message lines and Approve, and presses its Deny', async () => {
    const account = 'mtst1apsnkg6x57mhxyrq09aavyq08yu5dy4p_qr7qqq9wr6w';
    const onResolve = jest.fn();
    render(
      React.createElement(DappConfirmationModal, {
        request: {
          id: 'req-1',
          type: 'transaction',
          origin: 'http://localhost:4810',
          appMeta: { name: 'localhost' },
          network: 'testnet',
          networkRpc: 'https://rpc.testnet.miden.io',
          privateDataPermission: PrivateDataPermission.UponRequest,
          allowedPrivateData: AllowedPrivateData.None,
          existingPermission: false,
          transactionMessages: ['Simulated effects:', 'Notes created, 1'],
          sourcePublicKey: account
        },
        accountId: account,
        onResolve
      })
    );
    await expect(readSheet(wallet)).resolves.toEqual({
      origin: 'http://localhost:4810',
      messages: ['Simulated effects:', 'Notes created, 1'],
      approveEnabled: true
    });
    // A source account other than the current one is denied on mount, which would answer the Deny below by itself.
    expect(onResolve).not.toHaveBeenCalled();
    await pressSheet(wallet, 'deny', 5_000);
    expect(onResolve).toHaveBeenCalledWith({ confirmed: false }, 'req-1');
  }, 10_000);
});
