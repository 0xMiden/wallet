import {
  _resetE2eOverridesForTest,
  getE2eOverrides,
  setEarnCollateralFaucetOverride,
  subscribeE2eOverrides
} from './e2e-overrides';

const FAUCET = '0xABCD00000000000000000000000001';
const NONE = { earnCollateralFaucet: null };

const saved = process.env.MIDEN_E2E_TEST;
const setE2e = (value: string | undefined) => {
  if (value === undefined) delete process.env.MIDEN_E2E_TEST;
  else process.env.MIDEN_E2E_TEST = value;
};
beforeEach(() => {
  setE2e('true');
  _resetE2eOverridesForTest();
});
afterAll(() => setE2e(saved));

it('starts with no override', () => {
  expect(getE2eOverrides()).toEqual(NONE);
});

it('fills the collateral faucet with the Earn E2E faucet symbol and decimals, the id lowercase', () => {
  setEarnCollateralFaucetOverride({ faucetId: FAUCET });
  expect(getE2eOverrides().earnCollateralFaucet).toEqual({
    faucetId: '0xabcd00000000000000000000000001',
    symbol: 'USDC',
    decimals: 6
  });
  setEarnCollateralFaucetOverride({ faucetId: FAUCET, symbol: 'TST', decimals: 8 });
  expect(getE2eOverrides().earnCollateralFaucet).toMatchObject({ symbol: 'TST', decimals: 8 });
  setEarnCollateralFaucetOverride(null);
  expect(getE2eOverrides().earnCollateralFaucet).toBeNull();
});

it('returns the same object until a setter changes it', () => {
  const first = getE2eOverrides();
  expect(getE2eOverrides()).toBe(first);
  setEarnCollateralFaucetOverride({ faucetId: FAUCET });
  const second = getE2eOverrides();
  expect(second).not.toBe(first);
  expect(getE2eOverrides()).toBe(second);
});

it('calls a subscriber once per change until it unsubscribes', () => {
  const listener = jest.fn();
  const unsubscribe = subscribeE2eOverrides(listener);
  setEarnCollateralFaucetOverride({ faucetId: FAUCET });
  _resetE2eOverridesForTest();
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe();
  setEarnCollateralFaucetOverride({ faucetId: FAUCET });
  expect(listener).toHaveBeenCalledTimes(2);
});

it.each([undefined, 'false', ''])('is inert, and silent, when MIDEN_E2E_TEST is %p', value => {
  const listener = jest.fn();
  const unsubscribe = subscribeE2eOverrides(listener);
  setE2e(value);
  setEarnCollateralFaucetOverride({ faucetId: FAUCET });
  setE2e('true');
  expect(getE2eOverrides()).toEqual(NONE);
  expect(listener).not.toHaveBeenCalled();
  unsubscribe();
});

it('hides an override set under an E2E build from a build without it', () => {
  setEarnCollateralFaucetOverride({ faucetId: FAUCET });
  setE2e(undefined);
  expect(getE2eOverrides()).toEqual(NONE);
});
