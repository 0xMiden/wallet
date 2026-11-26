import * as DepositFlow from './index';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }), Trans: () => null }));
jest.mock('@capacitor/local-notifications', () => ({ LocalNotifications: {} }));

describe('deposit-flow barrel', () => {
  it('forwards every view, sheet, Home part and helper', () => {
    expect(Object.keys(DepositFlow).sort()).toEqual(
      [
        'DepositAddressView',
        'DepositAmountView',
        'DepositBadge',
        'DepositProcessingView',
        'DepositQrSheet',
        'DepositReviewView',
        'DepositRouteSheet',
        'DepositSuccessView',
        'DepositTokenSheet',
        'HIGH_FEE_SHARE',
        'OpenWalletSheet',
        'PendingDepositArrivalWatcher',
        'PendingDepositHomeRow',
        'PendingDepositRow',
        'addressLines',
        'amountFontClass',
        'pendingDepositPath'
      ].sort()
    );
    Object.values(DepositFlow).forEach(value => expect(value).toBeDefined());
  });
});
