import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Before #875's follow-up, `<NetworkModeBanner />` sat in one slot in `PageRouter` under the
 * comment "sits above EVERY routed page ... so no screen can forget it". That slot was removed in
 * favour of a corner ribbon in the tab bar, and the ribbon reaches only tab pages - so every
 * screen that commits value silently stopped naming the network, with no test failing.
 *
 * These seven are the screens on which the user commits value. They span two shells and share no
 * wrapper: five are full-screen routes that render the banner themselves, and two render inside
 * `TabLayout` through `ReviewLayout` - where the ribbon is HIDDEN, because `ReviewLayout` calls
 * `useHideNavbarWhileOpen` and `main.css` hides the tab-bar footer the ribbon lives in. So those
 * two sit in the shell that has a ribbon and still showed nothing.
 *
 * What this test does and does not do, stated plainly because the distinction matters: it fails
 * when the banner is REMOVED from a listed screen, which is exactly the regression above. It
 * cannot fail when an eighth value-signing screen is ADDED, because the seven share no marker a
 * search could key on - not a base component, not a naming convention (`BridgeDeposit` carries no
 * "Review"), not a transaction hook (four of the seven call none). The list is the registry; a new
 * signing screen has to be added here by hand.
 */
const VALUE_SIGNING_SCREENS: ReadonlyArray<{ screen: string; rendersBannerIn: string }> = [
  {
    screen: 'screens/send-flow/ReviewTransaction.tsx',
    rendersBannerIn: 'screens/send-flow/ReviewTransaction.tsx'
  },
  { screen: 'app/pages/RotateGuardianReview.tsx', rendersBannerIn: 'app/pages/RotateGuardianReview.tsx' },
  { screen: 'app/pages/BridgeDeposit.tsx', rendersBannerIn: 'app/pages/BridgeDeposit.tsx' },
  { screen: 'screens/earn-flow/EarnDepositReview.tsx', rendersBannerIn: 'screens/earn-flow/EarnDepositReview.tsx' },
  { screen: 'screens/earn-flow/EarnWithdrawReview.tsx', rendersBannerIn: 'screens/earn-flow/EarnWithdrawReview.tsx' },
  // These two render inside TabLayout via ReviewLayout, which carries the banner for both.
  { screen: 'screens/swap-flow/ReviewSwap.tsx', rendersBannerIn: 'components/review/ReviewLayout.tsx' },
  {
    screen: 'app/templates/EvmConnectModal/EvmBridgeDepositReview.tsx',
    rendersBannerIn: 'components/review/ReviewLayout.tsx'
  }
];

const read = (relative: string) => readFileSync(join(__dirname, '..', relative), 'utf8');

describe('every screen that commits value names the network', () => {
  it.each(VALUE_SIGNING_SCREENS)('$screen renders the banner (via $rendersBannerIn)', ({ rendersBannerIn }) => {
    const source = read(rendersBannerIn);

    expect(source).toContain("import { NetworkModeBanner } from 'components/NetworkModeBanner';");
    expect(source).toContain('<NetworkModeBanner />');
  });

  it.each(VALUE_SIGNING_SCREENS.filter(s => s.screen !== s.rendersBannerIn))(
    '$screen still renders through $rendersBannerIn, which is what carries its banner',
    ({ screen, rendersBannerIn }) => {
      // A screen that stops using the layout loses the banner with it, and its own file would
      // never show that. `ReviewLayout` -> `<ReviewLayout`.
      const component = rendersBannerIn.split('/').pop()!.replace('.tsx', '');

      expect(read(screen)).toContain(`<${component}`);
    }
  );

  it('lists every screen exactly once', () => {
    const screens = VALUE_SIGNING_SCREENS.map(s => s.screen);

    expect(new Set(screens).size).toBe(screens.length);
  });
});
