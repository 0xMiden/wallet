import React from 'react';

import { AllowedPrivateData, PrivateDataPermission } from '@demox-labs/miden-wallet-adapter-base';
import { render, screen } from '@testing-library/react';

import PrivateDataPermissionBanner from './PrivateDataPermissionBanner';

// Re-import the mocked enums for use in the test cases.

// The wallet-adapter package ships as ESM and is not transformed by jest, so we
// provide only the two enums the banner reads. `PrivateDataPermission` values
// mirror the real enum (`UPON_REQUEST` / `AUTO`) so the equality checks behave
// identically to production, and `AllowedPrivateData` mirrors the real bit-flag
// values (Assets=1, Notes=2, Storage=4) so the bitwise `&` masking is faithful.
jest.mock('@demox-labs/miden-wallet-adapter-base', () => ({
  PrivateDataPermission: { UponRequest: 'UPON_REQUEST', Auto: 'AUTO' },
  AllowedPrivateData: { None: 0, Assets: 1, Notes: 2, Storage: 4, All: 65535 }
}));

// `t` is never `init()`-ed in the unit env; echo the key back so rendered copy
// is directly assertable by translation key.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// The v2 icon barrel pulls in every SVG; stub `Icon` to a marker so we can count
// the rendered checkbox icons without dragging in SVG modules, and expose the
// one `IconName` member the banner references.
jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid="icon" data-name={name} />,
  IconName: { CheckboxCircle: 'CheckboxCircle' }
}));

// `utils/brand-colors` reaches into chain constants at import time; the banner
// only forwards `PRIMARY_HEX` as the (ignored) `fill` prop of the mocked Icon,
// so a plain string keeps the test hermetic.
jest.mock('utils/brand-colors', () => ({
  PRIMARY_HEX: '#E77537'
}));

describe('PrivateDataPermissionBanner', () => {
  describe('public account', () => {
    it('renders the public access copy and three checklist items, skipping the private-data section', () => {
      render(
        <PrivateDataPermissionBanner
          privateDataPermission={PrivateDataPermission.Auto}
          allowedPrivateData={AllowedPrivateData.All}
          isPublicAccount
        />
      );

      // Public heading + the three public-account checklist rows.
      expect(screen.getByText('publicAccountAccessRequest')).toBeInTheDocument();
      expect(screen.getByText('balanceAccess')).toBeInTheDocument();
      expect(screen.getByText('sendTransactionRequests')).toBeInTheDocument();
      expect(screen.getByText('fundsStayInWallet')).toBeInTheDocument();

      // One checkbox icon per checklist row.
      expect(screen.getAllByTestId('icon')).toHaveLength(3);

      // The private branch (PrivateDataAccess) must not render.
      expect(screen.queryByText('privateAccountAccessRequest')).not.toBeInTheDocument();
      expect(screen.queryByText('privateDataAccessAuto')).not.toBeInTheDocument();
      expect(screen.queryByText('privateDataAccessUponRequest')).not.toBeInTheDocument();
    });
  });

  describe('private account — Auto permission', () => {
    it('renders the auto copy and the full allowed-data list when all flags are set', () => {
      render(
        <PrivateDataPermissionBanner
          privateDataPermission={PrivateDataPermission.Auto}
          allowedPrivateData={AllowedPrivateData.Assets | AllowedPrivateData.Notes | AllowedPrivateData.Storage}
          isPublicAccount={false}
        />
      );

      expect(screen.getByText('privateAccountAccessRequest')).toBeInTheDocument();
      expect(screen.getByText('privateDataAccessAuto')).toBeInTheDocument();
      expect(screen.getByText('accessWillBeGranted')).toBeInTheDocument();

      // Every `if` in the shared `formatAllowedPrivateData` is truthy → all three
      // labels joined, in the same order the mobile and desktop prompts render them.
      expect(screen.getByText('Assets, Notes, Storage')).toBeInTheDocument();

      // No public-account content and no upon-request content.
      expect(screen.queryByText('publicAccountAccessRequest')).not.toBeInTheDocument();
      expect(screen.queryByText('confirmationRequired')).not.toBeInTheDocument();
      expect(screen.queryByTestId('icon')).not.toBeInTheDocument();
    });

    it('describes Auto with an empty category mask as upon-request, matching the other two surfaces', () => {
      // `dapp.ts` defaults `allowedPrivateData` to `None`, so a connect request can
      // arrive as Auto+None from any page. The three private-data handlers require a
      // non-empty category bit to serve without prompting, so this grant is NOT
      // standing — the popup used to say "Automatic" and then list nothing, while the
      // mobile modal and desktop overlay (which share
      // `grantsStandingPrivateDataAccess`) correctly said "Upon Request".
      render(
        <PrivateDataPermissionBanner
          privateDataPermission={PrivateDataPermission.Auto}
          allowedPrivateData={AllowedPrivateData.None}
          isPublicAccount={false}
        />
      );

      expect(screen.getByText('privateDataAccessUponRequest')).toBeInTheDocument();
      expect(screen.getByText('confirmationRequired')).toBeInTheDocument();
      expect(screen.queryByText('privateDataAccessAuto')).not.toBeInTheDocument();
      expect(screen.queryByText('accessWillBeGranted')).not.toBeInTheDocument();
    });

    it('renders a partial allowed-data list, exercising a mix of true/false bitwise branches', () => {
      render(
        <PrivateDataPermissionBanner
          privateDataPermission={PrivateDataPermission.Auto}
          allowedPrivateData={AllowedPrivateData.Assets | AllowedPrivateData.Storage}
          isPublicAccount={false}
        />
      );

      // Assets (set) and Storage (set) present; Notes (unset) omitted from the join.
      expect(screen.getByText('Assets, Storage')).toBeInTheDocument();
    });
  });

  describe('private account — UponRequest permission', () => {
    it('renders the upon-request copy and confirmation notice, skipping the allowed-data list', () => {
      render(
        <PrivateDataPermissionBanner
          privateDataPermission={PrivateDataPermission.UponRequest}
          allowedPrivateData={AllowedPrivateData.All}
          isPublicAccount={false}
        />
      );

      expect(screen.getByText('privateAccountAccessRequest')).toBeInTheDocument();
      expect(screen.getByText('privateDataAccessUponRequest')).toBeInTheDocument();
      expect(screen.getByText('confirmationRequired')).toBeInTheDocument();

      // The Auto-only allowed-data section must not render.
      expect(screen.queryByText('privateDataAccessAuto')).not.toBeInTheDocument();
      expect(screen.queryByText('accessWillBeGranted')).not.toBeInTheDocument();
    });
  });
});
