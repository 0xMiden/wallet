/** @jest-environment node */
import { createSwapOrder } from './swap';
import type { ChromeWalletPageApi } from './wallet-page';

interface LocatorValue {
  inputValue?(): Promise<string>;
  count?(): Promise<number>;
}

jest.mock('@playwright/test', () => ({
  expect: Object.assign(
    (input: LocatorValue) => ({
      toBeVisible: async () => {},
      toHaveValue: async (expected: string) => {
        expect(await input.inputValue?.()).toBe(expected);
      },
      toHaveCount: async (expected: number) => {
        expect(await input.count?.()).toBe(expected);
      }
    }),
    {
      poll: (read: () => Promise<string>) => ({
        not: {
          toBe: async (expected: string) => {
            expect(await read()).not.toBe(expected);
          }
        }
      })
    }
  )
}));
jest.mock('./faucet-address', () => ({}));
jest.mock('./feature-eligibility', () => ({}));
jest.mock('./history', () => ({}));
jest.mock('../config/environments', () => ({ IS_LOCALNET: true }));

function wallet(payLoading = false) {
  const fills: string[] = [];
  const submitted: Array<{ pay: string; receive: string }> = [];
  let pay = '';
  let receive = '';
  let requestedSymbol = '';
  let selectingReceive = false;
  let reviewOpen = false;
  let reads = 0;
  const amount = (side: number) => ({
    fill: async (value: string) => {
      fills.push(side === 0 ? 'pay' : 'receive');
      payLoading = false;
      if (side === 0) {
        pay = value;
        receive = value === '9.00450226' ? '9' : '9.995';
      } else {
        throw new Error('Command receive has no editable amount');
      }
    },
    inputValue: async () => (side === 0 ? pay : receive)
  });
  const selector = {
    click: async () => {},
    getByTestId(id: string) {
      if (id === 'send-amount-input') return amount(0);
      if (id === 'swap-review-submit')
        return {
          click: async () => {
            reviewOpen = true;
          }
        };
      if (id === 'swap-submit')
        return {
          click: async () => {
            if (!reviewOpen) throw new Error('Order signed without Command review');
            submitted.push({ pay, receive });
          }
        };
      return this;
    },
    getByText(text: string, options: { exact: boolean }) {
      return { count: async () => Number(options.exact && reviewOpen && text === `≈ ${receive} ${requestedSymbol}`) };
    },
    first() {
      return this;
    },
    nth() {
      throw new Error('Command receive has no second token selector');
    }
  };
  const page = {
    goto: async () => {},
    evaluate: async () => (reads++ === 0 ? [] : ['123']),
    waitForURL: async () => {},
    getByTestId: (id: string) => {
      if (id === 'send-amount-input') {
        return { first: () => amount(payLoading ? 1 : 0), nth: (side: number) => amount(side) };
      }
      if (id === 'swap-pay-side' || id === 'swap-receive-side')
        throw new Error('Command composer has no legacy swap amount sides');
      if (id === 'command-swap-receive')
        return {
          getByRole: (role: string, options: { name: string }) => {
            expect(role).toBe('button');
            expect(options.name).toBe('You Receive');
            return {
              click: async () => {
                selectingReceive = true;
              }
            };
          },
          getByText: (text: string, options: { exact: boolean }) => {
            expect(options.exact).toBe(true);
            return { textContent: async () => receive, count: async () => (receive === text ? 1 : 0) };
          },
          getByTestId: () => ({ count: async () => 0 })
        };
      if (id.startsWith('swap-token-'))
        return {
          click: async () => {
            if (selectingReceive) requestedSymbol = id.slice('swap-token-'.length);
          }
        };
      return selector;
    }
  };
  return { fills, submitted, maker: { page, extensionId: 'test' } as unknown as ChromeWalletPageApi };
}

it('anchors pay once and checks its quoted receive before signing', async () => {
  const w = wallet();
  const options = {
    offerSymbol: 'A',
    requestSymbol: 'B',
    payAmount: '10',
    receiveAmount: '9.995'
  };
  await expect(createSwapOrder(w.maker, options)).resolves.toBe('123');
  expect(w.fills).toEqual(['pay']);
  expect(w.submitted).toEqual([{ pay: '10', receive: '9.995' }]);
});

it('types the exact pay for a requested receive and checks its readonly quoted amount before signing', async () => {
  const w = wallet();
  const options = {
    offerSymbol: 'B',
    requestSymbol: 'A',
    payAmount: '9.00450226',
    receiveAmount: '9'
  };
  await expect(createSwapOrder(w.maker, options)).resolves.toBe('123');
  expect(w.fills).toEqual(['pay']);
  expect(w.submitted).toEqual([{ pay: '9.00450226', receive: '9' }]);
});

it('refuses to sign when the Command readonly receive quote disagrees with the scenario', async () => {
  const w = wallet();
  const options = {
    offerSymbol: 'A',
    requestSymbol: 'B',
    payAmount: '10',
    receiveAmount: '9'
  };
  await expect(createSwapOrder(w.maker, options)).rejects.toThrow();
  expect(w.submitted).toEqual([]);
});

it('scopes the pay edit to Command when another page input appears first', async () => {
  const w = wallet(true);
  const options = {
    offerSymbol: 'A',
    requestSymbol: 'B',
    payAmount: '10',
    receiveAmount: '9.995'
  };
  await expect(createSwapOrder(w.maker, options)).resolves.toBe('123');
  expect(w.fills).toEqual(['pay']);
  expect(w.submitted).toEqual([{ pay: '10', receive: '9.995' }]);
});
