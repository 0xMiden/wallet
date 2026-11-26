import * as DepositFlow from './index';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }), Trans: () => null }));

describe('deposit-flow barrel', () => {
  it('forwards every view, sheet and helper', () => {
    expect(Object.keys(DepositFlow).sort()).toEqual(
      [
        'DepositAddressView',
        'DepositAmountView',
        'DepositQrSheet',
        'DepositReviewView',
        'DepositRouteSheet',
        'HIGH_FEE_SHARE',
        'OpenWalletSheet',
        'PendingDepositRow',
        'addressLines',
        'amountFontClass'
      ].sort()
    );
    Object.values(DepositFlow).forEach(value => expect(value).toBeDefined());
  });
});
