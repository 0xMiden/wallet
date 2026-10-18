/**
 * @jest-environment jsdom
 */
import React from 'react';

import { AllowedPrivateData, PrivateDataPermission } from '@miden-sdk/miden-wallet-adapter-base';
import { render } from '@testing-library/react';

import { DappConfirmationModal } from 'app/pages/Browser/DappConfirmationModal';

import { CellDeadlineExceeded, deadlineIn, HarnessFault, type CellContext } from './dapp-cells';
import type { DappChannel } from './dapp-channel';
import {
  answerSheet,
  approveSheetIfShown,
  expectNoSheet,
  pressSheet,
  readSheet,
  tickStandingAccess,
  waitForSheetClosed,
  type SheetHost,
  type SheetWallet
} from './dapp-mobile-sheet';

jest.mock('@playwright/test', () => {
  const jestExpect = (globalThis as typeof globalThis & { expect: typeof expect }).expect;
  // Playwright's expect names its claim and jest's cannot, so a failed claim is rethrown under that name.
  const named = (message: string | undefined, check: () => void): void => {
    try {
      check();
    } catch (error) {
      throw new Error(`${message ?? 'expect'}: ${String(error)}`);
    }
  };
  return {
    expect: (actual: unknown, message?: string) => ({
      toBeNull: () => named(message, () => jestExpect(actual).toBeNull()),
      toBeLessThanOrEqual: (bound: number) => named(message, () => jestExpect(actual).toBeLessThanOrEqual(bound))
    })
  };
});

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

// A sheet whose `button` closes it, as the wallet's sheet leaves the DOM once answered.
function renderSheetClosingOn(button: 'approve' | 'deny', onClose: () => void = () => undefined): void {
  renderSheet()[button].addEventListener('click', () => {
    document.body.innerHTML = '';
    onClose();
  });
}

// Another dialog in the app, earlier in the document, with a button of the same id.
const OTHER_DIALOG =
  '<div role="dialog" aria-modal="true" data-other=""><h2>Choose a token</h2>' +
  '<button type="button" data-testid="dapp-confirmation-approve">confirm</button></div>';

// The page objects run each body as a function body in the wallet webview; jsdom stands in.
// eslint-disable-next-line no-new-func
const runInPage = (js: string) => new Function(js)();
const wallet: SheetWallet = { evalJs: async js => runInPage(js) };
const hostFor = (send: DappChannel['send'] = jest.fn(async () => ({ visibility: 'visible' }))): SheetHost => ({
  wallet,
  channel: { label: 'A/one', send },
  origin: 'http://localhost:4810'
});
const contextFor = (ms = 60_000): CellContext => ({
  deadline: deadlineIn(ms, 'cell'),
  evidence: {},
  softFail: jest.fn()
});
const declined = { ok: false, error: { name: 'WalletTransactionError', message: 'NOT_GRANTED' } };
const ACCOUNT = 'mtst1apsnkg6x57mhxyrq09aavyq08yu5dy4p_qr7qqq9wr6w';

afterEach(() => {
  jest.useRealTimers();
  document.body.innerHTML = '';
});

describe('the approval sheet over the wallet webview', () => {
  it.each(['answerSheet', 'approveSheetIfShown', 'expectNoSheet'])(
    'classifies an evaluator disconnect after the first read in %s as HarnessFault',
    async action => {
      jest.useFakeTimers();
      let reads = 0;
      const disconnected: SheetHost = {
        ...hostFor(),
        wallet: {
          evalJs: async <T>(js: string): Promise<T> => {
            reads += 1;
            if (reads > 1) throw new Error('Remote debugger is not connected');
            return wallet.evalJs<T>(js);
          }
        }
      };
      const start = (): Promise<never> => new Promise(() => undefined);
      const ctx = contextFor(1_000);
      const pending =
        action === 'answerSheet'
          ? answerSheet(disconnected, start, { decision: 'approve' }, ctx)
          : action === 'approveSheetIfShown'
            ? approveSheetIfShown(disconnected, start, ctx)
            : expectNoSheet(disconnected, start, ctx);
      const outcome = pending.catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(1_000);
      await expect(outcome).resolves.toBeInstanceOf(HarnessFault);
    }
  );

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
      expect(answerSheet(hostFor(), start, { decision: 'approve' }, contextFor())).rejects.toBeInstanceOf(HarnessFault),
      jest.advanceTimersByTimeAsync(11_000)
    ]);
    expect(start).not.toHaveBeenCalled();
  });

  it('records a sheet that opens for a request that must not prompt', async () => {
    const ctx = contextFor();
    setTimeout(() => renderSheet(), 300);
    await expect(expectNoSheet(hostFor(), () => new Promise<never>(() => undefined), ctx)).rejects.toThrow(
      'an approval sheet opened for a request that must not prompt'
    );
    expect(ctx.evidence.popupOpened).toBe(true);
  }, 10_000);

  it("takes the wallet's own answer when nothing is pressed, once the sheet has closed", async () => {
    const ctx = contextFor();
    const send = jest.fn(async () => ({ visibility: 'visible' }));
    const start = () =>
      new Promise(resolve => {
        setTimeout(() => renderSheet(), 50);
        setTimeout(() => {
          document.body.innerHTML = '';
        }, 400);
        setTimeout(() => resolve(declined), 500);
      });
    const { result, sheet } = await answerSheet(hostFor(send), start, { decision: 'none' }, ctx);
    expect(result).toEqual(declined);
    expect(sheet.origin).toBe('http://localhost:4810');
    expect(ctx.evidence.dappError).toEqual(declined.error);
    expect(send).not.toHaveBeenCalled();
  }, 10_000);

  it('records a request the wallet answers before any sheet, and fails it', async () => {
    const ctx = contextFor();
    await expect(answerSheet(hostFor(), async () => declined, { decision: 'approve' }, ctx)).rejects.toThrow(
      'expected an approval sheet, but the request settled first'
    );
    expect(ctx.evidence).toEqual({ popupOpened: false, dappError: declined.error });
  });

  it('asks the page for its state once the answer is 10 s late, and calls silence a lost page', async () => {
    jest.useFakeTimers();
    const send = jest.fn(async () => {
      throw new Error('the page took no command');
    });
    const start = () =>
      new Promise<never>(() => {
        setTimeout(() => renderSheetClosingOn('deny'), 50);
      });
    await Promise.all([
      expect(answerSheet(hostFor(send), start, { decision: 'deny' }, contextFor(30_000))).rejects.toBeInstanceOf(
        HarnessFault
      ),
      jest.advanceTimersByTimeAsync(31_000)
    ]);
    expect(send).toHaveBeenCalledWith('__state', {}, 5_000);
  });

  it('waits on past the grace for an answer while the page still answers', async () => {
    jest.useFakeTimers();
    const granted = { ok: true, value: 'tx-1' };
    const send = jest.fn(async () => ({ visibility: 'visible' }));
    const start = () =>
      new Promise(resolve => {
        setTimeout(() => renderSheetClosingOn('approve'), 50);
        setTimeout(() => resolve(granted), 12_000);
      });
    const [answered] = await Promise.all([
      answerSheet(hostFor(send), start, { decision: 'approve' }, contextFor(30_000)),
      jest.advanceTimersByTimeAsync(13_000)
    ]);
    expect(answered.result).toEqual(granted);
    expect(send).toHaveBeenCalledWith('__state', {}, 5_000);
  });

  it('gives up a press at the cell deadline and presses nothing after it', async () => {
    jest.useFakeTimers();
    let clicks = 0;
    const start = () =>
      new Promise<never>(() => {
        setTimeout(() => {
          const { approve } = renderSheet({ approveDisabled: true });
          approve.addEventListener('click', () => {
            clicks += 1;
          });
          setTimeout(() => {
            approve.disabled = false;
          }, 5_000);
        }, 50);
      });
    await Promise.all([
      expect(answerSheet(hostFor(), start, { decision: 'approve' }, contextFor(3_000))).rejects.toBeInstanceOf(
        CellDeadlineExceeded
      ),
      jest.advanceTimersByTimeAsync(10_000)
    ]);
    expect(clicks).toBe(0);
  });

  it('names the last failed sheet read when the cell runs out waiting for a sheet', async () => {
    jest.useFakeTimers();
    let reads = 0;
    const dying: SheetWallet = {
      evalJs: async js => {
        reads += 1;
        if (reads > 1) throw new Error('webview gone');
        return runInPage(js);
      }
    };
    const host = { ...hostFor(), wallet: dying };
    await Promise.all([
      expect(
        answerSheet(host, () => new Promise<never>(() => undefined), { decision: 'approve' }, contextFor(2_000))
      ).rejects.toThrow('the last sheet read failed: Error: webview gone'),
      jest.advanceTimersByTimeAsync(2_500)
    ]);
  });

  it('approves the sheet a connect opens and says it prompted', async () => {
    const ctx = contextFor();
    const granted = { ok: true, value: { address: ACCOUNT } };
    const start = () =>
      new Promise(resolve => {
        setTimeout(() => renderSheetClosingOn('approve', () => resolve(granted)), 50);
      });
    await expect(approveSheetIfShown(hostFor(), start, ctx)).resolves.toEqual({ result: granted, prompted: true });
    expect(ctx.evidence.popupOpened).toBe(true);
  }, 10_000);

  it('says no sheet opened for a connect the wallet grants without one', async () => {
    const ctx = contextFor();
    const granted = { ok: true, value: { address: ACCOUNT } };
    await expect(approveSheetIfShown(hostFor(), async () => granted, ctx)).resolves.toEqual({
      result: granted,
      prompted: false
    });
    expect(ctx.evidence.popupOpened).toBe(false);
  });
});

describe('a request that must open no sheet', () => {
  it('passes a refusal answered within one block with no sheet', async () => {
    const ctx = contextFor();
    const send = jest.fn().mockResolvedValueOnce({ height: 10 }).mockResolvedValueOnce({ height: 11 });
    await expect(expectNoSheet(hostFor(send), async () => declined, ctx, { refusal: true })).resolves.toEqual(declined);
    expect(ctx.evidence).toEqual({ popupOpened: false, dappError: declined.error });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('fails a refusal that took two blocks, with its error recorded first', async () => {
    const ctx = contextFor();
    const send = jest.fn().mockResolvedValueOnce({ height: 10 }).mockResolvedValueOnce({ height: 12 });
    await expect(expectNoSheet(hostFor(send), async () => declined, ctx, { refusal: true })).rejects.toThrow(
      'blocks the dApp saw while a refusal before enqueue was pending'
    );
    expect(ctx.evidence.dappError).toEqual(declined.error);
  });

  it('fails when a sheet opens and closes between two polls after the answer', async () => {
    const ctx = contextFor();
    // The height read after the answer takes 300 ms, the time the sheet has to flash open and closed.
    const send = jest
      .fn()
      .mockResolvedValueOnce({ height: 10 })
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve({ height: 10 }), 300)));
    const start = () =>
      new Promise(resolve => {
        setTimeout(() => {
          resolve(declined);
          setTimeout(() => renderSheet(), 10);
          setTimeout(() => {
            document.body.innerHTML = '';
          }, 110);
        }, 50);
      });
    await expect(expectNoSheet(hostFor(send), start, ctx, { refusal: true })).rejects.toThrow(
      'an approval sheet opened for a request that must not prompt'
    );
    expect(ctx.evidence).toEqual({ popupOpened: true, dappError: declined.error });
  }, 10_000);
});

describe('the driver over the sheet DappConfirmationModal renders', () => {
  // The driver clicks as the webview does, outside act(), so React flushes its own updates; RTL's render still acts.
  beforeAll(() => {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', false);
  });
  afterAll(() => {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  });

  // The fixture above is a copy of this markup; reading the component itself is what catches the two drifting apart.
  it('reads its origin, message lines and Approve, and presses its Deny', async () => {
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
          sourcePublicKey: ACCOUNT
        },
        accountId: ACCOUNT,
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

  it('ticks the standing private-data box by its id and approves an Auto connect', async () => {
    const onResolve = jest.fn();
    render(
      React.createElement(DappConfirmationModal, {
        request: {
          id: 'req-1',
          type: 'connect',
          origin: 'http://localhost:4810',
          appMeta: { name: 'localhost' },
          network: 'testnet',
          networkRpc: 'https://rpc.testnet.miden.io',
          privateDataPermission: PrivateDataPermission.Auto,
          allowedPrivateData: AllowedPrivateData.Assets | AllowedPrivateData.Notes,
          existingPermission: false
        },
        accountId: ACCOUNT,
        onResolve
      })
    );
    await tickStandingAccess(wallet, deadlineIn(5_000, 'tick'));
    await pressSheet(wallet, 'approve', 5_000);
    // Approving without the tick downgrades the grant to UponRequest, so AUTO is the box's own effect.
    expect(onResolve).toHaveBeenCalledWith(
      expect.objectContaining({ confirmed: true, privateDataPermission: 'AUTO' }),
      'req-1'
    );
  }, 10_000);
});
