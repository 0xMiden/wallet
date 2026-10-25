/** @jest-environment node */
import type { ChromeWalletPageApi } from './wallet-page';

import { createSwapOrder } from './swap';

interface Input {
  inputValue(): Promise<string>;
}

jest.mock('@playwright/test', () => ({
  expect: Object.assign(
    (input: Input) => ({
      toBeVisible: async () => {},
      toHaveValue: async (expected: string) => {
        expect(await input.inputValue()).toBe(expected);
      }
    }),
    {
      poll: (read: () => Promise<string>) => ({
        not: { toBe: async (expected: string) => { expect(await read()).not.toBe(expected); } }
      })
    }
  )
}));
jest.mock('./faucet-address', () => ({}));
jest.mock('./feature-eligibility', () => ({}));
jest.mock('./history', () => ({}));
jest.mock('../config/environments', () => ({ IS_LOCALNET: true }));

function wallet() {
  const fills: string[] = [];
  const submitted: Array<{ pay: string; receive: string }> = [];
  let pay = '';
  let receive = '';
  let reads = 0;
  const amount = (side: number) => ({
    fill: async (value: string) => {
      fills.push(side === 0 ? 'pay' : 'receive');
      if (side === 0) {
        pay = value;
        receive = '9.995';
      } else {
        receive = value;
        pay = value === '9' ? '9.00450226' : '10';
      }
    },
    inputValue: async () => side === 0 ? pay : receive
  });
  const selector = { click: async () => {}, first() { return this; }, nth() { return this; } };
  const page = {
    goto: async () => {},
    evaluate: async () => reads++ === 0 ? [] : ['123'],
    waitForURL: async () => {},
    getByTestId: (id: string) => {
      if (id === 'send-amount-input') return { first: () => amount(0), nth: (side: number) => amount(side) };
      if (id === 'swap-submit') return { click: async () => { submitted.push({ pay, receive }); } };
      return selector;
    }
  };
  return { fills, submitted, maker: { page, extensionId: 'test' } as unknown as ChromeWalletPageApi };
}

it('anchors pay once and checks its quoted receive before signing', async () => {
  const w = wallet();
  const options = {
    offerSymbol: 'A', requestSymbol: 'B', amountAnchor: 'pay' as const, payAmount: '10', receiveAmount: '9.995'
  };
  await expect(createSwapOrder(w.maker, options)).resolves.toBe('123');
  expect(w.fills).toEqual(['pay']);
  expect(w.submitted).toEqual([{ pay: '10', receive: '9.995' }]);
});

it('anchors receive once and checks the hand-derived required pay before signing', async () => {
  const w = wallet();
  const options = {
    offerSymbol: 'B', requestSymbol: 'A', amountAnchor: 'receive' as const, payAmount: '9.00450226', receiveAmount: '9'
  };
  await expect(createSwapOrder(w.maker, options)).resolves.toBe('123');
  expect(w.fills).toEqual(['receive']);
  expect(w.submitted).toEqual([{ pay: '9.00450226', receive: '9' }]);
});

it('refuses to sign when the quoted opposite amount disagrees with the scenario', async () => {
  const w = wallet();
  const options = {
    offerSymbol: 'A', requestSymbol: 'B', amountAnchor: 'receive' as const, payAmount: '10', receiveAmount: '9'
  };
  await expect(createSwapOrder(w.maker, options)).rejects.toThrow();
  expect(w.submitted).toEqual([]);
});
