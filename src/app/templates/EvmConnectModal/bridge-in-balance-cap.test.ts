import { bridgeInBalanceCapVerdict } from './bridge-in-balance-cap';

describe('bridgeInBalanceCapVerdict', () => {
  const cap = 1232.462;

  it('holds nothing when the document sets no ceiling', () => {
    expect(bridgeInBalanceCapVerdict({ capUsd: null, heldUsd: null, depositAmount: 5, depositPriceUsd: 1 })).toEqual({
      state: 'none'
    });
  });

  it('waits while the holdings or the amount are not in', () => {
    expect(bridgeInBalanceCapVerdict({ capUsd: cap, heldUsd: null, depositAmount: 5, depositPriceUsd: 1 })).toEqual({
      state: 'loading'
    });
    expect(bridgeInBalanceCapVerdict({ capUsd: cap, heldUsd: 10, depositAmount: null, depositPriceUsd: 1 })).toEqual({
      state: 'loading'
    });
  });

  it('refuses a deposit whose token has no price', () => {
    expect(
      bridgeInBalanceCapVerdict({ capUsd: cap, heldUsd: 10, depositAmount: 0.5, depositPriceUsd: undefined })
    ).toEqual({ state: 'unpriced', capUsd: cap });
    expect(bridgeInBalanceCapVerdict({ capUsd: cap, heldUsd: 10, depositAmount: 0.5, depositPriceUsd: 0 })).toEqual({
      state: 'unpriced',
      capUsd: cap
    });
  });

  it('clears a deposit that lands at or under the ceiling', () => {
    expect(
      bridgeInBalanceCapVerdict({ capUsd: cap, heldUsd: 1000, depositAmount: 232.46, depositPriceUsd: 1 })
    ).toEqual({ state: 'clear', capUsd: cap, heldUsd: 1000, depositUsd: 232.46 });
    expect(bridgeInBalanceCapVerdict({ capUsd: 100, heldUsd: 0, depositAmount: 100, depositPriceUsd: 1 }).state).toBe(
      'clear'
    );
  });

  it('refuses a deposit that takes the account past the ceiling', () => {
    expect(
      bridgeInBalanceCapVerdict({ capUsd: cap, heldUsd: 1000, depositAmount: 232.47, depositPriceUsd: 1 })
    ).toEqual({ state: 'exceeded', capUsd: cap, heldUsd: 1000, depositUsd: 232.47 });
    expect(bridgeInBalanceCapVerdict({ capUsd: cap, heldUsd: 0, depositAmount: 1, depositPriceUsd: 2000 }).state).toBe(
      'exceeded'
    );
  });

  it('compares at the cent, so float noise on an exact ceiling does not refuse it', () => {
    expect(bridgeInBalanceCapVerdict({ capUsd: 0.3, heldUsd: 0.1, depositAmount: 0.2, depositPriceUsd: 1 }).state).toBe(
      'clear'
    );
  });
});
